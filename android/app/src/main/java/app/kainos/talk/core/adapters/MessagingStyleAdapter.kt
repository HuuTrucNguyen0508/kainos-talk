package app.kainos.talk.core.adapters

import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.core.SourceAdapter
import app.kainos.talk.core.cleanText
import app.kainos.talk.core.commonIgnoreReason
import app.kainos.talk.core.parseStyleMessages
import app.kainos.talk.core.pickMarkReadAction
import app.kainos.talk.core.pickReplyAction
import app.kainos.talk.core.stableKey

/**
 * A plain MessagingStyle reader with no app-specific rules. The instrumented test registers it
 * for its fake sender; it also documents the minimum a chat notification needs to carry.
 */
class MessagingStyleAdapter(private val source: Source) : SourceAdapter {
    override fun parse(snapshot: NotificationSnapshot): ParseResult {
        commonIgnoreReason(snapshot)?.let { return ParseResult.Ignored(it) }
        val messages = parseStyleMessages(snapshot)
        if (messages.isEmpty()) return ParseResult.Ignored("no MessagingStyle messages")
        val title = cleanText(snapshot.conversationTitle) ?: cleanText(snapshot.title)
            ?: return ParseResult.Ignored("no title")
        val identity = snapshot.shortcutId?.let { "s:$it" } ?: "t:$title"
        return ParseResult.Chat(
            ChatUpdate(
                conversationKey = stableKey(source.id, snapshot.userId, identity),
                source = source,
                title = title,
                isGroup = snapshot.isGroupConversation,
                messages = messages,
                replyAction = pickReplyAction(snapshot),
                markReadAction = pickMarkReadAction(snapshot),
                shape = Shape.MESSAGING_STYLE,
            ),
        )
    }
}
