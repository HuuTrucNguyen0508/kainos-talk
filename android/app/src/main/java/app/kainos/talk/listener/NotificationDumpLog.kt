package app.kainos.talk.listener

import app.kainos.talk.core.DumpRecord
import app.kainos.talk.core.NotificationSnapshot
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** The most recent notifications from watched apps, newest first. Memory only. */
class NotificationDumpLog(private val capacity: Int = 100) {
    private val state = MutableStateFlow<List<DumpRecord>>(emptyList())
    private var seq = 0L

    val records: StateFlow<List<DumpRecord>> = state

    @Synchronized
    fun record(snapshot: NotificationSnapshot, outcome: String) {
        val record = DumpRecord(seq++, snapshot, outcome)
        state.update { (listOf(record) + it).take(capacity) }
    }

    fun removed(sbnKey: String, reason: Int) {
        state.update { list ->
            list.map { if (it.snapshot.key == sbnKey && it.removedReason == null) it.copy(removedReason = reason) else it }
        }
    }

    fun clear() {
        state.value = emptyList()
    }
}
