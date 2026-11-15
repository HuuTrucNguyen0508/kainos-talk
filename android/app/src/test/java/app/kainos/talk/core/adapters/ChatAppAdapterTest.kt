package app.kainos.talk.core.adapters

import app.kainos.talk.core.ActionRef
import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.MESSAGING_STYLE
import app.kainos.talk.core.NotificationFlags
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.ParsedMessage
import app.kainos.talk.core.Shape
import app.kainos.talk.core.incoming
import app.kainos.talk.core.markReadAction
import app.kainos.talk.core.own
import app.kainos.talk.core.replyAction
import app.kainos.talk.core.snapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAppAdapterTest {
    private val messages = "com.google.android.apps.messaging"

    private fun chat(s: NotificationSnapshot): ChatUpdate {
        val result = ChatAppAdapter.parse(s)
        check(result is ParseResult.Chat) { "expected a chat, got $result" }
        return result.update
    }

    @Test
    fun anRcsConversationIsKeyedByShortcutAndKeepsItsReplyAction() {
        val update = chat(
            snapshot(
                packageName = messages,
                shortcutId = "conversation_42",
                template = MESSAGING_STYLE,
                title = "Mira Okafor",
                messages = listOf(incoming("Still up for climbing?", 1_000, "Mira Okafor"), own("Yes!", 2_000)),
                actions = listOf(replyAction, markReadAction),
            ),
        )
        assertEquals("sms|0|s:conversation_42", update.conversationKey)
        assertEquals("Mira Okafor", update.title)
        assertEquals(Shape.MESSAGING_STYLE, update.shape)
        assertEquals(
            listOf(
                ParsedMessage("Mira Okafor", "key:Mira Okafor", "Still up for climbing?", 1_000, outgoing = false),
                ParsedMessage(null, null, "Yes!", 2_000, outgoing = true),
            ),
            update.messages,
        )
        assertEquals(ActionRef(0, false, "Reply"), update.replyAction)
    }

    @Test
    fun groupChatTakesTheConversationTitle() {
        val update = chat(
            snapshot(
                packageName = messages,
                template = MESSAGING_STYLE,
                title = "Odile",
                conversationTitle = "Climbing Saturdays",
                isGroupConversation = true,
                messages = listOf(incoming("Who's driving?", 1_000, "Odile")),
            ),
        )
        assertEquals("Climbing Saturdays", update.title)
        assertTrue(update.isGroup)
        assertEquals("sms|0|t:Climbing Saturdays", update.conversationKey)
    }

    @Test
    fun smsWithoutMessagingStyleBecomesOneMessageFromTheTitle() {
        val update = chat(
            snapshot(
                packageName = messages,
                title = "Garage Delaunay",
                text = "Your car is ready.",
                whenMs = 5_000,
            ),
        )
        assertEquals("sms|0|t:Garage Delaunay", update.conversationKey)
        assertEquals(Shape.FALLBACK, update.shape)
        assertEquals(listOf(ParsedMessage("Garage Delaunay", null, "Your car is ready.", 5_000, outgoing = false)), update.messages)
    }

    @Test
    fun callsProgressAndSummariesAreSkipped() {
        val call = ChatAppAdapter.parse(snapshot(packageName = messages, category = "call", title = "Mum", text = "Incoming call"))
        assertEquals(ParseResult.Ignored("category call"), call)
        val progress = ChatAppAdapter.parse(snapshot(packageName = messages, category = "progress", title = "Sending photo", text = "1 of 2"))
        assertEquals(ParseResult.Ignored("category progress"), progress)
        val summary = ChatAppAdapter.parse(
            snapshot(packageName = messages, flags = NotificationFlags.GROUP_SUMMARY, title = "2 new messages", text = "x"),
        )
        assertTrue(summary is ParseResult.Ignored)
    }
}
