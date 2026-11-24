package app.kainos.talk.ui.talk

import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import android.content.pm.PackageManager
import android.Manifest
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.sync.FoundPc
import app.kainos.talk.sync.PairingState
import app.kainos.talk.sync.SaveFolder
import app.kainos.talk.sync.SyncControl
import app.kainos.talk.sync.SyncStatus
import app.kainos.talk.ui.theme.SwitchboardShapes
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard

/**
 * Connect to PC, the app's home screen: pairs this phone with Kainos Talk on a computer so its
 * texts can be read and answered there. Lists PCs found on the Wi-Fi, shows the pairing code, and
 * once paired shows the connection and a way to forget the PC. [warning] sits under the header.
 */
@Composable
fun ConnectPcScreen(sync: SyncControl, warning: @Composable () -> Unit = {}) {
    val status by sync.status.collectAsStateWithLifecycle()
    val found by sync.discovered.collectAsStateWithLifecycle()
    val pairing by sync.pairing.collectAsStateWithLifecycle()
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing

    DisposableEffect(sync) {
        sync.startDiscovery()
        onDispose { sync.stopDiscovery() }
    }

    Scaffold(
        containerColor = c.surface,
        topBar = {
            Column {
                TalkTopBar {
                    AppMark(MaterialTheme.sizes.appMark, c.teal, c.onTeal)
                    Text(
                        "Kainos Talk",
                        style = MaterialTheme.typography.headlineSmall,
                        color = c.ink,
                        modifier = Modifier.padding(start = sp.md).semantics { heading() },
                    )
                }
                warning()
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(start = sp.xxl, end = sp.xxl, top = sp.lg, bottom = sp.xxl),
            verticalArrangement = Arrangement.spacedBy(sp.md),
        ) {
            val current = pairing
            when {
                current is PairingState.Code -> CodePanel(
                    current.code,
                    confirmed = false,
                    onMatch = { sync.confirmCode(true) },
                    onCancel = { sync.confirmCode(false) },
                )
                current is PairingState.Confirmed -> CodePanel(current.code, confirmed = true, onMatch = {}, onCancel = { sync.confirmCode(false) })
                current is PairingState.Connecting -> {
                    Text("Contacting ${current.name}…", style = MaterialTheme.typography.bodyLarge, color = c.soft)
                    LinkButton("Cancel", onClick = { sync.confirmCode(false) })
                }
                status !is SyncStatus.NotPaired -> PairedPanel(status, onForget = sync::forget, onSmsAccess = sync::refreshInbox)
                else -> {
                    Text(
                        "Read and answer this phone's texts in Kainos Talk on your computer while both are on the same Wi-Fi. Nothing goes through the internet.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = c.ink,
                    )
                    Text(
                        "Open Texts in Kainos Talk on the computer, then pick it here.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.soft,
                    )
                    if (current is PairingState.Problem) Text(current.message, style = MaterialTheme.typography.bodyMedium, color = c.alert)
                    FoundList(found, onPick = sync::pair)
                    Text(
                        "Not listed? Check that Kainos Talk is open on the computer and that both are on the same Wi-Fi. A firewall on the computer must let Kainos Talk through.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.soft,
                        modifier = Modifier.padding(top = sp.md),
                    )
                }
            }
        }
    }
}

@Composable
private fun FoundList(found: List<FoundPc>, onPick: (FoundPc) -> Unit) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    val s = MaterialTheme.sizes
    if (found.isEmpty()) {
        Text("Looking for computers on this Wi-Fi…", style = MaterialTheme.typography.bodyMedium, color = c.soft)
        return
    }
    Column(Modifier.fillMaxWidth().clip(SwitchboardShapes.card).background(c.board)) {
        found.forEach { pc ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = s.rowMinHeight)
                    .clickable { onPick(pc) }
                    .semantics { contentDescription = "Connect to ${pc.name}" }
                    .padding(horizontal = sp.lg, vertical = sp.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(pc.name, style = MaterialTheme.typography.titleMedium, color = c.ink)
                }
                Text("Connect", style = MaterialTheme.typography.labelLarge, color = c.teal)
            }
        }
    }
}

@Composable
private fun CodePanel(code: String, confirmed: Boolean, onMatch: () -> Unit, onCancel: () -> Unit) {
    val c = MaterialTheme.switchboard
    Text("Check the code", style = MaterialTheme.typography.headlineSmall, color = c.ink, modifier = Modifier.semantics { heading() })
    Text(
        if (confirmed) {
            "Now press Connect on the computer."
        } else {
            "Does the computer show the same code? Confirm on both: Codes match here, Connect on the computer."
        },
        style = MaterialTheme.typography.bodyLarge,
        color = c.ink,
    )
    Text(
        "${code.take(3)} ${code.drop(3)}",
        style = MaterialTheme.typography.displaySmall,
        fontWeight = FontWeight.Bold,
        color = c.ink,
        modifier = Modifier
            .padding(top = MaterialTheme.spacing.md)
            .semantics { contentDescription = "Code ${code.toList().joinToString(" ")}" },
    )
    if (!confirmed) BigButton("Codes match", onClick = onMatch, modifier = Modifier.padding(top = MaterialTheme.spacing.lg))
    LinkButton(if (confirmed) "Cancel" else "They don't match", onClick = onCancel)
}

@Composable
private fun PairedPanel(status: SyncStatus, onForget: () -> Unit, onSmsAccess: () -> Unit) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    val (name, line, live) = when (status) {
        is SyncStatus.Connected -> Triple(
            status.pcName,
            if (status.viaTailnet) "Connected over Tailscale. Your texts show on this computer." else "Connected. Your texts show on this computer.",
            true,
        )
        is SyncStatus.Connecting -> Triple(status.pcName, "Connecting…", false)
        is SyncStatus.Offline -> Triple(status.pcName, "Can't reach it. Kainos Talk needs to be open on the computer, on the same Wi-Fi as this phone or on Tailscale with it. Retrying.", false)
        is SyncStatus.Mismatch -> Triple(status.pcName, "This phone and the computer run different versions of Kainos Talk. Update both; they reconnect by themselves.", false)
        is SyncStatus.Refused -> Triple(status.pcName, "The computer no longer knows this phone. Forget it, then connect again.", false)
        SyncStatus.NotPaired -> return
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(sp.md)) {
        Box(Modifier.size(MaterialTheme.sizes.iconTiny).clip(SwitchboardShapes.lamp).background(if (live) c.teal else c.outline))
        Text(name, style = MaterialTheme.typography.headlineSmall, color = c.ink, modifier = Modifier.semantics { heading() })
    }
    Text(line, style = MaterialTheme.typography.bodyLarge, color = if (status is SyncStatus.Refused) c.alert else c.ink)
    Text(
        "Your texts go only to this computer, over your Wi-Fi. You don't need to open this app again: it keeps passing texts on in the background.",
        style = MaterialTheme.typography.bodyMedium,
        color = c.soft,
    )
    SmsAccess(onGranted = onSmsAccess)
    CallAccess(onGranted = onSmsAccess)
    SaveFolderChoice()
    FileNotificationAccess()
    Text(
        "If the computer gets a new address on your Wi-Fi, this phone finds it again by itself.",
        style = MaterialTheme.typography.bodyMedium,
        color = c.soft,
    )
    LinkButton("Forget this computer", onClick = onForget)
}

private val SMS_PERMISSIONS = arrayOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.READ_CONTACTS)

/**
 * Offers the SMS history and sending from the computer. Without it the computer shows only texts
 * that arrive while Kainos Talk runs, and replies need the text's notification.
 */
@Composable
private fun SmsAccess(onGranted: () -> Unit) {
    val context = LocalContext.current
    val c = MaterialTheme.switchboard
    var granted by remember { mutableStateOf(SMS_PERMISSIONS.take(2).all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        granted = SMS_PERMISSIONS.take(2).all { results[it] == true || context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        onGranted()
    }
    if (granted) {
        Text("Your past texts show on the computer, and texts you write there are sent from this phone.", style = MaterialTheme.typography.bodyMedium, color = c.soft)
        return
    }
    Text(
        "Show your past texts on the computer and send texts from it? Kainos Talk then reads this phone's texts and contacts, and sends texts for you.",
        style = MaterialTheme.typography.bodyMedium,
        color = c.ink,
    )
    LinkButton("Allow texts and contacts", onClick = { ask.launch(SMS_PERMISSIONS) })
}

private val CALL_PERMISSIONS = arrayOf(
    Manifest.permission.READ_PHONE_STATE,
    Manifest.permission.READ_CALL_LOG,
    Manifest.permission.ANSWER_PHONE_CALLS,
    Manifest.permission.CALL_PHONE,
    Manifest.permission.READ_CONTACTS,
)

/**
 * Offers calls on the computer: what rings and who, the call log, and its Answer, End and Call
 * buttons. The sound goes to the computer when this phone is connected to it over Bluetooth.
 */
@Composable
private fun CallAccess(onGranted: () -> Unit) {
    val context = LocalContext.current
    val c = MaterialTheme.switchboard
    val needed = CALL_PERMISSIONS.take(4)
    var granted by remember { mutableStateOf(needed.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        granted = needed.all { results[it] == true || context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        onGranted()
    }
    if (granted) {
        Text(
            "Calls show on the computer, and you can answer, end and make them there. Connect this phone to the computer over Bluetooth to hear them on it.",
            style = MaterialTheme.typography.bodyMedium,
            color = c.soft,
        )
        return
    }
    Text(
        "Answer and make calls on the computer? Kainos Talk then sees who is calling and your call log, and presses Answer, End and Call for you.",
        style = MaterialTheme.typography.bodyMedium,
        color = c.ink,
    )
    LinkButton("Allow calls", onClick = { ask.launch(CALL_PERMISSIONS) })
}

/**
 * Where files from the computer save: Downloads, or a folder picked with Android's folder picker.
 * A picked folder that is gone or no longer allowed falls back to Downloads, and says so.
 */
@Composable
private fun SaveFolderChoice() {
    val context = LocalContext.current
    val c = MaterialTheme.switchboard
    val folder = remember { SaveFolder(context) }
    var name by remember { mutableStateOf(folder.name()) }
    var lost by remember { mutableStateOf(folder.isLost()) }
    fun refresh() {
        name = folder.name()
        lost = folder.isLost()
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree ->
        if (tree != null) runCatching { folder.choose(tree) }
        refresh()
    }
    val chosen = name
    when {
        chosen != null -> Text("Files from the computer save to $chosen.", style = MaterialTheme.typography.bodyMedium, color = c.soft)
        lost -> Text(
            "The folder you chose for files from the computer can't be reached, so they save to Downloads. Choose it again.",
            style = MaterialTheme.typography.bodyMedium,
            color = c.alert,
        )
        else -> Text("Files from the computer save to Downloads.", style = MaterialTheme.typography.bodyMedium, color = c.soft)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.xl)) {
        LinkButton(if (chosen != null) "Change folder" else "Choose folder", onClick = { pick.launch(null) })
        if (chosen != null || lost) {
            LinkButton("Save to Downloads", onClick = {
                folder.useDownloads()
                refresh()
            })
        }
    }
}

/** Offers a notification when files arrive from the computer, so tapping it opens the file. */
@Composable
private fun FileNotificationAccess() {
    val context = LocalContext.current
    val c = MaterialTheme.switchboard
    var granted by remember {
        mutableStateOf(context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        granted = allowed || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    if (granted) return
    Text(
        "Show a notification when files arrive from the computer? Without it, files still save.",
        style = MaterialTheme.typography.bodyMedium,
        color = c.ink,
    )
    LinkButton("Allow file notifications", onClick = { ask.launch(Manifest.permission.POST_NOTIFICATIONS) })
}
