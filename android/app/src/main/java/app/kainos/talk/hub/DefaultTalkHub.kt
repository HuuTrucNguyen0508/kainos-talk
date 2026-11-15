package app.kainos.talk.hub

import app.kainos.talk.listener.NotificationImages
import android.app.Activity
import android.app.ActivityOptions
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import app.kainos.talk.core.DumpRecord
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.Source
import app.kainos.talk.core.SourceKind
import app.kainos.talk.core.WatchedApps
import app.kainos.talk.listener.ConnectionTracker
import app.kainos.talk.listener.KainosNotificationListener
import app.kainos.talk.listener.LiveEntry
import app.kainos.talk.listener.LiveNotifications
import app.kainos.talk.listener.NotificationDumpLog
import app.kainos.talk.store.MessageStore
import app.kainos.talk.store.TalkDao
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext

class DefaultTalkHub(
    private val context: Context,
    private val watched: WatchedApps,
    private val dao: TalkDao,
    private val store: MessageStore,
    private val live: LiveNotifications,
    private val dumpLog: NotificationDumpLog,
    private val connection: ConnectionTracker,
    private val writer: CoroutineDispatcher,
    private val images: NotificationImages? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : TalkHub {

    override val sources: List<Source> = watched.sources

    private fun source(id: String): Source =
        watched.sourceById(id) ?: Source(id, id, SourceKind.CHAT, canReply = false, hasMailActions = false)

    override fun inbox(sourceIds: Set<String>?): Flow<Inbox> =
        combine(dao.observeConversationRows(), dao.observeMail(), live.entries) { rows, mail, liveEntries ->
            val chats = rows.map { row ->
                val c = row.conversation
                InboxItem.Chat(
                    key = c.key,
                    source = source(c.sourceId),
                    title = c.title,
                    isGroup = c.isGroup,
                    timeMs = c.lastActivityMs,
                    unreadCount = row.unreadCount,
                    muted = c.muted,
                    lastText = row.lastText,
                    lastSender = row.lastSender,
                    lastOutgoing = row.lastOutgoing ?: false,
                    lastMedia = row.lastMedia,
                    notificationLive = c.key in liveEntries,
                )
            }
            val mails = mail.map { m ->
                InboxItem.Mail(
                    key = m.key,
                    source = source(m.sourceId),
                    sender = m.sender,
                    senderHidden = m.senderHidden,
                    subject = m.subject,
                    accountLabel = m.accountLabel,
                    timeMs = m.receivedAtMs,
                    read = m.read,
                    requestedAction = m.requestedAction,
                    notificationLive = m.key in liveEntries,
                )
            }
            val items = (chats + mails)
                .filter { sourceIds == null || it.source.id in sourceIds }
                .sortedByDescending { it.timeMs }
            val unread = items
                .filterNot { it is InboxItem.Chat && it.muted }
                .groupBy { it.source.id }
                .mapValues { (_, list) -> list.sumOf { it.unreadCount } }
            Inbox(items, unread)
        }

    override fun thread(conversationKey: String, limit: Int): Flow<ChatThread?> {
        val messageRows = if (limit == ALL_MESSAGES) dao.observeMessages(conversationKey) else dao.observeLatestMessages(conversationKey, limit)
        return combine(
            dao.observeConversation(conversationKey), messageRows,
            live.entries.map { it[conversationKey] }.distinctUntilChanged(), images?.changes ?: flowOf(0L),
        ) { c, messages, entry, _ ->
            c ?: return@combine null
            val src = source(c.sourceId)
            val replyBlocked = when {
                !src.canReply -> ReplyFailure.NOT_SUPPORTED
                entry == null -> ReplyFailure.NOTIFICATION_GONE
                entry.replyAction == null -> ReplyFailure.NO_REPLY_ACTION
                else -> null
            }
            ChatThread(
                key = c.key,
                source = src,
                title = c.title,
                isGroup = c.isGroup,
                muted = c.muted,
                shape = c.shape,
                messages = messages.map {
                    ThreadMessage(it.id, it.senderName, it.text, it.timeMs, it.outgoing, it.status, it.media, it.read, images?.idFor(it.dedupKey), it.senderKey)
                },
                capabilities = ChatCapabilities(
                    canReply = replyBlocked == null,
                    replyBlocked = replyBlocked,
                    canMarkReadInApp = entry?.markReadAction != null,
                ),
                notificationRemovedReason = c.lastRemovalReason,
                unread = messages.count { !it.outgoing && !it.read },
            )
        }
    }

    override fun mailItem(mailKey: String): Flow<MailItem?> =
        combine(dao.observeMailItem(mailKey), live.entries.map { it[mailKey] }.distinctUntilChanged()) { m, entry ->
            m ?: return@combine null
            MailItem(
                key = m.key,
                source = source(m.sourceId),
                accountKey = m.accountKey,
                accountLabel = m.accountLabel,
                sender = m.sender,
                senderHidden = m.senderHidden,
                subject = m.subject,
                receivedAtMs = m.receivedAtMs,
                read = m.read,
                requestedAction = m.requestedAction,
                notificationLive = entry != null,
                actions = entry?.mailActions.orEmpty().map { AvailableMailAction(it.action, it.ref.title) },
                shape = m.shape,
            )
        }

    override fun isSourceAppInstalled(sourceId: String): Boolean =
        packagesFor(sourceId).any { context.packageManager.getLaunchIntentForPackage(it) != null }

    private fun packagesFor(sourceId: String): List<String> =
        watched.packages.filter { watched[it]?.source?.id == sourceId }

    private val accessState = MutableStateFlow(currentAccess())
    override val access: StateFlow<AccessState> = accessState

    override fun refreshAccess() {
        accessState.value = currentAccess()
    }

    override val health: Flow<ListenerHealth> = combine(
        connection.connection,
        accessState,
        dao.observeLastIncomingMessageMs(),
        dao.observeLastMailMs(),
    ) { conn, access, lastChat, lastMail ->
        ListenerHealth(
            accessGranted = access.listenerGranted,
            connected = conn.connected,
            connectedSinceMs = conn.connectedSinceMs,
            lastDisconnectedMs = conn.lastDisconnectedMs,
            lastNotificationMs = conn.lastNotificationMs,
            lastMessageMs = listOfNotNull(lastChat, lastMail).maxOrNull(),
        )
    }

    override val dump: StateFlow<List<DumpRecord>> = dumpLog.records

    override fun clearDump() = dumpLog.clear()

    override suspend fun sendReply(conversationKey: String, text: String): ReplyResult = withContext(writer) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@withContext ReplyResult.Failed(ReplyFailure.EMPTY_TEXT)
        val conversation = dao.conversation(conversationKey)
        if (conversation != null && !source(conversation.sourceId).canReply) {
            return@withContext ReplyResult.Failed(ReplyFailure.NOT_SUPPORTED)
        }
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

    override suspend fun markReadInApp(conversationKey: String): ActionResult = withContext(writer) {
        val entry = live[conversationKey] ?: return@withContext ActionResult.Failed(ActionFailure.NOTIFICATION_GONE)
        val ref = entry.markReadAction ?: return@withContext ActionResult.Failed(ActionFailure.NOT_AVAILABLE)
        val result = fire(entry.notification.action(ref))
        if (result == ActionResult.Requested) store.markConversationRead(conversationKey)
        result
    }

    override suspend fun setMuted(conversationKey: String, muted: Boolean) {
        withContext(writer) { store.setMuted(conversationKey, muted) }
    }

    override suspend fun markMailRead(mailKey: String) {
        withContext(writer) { store.markMailRead(mailKey) }
    }

    override suspend fun mailAction(mailKey: String, action: MailAction): ActionResult = withContext(writer) {
        val entry = live[mailKey] ?: return@withContext ActionResult.Failed(ActionFailure.NOTIFICATION_GONE)
        val ref = entry.mailActions.firstOrNull { it.action == action }?.ref
            ?: return@withContext ActionResult.Failed(ActionFailure.NOT_AVAILABLE)
        val result = fire(entry.notification.action(ref))
        if (result == ActionResult.Requested) store.setMailRequestedAction(mailKey, action)
        result
    }

    private fun fire(action: Notification.Action?): ActionResult {
        val pending = action?.actionIntent ?: return ActionResult.Failed(ActionFailure.NOT_AVAILABLE)
        return try {
            pending.send()
            ActionResult.Requested
        } catch (_: PendingIntent.CanceledException) {
            ActionResult.Failed(ActionFailure.CANCELLED)
        }
    }

    override fun openInApp(context: Context, key: String): OpenResult {
        val known = live.lastKnown(key)
        known?.contentIntent?.let { pending ->
            try {
                pending.send(context, 0, null, null, null, null, backgroundStartOptions())
                return OpenResult.OPENED_NOTIFICATION
            } catch (_: PendingIntent.CanceledException) {
                // Fall through to the launcher screen.
            }
        }
        val packageName = known?.packageName ?: packageForKey(key) ?: return OpenResult.NOT_AVAILABLE
        val launch = context.packageManager.getLaunchIntentForPackage(packageName) ?: return OpenResult.NOT_AVAILABLE
        if (context !is Activity) launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(launch)
        return OpenResult.OPENED_APP
    }

    /**
     * Conversation and mail keys start with the source id; map it back to the app's package. A
     * source read from several packages (SMS) opens the first one that is installed, which is
     * the default SMS app.
     */
    private fun packageForKey(key: String): String? =
        packagesFor(key.substringBefore('|')).firstOrNull { context.packageManager.getLaunchIntentForPackage(it) != null }

    /** Opts in to starting the other app's activity, which Android 14+ requires from the sender. */
    @Suppress("DEPRECATION")
    private fun backgroundStartOptions(): Bundle? = when {
        Build.VERSION.SDK_INT >= 36 -> ActivityOptions.makeBasic()
            .setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE)
            .toBundle()
        Build.VERSION.SDK_INT >= 34 -> ActivityOptions.makeBasic()
            .setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
            .toBundle()
        else -> null
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
