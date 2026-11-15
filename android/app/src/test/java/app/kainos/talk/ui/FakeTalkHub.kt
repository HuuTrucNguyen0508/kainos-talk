package app.kainos.talk.ui

import android.content.Intent
import app.kainos.talk.hub.AccessState
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.InboxChat
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

/** An in-memory hub for UI and sync tests. It follows DefaultTalkHub's rules for replies. */
class FakeTalkHub(private val now: () -> Long = { 0L }) : TalkHub {
    val chats = MutableStateFlow<List<InboxChat>>(emptyList())
    val threads = MutableStateFlow<Map<String, ChatThread>>(emptyMap())
    val listening = MutableStateFlow(true)
    val accessState = MutableStateFlow(AccessState(true, Intent("detail"), Intent("list"), Intent("app-info")))

    /** What the next [sendReply] returns. */
    var nextReply: ReplyResult = ReplyResult.Sent
    val sentReplies = mutableListOf<Pair<String, String>>()
    val readKeys = mutableListOf<String>()
    private var nextId = 10_000L

    override fun inbox(): Flow<List<InboxChat>> = chats.map { list -> list.sortedByDescending { it.timeMs } }

    override fun thread(conversationKey: String, limit: Int): Flow<ChatThread?> =
        threads.map { all -> all[conversationKey]?.let { it.copy(messages = it.messages.takeLast(limit)) } }

    override val listenerConnected: Flow<Boolean> = listening
    override val access: StateFlow<AccessState> = accessState

    override fun refreshAccess() = Unit

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
}
