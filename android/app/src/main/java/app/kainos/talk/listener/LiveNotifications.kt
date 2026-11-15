package app.kainos.talk.listener

import android.app.Notification
import android.service.notification.StatusBarNotification
import app.kainos.talk.core.ActionRef
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** The live parts of a posted notification. PendingIntents cannot be stored, so this stays in memory. */
class LiveNotification(
    val sbnKey: String,
    private val actions: List<Notification.Action?>,
    private val wearableActions: List<Notification.Action>,
) {
    fun action(ref: ActionRef): Notification.Action? =
        (if (ref.fromWearable) wearableActions else actions).getOrNull(ref.index)

    companion object {
        fun from(sbn: StatusBarNotification) = LiveNotification(
            sbnKey = sbn.key,
            actions = sbn.notification.actions.orEmpty().toList(),
            wearableActions = SnapshotReader.wearableActions(sbn.notification),
        )
    }
}

/** The live notification currently behind one conversation, and its reply action. */
data class LiveEntry(val notification: LiveNotification, val replyAction: ActionRef? = null)

/**
 * Live handles keyed by conversation key. When a notification is removed its handle leaves
 * [entries], so a reply reports "notification gone".
 */
class LiveNotifications {
    private val state = MutableStateFlow<Map<String, LiveEntry>>(emptyMap())

    val entries: StateFlow<Map<String, LiveEntry>> = state

    operator fun get(targetKey: String): LiveEntry? = state.value[targetKey]

    fun put(targetKey: String, entry: LiveEntry) {
        state.update { it + (targetKey to entry) }
    }

    /** Removes every target whose current notification has [sbnKey]; returns the removed targets. */
    fun removeBySbnKey(sbnKey: String): Map<String, LiveEntry> {
        var gone: Map<String, LiveEntry> = emptyMap()
        state.update { current ->
            gone = current.filterValues { it.notification.sbnKey == sbnKey }
            current - gone.keys
        }
        return gone
    }

    /** On reconnect: drop all handles before backfilling from the active notifications. */
    fun clear() {
        state.value = emptyMap()
    }
}
