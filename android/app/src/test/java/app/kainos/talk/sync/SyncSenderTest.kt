package app.kainos.talk.sync

import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.InboxChat
import app.kainos.talk.hub.SmsAwareHub
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The classification survives the hub: the line sent to the PC says what the inbox decided. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncSenderTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun tearDown() = scope.cancel()

    private fun sms(thread: Long, title: String, number: String, sender: SenderKind, isGroup: Boolean = false) = SyncConversation(
        key = SmsInbox.keyFor(thread),
        title = title,
        isGroup = isGroup,
        unread = 1,
        lastActivityMs = 1_000L + thread,
        canReply = !isGroup,
        messages = listOf(SyncMessage("sms:$thread", title, "text", 1_000L + thread, false, "incoming", null)),
        numbers = listOf(number),
        sender = sender,
    )

    @Test
    fun theSenderKindReachesTheFrameLineForInboxAndNotifiedConversations() = runBlocking {
        val rcs = "sms|rcs"
        val base = FakeTalkHub().apply {
            chats.value = listOf(InboxChat(rcs, "Léa", false, 500L, 1, "salut", "Léa"))
            threads.value = mapOf(rcs to ChatThread(rcs, "Léa", false, listOf(ThreadMessage(1, "Léa", "salut", 500L, false, MessageStatus.INCOMING, null, false)), canReply = true))
        }
        val store = FakeSmsStore(
            listOf(
                sms(1, "36679", "36679", SenderKind.SERVICE),
                sms(2, "Maman", "+33612345678", SenderKind.PERSON),
                sms(3, "StripeLink, Sam", "StripeLink", SenderKind.PERSON, isGroup = true),
            ),
        )
        val hub = SmsAwareHub(base, store, scope)
        val client = SyncClient(ApplicationProvider.getApplicationContext(), hub, store, scope, Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test"))
        val lines = Channel<String>(Channel.UNLIMITED)
        scope.launch { client.syncConversations { lines.send(it) } }
        val senders = (1..4).map { JSONObject(withTimeout(5_000) { lines.receive() }).getJSONObject("conversation") }
            .associate { it.getString("key") to it.getString("sender") }
        assertEquals(
            mapOf(SmsInbox.keyFor(1) to "service", SmsInbox.keyFor(2) to "person", SmsInbox.keyFor(3) to "person", rcs to "person"),
            senders,
        )
    }
}
