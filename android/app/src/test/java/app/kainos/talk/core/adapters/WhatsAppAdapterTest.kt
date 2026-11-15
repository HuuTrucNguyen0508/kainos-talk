package app.kainos.talk.core.adapters

import app.kainos.talk.core.ActionRef
import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.MESSAGING_STYLE
import app.kainos.talk.core.MediaKind
import app.kainos.talk.core.NotificationFlags
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.ParsedMessage
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.core.incoming
import app.kainos.talk.core.markReadAction
import app.kainos.talk.core.messageDedupKey
import app.kainos.talk.core.own
import app.kainos.talk.core.replyAction
import app.kainos.talk.core.snapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class WhatsAppAdapterTest {
    private val adapter = WhatsAppAdapter(Source.WHATSAPP)

    private fun chat(s: NotificationSnapshot): ChatUpdate {
        val result = adapter.parse(s)
        check(result is ParseResult.Chat) { "expected a chat, got $result" }
        return result.update
    }

    @Test
    fun groupChatUsesShortcutJidAndStripsCounterAndBidi() {
        val update = chat(
            snapshot(
                channelId = "group_chat_defaults_6",
                shortcutId = "120363012345678901@g.us",
                template = MESSAGING_STYLE,
                title = "\u2068Family\u2069: \u2068Bob\u2069",
                text = "see you",
                conversationTitle = "\u2068Family\u2069 (2 messages)",
                isGroupConversation = true,
                messages = listOf(incoming("hi all", 1_000, "Alice"), incoming("see you", 2_000, "Bob")),
                actions = listOf(replyAction, markReadAction),
            ),
        )
        assertEquals("whatsapp|0|s:120363012345678901@g.us", update.conversationKey)
        assertEquals("Family", update.title)
        assertEquals(true, update.isGroup)
        assertEquals(Shape.MESSAGING_STYLE, update.shape)
        assertEquals(
            listOf(
                ParsedMessage("Alice", "key:Alice", "hi all", 1_000, outgoing = false),
                ParsedMessage("Bob", "key:Bob", "see you", 2_000, outgoing = false),
            ),
            update.messages,
        )
        assertEquals(ActionRef(0, false, "Reply"), update.replyAction)
        assertEquals(ActionRef(1, false, "Mark as read"), update.markReadAction)
    }

    @Test
    fun oneToOneChatIsNamedAfterTheSenderAndKeepsOwnMessages() {
        val update = chat(
            snapshot(
                channelId = "individual_chat_defaults_5",
                shortcutId = "123456789012345@lid",
                template = MESSAGING_STYLE,
                title = "Alice",
                messages = listOf(incoming("lunch?", 1_000, "Alice"), own("sure", 2_000)),
                actions = listOf(replyAction),
            ),
        )
        assertEquals("whatsapp|0|s:123456789012345@lid", update.conversationKey)
        assertEquals("Alice", update.title)
        assertEquals(false, update.isGroup)
        assertEquals(
            listOf(
                ParsedMessage("Alice", "key:Alice", "lunch?", 1_000, outgoing = false),
                ParsedMessage(null, null, "sure", 2_000, outgoing = true),
            ),
            update.messages,
        )
        assertEquals(null, update.markReadAction)
    }

    @Test
    fun groupSummaryIsSkipped() {
        val result = adapter.parse(
            snapshot(
                flags = NotificationFlags.GROUP_SUMMARY,
                shortcutId = "123456789012345@lid",
                title = "WhatsApp",
                text = "5 messages from 2 chats",
            ),
        )
        assertEquals(ParseResult.Ignored("group summary"), result)
    }

    @Test
    fun repeatedSnapshotsGiveTheSameMessageIdentity() {
        val first = chat(
            snapshot(
                shortcutId = "123456789012345@lid",
                template = MESSAGING_STYLE,
                messages = listOf(incoming("one", 1_000, "Alice")),
            ),
        )
        val second = chat(
            snapshot(
                shortcutId = "123456789012345@lid",
                template = MESSAGING_STYLE,
                messages = listOf(incoming("one", 1_000, "Alice"), incoming("two", 2_000, "Alice")),
            ),
        )
        assertEquals(first.conversationKey, second.conversationKey)
        val firstKeys = first.messages.map { messageDedupKey(first.conversationKey, it) }
        val secondKeys = second.messages.map { messageDedupKey(second.conversationKey, it) }
        assertEquals(firstKeys[0], secondKeys[0])
        assertNotEquals(secondKeys[0], secondKeys[1])
    }

    @Test
    fun mediaIsLabelledFromEmojiPrefixOrMimeType() {
        val update = chat(
            snapshot(
                shortcutId = "123456789012345@lid",
                template = MESSAGING_STYLE,
                messages = listOf(
                    incoming("📷 Holiday", 1_000, "Alice"),
                    incoming("", 2_000, "Alice", mime = "image/jpeg", uri = "content://com.whatsapp.provider/media/1"),
                    incoming("🎤 Voice message (0:12)", 3_000, "Alice"),
                ),
            ),
        )
        assertEquals(listOf(MediaKind.IMAGE, MediaKind.IMAGE, MediaKind.VOICE), update.messages.map { it.media })
        assertEquals(listOf("📷 Holiday", "", "🎤 Voice message (0:12)"), update.messages.map { it.text })
    }

    @Test
    fun legacyNonGroupMessagingStyleTitledGroupColonSenderIsAGroup() {
        val update = chat(
            snapshot(
                template = MESSAGING_STYLE,
                title = "Family: Alice",
                isGroupConversation = false,
                messages = listOf(incoming("📷 caption", 1_000, "Alice")),
            ),
        )
        assertEquals("whatsapp|0|t:g:Family", update.conversationKey)
        assertEquals("Family", update.title)
        assertEquals(true, update.isGroup)
        assertEquals("Alice", update.messages.single().senderName)
    }

    @Test
    fun legacyPlainGroupTextIsSplitIntoSenderAndBody() {
        val update = chat(
            snapshot(
                whenMs = 5_000,
                title = "Family",
                text = "Alice: 📷 caption",
                isGroupConversation = true,
            ),
        )
        assertEquals("whatsapp|0|t:g:Family", update.conversationKey)
        assertEquals(Shape.LEGACY_TEXT, update.shape)
        assertEquals(
            listOf(ParsedMessage("Alice", null, "📷 caption", 5_000, outgoing = false, media = MediaKind.IMAGE)),
            update.messages,
        )
    }

    @Test
    fun legacyBigPictureTitleSenderAtGroup() {
        val update = chat(
            snapshot(
                whenMs = 6_000,
                template = "android.app.Notification\$BigPictureStyle",
                title = "Alice @ Family",
                text = "📷 caption",
            ),
        )
        assertEquals("Family", update.title)
        assertEquals(true, update.isGroup)
        assertEquals(
            listOf(ParsedMessage("Alice", null, "📷 caption", 6_000, outgoing = false, media = MediaKind.IMAGE)),
            update.messages,
        )
    }

    @Test
    fun legacyPlainOneToOneUsesWhenAsTime() {
        val update = chat(snapshot(whenMs = 7_000, shortcutId = "123456789012345@lid", title = "Bob", text = "hi"))
        assertEquals("whatsapp|0|s:123456789012345@lid", update.conversationKey)
        assertEquals(false, update.isGroup)
        assertEquals("Bob", update.title)
        assertEquals(listOf(ParsedMessage("Bob", null, "hi", 7_000, outgoing = false)), update.messages)
    }

    @Test
    fun nonChatNotificationsAreIgnored() {
        assertEquals(
            ParseResult.Ignored("category progress"),
            adapter.parse(snapshot(category = "progress", title = "WhatsApp", text = "Downloading document")),
        )
        assertEquals(
            ParseResult.Ignored("ongoing"),
            adapter.parse(snapshot(flags = NotificationFlags.ONGOING_EVENT, title = "WhatsApp", text = "Ongoing voice call")),
        )
        assertEquals(
            ParseResult.Ignored("no chat content"),
            adapter.parse(snapshot(title = "WhatsApp", text = "Checking for new messages")),
        )
    }

    @Test
    fun businessAccountIsASeparateConversation() {
        val s = snapshot(
            packageName = "com.whatsapp.w4b",
            shortcutId = "123456789012345@lid",
            template = MESSAGING_STYLE,
            messages = listOf(incoming("order?", 1_000, "Customer")),
        )
        val update = (WhatsAppAdapter(Source.WHATSAPP_BUSINESS).parse(s) as ParseResult.Chat).update
        assertEquals("whatsapp-business|0|s:123456789012345@lid", update.conversationKey)
        assertEquals(Source.WHATSAPP_BUSINESS, update.source)
    }
}
