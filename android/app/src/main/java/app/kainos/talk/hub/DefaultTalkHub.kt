package app.kainos.talk.hub

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import app.kainos.talk.core.SMS_SOURCE
import app.kainos.talk.listener.ConnectionTracker
import app.kainos.talk.listener.KainosNotificationListener
import app.kainos.talk.listener.LiveEntry
import app.kainos.talk.listener.LiveNotifications
import app.kainos.talk.listener.NotificationImages
import app.kainos.talk.store.MessageStore
import app.kainos.talk.store.TalkDao
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/** Conversations known from the SMS app's notifications, as the database and the live notifications hold them. */
class DefaultTalkHub(
    private val context: Context,
    private val dao: TalkDao,
    private val store: MessageStore,
    private val live: LiveNotifications,
    connection: ConnectionTracker,
    private val writer: CoroutineDispatcher,
    private val images: NotificationImages? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : TalkHub {

    override fun inbox(): Flow<List<InboxChat>> =
        dao.observeConversationRows().map { rows ->
            rows.map { row ->
                val c = row.conversation
                InboxChat(c.key, c.title, c.isGroup, c.lastActivityMs, row.unreadCount, row.lastText, row.lastSender)
            }
        }

    override fun thread(conversationKey: String, limit: Int): Flow<ChatThread?> {
        val messageRows = if (limit == ALL_MESSAGES) dao.observeMessages(conversationKey) else dao.observeLatestMessages(conversationKey, limit)
        return combine(
            dao.observeConversation(conversationKey), messageRows,
            live.entries.map { it[conversationKey] }.distinctUntilChanged(), images?.changes ?: flowOf(0L),
        ) { c, messages, entry, _ ->
            // Rows older versions stored for other apps share the table; they are not texts.
            if (c == null || c.sourceId != SMS_SOURCE) return@combine null
            ChatThread(
                key = c.key,
                title = c.title,
                isGroup = c.isGroup,
                messages = messages.map {
                    ThreadMessage(it.id, it.senderName, it.text, it.timeMs, it.outgoing, it.status, it.media, it.read, images?.idFor(it.dedupKey), it.senderKey)
                },
                canReply = entry?.replyAction != null,
                unread = messages.count { !it.outgoing && !it.read },
            )
        }
    }

    private val accessState = MutableStateFlow(currentAccess())
    override val access: StateFlow<AccessState> = accessState

    override fun refreshAccess() {
        accessState.value = currentAccess()
    }

    override val listenerConnected: Flow<Boolean> = connection.connected

    override suspend fun sendReply(conversationKey: String, text: String): ReplyResult = withContext(writer) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@withContext ReplyResult.Failed(ReplyFailure.EMPTY_TEXT)
        if (dao.conversation(conversationKey)?.sourceId != SMS_SOURCE) return@withContext ReplyResult.Failed(ReplyFailure.NOT_SUPPORTED)
        val localId = store.addLocalReply(conversationKey, trimmed, clock())
        val failure = fireReply(live[conversationKey], trimmed)
        store.finishReply(localId, sent = failure == null)
        if (failure == null) ReplyResult.Sent else ReplyResult.Failed(failure)
    }

    private fun fireReply(entry: LiveEntry?, text: String): ReplyFailure? {
        entry ?: return ReplyFailure.NOTIFICATION_GONE
        val ref = entry.replyAction ?: return ReplyFailure.NO_REPLY_ACTION
        val action = entry.notification.action(ref) ?: return ReplyFailure.NO_REPLY_ACTION
        val inputs = action.remoteInputs?.filterNotNull()?.takeIf { it.isNotEmpty() } ?: return ReplyFailure.NO_REPLY_ACTION
        val pending = action.actionIntent ?: return ReplyFailure.NO_REPLY_ACTION
        val results = Bundle().apply {
            inputs.filter { it.allowFreeFormInput }.forEach { putCharSequence(it.resultKey, text) }
        }
        val fillIn = Intent()
        RemoteInput.addResultsToIntent(inputs.toTypedArray(), fillIn, results)
        RemoteInput.setResultsSource(fillIn, RemoteInput.SOURCE_FREE_FORM_INPUT)
        return try {
            pending.send(context, 0, fillIn)
            null
        } catch (_: PendingIntent.CanceledException) {
            ReplyFailure.CANCELLED
        }
    }

    override suspend fun markRead(conversationKey: String) {
        withContext(writer) { store.markConversationRead(conversationKey) }
    }

    private fun currentAccess(): AccessState {
        val component = ComponentName(context, KainosNotificationListener::class.java)
        val manager = context.getSystemService(NotificationManager::class.java)
        return AccessState(
            listenerGranted = manager.isNotificationListenerAccessGranted(component),
            listenerDetailSettings = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString()),
            listenerListSettings = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
            appInfoSettings = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", context.packageName, null)),
            runsInBackground = context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName),
            backgroundSettings = listOf(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.fromParts("package", context.packageName, null)),
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            ),
            autostartSettings = Intent().setClassName(XIAOMI_SECURITY, XIAOMI_AUTOSTART)
                .takeIf { context.packageManager.resolveActivity(it, 0) != null },
        )
    }
}

private const val XIAOMI_SECURITY = "com.miui.securitycenter"
private const val XIAOMI_AUTOSTART = "com.miui.permcenter.autostart.AutoStartManagementActivity"
