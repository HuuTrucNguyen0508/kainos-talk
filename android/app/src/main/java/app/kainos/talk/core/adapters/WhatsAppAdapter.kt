package app.kainos.talk.core.adapters

import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.ParsedMessage
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.core.SourceAdapter
import app.kainos.talk.core.cleanText
import app.kainos.talk.core.commonIgnoreReason
import app.kainos.talk.core.legacyMessageTime
import app.kainos.talk.core.mediaKindOf
import app.kainos.talk.core.parseStyleMessages
import app.kainos.talk.core.pickMarkReadAction
import app.kainos.talk.core.pickReplyAction
import app.kainos.talk.core.stableKey
import app.kainos.talk.core.stripTitleCounter

/**
 * Reads WhatsApp (`com.whatsapp`) and WhatsApp Business (`com.whatsapp.w4b`) chat notifications.
 *
 * Assumptions (see docs/notification-facts.md): each chat is one child notification, the group
 * summary is skipped, the shortcut id is the chat JID (`@g.us` group, `@lid` or
 * `@s.whatsapp.net` one-to-one), and most chats use MessagingStyle. Older non-MessagingStyle
 * layouts are read from title and text so a message is never dropped for its layout.
 */
class WhatsAppAdapter(private val source: Source) : SourceAdapter {

    override fun parse(snapshot: NotificationSnapshot): ParseResult {
        commonIgnoreReason(snapshot)?.let { return ParseResult.Ignored(it) }
        snapshot.category?.let { if (it in IGNORED_CATEGORIES) return ParseResult.Ignored("category $it") }

        val shortcutGroup = groupFlagFromJid(snapshot.shortcutId)
        val chat = if (snapshot.messages.isNotEmpty()) {
            fromMessagingStyle(snapshot, shortcutGroup)
        } else {
            fromLegacyText(snapshot, shortcutGroup)
        } ?: return ParseResult.Ignored("no chat content")

        val identity = snapshot.shortcutId?.let { "s:$it" }
            ?: "t:${if (chat.isGroup) "g" else "d"}:${chat.title}"
        return ParseResult.Chat(
            ChatUpdate(
                conversationKey = stableKey(source.id, snapshot.userId, identity),
                source = source,
                title = chat.title,
                isGroup = chat.isGroup,
                messages = chat.messages,
                replyAction = pickReplyAction(snapshot),
                markReadAction = pickMarkReadAction(snapshot),
                shape = chat.shape,
            ),
        )
    }

    private class Chat(val title: String, val isGroup: Boolean, val messages: List<ParsedMessage>, val shape: Shape)

    private fun fromMessagingStyle(snapshot: NotificationSnapshot, shortcutGroup: Boolean?): Chat? {
        val messages = parseStyleMessages(snapshot)
        if (messages.isEmpty()) return null
        val incomingSenders = messages.filterNot { it.outgoing }.mapNotNull { it.senderName }.distinct()
        val title = cleanText(snapshot.title)
        val conversationTitle = cleanText(snapshot.conversationTitle)?.let(::stripTitleCounter)

        // 2021 report: a group photo arrived as a non-group MessagingStyle titled "Group: Sender".
        val legacyGroupName = if (conversationTitle == null && !snapshot.isGroupConversation) {
            title?.let { splitPrefix(it, ": ") }?.takeIf { (_, sender) -> sender in incomingSenders }?.first
        } else {
            null
        }

        val isGroup = shortcutGroup ?: (snapshot.isGroupConversation || legacyGroupName != null)
        val displayName = if (isGroup) {
            conversationTitle ?: legacyGroupName ?: title?.let(::stripTitleCounter)
        } else {
            incomingSenders.singleOrNull() ?: conversationTitle ?: title
        } ?: return null
        return Chat(displayName, isGroup, messages, Shape.MESSAGING_STYLE)
    }

    private fun fromLegacyText(snapshot: NotificationSnapshot, shortcutGroup: Boolean?): Chat? {
        val title = cleanText(snapshot.title) ?: return null
        val text = cleanText(snapshot.text) ?: cleanText(snapshot.bigText) ?: return null
        if (SERVICE_TEXTS.any { it.matches(text) } || SERVICE_TEXTS.any { it.matches(title) }) return null

        var group: String? = null
        var sender: String = title
        var body: String = text
        val atSplit = splitPrefix(title, " @ ")
        val colonInTitle = splitPrefix(title, ": ")
        val colonInText = splitPrefix(text, ": ")
        when {
            // BigPicture variant: title "Sender @ Group", text "📷 caption".
            shortcutGroup != false && atSplit != null -> {
                sender = atSplit.first
                group = atSplit.second
            }
            // Plain group variant: title "Group", text "Sender: message".
            (shortcutGroup == true || snapshot.isGroupConversation) && colonInText != null -> {
                group = title
                sender = colonInText.first
                body = colonInText.second
            }
            // Title "Group: Sender" only counts as a group when the shortcut says so.
            shortcutGroup == true && colonInTitle != null -> {
                group = colonInTitle.first
                sender = colonInTitle.second
            }
            shortcutGroup == true -> group = title
        }
        val message = ParsedMessage(
            senderName = sender,
            senderKey = null,
            text = body,
            timeMs = legacyMessageTime(snapshot),
            outgoing = false,
            media = mediaKindOf(body, null),
        )
        val isGroup = group != null
        val displayName = stripTitleCounter(group ?: sender)
        return Chat(displayName, isGroup, listOf(message), Shape.LEGACY_TEXT)
    }

    companion object {
        /** Categories WhatsApp uses for non-chat notifications (progress confirmed, the rest guarded). */
        val IGNORED_CATEGORIES = setOf(
            "progress", "call", "missed_call", "service", "status", "err", "transport", "sys",
        )

        /** Secondary guard for service notifications that might come without a category. */
        val SERVICE_TEXTS = listOf(
            Regex("Checking for new messages", RegexOption.IGNORE_CASE),
            Regex("WhatsApp Web is currently active", RegexOption.IGNORE_CASE),
            Regex("Backup in progress.*", RegexOption.IGNORE_CASE),
            Regex("You may have new messages", RegexOption.IGNORE_CASE),
            Regex("\\d+ new messages?", RegexOption.IGNORE_CASE),
            Regex("\\d+ messages from \\d+ chats", RegexOption.IGNORE_CASE),
        )

        /** True for a group JID, false for a one-to-one JID, null when the id is not a JID. */
        fun groupFlagFromJid(shortcutId: String?): Boolean? = when {
            shortcutId == null -> null
            shortcutId.endsWith("@g.us") -> true
            shortcutId.endsWith("@lid") || shortcutId.endsWith("@s.whatsapp.net") -> false
            else -> null
        }

        private fun splitPrefix(value: String, separator: String): Pair<String, String>? {
            val at = value.indexOf(separator)
            if (at <= 0 || at + separator.length >= value.length) return null
            val left = value.substring(0, at).trim()
            val right = value.substring(at + separator.length).trim()
            return if (left.isEmpty() || right.isEmpty()) null else left to right
        }
    }
}
