package app.kainos.talk.ui

import app.kainos.talk.sync.FoundPc
import app.kainos.talk.sync.PairResult
import app.kainos.talk.sync.SyncControl
import app.kainos.talk.sync.SyncStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow

/** A Connect to PC backend for UI tests: pairing shows [code] and then waits for [answer]. */
class FakeSync(
    status: SyncStatus = SyncStatus.NotPaired,
    found: List<FoundPc> = listOf(FoundPc("studio-desktop", listOf("192.168.1.20"), "AB".repeat(32))),
    private val code: String = "482193",
) : SyncControl {
    override val status = MutableStateFlow(status)
    override val discovered = MutableStateFlow(found)
    val answer = CompletableDeferred<PairResult>()
    val pairedWith = mutableListOf<String>()
    var forgotten = false

    override fun startDiscovery() = Unit
    override fun stopDiscovery() = Unit

    override suspend fun pair(pc: FoundPc, onCode: (String) -> Unit): PairResult {
        pairedWith += pc.name
        onCode(code)
        return answer.await()
    }

    var refreshed = 0

    override fun refreshInbox() {
        refreshed++
    }

    val confirmations = mutableListOf<Boolean>()

    override fun confirmCode(matches: Boolean) {
        confirmations += matches
    }

    override fun forget() {
        forgotten = true
        status.value = SyncStatus.NotPaired
    }
}
