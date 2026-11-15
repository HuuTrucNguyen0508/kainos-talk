package app.kainos.talk.core

/**
 * A plain, immutable copy of what the hub needs from one posted notification.
 *
 * The listener builds it from a `StatusBarNotification` at the boundary; everything past that
 * point (adapter, store) works on this type only, so it runs on the JVM without Android.
 * Live handles (PendingIntents, actions) are not here: they stay in memory in the listener layer.
 */
data class NotificationSnapshot(
    val packageName: String,
    val userId: Int,
    val key: String,
    val id: Int,
    val tag: String?,
    val postTimeMs: Long,
    /** `Notification.when`; apps usually set it to the newest message time. */
    val whenMs: Long,
    val channelId: String?,
    val category: String?,
    val flags: Int,
    val groupKey: String?,
    val group: String?,
    val sortKey: String?,
    val shortcutId: String?,
    /** `android.template`, for example `android.app.Notification$MessagingStyle`. */
    val template: String?,
    val title: String?,
    val text: String?,
    val subText: String?,
    val bigText: String?,
    val textLines: List<String>,
    val tickerText: String?,
    val conversationTitle: String?,
    val isGroupConversation: Boolean,
    /** The device user's own name as the posting app gave it (MessagingStyle user). */
    val selfName: String?,
    /** MessagingStyle messages, oldest first; empty when the notification has none. */
    val messages: List<SnapshotMessage>,
    /** `notification.actions`, in order. */
    val actions: List<SnapshotAction>,
    /** Actions found only in the WearableExtender bundle. */
    val wearableActions: List<SnapshotAction>,
    val hasContentIntent: Boolean,
) {
    fun hasFlag(flag: Int): Boolean = flags and flag != 0
}

data class SnapshotMessage(
    val text: String?,
    val timeMs: Long,
    /** Null when the posting app marked the message as the device user's own. */
    val senderName: String?,
    val senderKey: String?,
    val isSelf: Boolean,
    val dataMimeType: String? = null,
    val dataUri: String? = null,
)

data class SnapshotAction(
    val index: Int,
    val title: String?,
    val semanticAction: Int,
    val showsUserInterface: Boolean,
    val remoteInputs: List<SnapshotRemoteInput>,
    val fromWearable: Boolean = false,
)

data class SnapshotRemoteInput(
    val resultKey: String,
    val label: String?,
    val allowFreeFormInput: Boolean,
    val choiceCount: Int,
)

/** Values copied from `android.app.Notification`; a unit test checks they still match. */
object NotificationFlags {
    const val ONGOING_EVENT = 0x2
    const val FOREGROUND_SERVICE = 0x40
    const val LOCAL_ONLY = 0x100
    const val GROUP_SUMMARY = 0x200
}

/** Values copied from `android.app.Notification.Action`. */
object SemanticAction {
    const val NONE = 0
    const val REPLY = 1
    const val MARK_AS_READ = 2
}
