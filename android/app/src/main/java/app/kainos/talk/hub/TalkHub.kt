package app.kainos.talk.hub

import android.content.Intent
import app.kainos.talk.core.MediaKind
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.sync.SenderKind
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/** [TalkHub.thread] with every message, not only the newest. */
const val ALL_MESSAGES = Int.MAX_VALUE

/**
 * The phone's texts as the PC sync and the screens see them. Neither touches notifications,
 * PendingIntents or the database directly.
 */
interface TalkHub {
    /** Every conversation, newest first. */
    fun inbox(): Flow<List<InboxChat>>

    /** A conversation and its messages; only the newest [limit] of them when one is given. */
    fun thread(conversationKey: String, limit: Int = ALL_MESSAGES): Flow<ChatThread?>

    /** Whether Android has the notification listener bound; texts stop arriving when it is not. */
    val listenerConnected: Flow<Boolean>

    /** Notification-access state for setup. Call [refreshAccess] when the UI resumes. */
    val access: StateFlow<AccessState>

    fun refreshAccess()

    /**
     * Sends [text] to the conversation: through the reply action of its live notification, or as
     * an SMS (see [SmsAwareHub]). A notification reply appears in the thread at once as SENDING,
     * then SENT, then CONFIRMED when the app's updated notification shows it, or FAILED.
     */
    suspend fun sendReply(conversationKey: String, text: String): ReplyResult

    /** Marks the conversation read. For texts in the SMS inbox, the inbox is told too. */
    suspend fun markRead(conversationKey: String)
}

/** One conversation in the list. */
data class InboxChat(
    val key: String,
    val title: String,
    val isGroup: Boolean,
    val timeMs: Long,
    val unreadCount: Int,
    val lastText: String?,
    val lastSender: String?,
    val sender: SenderKind = SenderKind.PERSON,
)

data class ChatThread(
    val key: String,
    val title: String,
    val isGroup: Boolean,
    val messages: List<ThreadMessage>,
    /** A reply can go out now: the notification's reply action is live, or the contact can be texted. */
    val canReply: Boolean,
    /** Incoming messages in this page that are not read yet. */
    val unread: Int = 0,
)

data class ThreadMessage(
    val id: Long,
    val senderName: String?,
    val text: String,
    val timeMs: Long,
    val outgoing: Boolean,
    val status: MessageStatus,
    val media: MediaKind?,
    val read: Boolean,
    /** A picture the PC can fetch (see SyncClient), when one was kept. */
    val imageId: String? = null,
    /** How the source app identified the sender (for texts, often its phone number). */
    val senderKey: String? = null,
)

sealed interface ReplyResult {
    data object Sent : ReplyResult
    data class Failed(val reason: ReplyFailure) : ReplyResult
}

enum class ReplyFailure {
    /** The SMS app's notification was removed, so there is no reply action to fire. */
    NOTIFICATION_GONE,

    /** The live notification has no free-form reply action. */
    NO_REPLY_ACTION,

    /** The conversation cannot be answered: no texting permission, no number, or not a text. */
    NOT_SUPPORTED,

    /** The SMS app cancelled the reply PendingIntent. */
    CANCELLED,

    EMPTY_TEXT,
}

data class AccessState(
    val listenerGranted: Boolean,
    /** Opens the app's own notification-access page (Android 11+). */
    val listenerDetailSettings: Intent,
    /** Opens the list of all notification-access apps. */
    val listenerListSettings: Intent,
    /** App info, where a sideloaded install shows "Allow restricted settings" in the menu. */
    val appInfoSettings: Intent,
    /** Exempt from battery optimisation, so the phone does not stop the listener and sync. */
    val runsInBackground: Boolean = true,
    /** Asks to be exempt from battery optimisation, then the general list as a fallback. */
    val backgroundSettings: List<Intent> = emptyList(),
    /** The phone maker's own autostart screen (Xiaomi), when it has one. */
    val autostartSettings: Intent? = null,
)
