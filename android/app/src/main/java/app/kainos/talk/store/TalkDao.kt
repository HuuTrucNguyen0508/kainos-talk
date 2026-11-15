package app.kainos.talk.store

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import app.kainos.talk.core.MailAction
import kotlinx.coroutines.flow.Flow

@Dao
interface TalkDao {

    @Query(
        """
        SELECT c.*,
          (SELECT COUNT(*) FROM messages m WHERE m.conversationKey = c.`key` AND m.read = 0 AND m.outgoing = 0) AS unreadCount,
          (SELECT m.text FROM messages m WHERE m.conversationKey = c.`key` ORDER BY m.timeMs DESC, m.id DESC LIMIT 1) AS lastText,
          (SELECT m.senderName FROM messages m WHERE m.conversationKey = c.`key` ORDER BY m.timeMs DESC, m.id DESC LIMIT 1) AS lastSender,
          (SELECT m.outgoing FROM messages m WHERE m.conversationKey = c.`key` ORDER BY m.timeMs DESC, m.id DESC LIMIT 1) AS lastOutgoing,
          (SELECT m.media FROM messages m WHERE m.conversationKey = c.`key` ORDER BY m.timeMs DESC, m.id DESC LIMIT 1) AS lastMedia
        FROM conversations c
        ORDER BY c.lastActivityMs DESC
        """,
    )
    fun observeConversationRows(): Flow<List<ConversationRow>>

    @Query("SELECT * FROM conversations WHERE `key` = :key")
    fun observeConversation(key: String): Flow<ConversationEntity?>

    @Query("SELECT * FROM conversations WHERE `key` = :key")
    suspend fun conversation(key: String): ConversationEntity?

    @Upsert
    suspend fun upsertConversation(conversation: ConversationEntity)

    @Query("SELECT * FROM messages WHERE conversationKey = :key ORDER BY timeMs ASC, id ASC")
    fun observeMessages(key: String): Flow<List<MessageEntity>>

    /** The newest [limit] messages, oldest first: what the PC sync sends. */
    @Query("SELECT * FROM (SELECT * FROM messages WHERE conversationKey = :key ORDER BY timeMs DESC, id DESC LIMIT :limit) ORDER BY timeMs ASC, id ASC")
    fun observeLatestMessages(key: String, limit: Int): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE conversationKey = :key ORDER BY timeMs ASC, id ASC")
    suspend fun messages(key: String): List<MessageEntity>

    @Query("SELECT EXISTS(SELECT 1 FROM messages WHERE dedupKey = :dedupKey)")
    suspend fun messageExists(dedupKey: String): Boolean

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertMessage(message: MessageEntity): Long

    @Query(
        """
        SELECT * FROM messages WHERE conversationKey = :key AND outgoing = 1
          AND status IN ('SENDING', 'SENT') AND dedupKey LIKE 'local:%'
        ORDER BY timeMs ASC
        """,
    )
    suspend fun unconfirmedReplies(key: String): List<MessageEntity>

    @Query("UPDATE messages SET status = 'CONFIRMED', dedupKey = :dedupKey WHERE id = :id")
    suspend fun confirmReply(id: Long, dedupKey: String)

    /** Only moves forward from SENDING, so a confirmation that arrived first is not undone. */
    @Query("UPDATE messages SET status = :status WHERE id = :id AND status = 'SENDING'")
    suspend fun finishSending(id: Long, status: MessageStatus)

    @Query("UPDATE messages SET read = 1 WHERE conversationKey = :key AND read = 0")
    suspend fun markConversationRead(key: String): Int

    @Query("UPDATE conversations SET muted = :muted WHERE `key` = :key")
    suspend fun setMuted(key: String, muted: Boolean)

    @Query("UPDATE conversations SET lastRemovalReason = :reason WHERE `key` = :key")
    suspend fun setConversationRemoval(key: String, reason: Int)

    @Query("SELECT MAX(timeMs) FROM messages WHERE outgoing = 0")
    fun observeLastIncomingMessageMs(): Flow<Long?>

    @Query("SELECT * FROM mail ORDER BY receivedAtMs DESC")
    fun observeMail(): Flow<List<MailEntity>>

    @Query("SELECT * FROM mail WHERE `key` = :key")
    fun observeMailItem(key: String): Flow<MailEntity?>

    @Query("SELECT * FROM mail WHERE `key` = :key")
    suspend fun mail(key: String): MailEntity?

    @Upsert
    suspend fun upsertMail(mail: MailEntity)

    @Query("UPDATE mail SET read = 1 WHERE `key` = :key")
    suspend fun markMailRead(key: String)

    @Query("UPDATE mail SET requestedAction = :action WHERE `key` = :key")
    suspend fun setMailRequestedAction(key: String, action: MailAction)

    @Query("UPDATE mail SET lastRemovalReason = :reason WHERE `key` = :key")
    suspend fun setMailRemoval(key: String, reason: Int)

    @Query("SELECT MAX(receivedAtMs) FROM mail")
    fun observeLastMailMs(): Flow<Long?>
}
