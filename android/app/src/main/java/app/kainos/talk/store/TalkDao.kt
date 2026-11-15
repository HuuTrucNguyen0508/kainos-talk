package app.kainos.talk.store

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import app.kainos.talk.core.SMS_SOURCE
import kotlinx.coroutines.flow.Flow

@Dao
interface TalkDao {

    @Query(
        """
        SELECT c.*,
          (SELECT COUNT(*) FROM messages m WHERE m.conversationKey = c.`key` AND m.read = 0 AND m.outgoing = 0) AS unreadCount,
          (SELECT m.text FROM messages m WHERE m.conversationKey = c.`key` ORDER BY m.timeMs DESC, m.id DESC LIMIT 1) AS lastText,
          (SELECT m.senderName FROM messages m WHERE m.conversationKey = c.`key` ORDER BY m.timeMs DESC, m.id DESC LIMIT 1) AS lastSender
        FROM conversations c
        WHERE c.sourceId = :sourceId
        ORDER BY c.lastActivityMs DESC
        """,
    )
    fun observeConversationRows(sourceId: String = SMS_SOURCE): Flow<List<ConversationRow>>

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
}
