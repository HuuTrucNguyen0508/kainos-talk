package app.kainos.talk.listener

import android.app.Notification
import android.app.PendingIntent
import android.service.notification.StatusBarNotification
import app.kainos.talk.core.ActionRef
import app.kainos.talk.core.MailActionRef
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** The live parts of a posted notification. PendingIntents cannot be stored, so this stays in memory. */
class LiveNotification(
    val sbnKey: String,
    val packageName: String,
    val contentIntent: PendingIntent?,
    private val actions: List<Notification.Action?>,
    private val wearableActions: List<Notification.Action>,
) {
    fun action(ref: ActionRef): Notification.Action? =
        (if (ref.fromWearable) wearableActions else actions).getOrNull(ref.index)

    companion object {
        fun from(sbn: StatusBarNotification) = LiveNotification(
            sbnKey = sbn.key,
            packageName = sbn.packageName,
            contentIntent = sbn.notification.contentIntent,
            actions = sbn.notification.actions.orEmpty().toList(),
            wearableActions = SnapshotReader.wearableActions(sbn.notification),
        )
    }
}

enum class TargetKind { CHAT, MAIL }

/** The live notification currently behind one conversation or mail item, and what it can do. */
data class LiveEntry(
    val kind: TargetKind,
    val notification: LiveNotification,
    val replyAction: ActionRef? = null,
    val markReadAction: ActionRef? = null,
    val mailActions: List<MailActionRef> = emptyList(),
)

/**
 * Live handles keyed by conversation or mail key. When a notification is removed its handle
 * leaves [entries] (so reply and actions report "notification gone"), but its content intent is
 * kept in [lastKnown] because "Open" may still work with it.
 */
class LiveNotifications {
    private val state = MutableStateFlow<Map<String, LiveEntry>>(emptyMap())
    private val removed = HashMap<String, LiveNotification>()

    val entries: StateFlow<Map<String, LiveEntry>> = state

    operator fun get(targetKey: String): LiveEntry? = state.value[targetKey]

    fun put(targetKey: String, entry: LiveEntry) {
        synchronized(removed) { removed.remove(targetKey) }
        state.update { it + (targetKey to entry) }
    }

    /** Removes every target whose current notification has [sbnKey]; returns the removed targets. */
    fun removeBySbnKey(sbnKey: String): Map<String, LiveEntry> {
        var gone: Map<String, LiveEntry> = emptyMap()
        state.update { current ->
            gone = current.filterValues { it.notification.sbnKey == sbnKey }
            current - gone.keys
        }
        synchronized(removed) { gone.forEach { (k, v) -> removed[k] = v.notification } }
        return gone
    }

    fun lastKnown(targetKey: String): LiveNotification? =
        state.value[targetKey]?.notification ?: synchronized(removed) { removed[targetKey] }

    /** On reconnect: drop all handles before backfilling from the active notifications. */
    fun clear() {
        val all = state.value
        synchronized(removed) { all.forEach { (k, v) -> removed[k] = v.notification } }
        state.value = emptyMap()
    }
}
