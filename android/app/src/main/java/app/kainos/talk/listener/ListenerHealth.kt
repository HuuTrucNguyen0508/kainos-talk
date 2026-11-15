package app.kainos.talk.listener

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Whether Android has the notification listener bound right now. */
class ConnectionTracker {
    private val state = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = state

    fun connected() {
        state.value = true
    }

    fun disconnected() {
        state.value = false
    }
}
