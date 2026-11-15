package app.kainos.talk.listener

import app.kainos.talk.core.messageDedupKey
import kotlinx.coroutines.Dispatchers
import android.service.notification.StatusBarNotification
import android.util.Log
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.adapters.ChatAppAdapter
import app.kainos.talk.store.MessageStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The path from a listener callback to the store. Callbacks arrive on the main thread: the
 * snapshot and live handles are taken there, while the sbn is valid, and database writes go to
 * one sequential [writer] so they keep callback order.
 *
 * Logs carry package names and outcomes only, never titles, text or senders.
 */
class NotificationIngest(
    private val ownPackage: String,
    /** The SMS apps whose notifications are read. */
    private val packages: Set<String>,
    private val store: MessageStore,
    private val live: LiveNotifications,
    private val connection: ConnectionTracker,
    private val scope: CoroutineScope,
    private val writer: CoroutineDispatcher,
    private val images: NotificationImages? = null,
) {
    fun onConnected(active: List<StatusBarNotification>) {
        connection.connected()
        live.clear()
        active.forEach(::onPosted)
        Log.i(TAG, "connected; backfilled ${active.size} active notification(s)")
    }

    fun onDisconnected() {
        connection.disconnected()
        Log.i(TAG, "disconnected")
    }

    fun onPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == ownPackage || sbn.packageName !in packages) return
        val snapshot = SnapshotReader.read(sbn)
        val result = runCatching { ChatAppAdapter.parse(snapshot) }
            .getOrElse { ParseResult.Ignored("adapter error: ${it.javaClass.simpleName}") }
        val outcome = when (result) {
            is ParseResult.Chat -> "chat (${result.update.shape.name.lowercase()}, ${result.update.messages.size} message(s))"
            is ParseResult.Ignored -> "ignored: ${result.reason}"
        }
        Log.d(TAG, "${sbn.packageName}: $outcome")

        when (result) {
            is ParseResult.Chat -> {
                val update = result.update
                live.put(update.conversationKey, LiveEntry(LiveNotification.from(sbn), update.replyAction))
                scope.launch(writer) { store.applyChat(update) }
                // Copy pictures now: the source app's URI stops working once the notification goes.
                val pictures = update.messages.filter { it.dataUri != null }
                if (images != null && pictures.isNotEmpty()) {
                    scope.launch(Dispatchers.IO) {
                        for (message in pictures) images.save(messageDedupKey(update.conversationKey, message), message.dataUri!!)
                    }
                }
            }
            is ParseResult.Ignored -> Unit
        }
    }

    fun onRemoved(sbn: StatusBarNotification) {
        if (sbn.packageName == ownPackage || sbn.packageName !in packages) return
        live.removeBySbnKey(sbn.key)
    }

    private companion object {
        const val TAG = "KainosIngest"
    }
}
