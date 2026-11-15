package app.kainos.talk.store

import androidx.room.withTransaction
import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MailUpdate
import app.kainos.talk.core.messageDedupKey
import app.kainos.talk.core.normalizeForMatch
import kotlin.math.abs

/**
 * Applies parsed notification events to the database. Every apply is idempotent: posting the
 * same snapshot twice, or a later snapshot that repeats earlier messages, changes nothing.
 * Nothing here deletes a message; a removed notification only records why it went away.
 */
class MessageStore(private val db: TalkDatabase) {
    private val dao = db.dao()

    data class ChatApplied(val inserted: Int, val confirmedReplies: Int)

    suspend fun applyChat(update: ChatUpdate): ChatApplied = db.withTransaction {
        val existing = dao.conversation(update.conversationKey)
        val newestMessage = update.messages.maxOfOrNull { it.timeMs } ?: 0L
        val proposed = ConversationEntity(
            key = update.conversationKey,
            sourceId = update.source.id,
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

    /** Returns true when the mail item is new. A re-post keeps read state and requested action. */
    suspend fun applyMail(update: MailUpdate): Boolean = db.withTransaction {
        val existing = dao.mail(update.mailKey)
        val proposed = MailEntity(
            key = update.mailKey,
            sourceId = update.source.id,
            accountKey = update.accountKey,
            accountLabel = update.accountLabel,
            sender = update.sender,
            senderHidden = update.senderHidden,
            subject = update.subject,
            receivedAtMs = existing?.receivedAtMs ?: update.receivedAtMs,
            read = existing?.read ?: false,
            requestedAction = existing?.requestedAction,
            shape = update.shape,
            lastRemovalReason = null,
        )
        if (proposed != existing) dao.upsertMail(proposed)
        existing == null
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

    suspend fun conversationRemoved(key: String, reason: Int) = dao.setConversationRemoval(key, reason)

    suspend fun mailRemoved(key: String, reason: Int) = dao.setMailRemoval(key, reason)

    suspend fun markConversationRead(key: String) = dao.markConversationRead(key)

    suspend fun setMuted(key: String, muted: Boolean) = dao.setMuted(key, muted)

    suspend fun markMailRead(key: String) = dao.markMailRead(key)

    suspend fun setMailRequestedAction(key: String, action: MailAction) {
        dao.setMailRequestedAction(key, action)
        if (action == MailAction.MARK_READ) dao.markMailRead(key)
    }

    companion object {
        /** How far apart the hub's send time and the app's echo time may be. */
        const val ECHO_WINDOW_MS = 10 * 60 * 1000L
    }
}
