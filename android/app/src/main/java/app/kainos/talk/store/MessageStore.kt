package app.kainos.talk.store

import androidx.room.withTransaction
import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.SMS_SOURCE
import app.kainos.talk.core.messageDedupKey
import app.kainos.talk.core.normalizeForMatch
import kotlin.math.abs

/**
 * Applies parsed notification events to the database. Every apply is idempotent: posting the
 * same snapshot twice, or a later snapshot that repeats earlier messages, changes nothing.
 * Nothing here deletes a message.
 */
class MessageStore(private val db: TalkDatabase) {
    private val dao = db.dao()

    data class ChatApplied(val inserted: Int, val confirmedReplies: Int)

    suspend fun applyChat(update: ChatUpdate): ChatApplied = db.withTransaction {
        val existing = dao.conversation(update.conversationKey)
        val newestMessage = update.messages.maxOfOrNull { it.timeMs } ?: 0L
        val proposed = ConversationEntity(
            key = update.conversationKey,
            sourceId = SMS_SOURCE,
            title = update.title,
            isGroup = update.isGroup,
            lastActivityMs = maxOf(existing?.lastActivityMs ?: 0L, newestMessage),
            muted = existing?.muted ?: false,
            shape = update.shape,
            lastRemovalReason = null,
        )
        if (proposed != existing) dao.upsertConversation(proposed)

        val pending = dao.unconfirmedReplies(update.conversationKey).toMutableList()
        var inserted = 0
        var confirmed = 0
        for (message in update.messages.sortedBy { it.timeMs }) {
            val dedupKey = messageDedupKey(update.conversationKey, message)
            if (dao.messageExists(dedupKey)) continue
            if (message.outgoing) {
                // The source app echoes a reply sent from the hub; attach the echo to that reply.
                val match = pending.firstOrNull {
                    normalizeForMatch(it.text) == normalizeForMatch(message.text) &&
                        abs(it.timeMs - message.timeMs) <= ECHO_WINDOW_MS
                }
                if (match != null) {
                    dao.confirmReply(match.id, dedupKey)
                    pending.remove(match)
                    confirmed++
                    continue
                }
            }
            val rowId = dao.insertMessage(
                MessageEntity(
                    conversationKey = update.conversationKey,
                    dedupKey = dedupKey,
                    senderName = message.senderName,
                    senderKey = message.senderKey,
                    text = message.text,
                    timeMs = message.timeMs,
                    outgoing = message.outgoing,
                    status = if (message.outgoing) MessageStatus.CONFIRMED else MessageStatus.INCOMING,
                    media = message.media,
                    read = message.outgoing,
                ),
            )
            if (rowId != -1L) inserted++
        }
        ChatApplied(inserted, confirmed)
    }

    /** Stores a reply typed in the hub before it is handed to the source app. */
    suspend fun addLocalReply(conversationKey: String, text: String, nowMs: Long): Long {
        val local = MessageEntity(
            conversationKey = conversationKey,
            dedupKey = "local:$conversationKey:$nowMs:${text.hashCode()}:${System.nanoTime()}",
            senderName = null,
            senderKey = null,
            text = text,
            timeMs = nowMs,
            outgoing = true,
            status = MessageStatus.SENDING,
            media = null,
            read = true,
        )
        return dao.insertMessage(local)
    }

    suspend fun finishReply(id: Long, sent: Boolean) =
        dao.finishSending(id, if (sent) MessageStatus.SENT else MessageStatus.FAILED)

    suspend fun markConversationRead(key: String) = dao.markConversationRead(key)

    companion object {
        /** How far apart the hub's send time and the app's echo time may be. */
        const val ECHO_WINDOW_MS = 10 * 60 * 1000L
    }
}
