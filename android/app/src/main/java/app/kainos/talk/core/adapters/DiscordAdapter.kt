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
import app.kainos.talk.core.parseStyleMessages
import app.kainos.talk.core.pickMarkReadAction
import app.kainos.talk.core.pickReplyAction
import app.kainos.talk.core.stableKey

/**
 * Reads Discord (`com.discord`) notifications. This is the least certain source: nothing
 * public documents its notification template, extras or actions.
 *
 * Classification uses the notification channel id: `directMessages` and `messages` are chats,
 * the other channel ids from the community-documented list are not. An unknown channel id is
 * kept as a chat with [Shape.FALLBACK] so a message is never silently lost. Server and channel
 * names are not parsed out of titles: the title is shown as Discord wrote it.
 */
class DiscordAdapter(private val source: Source = Source.DISCORD) : SourceAdapter {

    override fun parse(snapshot: NotificationSnapshot): ParseResult {
        commonIgnoreReason(snapshot)?.let { return ParseResult.Ignored(it) }
        if (snapshot.category == "call") return ParseResult.Ignored("category call")
        val channel = snapshot.channelId
        if (channel != null && (channel in NON_CHAT_CHANNELS || channel.startsWith("calls_"))) {
            return ParseResult.Ignored("channel $channel")
        }
        val recognised = channel in CHAT_CHANNELS
        val isGroup = when (channel) {
            SERVER_CHANNEL -> true
            else -> snapshot.isGroupConversation
        }

        val styleMessages = parseStyleMessages(snapshot)
        val messages: List<ParsedMessage>
        val title: String
        if (styleMessages.isNotEmpty()) {
            messages = styleMessages
            val singleSender = styleMessages.filterNot { it.outgoing }.mapNotNull { it.senderName }.distinct().singleOrNull()
            title = cleanText(snapshot.conversationTitle)
                ?: (if (!isGroup) singleSender else null)
                ?: cleanText(snapshot.title)
                ?: singleSender
                ?: return ParseResult.Ignored("no title")
        } else {
            title = cleanText(snapshot.title) ?: return ParseResult.Ignored("no title")
            val text = cleanText(snapshot.bigText) ?: cleanText(snapshot.text) ?: return ParseResult.Ignored("no text")
            messages = listOf(
                ParsedMessage(
                    senderName = title,
                    senderKey = null,
                    text = text,
                    timeMs = legacyMessageTime(snapshot),
                    outgoing = false,
                ),
            )
        }

        val identity = snapshot.shortcutId?.let { "s:$it" } ?: "c:${channel.orEmpty()}:t:$title"
        val shape = when {
            !recognised -> Shape.FALLBACK
            styleMessages.isNotEmpty() -> Shape.MESSAGING_STYLE
            else -> Shape.FALLBACK
        }
        return ParseResult.Chat(
            ChatUpdate(
                conversationKey = stableKey(source.id, snapshot.userId, identity),
                source = source,
                title = title,
                isGroup = isGroup,
                messages = messages,
                replyAction = pickReplyAction(snapshot),
                markReadAction = pickMarkReadAction(snapshot),
                shape = shape,
            ),
        )
    }

    companion object {
        const val DM_CHANNEL = "directMessages"
        const val SERVER_CHANNEL = "messages"
        val CHAT_CHANNELS = setOf(DM_CHANNEL, SERVER_CHANNEL)

        /** Community-documented Discord channels that never carry a chat message. */
        val NON_CHAT_CHANNELS = setOf(
            "calls", "mediaConnections", "gameDetection", "friendRequests", "reactions", "polls",
            "social", "forumThreadCreated", "guildEventLive", "guildHighlights", "stageLive", "other",
            "systemMessages", "otherHighPriority", "default",
        )
    }
}
