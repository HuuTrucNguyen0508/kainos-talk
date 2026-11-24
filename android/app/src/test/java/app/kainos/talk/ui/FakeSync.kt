package app.kainos.talk.ui

import app.kainos.talk.sync.FoundPc
import app.kainos.talk.sync.PairingState
import app.kainos.talk.sync.SyncClient
import app.kainos.talk.sync.SyncControl
import app.kainos.talk.sync.SyncStatus
import kotlinx.coroutines.flow.MutableStateFlow

/** A Connect to PC backend for UI tests: pairing shows [code] until the test changes [pairing]. */
class FakeSync(
    status: SyncStatus = SyncStatus.NotPaired,
    found: List<FoundPc> = listOf(FoundPc("studio-desktop", listOf("192.168.1.20"), "AB".repeat(32))),
    private val code: String = "482193",
) : SyncControl {
    override val status = MutableStateFlow(status)
    override val discovered = MutableStateFlow(found)
    override val pairing = MutableStateFlow<PairingState>(PairingState.Idle)
    val pairedWith = mutableListOf<String>()
    var forgotten = false

    override fun startDiscovery() {
        if (pairing.value is PairingState.Problem) pairing.value = PairingState.Idle
    }
    override fun stopDiscovery() = Unit

    override fun pair(pc: FoundPc) {
        pairedWith += pc.name
        pairing.value = PairingState.Code(code)
    }

    var refreshed = 0

    override fun refreshInbox() {
        refreshed++
    }

    val confirmations = mutableListOf<Boolean>()

    override fun confirmCode(matches: Boolean) {
        confirmations += matches
        val current = pairing.value
        if (matches && current is PairingState.Code) pairing.value = PairingState.Confirmed(current.code)
        if (!matches) {
            pairing.value = if (current is PairingState.Code) {
                PairingState.Problem(SyncClient.CODE_MISMATCH_MESSAGE)
            } else {
                PairingState.Idle
            }
        }
    }

    override fun forget() {
        forgotten = true
        if (pairing.value is PairingState.Problem) pairing.value = PairingState.Idle
        status.value = SyncStatus.NotPaired
    }
}
