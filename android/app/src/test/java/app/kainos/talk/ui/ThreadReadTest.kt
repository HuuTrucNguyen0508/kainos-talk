package app.kainos.talk.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.hub.ChatCapabilities
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.SmsAwareHub
import app.kainos.talk.sync.FakeSmsStore
import app.kainos.talk.sync.SyncConversation
import app.kainos.talk.sync.SyncMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.talk.LocalTalkClock
import app.kainos.talk.ui.talk.ThreadScreen
import app.kainos.talk.ui.theme.KainosTheme
import kotlinx.coroutines.flow.update
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** An open thread is marked read when a late message arrives, even one that sorts before the newest. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ThreadReadTest {
    @get:Rule
    val compose = createComposeRule()

    private class CountingHub(val inner: TalkHub) : TalkHub by inner {
        var marked = 0

        override suspend fun markRead(conversationKey: String) {
            marked++
            inner.markRead(conversationKey)
        }
    }

    private fun message(id: Long, timeMs: Long) =
        ThreadMessage(id, "Ana", "Message $id", timeMs, outgoing = false, status = MessageStatus.INCOMING, media = null, read = true)

    private fun thread(messages: List<ThreadMessage>, unread: Int) = ChatThread(
        key = KEY,
        source = Source.SMS,
        title = "Ana Ribeiro",
        isGroup = false,
        muted = false,
        shape = Shape.MESSAGING_STYLE,
        messages = messages,
        capabilities = ChatCapabilities(canReply = true, replyBlocked = null, canMarkReadInApp = false),
        notificationRemovedReason = null,
        unread = unread,
    )

    @Test
    fun aLateMessageBeforeTheNewestMarksTheOpenThreadReadOnce() {
        val inner = MockupData.hub().apply { threads.value = mapOf(KEY to thread(listOf(message(1, 1_000), message(3, 3_000)), unread = 0)) }
        val hub = CountingHub(inner)
        compose.setContent {
            KainosTheme { CompositionLocalProvider(LocalTalkClock provides MockupData.clock) { ThreadScreen(hub, KEY, onBack = {}) } }
        }
        compose.waitForIdle()
        assertEquals("opening reads it", 1, hub.marked)

        // Message 2 was delayed: it sorts before message 3, so the newest id is still 3.
        inner.threads.update { it + (KEY to thread(listOf(message(1, 1_000), message(2, 2_000), message(3, 3_000)), unread = 1)) }
        compose.waitForIdle()
        assertEquals("the late message read the thread", 2, hub.marked)

        // The hub reads it: nothing unread, nothing more is written.
        inner.threads.update { it + (KEY to thread(listOf(message(1, 1_000), message(2, 2_000), message(3, 3_000)), unread = 0)) }
        compose.waitForIdle()
        assertEquals(2, hub.marked)
    }

    @Test
    fun aFoldedLateRcsMessageMarksTheOpenSmsThreadReadOnce() {
        val number = "+33612345678"
        val sms = SyncConversation(
            key = SMS_KEY, title = "Ana", isGroup = false, unread = 0, lastActivityMs = 3_000, canReply = true, numbers = listOf(number),
            messages = listOf(SyncMessage("sms:1", "Ana", "one", 1_000, false, "incoming", null), SyncMessage("sms:3", "Ana", "three", 3_000, false, "incoming", null)),
        )
        fun rcs(read: Boolean, vararg late: ThreadMessage) = ChatThread(
            RCS_KEY, Source.SMS, number, false, false, Shape.MESSAGING_STYLE,
            listOf(ThreadMessage(7, "Ana", "RCS first", 500, false, MessageStatus.INCOMING, null, true)) + late.map { it.copy(read = read) },
            ChatCapabilities(true, null, false), null,
        )
        fun chat(unread: Int) = InboxItem.Chat(RCS_KEY, Source.SMS, number, false, 3_000, unread, false, "RCS first", null, false, null, true)
        val base = FakeTalkHub().apply {
            chats.value = listOf(chat(0))
            threads.value = mapOf(RCS_KEY to rcs(true))
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val hub = CountingHub(SmsAwareHub(base, FakeSmsStore(listOf(sms)), scope))
        try {
            compose.setContent {
                KainosTheme { CompositionLocalProvider(LocalTalkClock provides MockupData.clock) { ThreadScreen(hub, SMS_KEY, onBack = {}) } }
            }
            compose.waitUntil(10_000) { hub.marked == 1 }

            // A late RCS message, dated before the newest text, arrives unread in the folded chat.
            val late = ThreadMessage(8, "Ana", "RCS late", 2_000, false, MessageStatus.INCOMING, null, false)
            base.chats.value = listOf(chat(1))
            base.threads.value = mapOf(RCS_KEY to rcs(false, late))
            compose.waitUntil(10_000) { hub.marked == 2 }

            // The hub reads it: nothing more is written.
            base.chats.value = listOf(chat(0))
            base.threads.value = mapOf(RCS_KEY to rcs(true, late))
            compose.waitForIdle()
            Thread.sleep(500)
            compose.waitForIdle()
            assertEquals(2, hub.marked)
        } finally {
            scope.cancel()
        }
    }

    private companion object {
        const val KEY = "sms|t:7"
        const val SMS_KEY = "sms|t:9"
        const val RCS_KEY = "sms|rcs"
    }
}