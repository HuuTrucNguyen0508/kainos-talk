package app.kainos.talk.hub

import android.content.Context
import android.content.Intent
import app.kainos.talk.core.DumpRecord
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MediaKind
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.store.MessageStatus
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/** [TalkHub.thread] with every message, not only the newest. */
const val ALL_MESSAGES = Int.MAX_VALUE

/**
 * Everything the UI needs from the hub. The UI never touches notifications, PendingIntents or
 * the database directly.
 */
interface TalkHub {
    /** The accounts the hub reads, in display order. */
    val sources: List<Source>

    /** Chats and mail in one list, newest first. [sourceIds] null means every source. */
    fun inbox(sourceIds: Set<String>? = null): Flow<Inbox>

    /** A conversation and its messages; only the newest [limit] of them when one is given. */
    fun thread(conversationKey: String, limit: Int = ALL_MESSAGES): Flow<ChatThread?>

    fun mailItem(mailKey: String): Flow<MailItem?>

    /** Whether the real app behind a source is installed, for onboarding. */
    fun isSourceAppInstalled(sourceId: String): Boolean

    val health: Flow<ListenerHealth>

    /** Notification-access state for onboarding. Call [refreshAccess] when the UI resumes. */
    val access: StateFlow<AccessState>

    fun refreshAccess()

    /** Recent notifications from watched apps, newest first, for the dump screen. */
    val dump: StateFlow<List<DumpRecord>>

    fun clearDump()

    /**
     * Hands [text] to the source app through the reply action of the conversation's live
     * notification. The message appears in the thread at once as SENDING, then SENT, then
     * CONFIRMED when the app's updated notification shows it, or FAILED.
     */
    suspend fun sendReply(conversationKey: String, text: String): ReplyResult

    /** Clears the hub's unread count only. The source app is not told. */
    suspend fun markRead(conversationKey: String)

    /**
     * Fires the source app's own "mark as read" action. For WhatsApp this sends read receipts,
     * so only call it on an explicit user action.
     */
    suspend fun markReadInApp(conversationKey: String): ActionResult

    suspend fun setMuted(conversationKey: String, muted: Boolean)

    /** Clears the hub's unread flag for a mail item only. */
    suspend fun markMailRead(mailKey: String)

    /**
     * Fires Proton's Archive, Trash or Mark read action. Proton reports no result, so success
     * means "requested": the item shows [MailItem.requestedAction] afterwards.
     */
    suspend fun mailAction(mailKey: String, action: MailAction): ActionResult

    /**
     * Opens the real app at the conversation or mail, through the notification's content
     * intent, or the app's launcher screen when that is gone. Call it from a visible activity:
     * Android blocks background activity starts, silently.
     */
    fun openInApp(context: Context, key: String): OpenResult
}

data class Inbox(
    val items: List<InboxItem>,
    /** Unread counts per source id, not counting muted conversations. */
    val unreadBySource: Map<String, Int>,
) {
    val totalUnread: Int get() = unreadBySource.values.sum()
}

sealed interface InboxItem {
    val key: String
    val source: Source
    val timeMs: Long
    val unreadCount: Int

    data class Chat(
        override val key: String,
        override val source: Source,
        val title: String,
        val isGroup: Boolean,
        override val timeMs: Long,
        override val unreadCount: Int,
        val muted: Boolean,
        val lastText: String?,
        val lastSender: String?,
        val lastOutgoing: Boolean,
        val lastMedia: MediaKind?,
        /** The source app's notification for this chat is still posted. */
        val notificationLive: Boolean,
    ) : InboxItem

    data class Mail(
        override val key: String,
        override val source: Source,
        val sender: String?,
        val senderHidden: Boolean,
        val subject: String,
        val accountLabel: String?,
        override val timeMs: Long,
        val read: Boolean,
        val requestedAction: MailAction?,
        val notificationLive: Boolean,
    ) : InboxItem {
        override val unreadCount: Int get() = if (read) 0 else 1
    }
}

data class ChatThread(
    val key: String,
    val source: Source,
    val title: String,
    val isGroup: Boolean,
    val muted: Boolean,
    val shape: Shape,
    val messages: List<ThreadMessage>,
    val capabilities: ChatCapabilities,
    /** Why the source app's notification went away (NotificationListenerService.REASON_*), if it did. */
    val notificationRemovedReason: Int?,
    /** Incoming messages in this page that are not read yet; opening the thread reads them. */
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

data class ChatCapabilities(
    val canReply: Boolean,
    /** Why [canReply] is false, for the UI to explain; null when replying works. */
    val replyBlocked: ReplyFailure?,
    val canMarkReadInApp: Boolean,
)

data class MailItem(
    val key: String,
    val source: Source,
    val accountKey: String,
    val accountLabel: String?,
    val sender: String?,
    val senderHidden: Boolean,
    val subject: String,
    val receivedAtMs: Long,
    val read: Boolean,
    val requestedAction: MailAction?,
    val notificationLive: Boolean,
    /** Actions the live notification offers, with the source app's own titles. Empty when gone. */
    val actions: List<AvailableMailAction>,
    val shape: Shape,
)

data class AvailableMailAction(val action: MailAction, val title: String?)

sealed interface ReplyResult {
    data object Sent : ReplyResult
    data class Failed(val reason: ReplyFailure) : ReplyResult
}

enum class ReplyFailure {
    /** The source app's notification was removed, so there is no reply action to fire. */
    NOTIFICATION_GONE,

    /** The live notification has no free-form reply action. */
    NO_REPLY_ACTION,

    /** This source never offers replies (Proton Mail). */
    NOT_SUPPORTED,

    /** The source app cancelled the reply PendingIntent. */
    CANCELLED,

    EMPTY_TEXT,
}

sealed interface ActionResult {
    data object Requested : ActionResult
    data class Failed(val reason: ActionFailure) : ActionResult
}

enum class ActionFailure { NOTIFICATION_GONE, NOT_AVAILABLE, CANCELLED }

enum class OpenResult {
    /** The notification's own content intent was sent; it should land on the exact chat or mail. */
    OPENED_NOTIFICATION,

    /** Fell back to the app's launcher screen. */
    OPENED_APP,

    /** The source app is not installed or has no launcher screen. */
    NOT_AVAILABLE,
}

data class ListenerHealth(
    val accessGranted: Boolean,
    val connected: Boolean,
    val connectedSinceMs: Long?,
    val lastDisconnectedMs: Long?,
    /** Last notification from any watched app, including ones the hub ignored. */
    val lastNotificationMs: Long?,
    /** Newest incoming chat message or mail stored. */
    val lastMessageMs: Long?,
)

data class AccessState(
    val listenerGranted: Boolean,
    /** Opens the hub's own notification-access page (Android 11+). */
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
