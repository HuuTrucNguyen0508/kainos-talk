package app.kainos.talk.hub

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.retryWhen
import app.kainos.talk.core.MediaKind
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.sync.PhoneNumbers
import app.kainos.talk.sync.SmsInbox
import app.kainos.talk.sync.SmsStore
import app.kainos.talk.sync.SyncConversation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.shareIn
import kotlinx.coroutines.withContext
import kotlin.math.abs

/**
 * One view of texts for the PC, one conversation per contact.
 *
 * With SMS access, SMS conversations come from Android's SMS inbox and replies go out as texts
 * from this phone, so a reply sent from the phone, the PC or the SMS app shows everywhere.
 * Conversations known only from the SMS app's notifications (RCS chats in Google Messages) are
 * folded into the inbox conversation with the same phone number. One with no inbox match stays
 * on its own; it replies through its notification while that is up, and as an SMS to the
 * contact's number once it is gone. Without access, this is [base] unchanged.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SmsAwareHub(private val base: TalkHub, private val sms: SmsStore, scope: CoroutineScope) : TalkHub by base {

    /** A conversation from notifications, with the phone number it belongs to when one is known. */
    private data class Notified(val chat: InboxChat, val thread: ChatThread?, val number: String?)

    /**
     * Shared, so the inbox and every SMS conversation read the notified chats once per change, not
     * once each. Nothing is replayed once no one listens, so a later [first] is never stale.
     */
    private val notified: Flow<List<Notified>> =
        base.inbox()
            .flatMapLatest { chats ->
                if (chats.isEmpty()) flowOf(emptyList()) else combine(chats.map { base.thread(it.key) }) { threads ->
                    chats.zip(threads.toList()).map { (chat, thread) -> Notified(chat, thread, numberOf(chat, thread)) }
                }
            }
            .recover()
            .shareIn(scope, SharingStarted.WhileSubscribed(5_000, replayExpirationMillis = 0), replay = 1)

    private data class SmsSnapshot(
        val texts: List<SyncConversation>,
        val notified: List<Notified>,
        val owners: Map<String, String>,
    )

    /** The join and its inputs travel together so consumers cannot use an owner from another read. */
    private val snapshot: Flow<SmsSnapshot> = combine(sms.conversations, notified) { texts, chats ->
        SmsSnapshot(texts, chats, owners(texts, chats))
    }.recover().shareIn(scope, SharingStarted.WhileSubscribed(5_000, replayExpirationMillis = 0), replay = 1)

    private fun <T> Flow<T>.recover(): Flow<T> = retryWhen { error, attempt ->
        if (error is CancellationException) throw error
        Log.w("SmsAwareHub", "SMS snapshot failed; retrying", error)
        delay(1_000L shl attempt.coerceAtMost(5).toInt())
        true
    }

    /** Which inbox conversation each notified one belongs to, by number or else by a shared text. */
    private fun owners(texts: List<SyncConversation>, notified: List<Notified>): Map<String, String> =
        notified.mapNotNull { n ->
            val key = PhoneNumbers.key(n.number)
            val byNumber = key?.let { k -> texts.firstOrNull { c -> !c.isGroup && c.numbers.any { PhoneNumbers.key(it) == k } } }
            val owner = byNumber ?: texts.firstOrNull { c -> sharesText(n.chat, c) }
            owner?.let { n.chat.key to it.key }
        }.toMap()

    override fun inbox(): Flow<List<InboxChat>> =
        snapshot.map { (texts, notifiedChats, owners) ->
            val chats = notifiedChats.map { it.chat }
            if (texts.isEmpty()) return@map chats
            val kept = chats.filterNot { it.key in owners }
            val merged = texts.map { c ->
                val folded = notifiedChats.filter { owners[it.chat.key] == c.key }.map { it.chat }
                val newest = folded.maxByOrNull { it.timeMs }
                val chat = chatOf(c)
                // A notification of a text the inbox has would count it twice; only the rest (RCS) adds.
                val extraUnread = folded.filterNot { sharesText(it, c) }.sumOf { it.unreadCount }
                if (newest == null || newest.timeMs <= chat.timeMs) {
                    chat.copy(unreadCount = chat.unreadCount + extraUnread)
                } else {
                    chat.copy(
                        timeMs = newest.timeMs,
                        lastText = newest.lastText,
                        lastSender = newest.lastSender,
                        unreadCount = chat.unreadCount + extraUnread,
                    )
                }
            }
            (kept + merged).sortedByDescending { it.timeMs }
        }

    override fun thread(conversationKey: String, limit: Int): Flow<ChatThread?> =
        if (SmsInbox.threadOf(conversationKey) == null) {
            combine(base.thread(conversationKey, limit), notified) { thread, notifiedChats ->
                val n = notifiedChats.firstOrNull { it.chat.key == conversationKey }
                if (thread != null && n != null && canFallBack(n)) {
                    thread.copy(canReply = true)
                } else {
                    thread
                }
            }
        } else {
            snapshot.map { (texts, notifiedChats, owners) ->
                val c = texts.firstOrNull { it.key == conversationKey } ?: return@map null
                val foldedIn = notifiedChats.filter { owners[it.chat.key] == conversationKey }.flatMap { it.thread?.messages.orEmpty() }
                // Only the newest `limit` are converted: any older one is past the cut below anyway.
                val own = threadOf(c, limit)
                // Messages only the notification had (RCS), in time order with the inbox's own. A copy of
                // a text from before the window may be stamped up to MATCH_WINDOW_MS later, inside it,
                // so it is matched against every inbox message, not just the converted ones.
                val extra = foldedIn.filterNot { m -> c.messages.any { it.text.trim() == m.text.trim() && abs(it.timeMs - m.timeMs) < MATCH_WINDOW_MS } }
                // The inbox row counts the notified chat's unread too; the screen needs it to mark them read.
                own.copy(
                    messages = (own.messages + extra).sortedBy { it.timeMs }.takeLast(limit),
                    unread = own.unread + extra.count { !it.outgoing && !it.read },
                )
            }
        }

    override suspend fun sendReply(conversationKey: String, text: String): ReplyResult {
        if (text.isBlank()) return ReplyResult.Failed(ReplyFailure.EMPTY_TEXT)
        if (SmsInbox.threadOf(conversationKey) == null) {
            val n = notified.first().firstOrNull { it.chat.key == conversationKey }
            // Through the notification while it can (this keeps an RCS chat in RCS)...
            if (n == null || n.thread?.canReply == true || !canFallBack(n)) return base.sendReply(conversationKey, text)
            // ...and as an SMS to the contact once it is gone.
            return sendSms(n.number!!, text)
        }
        val to = withContext(Dispatchers.IO) { sms.addressOf(conversationKey) } ?: return ReplyResult.Failed(ReplyFailure.NOT_SUPPORTED)
        return sendSms(to, text)
    }

    override suspend fun markRead(conversationKey: String) {
        if (SmsInbox.threadOf(conversationKey) == null) return base.markRead(conversationKey)
        withContext(Dispatchers.IO) { sms.markRead(conversationKey) }
        // Its folded-in notification conversations are read too.
        val current = snapshot.first()
        for ((notifiedKey, owner) in current.owners) if (owner == conversationKey) base.markRead(notifiedKey)
    }

    private suspend fun sendSms(to: String, text: String): ReplyResult {
        val error = withContext(Dispatchers.IO) { sms.send(to, text) }
        sms.refresh()
        return if (error == null) ReplyResult.Sent else ReplyResult.Failed(ReplyFailure.NOT_SUPPORTED)
    }

    /** A one-to-one notified conversation with a known number can still be answered by SMS. */
    private fun canFallBack(n: Notified) = !n.chat.isGroup && n.number != null && sms.canSend()

    private fun numberOf(chat: InboxChat, thread: ChatThread?): String? {
        if (chat.isGroup) return null
        val incoming = thread?.messages?.filterNot { it.outgoing }.orEmpty()
        val candidates = incoming.flatMap { listOf(it.senderKey?.removePrefix("tel:"), it.senderName) } + chat.title + chat.lastSender
        return candidates.firstNotNullOfOrNull { PhoneNumbers.find(it) }
    }

    /** The notified conversation's latest message is also in the inbox conversation: same text, close in time. */
    private fun sharesText(chat: InboxChat, c: SyncConversation): Boolean {
        val text = chat.lastText?.trim()?.takeIf { it.isNotEmpty() } ?: return false
        return c.messages.any { it.text.trim() == text && abs(it.timeMs - chat.timeMs) < MATCH_WINDOW_MS }
    }

    private fun chatOf(c: SyncConversation): InboxChat {
        val last = c.messages.lastOrNull()
        return InboxChat(c.key, c.title, c.isGroup, c.lastActivityMs, c.unread, last?.text, last?.sender, c.sender)
    }

    private fun threadOf(c: SyncConversation, limit: Int) = ChatThread(
        key = c.key,
        title = c.title,
        isGroup = c.isGroup,
        messages = c.messages.takeLast(limit).map { m ->
            ThreadMessage(
                id = m.id.substringAfter(':').toLongOrNull() ?: 0L,
                senderName = m.sender,
                text = m.text,
                timeMs = m.timeMs,
                outgoing = m.outgoing,
                status = when (m.status) {
                    "incoming" -> MessageStatus.INCOMING
                    "sending" -> MessageStatus.SENDING
                    "failed" -> MessageStatus.FAILED
                    else -> MessageStatus.CONFIRMED
                },
                media = if (m.image != null) MediaKind.IMAGE else null,
                read = true,
                imageId = m.image,
            )
        },
        canReply = c.canReply,
        unread = c.unread,
    )

    private companion object {
        const val MATCH_WINDOW_MS = 120_000L
    }
}
