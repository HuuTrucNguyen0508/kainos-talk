package app.kainos.talk.hub

import app.kainos.talk.store.MessageStatus
import app.kainos.talk.sync.FakeSmsStore
import app.kainos.talk.sync.SyncConversation
import app.kainos.talk.sync.SyncMessage
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
class SmsOwnershipTest {
    @Test fun inboxAndThreadsShareOwnershipWithItsExactInputs() = runTest {
        val matches = AtomicInteger()
        val countedNumber = object : AbstractList<String>() {
            override val size = 1
            override fun get(index: Int): String { matches.incrementAndGet(); return "+33612345678" }
        }
        fun sms(id: Int, numbers: List<String>) = SyncConversation(
            key = "sms|t:$id", title = "SMS $id", isGroup = false, unread = 1,
            lastActivityMs = 1000, canReply = true, numbers = numbers,
            messages = listOf(SyncMessage("sms:$id", "Sender", "text $id", 1000, false, "incoming", null)),
        )
        val texts = listOf(sms(1, countedNumber), sms(2, listOf("+33699999999")), sms(3, listOf("+33688888888")))
        val notifiedKey = "sms|rcs"
        val fake = FakeTalkHub().apply {
            chats.value = listOf(InboxChat(notifiedKey, "+33612345678", false, 2000, 2, "RCS", null))
            threads.value = mapOf(notifiedKey to ChatThread(notifiedKey, "+33612345678", false,
                listOf(ThreadMessage(7, "Sender", "RCS", 2000, false, MessageStatus.INCOMING, null, false)), canReply = true))
        }
        val store = FakeSmsStore(texts)
        val hub = SmsAwareHub(fake, store, backgroundScope)
        var inbox: List<InboxChat>? = null
        val threads = mutableMapOf<String, ChatThread?>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hub.inbox().collect { value ->
            inbox = value
            value.filter { it.key.startsWith("sms|t:") }.forEach { chat ->
                val owns = chat.title == "SMS 1" || chat.title == "Moved 2"
                assertEquals("unread belongs to the same snapshot as its conversation", if (owns) 3 else 1, chat.unreadCount)
            }
        } }
        texts.forEach { c ->
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hub.thread(c.key).collect { value ->
                threads[c.key] = value
                if (value != null) {
                    val owns = value.title == "SMS 1" || value.title == "Moved 2"
                    assertEquals("folded messages belong to the same snapshot as their conversation", owns, value.messages.any { it.text == "RCS" })
                }
            } }
        }
        runCurrent()
        assertEquals("one match for the inbox and all three threads", 1, matches.get())
        assertEquals(listOf("text 1", "RCS"), threads["sms|t:1"]!!.messages.map { it.text })
        assertEquals(3, inbox!!.single { it.key == "sms|t:1" }.unreadCount)

        matches.set(0)
        // The same notified chat now belongs to thread 2, which leads this provider snapshot.
        store.conversations.value = listOf(texts[1].copy(title = "Moved 2", numbers = countedNumber), texts[0].copy(title = "Moved 1", numbers = listOf("+33699999999")), texts[2])
        runCurrent()
        assertEquals("one match after the provider update", 1, matches.get())
        assertEquals(listOf("text 1"), threads["sms|t:1"]!!.messages.map { it.text })
        assertEquals(listOf("text 2", "RCS"), threads["sms|t:2"]!!.messages.map { it.text })
        val chats = requireNotNull(inbox).associateBy { it.key }
        assertEquals(1, chats.getValue("sms|t:1").unreadCount)
        assertEquals(3, chats.getValue("sms|t:2").unreadCount)
    }
}

/** An SMS thread converts only the newest page of a long conversation, and shows what converting all would. */
@OptIn(ExperimentalCoroutinesApi::class)
class SmsThreadPagingTest {
    private val all = (1..1000).map { SyncMessage("sms:$it", "Ana", "text $it", it * 1_000L, false, "incoming", null) }

    private fun conversation(messages: List<SyncMessage>) = SyncConversation(
        key = "sms|t:1", title = "Ana", isGroup = false, unread = 1, lastActivityMs = 1000, canReply = true,
        numbers = listOf("+33612345678"), messages = messages,
    )

    @Test fun aLongTextThreadConvertsOnlyItsNewestPage() = runTest {
        val reads = AtomicInteger()
        val counted = object : AbstractList<SyncMessage>(), RandomAccess {
            override val size = all.size
            override fun get(index: Int): SyncMessage { reads.incrementAndGet(); return all[index] }
        }
        val hub = SmsAwareHub(FakeTalkHub(), FakeSmsStore(listOf(conversation(counted))), backgroundScope)
        // The inbox's own read of the snapshot is shared and not this thread's cost: let it settle first.
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hub.inbox().collect {} }
        runCurrent()
        val baseline = reads.get()
        var paged: ChatThread? = null
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hub.thread("sms|t:1", 200).collect { paged = it } }
        runCurrent()
        val converted = reads.get() - baseline
        assertEquals(all.takeLast(200).map { it.text }, paged!!.messages.map { it.text })
        assertTrue("converted $converted rows for a 200-message page of 1,000", converted <= 250)
    }

    @Test fun foldedInMessagesAndTheCutGiveWhatCuttingTheFullThreadGives() = runTest {
        val notifiedKey = "sms|rcs"
        val fake = FakeTalkHub().apply {
            chats.value = listOf(InboxChat(notifiedKey, "+33612345678", false, 5000, 2, "RCS", null))
            threads.value = mapOf(notifiedKey to ChatThread(notifiedKey, "+33612345678", false,
                listOf(
                    ThreadMessage(7, "Ana", "RCS only", 5_000_000, false, MessageStatus.INCOMING, null, false),
                    ThreadMessage(8, "Ana", "RCS early", 900, false, MessageStatus.INCOMING, null, false),
                    // The inbox has this one, just outside the newest page, but the notification stamped it
                    // 119 s later, inside the page: it is not an RCS-only message and must not push one off.
                    ThreadMessage(9, "Ana", "text 800", 800_000 + 119_000, false, MessageStatus.INCOMING, null, false),
                ), canReply = true))
        }
        val hub = SmsAwareHub(fake, FakeSmsStore(listOf(conversation(all))), backgroundScope)
        val results = mutableMapOf<Int, ChatThread?>()
        for (limit in listOf(200, 150, 101, 5, ALL_MESSAGES)) {
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hub.thread("sms|t:1", limit).collect { results[limit] = it } }
        }
        runCurrent()
        val whole = results.getValue(ALL_MESSAGES)!!.messages
        assertEquals(1002, whole.size) // 1,000 texts, RCS only and RCS early; "text 800" is a duplicate
        for (limit in listOf(200, 150, 101, 5)) assertEquals("limit $limit", whole.takeLast(limit), results.getValue(limit)!!.messages)
        assertEquals("RCS only", whole.last().text)
        assertEquals("the page is the newest 199 texts and the RCS one; a duplicate pushed none off", (802..1000).map { "text $it" } + "RCS only", results.getValue(200)!!.messages.map { it.text })
        assertTrue(results.getValue(200)!!.messages.none { it.text == "text 800" && it.id == 9L })
    }
}
