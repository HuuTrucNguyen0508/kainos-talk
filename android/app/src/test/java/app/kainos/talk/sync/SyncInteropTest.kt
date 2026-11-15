package app.kainos.talk.sync

import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.hub.ChatCapabilities
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The phone's real SyncClient against the PC's real sync server (desktop/src/main/sms-sync.ts,
 * run with Node through desktop/test/sync-server-fixture.ts): pairing, texts, a reply, a read.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncInteropTest {
    private val desktop = File("../../desktop").canonicalFile
    private val port = 49_600 + (Math.random() * 300).toInt()
    private lateinit var server: Process
    private val lines = LinkedBlockingQueue<String>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Before
    fun startServer() {
        val node = listOf("/usr/bin/node", "/usr/local/bin/node").firstOrNull { File(it).canExecute() }
        assumeTrue("needs Node to run the desktop's sync server", node != null)
        val dir = Files.createTempDirectory("kainos-interop").toFile()
        server = ProcessBuilder(node, "test/sync-server-fixture.ts", port.toString(), dir.path)
            .directory(desktop)
            .redirectErrorStream(true)
            .start()
        Thread { server.inputStream.bufferedReader().forEachLine { lines.put(it) } }.apply { isDaemon = true }.start()
        await("server ready") { it == "ready" }
    }

    @After
    fun stop() {
        scope.cancel()
        if (::server.isInitialized) server.destroy()
    }

    private fun command(line: String) {
        server.outputStream.write("$line\n".toByteArray())
        server.outputStream.flush()
    }

    /** The next server line that matches, within 10 s. */
    private fun await(what: String, match: (String) -> Boolean): String {
        val end = System.currentTimeMillis() + 10_000
        while (true) {
            val left = end - System.currentTimeMillis()
            check(left > 0) { "timed out waiting for $what" }
            val line = lines.poll(left, TimeUnit.MILLISECONDS) ?: continue
            if (match(line)) return line
        }
    }

    private fun awaitState(what: String, match: (JSONObject) -> Boolean): JSONObject =
        JSONObject(await(what) { it.startsWith("state ") && match(JSONObject(it.removePrefix("state "))) }.removePrefix("state "))

    /** Frames and bytes the phone sent the PC since the last call (from the fixture). */
    private fun traffic(): JSONObject {
        command("traffic")
        return JSONObject(await("traffic") { it.startsWith("traffic ") }.removePrefix("traffic "))
    }

    private fun JSONObject.frames(type: String) = getJSONObject("in").optInt(type)

    /** The PC ends the connection; [whileAway] runs once the phone is off, then it reconnects. */
    private fun reconnect(whileAway: () -> Unit = {}) {
        command("drop")
        awaitState("the phone to drop") { it.optJSONObject("phone")?.optBoolean("connected") == false }
        Thread.sleep(300)
        traffic()
        whileAway()
        awaitState("the phone to reconnect") { it.optJSONObject("phone")?.optBoolean("connected") == true }
        Thread.sleep(1_000)
    }

    private fun JSONObject.conversation(key: String): JSONObject? {
        val all = getJSONArray("conversations")
        return (0 until all.length()).map { all.getJSONObject(it) }.firstOrNull { it.getString("key") == key }
    }

    private fun identity(name: String) = Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/$name")!!, "kainos-test")

    private fun hub() = FakeTalkHub(now = { 2_000L }).apply {
        val wa = "whatsapp|0|s:allot"
        val halden = "protonmail|0|halden"
        mails.value = mapOf(
            halden to app.kainos.talk.hub.MailItem(
                halden, Source.PROTON_MAIL, "acct", "me@proton.me", "Halden Housing Co-op", false, "Minutes", 1_500L, false, null, true,
                listOf(app.kainos.talk.hub.AvailableMailAction(app.kainos.talk.core.MailAction.ARCHIVE, "Archive")), Shape.EXPECTED,
            ),
        )
        val key = "sms|0|s:mum"
        chats.value = listOf(
            InboxItem.Chat(key, Source.SMS, "Mum", false, 1_000L, 1, false, "Dinner on Sunday?", "Mum", false, null, notificationLive = true),
            InboxItem.Chat(wa, Source.WHATSAPP, "Allotment crew", true, 900L, 1, false, "Shed key?", "Odile", false, null, notificationLive = true),
        )
        val waThread = ChatThread(
            wa, Source.WHATSAPP, "Allotment crew", isGroup = true, muted = false, shape = Shape.MESSAGING_STYLE,
            messages = listOf(ThreadMessage(7, "Odile", "Shed key?", 900L, outgoing = false, status = MessageStatus.INCOMING, media = null, read = false)),
            capabilities = ChatCapabilities(canReply = true, replyBlocked = null, canMarkReadInApp = false),
            notificationRemovedReason = null,
        )
        threads.value = mapOf(
            wa to waThread,
            key to ChatThread(
                key, Source.SMS, "Mum", isGroup = false, muted = false, shape = Shape.MESSAGING_STYLE,
                messages = listOf(ThreadMessage(1, "Mum", "Dinner on Sunday?", 1_000L, outgoing = false, status = MessageStatus.INCOMING, media = null, read = false)),
                capabilities = ChatCapabilities(canReply = true, replyBlocked = null, canMarkReadInApp = false),
                notificationRemovedReason = null,
            ),
        )
    }

    @Test
    fun pairsSyncsTextsAndCarriesRepliesAndReads() = runBlocking {
        val hub = hub()
        val store = FakeSmsStore().apply { images["mms-part:1"] = byteArrayOf(-1, -40, -1) }
        val client = SyncClient(ApplicationProvider.getApplicationContext(), hub, store, scope, identity("phone.p12"), port, lanAvailable = kotlinx.coroutines.flow.flowOf(true))
        val impostor = client.pairAt(listOf("127.0.0.1"), expectedFingerprint = "00".repeat(32), name = "Test PC") {}
        assertEquals("a PC whose certificate differs from its mDNS record is refused", true, impostor is PairResult.Failed)
        val phoneCode = java.util.concurrent.atomic.AtomicReference("")
        val pairing = scope.async { client.pairAt(listOf("172.31.255.254", "127.0.0.1"), expectedFingerprint = null, name = "Test PC") { phoneCode.set(it) } }
        val asking = awaitState("a pairing request") { !it.isNull("pairing") }
        val codeBy = System.currentTimeMillis() + 5_000
        while (phoneCode.get().isEmpty() && System.currentTimeMillis() < codeBy) Thread.sleep(20)
        assertEquals("both screens show the same code", asking.getJSONObject("pairing").getString("code"), phoneCode.get())
        command("accept")
        awaitState("the PC's Connect") { it.optJSONObject("pairing")?.optBoolean("pcAccepted") == true }
        assertEquals("not paired until the phone confirms too", true, client.status.value is SyncStatus.NotPaired)
        client.confirmCode(true)
        assertEquals(PairResult.Paired, withTimeout(10_000) { pairing.await() })

        val synced = awaitState("the phone's texts") { s ->
            s.optJSONObject("phone")?.optBoolean("connected") == true && s.conversation("sms|0|s:mum") != null
        }
        val mum = synced.conversation("sms|0|s:mum")!!
        assertEquals("Mum", mum.getString("title"))
        assertEquals(1, mum.getInt("unread"))
        assertEquals("Dinner on Sunday?", mum.getJSONArray("messages").getJSONObject(0).getString("text"))

        // Protocol 4: a reconnect sends only what the PC does not hold already.
        awaitState("the whole inbox") { s -> s.getJSONArray("conversations").length() == 2 && s.getJSONArray("mails").length() == 1 }
        Thread.sleep(500)
        val firstSync = traffic()
        println("traffic first connection: $firstSync")
        assertEquals(2, firstSync.frames("conversation"))
        reconnect()
        val unchanged = traffic()
        println("traffic reconnect, nothing changed: $unchanged")
        assertEquals("nothing changed: no conversation is sent again", 0, unchanged.frames("conversation"))
        assertEquals(0, unchanged.frames("mail"))
        assertEquals(0, unchanged.frames("removed"))
        reconnect {
            // While the phone is away, a message comes in on WhatsApp.
            val allot = hub.threads.value.getValue("whatsapp|0|s:allot")
            hub.threads.value += "whatsapp|0|s:allot" to allot.copy(messages = allot.messages + allot.messages[0].copy(id = 8, text = "Found it", timeMs = 950L))
        }
        val oneChange = traffic()
        println("traffic reconnect, one conversation changed: $oneChange")
        assertEquals("one conversation changed: only it is sent", 1, oneChange.frames("conversation"))
        assertEquals(0, oneChange.frames("mail"))
        command("state")
        awaitState("the new WhatsApp message") { s -> s.conversation("whatsapp|0|s:allot")?.getJSONArray("messages")?.length() == 2 }

        command("reply sms|0|s:mum Yes, at 7")
        await("the reply to be sent") { it == "replied true" }
        val replied = awaitState("the sent reply") { s ->
            val messages = s.conversation("sms|0|s:mum")?.getJSONArray("messages")
            messages != null && messages.length() == 2 && s.getJSONArray("sending").length() == 0
        }
        val last = replied.conversation("sms|0|s:mum")!!.getJSONArray("messages").getJSONObject(1)
        assertEquals(listOf("sms|0|s:mum" to "Yes, at 7"), hub.sentReplies)
        assertEquals("Yes, at 7", last.getString("text"))
        assertEquals("sent", last.getString("status"))

        command("read sms|0|s:mum")
        val end = System.currentTimeMillis() + 5_000
        while (hub.readKeys.isEmpty() && System.currentTimeMillis() < end) Thread.sleep(20)
        assertEquals(listOf("sms|0|s:mum"), hub.readKeys)
        assertEquals(SyncStatus.Connected::class, client.status.value::class)

        // Protocol 3: other apps' chats and mail travel too, and mail actions come back.
        val chatsAndMail = awaitState("WhatsApp and mail") { s ->
            s.getJSONArray("mails").length() == 1 &&
                (0 until s.getJSONArray("conversations").length()).any { s.getJSONArray("conversations").getJSONObject(it).getString("source") == "whatsapp" }
        }
        assertEquals("Halden Housing Co-op", chatsAndMail.getJSONArray("mails").getJSONObject(0).getString("sender"))
        command("mail protonmail|0|halden archive")
        await("the mail action to be sent") { it == "mailed true" }
        val until2 = System.currentTimeMillis() + 5_000
        while (hub.requestedMailActions.isEmpty() && System.currentTimeMillis() < until2) Thread.sleep(20)
        assertEquals(listOf("protonmail|0|halden" to app.kainos.talk.core.MailAction.ARCHIVE), hub.requestedMailActions)

        command("image mms-part:1")
        assertEquals("image data:image/jpeg;base64,/9j/", await("the picture") { it.startsWith("image ") })
        command("image mms-part:9")
        assertEquals("image null", await("a missing picture") { it.startsWith("image ") })

        // Without SMS access (none is granted here) a new text is refused by the phone, and the PC says so.
        command("send +33612345678 Hello")
        await("the new text to be handed to the phone") { it == "sent true" }
        awaitState("the phone's refusal") { s -> s.getJSONObject("newText").optString("failure") == "no permission to send texts" }

        // Another device with its own certificate cannot take the phone's place, even with its id.
        // Same app storage, so the same device id and PC pin; only the certificate differs.
        val stranger = SyncClient(ApplicationProvider.getApplicationContext(), hub, store, scope, identity("impostor.p12"), port, lanAvailable = kotlinx.coroutines.flow.flowOf(true))
        stranger.start()
        val until = System.currentTimeMillis() + 10_000
        while (stranger.status.value !is SyncStatus.Refused && System.currentTimeMillis() < until) Thread.sleep(50)
        assertEquals(SyncStatus.Refused::class, stranger.status.value::class)
        assertEquals("the real phone stays connected", SyncStatus.Connected::class, client.status.value::class)
        client.forget()
        awaitState("the phone to disconnect") { it.optJSONObject("phone")?.optBoolean("connected") == false }
        assertEquals(SyncStatus.NotPaired, client.status.value)
        command("quit")
    }
}
