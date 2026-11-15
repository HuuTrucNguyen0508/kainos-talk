package app.kainos.talk.ui

import android.content.Context
import android.content.Intent
import app.kainos.talk.core.DumpRecord
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.Source
import app.kainos.talk.hub.AccessState
import app.kainos.talk.hub.ActionFailure
import app.kainos.talk.hub.ActionResult
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.Inbox
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.ListenerHealth
import app.kainos.talk.hub.MailItem
import app.kainos.talk.hub.OpenResult
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

/** An in-memory hub for UI tests. It follows DefaultTalkHub's rules for unread counts and replies. */
class FakeTalkHub(
    override val sources: List<Source> = listOf(Source.WHATSAPP, Source.DISCORD, Source.MESSENGER, Source.SMS, Source.PROTON_MAIL),
    private val now: () -> Long = { 0L },
) : TalkHub {
    val chats = MutableStateFlow<List<InboxItem.Chat>>(emptyList())
    val threads = MutableStateFlow<Map<String, ChatThread>>(emptyMap())
    val mails = MutableStateFlow<Map<String, MailItem>>(emptyMap())
    val healthState = MutableStateFlow(ListenerHealth(true, true, 0L, null, null, null))
    val accessState = MutableStateFlow(AccessState(true, Intent("detail"), Intent("list"), Intent("app-info")))
    var installed: (String) -> Boolean = { true }

    /** What the next [sendReply] returns. */
    var nextReply: ReplyResult = ReplyResult.Sent
    val sentReplies = mutableListOf<Pair<String, String>>()
    val requestedMailActions = mutableListOf<Pair<String, MailAction>>()
    val opened = mutableListOf<String>()
    val readKeys = mutableListOf<String>()
    private var nextId = 10_000L

    override fun inbox(sourceIds: Set<String>?): Flow<Inbox> = combine(chats, mails) { chatList, mailMap ->
        val mailItems = mailMap.values.map {
            InboxItem.Mail(
                it.key, it.source, it.sender, it.senderHidden, it.subject, it.accountLabel, it.receivedAtMs,
                it.read, it.requestedAction, it.notificationLive,
            )
        }
        val items = (chatList + mailItems)
            .filter { sourceIds == null || it.source.id in sourceIds }
            .sortedByDescending { it.timeMs }
        val unread = items.filterNot { it is InboxItem.Chat && it.muted }
            .groupBy { it.source.id }
            .mapValues { (_, list) -> list.sumOf { it.unreadCount } }
        Inbox(items, unread)
    }

    override fun thread(conversationKey: String, limit: Int): Flow<ChatThread?> =
        threads.map { all -> all[conversationKey]?.let { it.copy(messages = it.messages.takeLast(limit)) } }

    override fun mailItem(mailKey: String): Flow<MailItem?> = mails.map { it[mailKey] }

    override fun isSourceAppInstalled(sourceId: String): Boolean = installed(sourceId)

    override val health: Flow<ListenerHealth> = healthState
    override val access: StateFlow<AccessState> = accessState

    override fun refreshAccess() = Unit

    override val dump: StateFlow<List<DumpRecord>> = MutableStateFlow(emptyList())

    override fun clearDump() = Unit

    override suspend fun sendReply(conversationKey: String, text: String): ReplyResult {
        sentReplies += conversationKey to text
        val result = nextReply
        val status = if (result is ReplyResult.Sent) MessageStatus.SENT else MessageStatus.FAILED
        threads.update { all ->
            val t = all[conversationKey] ?: return@update all
            val message = ThreadMessage(nextId++, null, text, now(), outgoing = true, status = status, media = null, read = true)
            all + (conversationKey to t.copy(messages = t.messages + message))
        }
        return result
    }

    override suspend fun markRead(conversationKey: String) {
        readKeys += conversationKey
    }

    override suspend fun markReadInApp(conversationKey: String): ActionResult = ActionResult.Requested

    override suspend fun setMuted(conversationKey: String, muted: Boolean) {
        threads.update { all -> all[conversationKey]?.let { all + (conversationKey to it.copy(muted = muted)) } ?: all }
        chats.update { list -> list.map { if (it.key == conversationKey) it.copy(muted = muted) else it } }
    }

    override suspend fun markMailRead(mailKey: String) {
        mails.update { all -> all[mailKey]?.let { all + (mailKey to it.copy(read = true)) } ?: all }
    }

    override suspend fun mailAction(mailKey: String, action: MailAction): ActionResult {
        val mail = mails.value[mailKey] ?: return ActionResult.Failed(ActionFailure.NOTIFICATION_GONE)
        if (mail.actions.none { it.action == action }) return ActionResult.Failed(ActionFailure.NOT_AVAILABLE)
        requestedMailActions += mailKey to action
        // Proton removes its notification after any action, so the buttons go with it.
        mails.update { it + (mailKey to mail.copy(requestedAction = action, actions = emptyList(), notificationLive = false)) }
        return ActionResult.Requested
    }

    override fun openInApp(context: Context, key: String): OpenResult {
        opened += key
        return OpenResult.OPENED_NOTIFICATION
    }
}
