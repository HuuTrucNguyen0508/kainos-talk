package app.kainos.talk.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToKeyAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.runtime.CompositionLocalProvider
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.hub.ChatCapabilities
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.talk.LocalTalkClock
import app.kainos.talk.ui.talk.ThreadScreen
import app.kainos.talk.ui.theme.KainosTheme
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.update
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDateTime
import java.time.ZoneOffset

/** A long thread opens on its newest page and reads older pages as you scroll up to them. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ThreadPagingTest {
    @get:Rule
    val compose = createComposeRule()

    /** Records each limit the screen asks for, and can hold back what it answers. */
    private class PagedHub(val inner: FakeTalkHub) : TalkHub by inner {
        val asked = mutableListOf<Int>()
        val answering = MutableStateFlow(true)

        override fun thread(conversationKey: String, limit: Int): Flow<ChatThread?> {
            asked += limit
            return flow {
                answering.first { it }
                emitAll(inner.thread(conversationKey, limit))
            }
        }
    }

    private val clock = MockupData.clock

    private fun time(day: Int, minute: Int): Long =
        LocalDateTime.of(2026, 11, day, 0, 0).plusMinutes(minute.toLong()).toInstant(ZoneOffset.UTC).toEpochMilli()

    private fun message(id: Long, timeMs: Long) =
        ThreadMessage(id, "Ana", "Message $id", timeMs, outgoing = false, status = MessageStatus.INCOMING, media = null, read = true)

    private fun thread(messages: List<ThreadMessage>) = ChatThread(
        key = KEY,
        source = Source.WHATSAPP,
        title = "Ana Ribeiro",
        isGroup = false,
        muted = false,
        shape = Shape.MESSAGING_STYLE,
        messages = messages,
        capabilities = ChatCapabilities(canReply = true, replyBlocked = null, canMarkReadInApp = false),
        notificationRemovedReason = null,
    )

    private fun hubWith(messages: List<ThreadMessage>) =
        PagedHub(MockupData.hub().apply { threads.value = mapOf(KEY to thread(messages)) })

    private fun open(hub: TalkHub) = compose.setContent {
        KainosTheme { CompositionLocalProvider(LocalTalkClock provides clock) { ThreadScreen(hub, KEY, onBack = {}) } }
    }

    private fun bubble(id: Long) = compose.onNode(hasContentDescription("Message $id,", substring = true))

    private fun scrollTo(key: String) = compose.onNode(hasScrollToKeyAction()).performScrollToKey(key)

    @Test
    fun scrollingUpReadsTheNextPageWithoutMovingWhatIsOnScreen() {
        // 1,000 messages: 1–794 on 1 November, 795–810 on 8 November, 811–1000 on 10 November.
        // The newest page (801–1000) starts part-way through 8 November.
        val messages = (1L..1000L).map { id ->
            when {
                id <= 794 -> message(id, time(1, id.toInt()))
                id <= 810 -> message(id, time(8, 600 + id.toInt() - 795))
                else -> message(id, time(10, 720 + id.toInt() - 811))
            }
        }
        val hub = hubWith(messages)
        val eighth = clock.day(time(8, 600))
        open(hub)
        compose.waitForIdle()
        assertEquals(listOf(200), hub.asked)
        bubble(1000).assertIsDisplayed()

        // Scroll up to within a screen of the oldest loaded message, holding the next page back.
        hub.answering.value = false
        scrollTo("m-830")
        compose.waitForIdle()
        assertEquals(listOf(200, 400), hub.asked)
        val listTop = compose.onNode(hasScrollToKeyAction()).getUnclippedBoundsInRoot().top
        val topId = (801L..830L).first { id -> runCatching { bubble(id).getUnclippedBoundsInRoot().top >= listTop }.getOrDefault(false) }
        val shown = (topId..830L).associateWith { bubble(it).getUnclippedBoundsInRoot() }
        assertTrue("only ${shown.size} messages on screen", shown.size >= 10)

        hub.answering.value = true
        compose.waitForIdle()
        assertEquals(listOf(200, 400), hub.asked)
        // Every message on screen, the top one included, stays exactly where it was.
        bubble(topId).assertIsDisplayed()
        shown.forEach { (id, bounds) -> assertEquals("message $id moved", bounds, bubble(id).getUnclippedBoundsInRoot()) }

        // Across the old page boundary: one separator for 8 November, above its first message, none between 800 and 801.
        scrollTo("m-801")
        compose.waitForIdle()
        assertEquals(listOf(200, 400), hub.asked)
        (795L..801L).forEach { bubble(it).assertIsDisplayed() }
        compose.onAllNodesWithText(eighth).assertCountEquals(1)
        val separator = compose.onNodeWithText(eighth).assertIsDisplayed().getUnclippedBoundsInRoot()
        assertTrue(separator.bottom <= bubble(795).getUnclippedBoundsInRoot().top)
        assertTrue(bubble(800).getUnclippedBoundsInRoot().bottom <= bubble(801).getUnclippedBoundsInRoot().top)
        compose.onAllNodesWithText("Earlier messages are in WhatsApp").assertCountEquals(0)
    }

    @Test
    fun theStartOfHistoryShowsOnlyOnceTheOldestMessageIsLoaded() {
        val hub = hubWith((1L..250L).map { message(it, time(11, it.toInt())) })
        open(hub)
        compose.waitForIdle()
        assertEquals(listOf(200), hub.asked)

        // A new message still arrives at the bottom.
        hub.inner.threads.update { all -> all + (KEY to all.getValue(KEY).let { it.copy(messages = it.messages + message(251, time(11, 300))) }) }
        compose.waitForIdle()
        bubble(251).assertIsDisplayed()

        scrollTo("m-52")
        compose.waitForIdle()
        assertEquals(listOf(200, 400), hub.asked)
        scrollTo("origin")
        compose.waitForIdle()
        compose.onNodeWithText("Earlier messages are in WhatsApp").assertIsDisplayed()
        bubble(1).assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Loading earlier messages").assertCountEquals(0)
        compose.onAllNodesWithText(clock.day(time(11, 0))).assertCountEquals(1)
        assertEquals(listOf(200, 400), hub.asked)
    }

    private companion object {
        const val KEY = "whatsapp|0|s:ana@lid"
    }
}
