package app.kainos.talk.ui.talk

import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.sync.SyncControl
import app.kainos.talk.ui.diagnostics.DiagnosticsApp
import app.kainos.talk.ui.diagnostics.DiagnosticsTheme
import kotlinx.coroutines.delay

private enum class Screen { INBOX, THREAD, MAIL, DIAGNOSTICS, CONNECT_PC }

/**
 * The product UI: first run until notification access is on, then the inbox with its thread
 * and mail screens. Diagnostics (the foundation's access, inbox and dump tabs) stays reachable
 * from the inbox menu. No navigation library: four screens and a key.
 */
@Composable
fun TalkApp(hub: TalkHub, clock: TalkClock? = null, sync: SyncControl? = null) {
    val context = LocalContext.current
    val liveClock by produceState(TalkClock(System.currentTimeMillis(), is24Hour = DateFormat.is24HourFormat(context))) {
        while (true) {
            delay(MINUTE_MS)
            value = value.copy(nowMs = System.currentTimeMillis())
        }
    }
    CompositionLocalProvider(LocalTalkClock provides (clock ?: liveClock)) {
        val access by hub.access.collectAsStateWithLifecycle()
        var screen by rememberSaveable { mutableStateOf(Screen.INBOX) }
        var key by rememberSaveable { mutableStateOf<String?>(null) }
        val home = {
            screen = Screen.INBOX
            key = null
        }
        val current = key
        when {
            screen == Screen.DIAGNOSTICS -> {
                BackHandler(onBack = home)
                DiagnosticsTheme { DiagnosticsApp(hub) }
            }
            screen == Screen.CONNECT_PC && sync != null -> {
                BackHandler(onBack = home)
                ConnectPcScreen(sync, onBack = home)
            }
            !access.listenerGranted -> SetupScreen(hub)
            screen == Screen.THREAD && current != null -> {
                BackHandler(onBack = home)
                ThreadScreen(hub, current, onBack = home)
            }
            screen == Screen.MAIL && current != null -> {
                BackHandler(onBack = home)
                MailScreen(hub, current, onBack = home)
            }
            else -> InboxScreen(
                hub,
                onOpenChat = {
                    screen = Screen.THREAD
                    key = it
                },
                onOpenMail = {
                    screen = Screen.MAIL
                    key = it
                },
                onDiagnostics = { screen = Screen.DIAGNOSTICS },
                onConnectPc = if (sync != null) ({ screen = Screen.CONNECT_PC }) else null,
            )
        }
    }
}

private const val MINUTE_MS = 60_000L
