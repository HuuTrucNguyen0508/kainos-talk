package app.kainos.talk.sync

import kotlinx.coroutines.flow.MutableStateFlow

/** An SMS inbox for tests: [conversations] is set by hand; sends are recorded or refused. */
class FakeSmsStore(
    initial: List<SyncConversation> = emptyList(),
    private val canSend: Boolean = false,
) : SmsStore {
    override val conversations = MutableStateFlow(initial)
    val sent = mutableListOf<Pair<String, String>>()
    val read = mutableListOf<String>()
    var refreshes = 0

    override fun addressOf(key: String): String? =
        conversations.value.firstOrNull { it.key == key }?.numbers?.singleOrNull() ?: if (SmsInbox.threadOf(key) != null) "+33612345678" else null

    override fun canSend(): Boolean = canSend

    override fun send(to: String, text: String): String? {
        if (!canSend) return "no permission to send texts"
        sent += to to text
        return null
    }

    override fun markRead(key: String) {
        read += key
        conversations.value = conversations.value.map { if (it.key == key) it.copy(unread = 0) else it }
    }

    /** Pictures by id, as the PC would get them. */
    val images = mutableMapOf<String, ByteArray>()

    override fun image(id: String): ByteArray? = images[id]

    override fun refresh() {
        refreshes++
    }
}
