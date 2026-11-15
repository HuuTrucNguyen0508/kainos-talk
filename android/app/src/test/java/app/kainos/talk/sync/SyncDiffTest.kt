package app.kainos.talk.sync

import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.hub.ChatCapabilities
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

/** What the phone sends the PC as the inbox changes: each change once, and nothing it already has. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncDiffTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun tearDown() = scope.cancel()

    private val mum = "sms|0|s:mum"
    private val wa = "whatsapp|0|s:allot"
    private val reply = ThreadMessage(1, null, "Yes, at 7", 800L, outgoing = true, status = MessageStatus.SENDING, media = null, read = true)
    private val question = ThreadMessage(2, "Mum", "Dinner on Sunday?", 1_000L, outgoing = false, status = MessageStatus.INCOMING, media = null, read = false)

    private fun thread(key: String, messages: List<ThreadMessage>) = ChatThread(
        key, Source.SMS, key, isGroup = false, muted = false, shape = Shape.MESSAGING_STYLE, messages = messages,
        capabilities = ChatCapabilities(canReply = true, replyBlocked = null, canMarkReadInApp = false), notificationRemovedReason = null,
    )

    private fun chat(key: String, timeMs: Long) = InboxItem.Chat(key, Source.SMS, key, false, timeMs, 1, false, "…", null, false, null, notificationLive = true)

    @Test
    fun sendsOnlyWhatChangedAndResubscribesOnlyForNewConversations() = runBlocking {
        val fake = FakeTalkHub().apply {
            chats.value = listOf(chat(mum, 1_000L), chat(wa, 900L))
            threads.value = mapOf(mum to thread(mum, listOf(reply, question)), wa to thread(wa, listOf(question.copy(id = 7, timeMs = 900L))))
        }
        val subscriptions = AtomicInteger()
        val hub = object : TalkHub by fake {
            override fun thread(conversationKey: String, limit: Int): Flow<ChatThread?> =
                fake.thread(conversationKey, limit).onStart { subscriptions.incrementAndGet() }
        }
        val client = SyncClient(ApplicationProvider.getApplicationContext(), hub, FakeSmsStore(), scope, Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test"))
        val frames = Channel<JSONObject>(Channel.UNLIMITED)
        scope.launch { client.syncConversations { frames.send(JSONObject(it)) } }
        suspend fun next() = withTimeout(5_000) { frames.receive() }
        suspend fun nothingMore() = assertNull("nothing else is sent", withTimeoutOrNull(500) { frames.receive() })

        assertEquals(setOf(mum, wa), setOf(next(), next()).map { it.getJSONObject("conversation").getString("key") }.toSet())
        nothingMore()
        assertEquals(2, subscriptions.get())

        // An older message's status changes: the PC gets it.
        fake.threads.update { it + (mum to thread(mum, listOf(reply.copy(status = MessageStatus.CONFIRMED), question))) }
        val confirmed = next().getJSONObject("conversation")
        assertEquals(mum, confirmed.getString("key"))
        assertEquals("confirmed", confirmed.getJSONArray("messages").getJSONObject(0).getString("status"))
        nothingMore()

        // The list reorders: only the conversation that changed is sent, and no flow is resubscribed.
        fake.chats.value = listOf(chat(wa, 1_100L), chat(mum, 1_000L))
        val moved = next().getJSONObject("conversation")
        assertEquals(wa to 1_100L, moved.getString("key") to moved.getLong("lastActivityMs"))
        nothingMore()
        assertEquals(2, subscriptions.get())

        // A picture saved later for a message: the PC gets its id.
        fake.threads.update { it + (wa to thread(wa, listOf(question.copy(id = 7, timeMs = 900L, imageId = "notif:abc")))) }
        assertEquals("notif:abc", next().getJSONObject("conversation").getJSONArray("messages").getJSONObject(0).getString("image"))
        nothingMore()

        // A conversation leaves the list: the PC is told, and the rest is not resent.
        fake.chats.value = listOf(chat(mum, 1_000L))
        val removed = next()
        assertEquals("removed" to wa, removed.getString("t") to removed.getString("key"))
        nothingMore()
    }

    @Test
    fun aReconnectSendsOnlyWhatThePcDoesNotHold() = runBlocking {
        val hub = FakeTalkHub().apply {
            chats.value = listOf(chat(mum, 1_000L), chat(wa, 900L))
            threads.value = mapOf(mum to thread(mum, listOf(reply, question)), wa to thread(wa, listOf(question.copy(id = 7, timeMs = 900L))))
        }
        val client = SyncClient(ApplicationProvider.getApplicationContext(), hub, FakeSmsStore(), scope, Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test"))
        suspend fun session(welcome: PcFrame.Welcome, count: Int): List<String> {
            val lines = Channel<String>(Channel.UNLIMITED)
            val job = scope.launch { client.syncConversations(welcome) { lines.send(it) } }
            val got = List(count) { withTimeout(5_000) { lines.receive() } }
            assertNull("nothing else is sent", withTimeoutOrNull(500) { lines.receive() })
            job.cancel()
            return got
        }
        val first = session(PcFrame.Welcome("PC"), 2).associateBy { JSONObject(it).getJSONObject("conversation").getString("key") }

        // While the phone was away, a message came in on WhatsApp; the PC still holds a chat the phone dropped.
        hub.threads.update { it + (wa to thread(wa, listOf(question.copy(id = 7, timeMs = 900L), question.copy(id = 8, text = "Found it", timeMs = 950L)))) }
        val held = mapOf(mum to SyncProtocol.frameHash(first.getValue(mum)), wa to SyncProtocol.frameHash(first.getValue(wa)), "sms|0|s:gone" to "0011223344556677")
        val second = session(PcFrame.Welcome("PC", held), 2).map(::JSONObject)
        val sentWa = second.single { it.getString("t") == "conversation" }.getJSONObject("conversation")
        assertEquals(wa, sentWa.getString("key"))
        assertEquals(2, sentWa.getJSONArray("messages").length())
        assertEquals("sms|0|s:gone", second.single { it.getString("t") == "removed" }.getString("key"))
    }
}
