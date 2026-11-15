package app.kainos.talk.store

import androidx.room.ColumnInfo
import androidx.room.Embedded
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MediaKind
import app.kainos.talk.core.Shape

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val key: String,
    val sourceId: String,
    val title: String,
    val isGroup: Boolean,
    val lastActivityMs: Long,
    val muted: Boolean = false,
    val shape: Shape,
    /** Why the conversation's notification was last removed, if it was. */
    val lastRemovalReason: Int? = null,
)

enum class MessageStatus {
    /** From someone else. */
    INCOMING,

    /** A reply typed in the hub, not handed to the source app yet. */
    SENDING,

    /** Handed to the source app's reply action; not yet seen in its notification. */
    SENT,

    /** The source app's updated notification showed this message as the user's own. */
    CONFIRMED,

    /** Could not be handed to the source app. */
    FAILED,
}

@Entity(
    tableName = "messages",
    indices = [Index(value = ["dedupKey"], unique = true), Index(value = ["conversationKey", "timeMs"])],
)
data class MessageEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val conversationKey: String,
    /** Hash of the message identity, or `local:<id>` for a hub reply not yet confirmed. */
    val dedupKey: String,
    val senderName: String?,
    val senderKey: String?,
    val text: String,
    val timeMs: Long,
    val outgoing: Boolean,
    val status: MessageStatus,
    val media: MediaKind?,
    val read: Boolean,
)

@Entity(tableName = "mail", indices = [Index(value = ["receivedAtMs"])])
data class MailEntity(
    @PrimaryKey val key: String,
    val sourceId: String,
    val accountKey: String,
    val accountLabel: String?,
    val sender: String?,
    val senderHidden: Boolean,
    val subject: String,
    val receivedAtMs: Long,
    val read: Boolean = false,
    /** The last action the user asked the source app to perform; the app does not report back. */
    val requestedAction: MailAction? = null,
    val shape: Shape,
    val lastRemovalReason: Int? = null,
)

/** A conversation with what the inbox row needs. */
data class ConversationRow(
    @Embedded val conversation: ConversationEntity,
    @ColumnInfo(name = "unreadCount") val unreadCount: Int,
    @ColumnInfo(name = "lastText") val lastText: String?,
    @ColumnInfo(name = "lastSender") val lastSender: String?,
    @ColumnInfo(name = "lastOutgoing") val lastOutgoing: Boolean?,
    @ColumnInfo(name = "lastMedia") val lastMedia: MediaKind?,
)
