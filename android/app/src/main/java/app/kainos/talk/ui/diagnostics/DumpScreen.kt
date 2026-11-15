package app.kainos.talk.ui.diagnostics

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.core.DumpFormat
import app.kainos.talk.core.DumpRecord
import app.kainos.talk.hub.TalkHub
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The structure of recent notifications from watched apps, to settle what the real apps post.
 * Content is hidden by default; the export is always redacted.
 */
@Composable
internal fun DumpScreen(hub: TalkHub, bottomBar: @Composable () -> Unit) {
    androidx.compose.runtime.DisposableEffect(Unit) {
        app.kainos.talk.core.DumpCapture.open()
        onDispose { app.kainos.talk.core.DumpCapture.close() }
    }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val records by hub.dump.collectAsStateWithLifecycle()
    var reveal by rememberSaveable { mutableStateOf(false) }
    var expanded by rememberSaveable { mutableStateOf(setOf<Long>()) }

    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val snapshot = records
        scope.launch {
            val saved = withContext(Dispatchers.IO) {
                runCatching {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(DumpFormat.exportJson(snapshot).toByteArray()) }
                        ?: error("no output stream")
                }.isSuccess
            }
            snackbar.showSnackbar(
                if (saved) "Saved ${snapshot.size} redacted notification(s)." else "The file couldn't be written. Pick another location.",
            )
        }
    }

    ScreenFrame(
        title = "Notification dump",
        snackbar = snackbar,
        bottomBar = bottomBar,
        actions = {
            IconButton(onClick = { export.launch("kainos-talk-dump.json") }, enabled = records.isNotEmpty()) {
                Icon(Icons.Outlined.Share, contentDescription = "Export redacted dump")
            }
            IconButton(onClick = { hub.clearDump() }, enabled = records.isNotEmpty()) {
                Icon(Icons.Outlined.Delete, contentDescription = "Clear dump")
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .toggleable(value = reveal, role = Role.Switch, onValueChange = { reveal = it })
                    .padding(horizontal = Gap.md, vertical = Gap.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Show content", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Off: text shows as its length and IDs as their shape. Exports are always redacted.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Switch(checked = reveal, onCheckedChange = null)
            }
            HorizontalDivider()
            if (records.isEmpty()) {
                Centered {
                    Text(
                        "Nothing recorded since Kainos Talk started. Notifications from WhatsApp, Discord, Messenger, " +
                            "your SMS app and Proton Mail appear here as they arrive.",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(records, key = { it.seq }) { record ->
                        val open = record.seq in expanded
                        DumpRow(record, open, reveal) {
                            expanded = if (open) expanded - record.seq else expanded + record.seq
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun DumpRow(record: DumpRecord, open: Boolean, reveal: Boolean, onToggle: () -> Unit) {
    val s = record.snapshot
    Column {
        ListItem(
            modifier = Modifier.clickable(onClickLabel = if (open) "Collapse" else "Expand", onClick = onToggle),
            headlineContent = { Text(s.packageName) },
            supportingContent = {
                Text("${record.outcome}\nchannel ${s.channelId ?: "none"}, ${Labels.time(s.postTimeMs)}")
            },
        )
        if (open) {
            val lines = DumpFormat.fields(record, reveal).map { (k, v) -> "$k: $v" } +
                listOf("actions:") + DumpFormat.actionLines(record).map { "  $it" }.ifEmpty { listOf("  none") } +
                listOf("extras:") + DumpFormat.extraLines(s.extras, reveal, indent = "  ")
            Column(
                Modifier.fillMaxWidth().padding(start = Gap.md, end = Gap.md, bottom = Gap.md),
                verticalArrangement = Arrangement.spacedBy(Gap.xs),
            ) {
                lines.forEach { line ->
                    Text(line, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                }
            }
        }
    }
}
