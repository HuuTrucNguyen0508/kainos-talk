package app.kainos.talk.listener

import app.kainos.talk.core.messageDedupKey
import kotlinx.coroutines.Dispatchers
import android.service.notification.StatusBarNotification
import android.util.Log
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.WatchedApps
import app.kainos.talk.store.MessageStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The path from a listener callback to the store. Callbacks arrive on the main thread: the
 * snapshot and live handles are taken there, while the sbn is valid, and database writes go to
 * one sequential [writer] so a removal never overtakes the post before it.
 *
 * Logs carry package names and outcomes only, never titles, text, senders or subjects.
 */
class NotificationIngest(
    private val ownPackage: String,
    private val watched: WatchedApps,
    private val store: MessageStore,
    private val live: LiveNotifications,
    private val dump: NotificationDumpLog,
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
        if (sbn.packageName == ownPackage) return
        val app = watched[sbn.packageName] ?: return
        connection.notificationSeen()
        val snapshot = SnapshotReader.read(sbn)
        val result = runCatching { app.adapter.parse(snapshot) }
            .getOrElse { ParseResult.Ignored("adapter error: ${it.javaClass.simpleName}") }
        val outcome = when (result) {
            is ParseResult.Chat -> "chat (${result.update.shape.name.lowercase()}, ${result.update.messages.size} message(s))"
            is ParseResult.Mail -> "mail (${result.update.shape.name.lowercase()}, ${result.update.actions.size} action(s))"
            is ParseResult.Ignored -> "ignored: ${result.reason}"
        }
        dump.record(snapshot, outcome)
        Log.d(TAG, "${sbn.packageName}: $outcome")

        when (result) {
            is ParseResult.Chat -> {
                val update = result.update
                live.put(
                    update.conversationKey,
                    LiveEntry(TargetKind.CHAT, LiveNotification.from(sbn), update.replyAction, update.markReadAction),
                )
                scope.launch(writer) { store.applyChat(update) }
                // Copy pictures now: the source app's URI stops working once the notification goes.
                val pictures = update.messages.filter { it.dataUri != null }
                if (images != null && pictures.isNotEmpty()) {
                    scope.launch(Dispatchers.IO) {
                        for (message in pictures) images.save(messageDedupKey(update.conversationKey, message), message.dataUri!!)
                    }
                }
            }
            is ParseResult.Mail -> {
                val update = result.update
                live.put(update.mailKey, LiveEntry(TargetKind.MAIL, LiveNotification.from(sbn), mailActions = update.actions))
                scope.launch(writer) { store.applyMail(update) }
            }
            is ParseResult.Ignored -> Unit
        }
    }

    fun onRemoved(sbn: StatusBarNotification, reason: Int) {
        if (sbn.packageName == ownPackage || watched[sbn.packageName] == null) return
        dump.removed(sbn.key, reason)
        val gone = live.removeBySbnKey(sbn.key)
        if (gone.isEmpty()) return
        scope.launch(writer) {
            gone.forEach { (key, entry) ->
                when (entry.kind) {
                    TargetKind.CHAT -> store.conversationRemoved(key, reason)
                    TargetKind.MAIL -> store.mailRemoved(key, reason)
                }
            }
        }
    }

    private companion object {
        const val TAG = "KainosIngest"
    }
}
