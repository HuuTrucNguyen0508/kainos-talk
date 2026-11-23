package app.kainos.talk.sync

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncTransferTest {
    private fun identity(name: String) =
        Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/$name")!!, "kainos-test")

    private class FakePcConnection(
        private val raw: java.net.Socket,
        private val socket: SSLSocket,
    ) {
        private val incoming = LinkedBlockingQueue<String>()
        private val writer = socket.outputStream.bufferedWriter(Charsets.UTF_8)

        init {
            Thread {
                runCatching {
                    socket.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { incoming.put(it) }
                }
            }.apply { isDaemon = true }.start()
        }

        @Synchronized
        fun send(line: String) {
            writer.write(line)
            writer.write("\n")
            writer.flush()
        }

        fun nextFrame(timeoutSec: Long = 10, predicate: (JSONObject) -> Boolean = { true }): JSONObject {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec)
            while (true) {
                val leftMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                check(leftMs > 0) { "timed out waiting for frame from phone" }
                val line = incoming.poll(leftMs, TimeUnit.MILLISECONDS) ?: continue
                val obj = JSONObject(line)
                if (predicate(obj)) return obj
            }
        }

        fun pollFrame(timeoutMs: Long = 250): JSONObject? =
            incoming.poll(timeoutMs, TimeUnit.MILLISECONDS)?.let(::JSONObject)

        fun dropHard() {
            runCatching { raw.setSoLinger(true, 0) }
            runCatching { raw.close() }
        }

        fun close() {
            runCatching { socket.close() }
            runCatching { raw.close() }
        }
    }

    private class FakePcServer(identity: Pkcs12Identity) : AutoCloseable {
        private val tls = SSLContext.getInstance("TLSv1.3").apply { init(identity.keyManagers(), null, null) }.socketFactory
        private val server = ServerSocket(0)
        val port get() = server.localPort
        private val connections = LinkedBlockingQueue<FakePcConnection>()

        init {
            Thread {
                while (!server.isClosed) {
                    val raw = runCatching { server.accept() }.getOrNull() ?: break
                    Thread {
                        runCatching {
                            val socket = (tls.createSocket(raw, null, raw.port, false) as SSLSocket).apply { useClientMode = false }
                            val conn = FakePcConnection(raw, socket)
                            val hello = conn.nextFrame { it.getString("t") == "hello" }
                            assertEquals(SyncProtocol.VERSION, hello.getInt("v"))
                            conn.send("""{"t":"welcome","name":"Test PC"}""")
                            connections.put(conn)
                        }
                    }.apply { isDaemon = true }.start()
                }
            }.apply { isDaemon = true }.start()
        }

        fun awaitConnection(timeoutSec: Long = 15): FakePcConnection =
            connections.poll(timeoutSec, TimeUnit.SECONDS) ?: error("phone did not connect")

        override fun close() {
            runCatching { server.close() }
            while (true) connections.poll()?.close() ?: break
        }
    }

    private class MemoryIncomingSink : IncomingFileSink {
        val committed = CopyOnWriteArrayList<Pair<SavedFile, ByteArray>>()
        val abortedNames = CopyOnWriteArrayList<String>()
        private val activeHandles = CopyOnWriteArrayList<String>()

        val openCount: Int get() = activeHandles.size

        override fun create(name: String, mime: String?): IncomingFileHandle {
            val chosen = uniqueFileName(name) { candidate -> committed.any { it.first.displayName == candidate } }
            activeHandles.add(chosen)
            val buffer = ByteArrayOutputStream()
            return object : IncomingFileHandle {
                override val output: OutputStream = buffer
                private var done = false

                override fun commit(): SavedFile {
                    done = true
                    activeHandles.remove(chosen)
                    val saved = SavedFile(Uri.parse("content://downloads/public_downloads/${committed.size + 1}"), chosen, mime)
                    committed.add(saved to buffer.toByteArray())
                    return saved
                }

                override fun abort() {
                    if (done) return
                    done = true
                    activeHandles.remove(chosen)
                    abortedNames.add(chosen)
                }
            }
        }
    }

    private fun testBytes(size: Int, seed: Int = 7): ByteArray =
        ByteArray(size) { i -> ((i * 31 + seed) and 0xFF).toByte() }

    private fun newClient(
        context: Context,
        pcPort: Int,
        pcFingerprint: String,
        scope: CoroutineScope,
        clipboard: ClipboardBridge = ClipboardBridge {},
        outgoing: OutgoingFileSource = OutgoingFileSource { null },
        incoming: IncomingFileSink = MemoryIncomingSink(),
        notifier: FileNotifier = FileNotifier {},
    ): SyncClient {
        SyncSettings(context).save(PairedPc("127.0.0.1", pcFingerprint, "phone-1", "Test PC"))
        return SyncClient(
            context = context,
            hub = FakeTalkHub(),
            sms = FakeSmsStore(),
            scope = scope,
            identity = identity("phone.p12"),
            port = pcPort,
            lanAvailable = MutableStateFlow(true),
            clipboard = clipboard,
            outgoingFiles = outgoing,
            incomingFiles = incoming,
            fileNotifier = notifier,
        )
    }

    @Test
    fun sendsMultiChunkFileThenEmptyFileSequentiallyWaitingForFileResult() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val big = testBytes(600_000, seed = 13)
        val uri1 = Uri.parse("content://test/big.bin")
        val uri2 = Uri.parse("content://test/empty.txt")
        val files = mapOf(
            uri1 to Triple("big.bin", big, "application/octet-stream"),
            uri2 to Triple("empty.txt", ByteArray(0), "text/plain"),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePcServer(pcIdentity).use { server ->
            val client = newClient(
                context, server.port, pcIdentity.fingerprint, scope,
                outgoing = OutgoingFileSource { uri ->
                    files[uri]?.let { (name, bytes, mime) ->
                        OutgoingFile(name, bytes.size.toLong(), mime, ByteArrayInputStream(bytes))
                    }
                },
            )
            try {
                client.start()
                val conn = server.awaitConnection()
                withTimeout(5_000) { client.status.first { it is SyncStatus.Connected } }

                assertEquals(OutboxResult.QUEUED, client.shareFiles(listOf(uri1, uri2)))

                val offer1 = conn.nextFrame { it.getString("t") == "fileOffer" }
                val id1 = offer1.getString("id")
                assertEquals("big.bin", offer1.getString("name"))
                assertEquals(600_000L, offer1.getLong("size"))
                assertEquals("application/octet-stream", offer1.getString("mime"))

                val received = ByteArrayOutputStream()
                val chunkSizes = mutableListOf<Int>()
                while (true) {
                    val frame = conn.nextFrame { it.getString("t") in setOf("fileChunk", "fileEnd", "fileOffer") }
                    if (frame.getString("t") == "fileEnd") {
                        assertEquals(id1, frame.getString("id"))
                        break
                    }
                    assertEquals("fileChunk", frame.getString("t"))
                    assertEquals(id1, frame.getString("id"))
                    val decoded = Base64.getDecoder().decode(frame.getString("data"))
                    chunkSizes += decoded.size
                    received.write(decoded)
                }
                assertEquals(listOf(262_144, 262_144, 75_712), chunkSizes)
                assertArrayEquals(big, received.toByteArray())

                // Second file must wait until the PC answers with fileResult for the first.
                val premature = conn.pollFrame(300)
                assertTrue("second file offered before fileResult: $premature", premature == null || premature.getString("t") != "fileOffer")

                conn.send(SyncProtocol.fileResult(id1, null))

                val offer2 = conn.nextFrame { it.getString("t") == "fileOffer" }
                val id2 = offer2.getString("id")
                assertEquals("empty.txt", offer2.getString("name"))
                assertEquals(0L, offer2.getLong("size"))
                val end2 = conn.nextFrame { it.getString("t") == "fileEnd" }
                assertEquals(id2, end2.getString("id"))
                conn.send(SyncProtocol.fileResult(id2, null))
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun receivesMultiChunkFileSavesToDownloadsAvoidsCollisionAndNotifies() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val payload = testBytes(600_000, seed = 42)
        val sink = MemoryIncomingSink()
        val notified = CopyOnWriteArrayList<SavedFile>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePcServer(pcIdentity).use { server ->
            val client = newClient(
                context, server.port, pcIdentity.fingerprint, scope,
                incoming = sink,
                notifier = FileNotifier { notified.add(it) },
            )
            try {
                client.start()
                val conn = server.awaitConnection()
                withTimeout(5_000) { client.status.first { it is SyncStatus.Connected } }

                conn.send(SyncProtocol.fileOffer("f1", "../../dir/Photo été 🌞.bin", payload.size.toLong(), "application/octet-stream"))
                var offset = 0
                while (offset < payload.size) {
                    val end = minOf(offset + SyncProtocol.MAX_CHUNK_BYTES, payload.size)
                    conn.send(SyncProtocol.fileChunk("f1", payload.copyOfRange(offset, end)))
                    offset = end
                }
                conn.send(SyncProtocol.fileEnd("f1"))

                val result1 = conn.nextFrame { it.getString("t") == "fileResult" }
                assertEquals("f1", result1.getString("id"))
                assertTrue(result1.getBoolean("ok"))
                assertTrue(result1.isNull("error"))

                assertEquals(1, sink.committed.size)
                assertEquals(0, sink.openCount)
                assertEquals("Photo été 🌞.bin", sink.committed[0].first.displayName)
                assertArrayEquals(payload, sink.committed[0].second)
                assertEquals(listOf(sink.committed[0].first), notified)

                // Sending the same name again never overwrites the first file.
                conn.send(SyncProtocol.fileOffer("f2", "Photo été 🌞.bin", 3L, "application/octet-stream"))
                conn.send(SyncProtocol.fileChunk("f2", byteArrayOf(1, 2, 3)))
                conn.send(SyncProtocol.fileEnd("f2"))
                val result2 = conn.nextFrame { it.getString("t") == "fileResult" && it.getString("id") == "f2" }
                assertTrue(result2.getBoolean("ok"))
                assertEquals(2, sink.committed.size)
                assertEquals("Photo été 🌞 (1).bin", sink.committed[1].first.displayName)
                assertArrayEquals(payload, sink.committed[0].second)
                assertArrayEquals(byteArrayOf(1, 2, 3), sink.committed[1].second)
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun droppedConnectionDeletesPartialIncomingAndDoesNotResumeOutgoing() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val sink = MemoryIncomingSink()
        val big = testBytes(600_000, seed = 99)
        val uri = Uri.parse("content://test/resume.bin")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePcServer(pcIdentity).use { server ->
            val client = newClient(
                context, server.port, pcIdentity.fingerprint, scope,
                outgoing = OutgoingFileSource { OutgoingFile("resume.bin", big.size.toLong(), null, ByteArrayInputStream(big)) },
                incoming = sink,
            )
            try {
                client.start()
                val conn1 = server.awaitConnection()
                withTimeout(5_000) { client.status.first { it is SyncStatus.Connected } }

                // Incoming file interrupted by a dropped socket -> pending file is deleted.
                conn1.send(SyncProtocol.fileOffer("in1", "half.bin", 500_000L, null))
                conn1.send(SyncProtocol.fileChunk("in1", testBytes(262_144)))
                withTimeout(5_000) { while (sink.openCount == 0) delay(10) }
                // Also queue an outgoing file so it starts right before the drop.
                assertEquals(OutboxResult.QUEUED, client.shareFiles(listOf(uri)))
                conn1.nextFrame { it.getString("t") == "fileOffer" }
                conn1.nextFrame { it.getString("t") == "fileChunk" }
                conn1.dropHard()

                val conn2 = server.awaitConnection()
                withTimeout(5_000) { client.status.first { it is SyncStatus.Connected } }
                assertEquals(0, sink.committed.size)
                assertEquals(0, sink.openCount)
                assertEquals(listOf("half.bin"), sink.abortedNames)

                // Reconnected session must NOT resume the dropped outgoing file.
                conn2.send("""{"t":"ping"}""")
                val pong = conn2.nextFrame { it.getString("t") == "pong" || it.getString("t") == "fileOffer" || it.getString("t") == "fileChunk" }
                assertEquals("pong", pong.getString("t"))
                val extra = conn2.pollFrame(300)
                assertTrue("dropped transfer resumed after reconnect: $extra", extra == null || extra.getString("t") !in setOf("fileOffer", "fileChunk", "fileEnd"))
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun fileCancelSupersededOfferAndSizeMismatchCleanUpPartialFiles() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val sink = MemoryIncomingSink()
        val big = testBytes(600_000, seed = 5)
        val uri1 = Uri.parse("content://test/cancel-me.bin")
        val uri2 = Uri.parse("content://test/after-cancel.txt")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePcServer(pcIdentity).use { server ->
            val client = newClient(
                context, server.port, pcIdentity.fingerprint, scope,
                outgoing = OutgoingFileSource { uri ->
                    when (uri) {
                        uri1 -> OutgoingFile("cancel-me.bin", big.size.toLong(), null, ByteArrayInputStream(big))
                        uri2 -> OutgoingFile("after-cancel.txt", 2L, "text/plain", ByteArrayInputStream(byteArrayOf(65, 66)))
                        else -> null
                    }
                },
                incoming = sink,
            )
            try {
                client.start()
                val conn = server.awaitConnection()
                withTimeout(5_000) { client.status.first { it is SyncStatus.Connected } }

                // 1. Superseded offer discards the previous open incoming file.
                conn.send(SyncProtocol.fileOffer("old", "old.bin", 100L, null))
                conn.send(SyncProtocol.fileChunk("old", ByteArray(20)))
                conn.send(SyncProtocol.fileOffer("new", "new.txt", 3L, "text/plain"))
                conn.send(SyncProtocol.fileChunk("new", "ok!".toByteArray()))
                conn.send(SyncProtocol.fileEnd("new"))
                val okRes = conn.nextFrame { it.getString("t") == "fileResult" && it.getString("id") == "new" }
                assertTrue(okRes.getBoolean("ok"))
                assertTrue("old.bin" in sink.abortedNames)
                assertEquals(listOf("new.txt"), sink.committed.map { it.first.displayName })

                // 2. fileCancel deletes the partial incoming file.
                conn.send(SyncProtocol.fileOffer("c1", "cancelled.bin", 100L, null))
                conn.send(SyncProtocol.fileChunk("c1", ByteArray(10)))
                conn.send(SyncProtocol.fileCancel("c1"))

                // 3. Size mismatch deletes the partial incoming file and replies ok=false.
                conn.send(SyncProtocol.fileOffer("bad", "short.bin", 100L, null))
                conn.send(SyncProtocol.fileChunk("bad", ByteArray(10)))
                conn.send(SyncProtocol.fileEnd("bad"))
                val badRes = conn.nextFrame { it.getString("t") == "fileResult" && it.getString("id") == "bad" }
                assertFalse(badRes.getBoolean("ok"))
                assertEquals("size mismatch", badRes.getString("error"))
                assertTrue("cancelled.bin" in sink.abortedNames)
                assertTrue("short.bin" in sink.abortedNames)
                assertEquals(0, sink.openCount)

                // 4. Outgoing file cancelled by PC stops and moves on to the second file.
                assertEquals(OutboxResult.QUEUED, client.shareFiles(listOf(uri1, uri2)))
                val out1 = conn.nextFrame { it.getString("t") == "fileOffer" }
                conn.send(SyncProtocol.fileCancel(out1.getString("id")))
                val out2 = conn.nextFrame { it.getString("t") == "fileOffer" && it.getString("name") == "after-cancel.txt" }
                val end2 = conn.nextFrame { it.getString("t") == "fileEnd" && it.getString("id") == out2.getString("id") }
                assertEquals(out2.getString("id"), end2.getString("id"))
                conn.send(SyncProtocol.fileResult(out2.getString("id"), null))
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }

    @Test
    fun clipEchoSuppressionShareTextAndDisconnectedOutbox() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pcIdentity = identity("impostor.p12")
        val clipboardWrites = CopyOnWriteArrayList<String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        FakePcServer(pcIdentity).use { server ->
            val client = newClient(
                context, server.port, pcIdentity.fingerprint, scope,
                clipboard = ClipboardBridge { clipboardWrites.add(it) },
            )
            try {
                // Disconnected: nothing is queued.
                assertFalse(client.isConnected)
                assertEquals(OutboxResult.NOT_CONNECTED, client.sendClip("while offline"))
                assertEquals(OutboxResult.NOT_CONNECTED, client.shareText("https://offline.example"))
                assertEquals(OutboxResult.NOT_CONNECTED, client.shareFiles(listOf(Uri.parse("content://test/a"))))

                client.start()
                val conn = server.awaitConnection()
                withTimeout(5_000) { client.status.first { it is SyncStatus.Connected } }
                assertTrue(client.isConnected)

                // Incoming clip updates phone clipboard and suppresses echo back to PC.
                conn.send(SyncProtocol.clip("copied on pc"))
                withTimeout(5_000) {
                    while (clipboardWrites.isEmpty()) delay(10)
                }
                assertEquals(listOf("copied on pc"), clipboardWrites)
                assertEquals(OutboxResult.UNCHANGED, client.sendClip("copied on pc"))

                // Different clip text and shared text go through cleanly.
                assertEquals(OutboxResult.QUEUED, client.sendClip("copied on phone"))
                assertEquals(OutboxResult.QUEUED, client.shareText("https://example.com/watch?v=42"))

                val clipFrame = conn.nextFrame { it.getString("t") == "clip" }
                assertEquals("copied on phone", clipFrame.getString("text"))

                val shareFrame = conn.nextFrame { it.getString("t") == "shareText" }
                assertEquals("https://example.com/watch?v=42", shareFrame.getString("text"))
            } finally {
                scope.cancel()
                SyncSettings(context).clear()
            }
        }
    }
}
