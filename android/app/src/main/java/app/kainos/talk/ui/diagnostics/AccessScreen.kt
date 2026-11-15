package app.kainos.talk.ui.diagnostics

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.TalkHub

/** Notification access, the sideload steps, listener health, and which source apps exist. */
@Composable
internal fun AccessScreen(hub: TalkHub, bottomBar: @Composable () -> Unit) {
    val context = LocalContext.current
    val access by hub.access.collectAsStateWithLifecycle()
    val health by hub.health.collectAsStateWithLifecycle(initialValue = null)

    ScreenFrame(title = "Notification access", bottomBar = bottomBar) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Gap.md, vertical = Gap.sm),
            verticalArrangement = Arrangement.spacedBy(Gap.md),
        ) {
            Text(
                text = if (access.listenerGranted) {
                    "Kainos Talk can read notifications."
                } else {
                    "Kainos Talk can't read notifications yet. Turn on notification access for it."
                },
                style = MaterialTheme.typography.titleMedium,
            )
            Button(
                onClick = { open(context, access.listenerDetailSettings, fallback = access.listenerListSettings) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (access.listenerGranted) "Review notification access" else "Turn on notification access")
            }

            if (!access.listenerGranted) {
                Text("If Android says the setting is restricted", style = MaterialTheme.typography.titleSmall)
                Text(
                    "Apps installed from a file are blocked from notification access until you allow it:\n" +
                        "1. Try the switch above once, so Android shows the restricted-setting message.\n" +
                        "2. Open app info, tap the menu in the top corner, then Allow restricted settings.\n" +
                        "3. Come back and turn on notification access.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedButton(onClick = { open(context, access.appInfoSettings) }, modifier = Modifier.fillMaxWidth()) {
                    Text("Open app info")
                }
            }

            HorizontalDivider()
            Text("Listener", style = MaterialTheme.typography.titleSmall)
            val h = health
            if (h == null) {
                Text("Reading listener state…", style = MaterialTheme.typography.bodyMedium)
            } else {
                Fact("Connected", if (h.connected) "Yes, since ${Labels.time(h.connectedSinceMs)}" else "No")
                Fact("Last disconnect", Labels.time(h.lastDisconnectedMs))
                Fact("Last notification from a watched app", Labels.time(h.lastNotificationMs))
                Fact("Last message stored", Labels.time(h.lastMessageMs))
            }

            HorizontalDivider()
            Text("Watched apps", style = MaterialTheme.typography.titleSmall)
            hub.sources.forEach { source ->
                Fact(source.label, if (hub.isSourceAppInstalled(source.id)) "Installed" else "Not installed")
            }
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    ListItem(
        headlineContent = { Text(label) },
        supportingContent = { Text(value) },
    )
}

private fun open(context: Context, intent: Intent, fallback: Intent? = null) {
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        fallback?.let { runCatching { context.startActivity(it) } }
    }
}
