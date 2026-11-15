package app.kainos.talk.sync

import app.kainos.talk.core.Source
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.hub.SmsAwareHub
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.runBlocking
import app.kainos.talk.hub.Inbox
import app.kainos.talk.hub.TalkHub
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class SmsMergeTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun tearDown() = scope.cancel()

    private fun inboxConversation(thread: Long, at: Long, vararg texts: Pair<String, Boolean>, number: String = "+33612345678") = SyncConversation(
        key = SmsInbox.keyFor(thread),
        title = "Garage",
        isGroup = false,
        unread = 1,
        lastActivityMs = at,
        canReply = true,
        messages = texts.mapIndexed { i, (text, outgoing) ->
            SyncMessage("sms:${thread * 100 + i}", if (outgoing) null else "Garage", text, at - 1_000L * (texts.size - 1 - i), outgoing, if (outgoing) "sent" else "incoming", null)
        },
        numbers = listOf(number),
    )

    private fun notified(key: String, at: Long, text: String, title: String = "Garage", live: Boolean = true) =
        InboxItem.Chat(key, Source.SMS, title, false, at, 1, false, text, title, false, null, notificationLive = live)

    private fun thread(key: String, title: String, text: String, at: Long, canReply: Boolean) = app.kainos.talk.hub.ChatThread(
        key, Source.SMS, title, isGroup = false, muted = false, shape = app.kainos.talk.core.Shape.MESSAGING_STYLE,
        messages = listOf(app.kainos.talk.hub.ThreadMessage(1, title, text, at, outgoing = false, status = MessageStatus.INCOMING, media = null, read = false)),
        capabilities = app.kainos.talk.hub.ChatCapabilities(canReply, if (canReply) null else app.kainos.talk.hub.ReplyFailure.NOTIFICATION_GONE, false),
        notificationRemovedReason = if (canReply) null else 8,
    )

    @Test
    fun everySmsConversationSharesOneReadOfTheNotifiedChats() = runBlocking {
        val fake = FakeTalkHub().apply {
            chats.value = listOf(notified("sms|0|s:168", 100_500, "Car ready"), notified("sms|0|s:mum", 200_000, "Sent over RCS", title = "Mum"))
            threads.value = mapOf(
                "sms|0|s:168" to thread("sms|0|s:168", "Garage", "Car ready", 100_500, canReply = true),
                "sms|0|s:mum" to thread("sms|0|s:mum", "Mum", "Sent over RCS", 200_000, canReply = true),
            )
        }
        val reads = AtomicInteger()
        val base = object : TalkHub by fake {
            override fun inbox(sourceIds: Set<String>?): Flow<Inbox> =
                fake.inbox(sourceIds).onStart { if (sourceIds == setOf(Source.SMS.id)) reads.incrementAndGet() }
        }
        val texts = (1L..5L).map { inboxConversation(it, 100_000 - it, "Text $it" to false, number = "+3361234567$it") }
        val hub = SmsAwareHub(base, FakeSmsStore(texts), scope)
        val threads = combine(texts.map { hub.thread(it.key) } + hub.thread("sms|0|s:mum")) { it.toList() }
        val (inbox, all) = combine(hub.inbox(), threads) { inbox, all -> inbox to all }.first()
        assertEquals(listOf("Text 1", "Text 2", "Text 3", "Text 4", "Text 5"), all.take(5).map { it!!.messages.single().text })
        assertEquals("Sent over RCS", all.last()!!.messages.single().text)
        assertEquals(7, inbox.items.size)
        assertEquals("the inbox and six conversations read the notified chats once", 1, reads.get())
    }

    @Test
    fun aTextInTheInboxAndInANotificationIsShownOnceFromTheInbox() = runBlocking {
        val base = FakeTalkHub().apply { chats.value = listOf(notified("sms|0|s:168", 100_500, "Car ready")) }
        val hub = SmsAwareHub(base, FakeSmsStore(listOf(inboxConversation(2, 100_000, "Car ready" to false))), scope)
        val items = hub.inbox().first().items
        assertEquals(listOf("sms|t:2"), items.map { it.key })
        assertEquals(1, hub.inbox().first().unreadBySource[Source.SMS.id])
    }

    @Test
    fun aChatOutsideTheSmsTableSuchAsRcsIsKept() = runBlocking {
        val base = FakeTalkHub().apply { chats.value = listOf(notified("sms|0|s:mum", 200_000, "Sent over RCS")) }
        val hub = SmsAwareHub(base, FakeSmsStore(listOf(inboxConversation(2, 100_000, "Car ready" to false))), scope)
        assertEquals(listOf("sms|0|s:mum", "sms|t:2"), hub.inbox().first().items.map { it.key })
    }

    @Test
    fun withoutInboxAccessTheHubIsUnchanged() = runBlocking {
        val base = FakeTalkHub().apply { chats.value = listOf(notified("sms|0|s:mum", 200_000, "Hi")) }
        val hub = SmsAwareHub(base, FakeSmsStore(), scope)
        assertEquals(base.inbox().first(), hub.inbox().first())
    }

    @Test
    fun aReplySentElsewhereShowsInTheThreadBecauseTheInboxHasIt() = runBlocking {
        val store = FakeSmsStore(listOf(inboxConversation(2, 100_000, "Car ready" to false)), canSend = true)
        val hub = SmsAwareHub(FakeTalkHub(), store, scope)
        // The same reply, whether typed on the PC, in Google Messages or here, lands in the inbox.
        store.conversations.value = listOf(inboxConversation(2, 130_000, "Car ready" to false, "On my way" to true))
        val thread = hub.thread("sms|t:2").first()!!
        assertEquals(listOf("Car ready", "On my way"), thread.messages.map { it.text })
        assertEquals(MessageStatus.CONFIRMED, thread.messages.last().status)
        assertTrue(thread.capabilities.canReply)
    }

    @Test
    fun repliesAndReadsOnInboxConversationsGoThroughTheInbox() = runBlocking {
        val store = FakeSmsStore(listOf(inboxConversation(2, 100_000, "Car ready" to false)), canSend = true)
        val base = FakeTalkHub()
        val hub = SmsAwareHub(base, store, scope)
        assertEquals(ReplyResult.Sent, hub.sendReply("sms|t:2", "On my way"))
        assertEquals(listOf("+33612345678" to "On my way"), store.sent)
        assertTrue(base.sentReplies.isEmpty())
        hub.markRead("sms|t:2")
        assertEquals(listOf("sms|t:2"), store.read)
        assertEquals(0, hub.inbox().first().unreadBySource[Source.SMS.id])
    }

    @Test
    fun anRcsChatIsFoldedIntoTheSameContactsSmsThreadByNumber() = runBlocking {
        val base = FakeTalkHub().apply {
            chats.value = listOf(notified("sms|0|s:rcs", 300_000, "Sent over RCS", title = "Sam, +33 6 39 98 01 23", live = false))
            threads.value = mapOf("sms|0|s:rcs" to thread("sms|0|s:rcs", "Sam, +33 6 39 98 01 23", "Sent over RCS", 300_000, canReply = false))
        }
        val store = FakeSmsStore(listOf(inboxConversation(9, 100_000, "Old SMS" to false, number = "0639980123")), canSend = true)
        val hub = SmsAwareHub(base, store, scope)
        val inbox = hub.inbox().first()
        assertEquals("one conversation for the contact", listOf("sms|t:9"), inbox.items.map { it.key })
        assertEquals("Sent over RCS", (inbox.items.single() as InboxItem.Chat).lastText)
        assertEquals(listOf("Old SMS", "Sent over RCS"), hub.thread("sms|t:9").first()!!.messages.map { it.text })
        assertEquals(ReplyResult.Sent, hub.sendReply("sms|t:9", "Got it"))
        assertEquals(listOf("0639980123" to "Got it"), store.sent)
    }

    @Test
    fun aChatWhoseNotificationIsGoneIsAnsweredBySms() = runBlocking {
        val base = FakeTalkHub().apply {
            chats.value = listOf(notified("sms|0|s:rcs", 300_000, "Hi", title = "Sam, +33639980123", live = false))
            threads.value = mapOf("sms|0|s:rcs" to thread("sms|0|s:rcs", "Sam, +33639980123", "Hi", 300_000, canReply = false))
        }
        val store = FakeSmsStore(listOf(inboxConversation(2, 100_000, "Car ready" to false)), canSend = true)
        val hub = SmsAwareHub(base, store, scope)
        assertTrue("it can be answered", hub.thread("sms|0|s:rcs").first()!!.capabilities.canReply)
        assertEquals(ReplyResult.Sent, hub.sendReply("sms|0|s:rcs", "On my way"))
        assertEquals(listOf("+33639980123" to "On my way"), store.sent)
        assertTrue("not through the dead notification", base.sentReplies.isEmpty())
    }

    @Test
    fun aLiveNotificationIsAnsweredThroughTheSmsAppSoRcsStaysRcs() = runBlocking {
        val base = FakeTalkHub().apply {
            chats.value = listOf(notified("sms|0|s:rcs", 300_000, "Hi", title = "Sam, +33639980123"))
            threads.value = mapOf("sms|0|s:rcs" to thread("sms|0|s:rcs", "Sam, +33639980123", "Hi", 300_000, canReply = true))
        }
        val store = FakeSmsStore(listOf(inboxConversation(2, 100_000, "Car ready" to false)), canSend = true)
        val hub = SmsAwareHub(base, store, scope)
        assertEquals(ReplyResult.Sent, hub.sendReply("sms|0|s:rcs", "On my way"))
        assertEquals(listOf("sms|0|s:rcs" to "On my way"), base.sentReplies)
        assertTrue(store.sent.isEmpty())
    }

    @Test
    fun phoneNumbersAndConversationKeys() {
        assertEquals(PhoneNumbers.key("+33 6 39 98 01 23"), PhoneNumbers.key("0639980123"))
        assertEquals("+33639980123", PhoneNumbers.find("Sam, +33639980123"))
        assertEquals(null, PhoneNumbers.find("Mum"))
        assertTrue(SmsInbox.isPhoneNumber("+33 6 12 34 56 78"))
        assertTrue(SmsInbox.isPhoneNumber("(555) 123-4567"))
        assertFalse(SmsInbox.isPhoneNumber("call me"))
        assertFalse(SmsInbox.isPhoneNumber("+"))
        assertEquals(42L, SmsInbox.threadOf(SmsInbox.keyFor(42)))
        assertEquals(null, SmsInbox.threadOf("sms|0|s:mum"))
    }
}
