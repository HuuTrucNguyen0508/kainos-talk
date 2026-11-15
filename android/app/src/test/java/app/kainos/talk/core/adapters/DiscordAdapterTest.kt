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
import app.kainos.talk.core.own
import app.kainos.talk.core.replyAction
import app.kainos.talk.core.snapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class DiscordAdapterTest {
    private val adapter = DiscordAdapter()

    private fun chat(s: NotificationSnapshot): ChatUpdate {
        val result = adapter.parse(s)
        check(result is ParseResult.Chat) { "expected a chat, got $result" }
        return result.update
    }

    @Test
    fun directMessageIsNamedAfterTheSender() {
        val update = chat(
            snapshot(
                packageName = "com.discord",
                channelId = "directMessages",
                template = MESSAGING_STYLE,
                title = "sam",
                messages = listOf(incoming("gg", 1_000, "sam"), own("gg wp", 2_000)),
                actions = listOf(replyAction),
            ),
        )
        assertEquals("discord|0|c:directMessages:t:sam", update.conversationKey)
        assertEquals("sam", update.title)
        assertEquals(false, update.isGroup)
        assertEquals(Shape.MESSAGING_STYLE, update.shape)
        assertEquals(
            listOf(
                ParsedMessage("sam", "key:sam", "gg", 1_000, outgoing = false),
                ParsedMessage(null, null, "gg wp", 2_000, outgoing = true),
            ),
            update.messages,
        )
        assertEquals(ActionRef(0, false, "Reply"), update.replyAction)
    }

    @Test
    fun serverMessageKeepsTheTitleAsDiscordWroteIt() {
        val update = chat(
            snapshot(
                packageName = "com.discord",
                channelId = "messages",
                shortcutId = "1123581321345589",
                template = MESSAGING_STYLE,
                title = "#general (My Server)",
                conversationTitle = "#general (My Server)",
                isGroupConversation = true,
                messages = listOf(incoming("deploy is out", 1_000, "ana"), incoming("nice", 2_000, "ben")),
            ),
        )
        assertEquals("discord|0|s:1123581321345589", update.conversationKey)
        assertEquals("#general (My Server)", update.title)
        assertEquals(true, update.isGroup)
        assertEquals(listOf("ana", "ben"), update.messages.map { it.senderName })
        assertEquals(null, update.replyAction)
    }

    @Test
    fun unknownChannelAndPlainLayoutFallBackToReadableText() {
        val update = chat(
            snapshot(
                packageName = "com.discord",
                channelId = "someNewChannel",
                whenMs = 9_000,
                title = "Somebody",
                text = "hello there",
            ),
        )
        assertEquals("discord|0|c:someNewChannel:t:Somebody", update.conversationKey)
        assertEquals(Shape.FALLBACK, update.shape)
        assertEquals("Somebody", update.title)
        assertEquals(listOf(ParsedMessage("Somebody", null, "hello there", 9_000, outgoing = false)), update.messages)
    }

    @Test
    fun recognisedChannelWithoutMessagingStyleIsAlsoAFallback() {
        val update = chat(
            snapshot(packageName = "com.discord", channelId = "directMessages", title = "sam", text = "yo"),
        )
        assertEquals(Shape.FALLBACK, update.shape)
        assertEquals("yo", update.messages.single().text)
    }

    @Test
    fun nonChatChannelsAndSummariesAreIgnored() {
        assertEquals(
            ParseResult.Ignored("channel friendRequests"),
            adapter.parse(snapshot(packageName = "com.discord", channelId = "friendRequests", title = "x", text = "y")),
        )
        assertEquals(
            ParseResult.Ignored("channel calls_default"),
            adapter.parse(snapshot(packageName = "com.discord", channelId = "calls_default", title = "x", text = "y")),
        )
        assertEquals(
            ParseResult.Ignored("group summary"),
            adapter.parse(
                snapshot(packageName = "com.discord", channelId = "messages", flags = NotificationFlags.GROUP_SUMMARY, title = "x"),
            ),
        )
    }
}
