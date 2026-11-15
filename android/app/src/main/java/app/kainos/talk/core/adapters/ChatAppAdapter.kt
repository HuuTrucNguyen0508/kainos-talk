package app.kainos.talk.core.adapters

import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.ParsedMessage
import app.kainos.talk.core.SMS_SOURCE
import app.kainos.talk.core.Shape
import app.kainos.talk.core.cleanText
import app.kainos.talk.core.commonIgnoreReason
import app.kainos.talk.core.legacyMessageTime
import app.kainos.talk.core.parseStyleMessages
import app.kainos.talk.core.pickReplyAction
import app.kainos.talk.core.stableKey

/**
 * Reads the default SMS app's notifications (Google Messages, Samsung Messages and others),
 * which follow Android's conversation guidelines. RCS chats exist only here, not in the SMS inbox.
 *
 * Assumptions (see docs/notification-facts.md): one notification per conversation, in
 * MessagingStyle, identified by its shortcut id. A notification without MessagingStyle is kept
 * as one message from its title and text, so nothing is dropped for its layout. Calls, progress
 * and other system categories are skipped.
 */
object ChatAppAdapter {
    /** Notification categories that never carry a message. */
    val IGNORED_CATEGORIES = setOf("call", "missed_call", "progress", "service", "status", "sys", "err", "transport", "event", "reminder", "promo", "recommendation")

    fun parse(snapshot: NotificationSnapshot): ParseResult {
        commonIgnoreReason(snapshot)?.let { return ParseResult.Ignored(it) }
        snapshot.category?.let { if (it in IGNORED_CATEGORIES) return ParseResult.Ignored("category $it") }

        val styleMessages = parseStyleMessages(snapshot)
        val messages: List<ParsedMessage>
        val title: String
        if (styleMessages.isNotEmpty()) {
            messages = styleMessages
            val singleSender = styleMessages.filterNot { it.outgoing }.mapNotNull { it.senderName }.distinct().singleOrNull()
            title = cleanText(snapshot.conversationTitle)
                ?: cleanText(snapshot.title)
                ?: singleSender
                ?: return ParseResult.Ignored("no title")
        } else {
            title = cleanText(snapshot.title) ?: return ParseResult.Ignored("no title")
            val text = cleanText(snapshot.bigText) ?: cleanText(snapshot.text) ?: return ParseResult.Ignored("no text")
            messages = listOf(
                ParsedMessage(senderName = title, senderKey = null, text = text, timeMs = legacyMessageTime(snapshot), outgoing = false),
            )
        }

        val identity = snapshot.shortcutId?.let { "s:$it" } ?: "t:$title"
        return ParseResult.Chat(
            ChatUpdate(
                conversationKey = stableKey(SMS_SOURCE, snapshot.userId, identity),
                title = title,
                isGroup = snapshot.isGroupConversation,
                messages = messages,
                replyAction = pickReplyAction(snapshot),
                shape = if (styleMessages.isNotEmpty()) Shape.MESSAGING_STYLE else Shape.FALLBACK,
            ),
        )
    }
}
