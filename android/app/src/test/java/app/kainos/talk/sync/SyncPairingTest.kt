package app.kainos.talk.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncPairingTest {
    private fun identity(name: String) =
        Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/$name")!!, "kainos-test")

    /**
     * A test PC that answers `pair` with `pairCode`. By default it then waits without accepting so
     * tests can verify Cancel and coroutine cancellation; with [sendPairedImmediately] it sends
     * `paired` straight away without waiting for `pairConfirm`.
     */
    private class FakePairingPc(
        identity: Pkcs12Identity,
        private val sendPairedImmediately: Boolean = false,
    ) : AutoCloseable {
        private val tls = SSLContext.getInstance("TLSv1.3").apply { init(identity.keyManagers(), null, null) }.socketFactory
        private val server = ServerSocket(0)
        val port get() = server.localPort
        val firstFrameType = CompletableDeferred<String>()
        val confirmed = CompletableDeferred<Unit>()
        val closed = CompletableDeferred<Unit>()
        val connections = AtomicInteger(0)
        private val failure = AtomicReference<Throwable?>(null)

        init {
            Thread {
                while (!server.isClosed) {
                    val raw = runCatching { server.accept() }.getOrNull() ?: break
                    connections.incrementAndGet()
                    Thread {
                        try {
                            val socket = (tls.createSocket(raw, null, raw.port, false) as SSLSocket).apply { useClientMode = false }
                            val reader = socket.inputStream.bufferedReader(Charsets.UTF_8)
                            val writer = socket.outputStream.bufferedWriter(Charsets.UTF_8)
                            val first = reader.readLine() ?: return@Thread
                            firstFrameType.complete(JSONObject(first).getString("t"))
                            writer.write("""{"t":"pairCode","nonce":"pc-nonce-1"}""" + "\n")
                            if (sendPairedImmediately) {
                                writer.write("""{"t":"paired","deviceId":"impostor-device"}""" + "\n")
                            }
                            writer.flush()
                            while (true) {
                                val next = reader.readLine() ?: break
                                if (JSONObject(next).getString("t") == "pairConfirm") confirmed.complete(Unit)
                            }
                        } catch (_: IOException) {
                            // Peer closed the TLS socket.
                        } catch (t: Throwable) {
                            failure.compareAndSet(null, t)
                        } finally {
                            closed.complete(Unit)
                            runCatching { raw.close() }
                        }
                    }.apply { isDaemon = true }.start()
                }
            }.apply { isDaemon = true }.start()
        }

        fun checkNoFailure() {
            failure.get()?.let { throw AssertionError("FakePairingPc daemon thread failed", it) }
        }

        override fun close() = server.close()
    }

    private fun newClient(context: Context, port: Int, scope: CoroutineScope) = SyncClient(
        context = context,
        hub = FakeTalkHub(),
        sms = FakeSmsStore(),
        scope = scope,
        identity = identity("phone.p12"),
        port = port,
        lanAvailable = MutableStateFlow(true),
    )

    @Test
    fun cancelAfterCodesMatchClosesSocketAndEndsPairing() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePairingPc(pcIdentity).use { pc ->
            val client = newClient(context, pc.port, scope)
            try {
                client.pair(FoundPc("Test PC", listOf("127.0.0.1"), pcIdentity.fingerprint))
                val shown = withTimeout(5_000) { client.pairing.first { it is PairingState.Code } } as PairingState.Code
                assertEquals("pair", withTimeout(3_000) { pc.firstFrameType.await() })

                client.confirmCode(true)
                assertEquals(PairingState.Confirmed(shown.code), client.pairing.value)
                withTimeout(5_000) { pc.confirmed.await() }

                // Cancel after "Codes match" must close the socket right away and return to Idle.
                client.confirmCode(false)
                withTimeout(3_000) { pc.closed.await() }
                withTimeout(3_000) { client.pairing.first { it is PairingState.Idle } }
                assertEquals(SyncStatus.NotPaired, client.status.value)
                pc.checkNoFailure()
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun cancelBeforeCodesMatchClosesSocketAndReturnsCancelled() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePairingPc(pcIdentity).use { pc ->
            val client = newClient(context, pc.port, scope)
            try {
                val codeShown = CompletableDeferred<String>()
                val job = scope.async {
                    client.pairAt(listOf("127.0.0.1"), pcIdentity.fingerprint, "Test PC") { codeShown.complete(it) }
                }
                withTimeout(5_000) { codeShown.await() }
                assertEquals("pair", withTimeout(3_000) { pc.firstFrameType.await() })
                client.confirmCode(false)
                withTimeout(3_000) { pc.closed.await() }
                assertEquals(PairResult.Cancelled, withTimeout(3_000) { job.await() })
                pc.checkNoFailure()
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun cancellingPairAtCoroutineClosesSocketSoPcIsNotStranded() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePairingPc(pcIdentity).use { pc ->
            val client = newClient(context, pc.port, scope)
            try {
                val codeShown = CompletableDeferred<String>()
                val job = scope.async {
                    client.pairAt(listOf("127.0.0.1"), pcIdentity.fingerprint, "Test PC") { codeShown.complete(it) }
                }
                withTimeout(5_000) { codeShown.await() }
                assertEquals("pair", withTimeout(3_000) { pc.firstFrameType.await() })
                client.confirmCode(true)
                withTimeout(5_000) { pc.confirmed.await() }

                job.cancelAndJoin()
                withTimeout(3_000) { pc.closed.await() }
                assertTrue(job.isCancelled)
                pc.checkNoFailure()
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun pairedBeforeUserConfirmsIsRefusedWithoutSavingOrSyncing() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePairingPc(pcIdentity, sendPairedImmediately = true).use { pc ->
            val client = newClient(context, pc.port, scope)
            try {
                client.pair(FoundPc("Fake PC", listOf("127.0.0.1"), pcIdentity.fingerprint))
                val problem = withTimeout(5_000) { client.pairing.first { it is PairingState.Problem } } as PairingState.Problem
                assertTrue(problem.message.contains("didn't connect"))
                assertEquals("pair", withTimeout(3_000) { pc.firstFrameType.await() })
                assertNull(SyncSettings(context).load())
                assertEquals(SyncStatus.NotPaired, client.status.value)
                assertEquals(1, pc.connections.get())
                pc.checkNoFailure()
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun immediateCancelAfterPairEndsInIdle() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePairingPc(pcIdentity).use { pc ->
            val client = newClient(context, pc.port, scope)
            try {
                client.pair(FoundPc("Test PC", listOf("127.0.0.1"), pcIdentity.fingerprint))
                client.confirmCode(false)
                withTimeout(3_000) { client.pairing.first { it is PairingState.Idle } }
                assertNull(SyncSettings(context).load())
                assertEquals(SyncStatus.NotPaired, client.status.value)
                pc.checkNoFailure()
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun cancelFromCodeShowsMismatchWarning() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePairingPc(pcIdentity).use { pc ->
            val client = newClient(context, pc.port, scope)
            try {
                client.pair(FoundPc("Test PC", listOf("127.0.0.1"), pcIdentity.fingerprint))
                withTimeout(5_000) { client.pairing.first { it is PairingState.Code } }
                assertEquals("pair", withTimeout(3_000) { pc.firstFrameType.await() })

                client.confirmCode(false)
                withTimeout(3_000) { pc.closed.await() }
                val problem = withTimeout(3_000) { client.pairing.first { it is PairingState.Problem } } as PairingState.Problem
                assertEquals(SyncClient.CODE_MISMATCH_MESSAGE, problem.message)
                assertNull(SyncSettings(context).load())
                assertEquals(SyncStatus.NotPaired, client.status.value)
                pc.checkNoFailure()
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun aStrayCancelKeepsAProblemWhileForgetAndStartDiscoveryClearIt() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePairingPc(pcIdentity).use { pc ->
            val client = newClient(context, pc.port, scope)
            try {
                // Trigger a Problem with no live attempt left.
                client.pair(FoundPc("Remote PC", listOf("8.8.8.8"), null))
                withTimeout(3_000) { client.pairing.first { it is PairingState.Problem } }

                // A second tap on Cancel after the attempt ended leaves the warning to be read.
                val problem = client.pairing.value
                client.confirmCode(false)
                assertEquals(problem, client.pairing.value)

                // forget() clears a stale Problem.
                client.forget()
                assertEquals(PairingState.Idle, client.pairing.value)

                // startDiscovery() clears a stale Problem.
                client.pair(FoundPc("Remote PC", listOf("8.8.8.8"), null))
                withTimeout(3_000) { client.pairing.first { it is PairingState.Problem } }
                client.startDiscovery()
                assertEquals(PairingState.Idle, client.pairing.value)

                // startDiscovery() does not clobber a live Code state.
                client.pair(FoundPc("Test PC", listOf("127.0.0.1"), pcIdentity.fingerprint))
                val shown = withTimeout(5_000) { client.pairing.first { it is PairingState.Code } } as PairingState.Code
                client.startDiscovery()
                assertEquals(shown, client.pairing.value)
                client.confirmCode(false)
                withTimeout(3_000) { pc.closed.await() }
                pc.checkNoFailure()
            } finally {
                client.stopDiscovery()
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }
}
