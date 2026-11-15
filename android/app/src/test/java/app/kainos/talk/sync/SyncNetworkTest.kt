package app.kainos.talk.sync

import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncNetworkTest {
    @Test fun retryWaitsForLanAndResumesWhenItReturns() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        SyncSettings(context).save(PairedPc("127.0.0.1", "00".repeat(32), "test", "PC"))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val network = MutableStateFlow(false)
        val client = SyncClient(context, FakeTalkHub(), FakeSmsStore(), scope,
            Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test"),
            port = 1, lanAvailable = network)
        suspend fun waiting() = withTimeout(5000) {
            client.status.first { it is SyncStatus.Offline && it.reason == "Waiting for Wi-Fi or Ethernet" }
        }
        try {
            client.start()
            waiting()
            delay(250)
            assertEquals(SyncStatus.Offline("PC", "Waiting for Wi-Fi or Ethernet"), client.status.value)
            network.value = true
            withTimeout(5000) { client.status.first { it is SyncStatus.Offline && it.reason != "Waiting for Wi-Fi or Ethernet" } }
            network.value = false
            waiting()
            delay(250)
            assertEquals(SyncStatus.Offline("PC", "Waiting for Wi-Fi or Ethernet"), client.status.value)
            network.value = true
            withTimeout(10000) { client.status.first { it is SyncStatus.Offline && it.reason != "Waiting for Wi-Fi or Ethernet" } }
        } finally { scope.cancel(); SyncSettings(context).clear() }
        Unit
    }

    @Test fun aConnectIsAttemptedAfterTheWaitWhenLanNeverAppears() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        SyncSettings(context).save(PairedPc("127.0.0.1", "00".repeat(32), "test", "PC"))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val client = SyncClient(context, FakeTalkHub(), FakeSmsStore(), scope,
            Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test"),
            port = 1, lanAvailable = MutableStateFlow(false), lanWaitMs = 600)
        try {
            client.start()
            withTimeout(5000) { client.status.first { it is SyncStatus.Offline && it.reason == "Waiting for Wi-Fi or Ethernet" } }
            delay(200)
            assertEquals("still inside the wait", SyncStatus.Offline("PC", "Waiting for Wi-Fi or Ethernet"), client.status.value)
            val tried = withTimeout(5000) { client.status.first { it is SyncStatus.Connecting || (it is SyncStatus.Offline && it.reason != "Waiting for Wi-Fi or Ethernet") } }
            assertTrue("attempted without LAN: $tried", tried is SyncStatus.Connecting || tried is SyncStatus.Offline)
        } finally { scope.cancel(); SyncSettings(context).clear() }
        Unit
    }

    /**
     * A PC that welcomes a phone and hangs up soon after: each welcome is a time stamp. With [abort]
     * it drops the link without a TLS close (a reset, as when a laptop sleeps or leaves the hotspot),
     * so the phone's read fails instead of ending cleanly.
     */
    private class WelcomingPc(identity: Pkcs12Identity, private val abort: Boolean = false) : AutoCloseable {
        private val tls = javax.net.ssl.SSLContext.getInstance("TLSv1.3").apply { init(identity.keyManagers(), null, null) }.socketFactory
        private val server = java.net.ServerSocket(0)
        val port get() = server.localPort
        val welcomes = java.util.concurrent.LinkedBlockingQueue<Long>()

        init {
            Thread {
                while (!server.isClosed) {
                    val raw = runCatching { server.accept() }.getOrNull() ?: break
                    Thread {
                        runCatching {
                            val socket = (tls.createSocket(raw, null, raw.port, false) as javax.net.ssl.SSLSocket).apply { useClientMode = false }
                            socket.soTimeout = 1_000
                            val reader = socket.getInputStream().bufferedReader()
                            reader.readLine()
                            socket.getOutputStream().apply { write("{\"t\":\"welcome\",\"name\":\"PC\"}\n".toByteArray()); flush() }
                            welcomes.put(System.nanoTime())
                            Thread.sleep(150)
                            if (abort) {
                                raw.setSoLinger(true, 0)
                                raw.close()
                            } else {
                                socket.close()
                            }
                        }
                    }.apply { isDaemon = true }.start()
                }
            }.apply { isDaemon = true }.start()
        }

        fun next(): Long = welcomes.poll(30, java.util.concurrent.TimeUnit.SECONDS) ?: error("no connection to the PC")

        override fun close() = server.close()
    }

    @Test fun afterAConnectionWithoutLanTheNextReconnectDoesNotWaitForLanAgain() = reconnectsWithoutWaitingAgain(abort = false)

    @Test fun aDroppedHotspotLinkIsNotWaitedForEither() = reconnectsWithoutWaitingAgain(abort = true)

    @Test fun aWelcomedLinkThatResetsIsRetriedWithoutGrowingTheWait() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val pc = WelcomingPc(Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/impostor.p12")!!, "kainos-test"), abort = true)
        val pcFingerprint = Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/impostor.p12")!!, "kainos-test").fingerprint
        SyncSettings(context).save(PairedPc("127.0.0.1", pcFingerprint, "test", "PC"))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val client = SyncClient(context, FakeTalkHub(), FakeSmsStore(), scope,
            Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test"),
            port = pc.port, lanAvailable = MutableStateFlow(true), lanWaitMs = 3_000)
        try {
            client.start()
            var last = pc.next()
            repeat(3) {
                val next = pc.next()
                // Each session was welcomed, so each retry starts from the shortest wait (2 s), not 4, 8 s.
                assertTrue("wait grew after a welcomed session: ${(next - last) / 1_000_000} ms", (next - last) / 1_000_000 < 3_500)
                last = next
            }
        } finally { scope.cancel(); pc.close(); SyncSettings(context).clear() }
        Unit
    }

    private fun reconnectsWithoutWaitingAgain(abort: Boolean) = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val pc = WelcomingPc(Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/impostor.p12")!!, "kainos-test"), abort)
        val pcFingerprint = Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/impostor.p12")!!, "kainos-test").fingerprint
        SyncSettings(context).save(PairedPc("127.0.0.1", pcFingerprint, "test", "PC"))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val network = MutableStateFlow(false)
        val client = SyncClient(context, FakeTalkHub(), FakeSmsStore(), scope,
            Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test"),
            port = pc.port, lanAvailable = network, lanWaitMs = 3_000)
        fun gapMs(from: Long, to: Long) = (to - from) / 1_000_000
        try {
            client.start()
            val first = pc.next() // after the 3 s wait: no LAN, so it tried anyway
            val second = pc.next()
            assertTrue("no second wait for LAN: ${gapMs(first, second)} ms", gapMs(first, second) < 4_000)
            network.value = true
            val third = pc.next() // a connection over LAN: the wait comes back for the next drop
            network.value = false
            val fourth = pc.next()
            assertTrue("waited for LAN again: ${gapMs(third, fourth)} ms", gapMs(third, fourth) > 4_500)
        } finally { scope.cancel(); pc.close(); SyncSettings(context).clear() }
        Unit
    }
}
