package app.kainos.talk.ui.talk

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.sync.SyncControl
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard
import kotlinx.coroutines.delay

/**
 * The whole app: setup until notification access is on, then Connect to PC. After pairing the
 * phone is a background bridge for texts; this screen only shows the link and what would stop it.
 */
@Composable
fun TalkApp(hub: TalkHub, sync: SyncControl) {
    val access by hub.access.collectAsStateWithLifecycle()
    if (!access.listenerGranted) {
        SetupScreen(hub)
    } else {
        ConnectPcScreen(sync, warning = { KeepRunning(hub) })
    }
}

/**
 * Warns when texts would silently stop reaching the computer: the listener is not running although
 * access is on (Android unbinds it after an update, and some phones never bind it again), or the
 * phone may stop the app to save battery.
 */
@Composable
private fun KeepRunning(hub: TalkHub) {
    val access by hub.access.collectAsStateWithLifecycle()
    val listening by hub.listenerConnected.collectAsStateWithLifecycle(null)
    val context = LocalContext.current
    // The listener takes a moment to connect when the app starts; don't flash a warning.
    var settled by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(LISTENER_GRACE_MS)
        settled = true
    }
    fun open(vararg intents: Intent?) {
        for (intent in intents.filterNotNull()) {
            try {
                context.startActivity(intent)
                return
            } catch (_: ActivityNotFoundException) {
                // Not on this phone; try the next one.
            }
        }
    }
    when {
        settled && access.listenerGranted && listening == false -> WarningStrip(
            title = "Kainos Talk stopped receiving notifications",
            body = if (access.autostartSettings != null) {
                "The phone stopped it, for example when you swiped it away. Turn its notification access off, then on again. " +
                    "To stop this happening, turn on Autostart for Kainos Talk."
            } else {
                "Android turned it off, often after an update. Turn Kainos Talk's notification access off, then on again."
            },
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.lg)) {
                LinkButton("Open notification access", onClick = { open(access.listenerDetailSettings, access.listenerListSettings) })
                if (access.autostartSettings != null) LinkButton("Autostart", onClick = { open(access.autostartSettings) })
            }
        }
        !access.runsInBackground -> WarningStrip(
            title = "Let Kainos Talk run in the background",
            body = "Otherwise the phone may stop it to save battery, and new texts stop reaching your computer.",
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.lg)) {
                LinkButton("Allow", onClick = { open(*access.backgroundSettings.toTypedArray(), access.appInfoSettings) })
                if (access.autostartSettings != null) LinkButton("Autostart", onClick = { open(access.autostartSettings) })
            }
        }
    }
}

@Composable
private fun WarningStrip(title: String, body: String, actions: @Composable () -> Unit) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.board)
            .padding(start = sp.xxl, end = sp.xxl, top = sp.md),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = c.ink, modifier = Modifier.semantics { heading() })
        Text(body, style = MaterialTheme.typography.bodyMedium, color = c.soft, modifier = Modifier.padding(top = sp.xs))
        actions()
    }
}

private const val LISTENER_GRACE_MS = 4_000L
