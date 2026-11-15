package app.kainos.talk.listener

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** What the listener connection itself reports. Message times come from the database. */
data class ConnectionState(
    val connected: Boolean = false,
    val connectedSinceMs: Long? = null,
    val lastDisconnectedMs: Long? = null,
    /** Last notification seen from any watched app, including ignored ones. */
    val lastNotificationMs: Long? = null,
)

class ConnectionTracker(private val clock: () -> Long = System::currentTimeMillis) {
    private val state = MutableStateFlow(ConnectionState())
    val connection: StateFlow<ConnectionState> = state

    fun connected() = state.update { it.copy(connected = true, connectedSinceMs = clock()) }

    fun disconnected() = state.update { it.copy(connected = false, connectedSinceMs = null, lastDisconnectedMs = clock()) }

    fun notificationSeen() = state.update { it.copy(lastNotificationMs = clock()) }
}
