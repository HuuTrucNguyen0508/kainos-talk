package app.kainos.talk.ui.talk

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.core.MailAction
import app.kainos.talk.hub.ActionResult
import app.kainos.talk.hub.MailItem
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.ui.theme.SwitchboardShapes
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

private sealed interface MailState {
    data object Loading : MailState
    data object Missing : MailState
    data class Ready(val mail: MailItem) : MailState
    data class Failed(val message: String) : MailState
}

/**
 * One mail notification. Proton Mail's notification carries no body, so this shows the sender,
 * subject, account and time, the actions Proton offered, and the way into Proton Mail.
 */
@Composable
fun MailScreen(hub: TalkHub, mailKey: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val state by remember(hub, mailKey) {
        hub.mailItem(mailKey)
            .map<MailItem?, MailState> { if (it == null) MailState.Missing else MailState.Ready(it) }
            .catch { emit(MailState.Failed(it.message ?: it.javaClass.simpleName)) }
    }.collectAsStateWithLifecycle(MailState.Loading)
    val mail = (state as? MailState.Ready)?.mail
    val say: (String) -> Unit = { scope.launch { snackbar.showSnackbar(it) } }

    LaunchedEffect(mailKey, mail?.read) { if (mail != null && !mail.read) hub.markMailRead(mailKey) }

    Scaffold(
        containerColor = MaterialTheme.switchboard.surface,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TalkTopBar {
                TalkIconButton(TalkIcons.Back, "Back", onBack)
                if (mail != null) {
                    Row(
                        Modifier.weight(1f).padding(start = MaterialTheme.spacing.sm).semantics(mergeDescendants = true) { heading() },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.md),
                    ) {
                        Jack(mail.source, behind = null, inline = true)
                        Text(mail.source.label, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.switchboard.ink, maxLines = 1)
                    }
                }
            }
        },
        bottomBar = {
            if (mail != null) {
                MailBoard(
                    mail,
                    onAction = { action ->
                        scope.launch {
                            when (val r = hub.mailAction(mailKey, action)) {
                                ActionResult.Requested -> say(Copy.mailRequested(action, mail.source))
                                is ActionResult.Failed -> say(Copy.actionFailed(r, mail.source))
                            }
                        }
                    },
                    onOpen = { Copy.opened(hub.openInApp(context, mailKey), mail.source)?.let(say) },
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (val s = state) {
                MailState.Loading -> CircularProgressIndicator(color = MaterialTheme.switchboard.teal, modifier = Modifier.align(Alignment.Center))
                MailState.Missing -> MailNote("This mail is no longer in Kainos Talk.")
                is MailState.Failed -> MailNote("Kainos Talk couldn't read this mail: ${s.message}")
                is MailState.Ready -> MailBody(s.mail)
            }
        }
    }
}

@Composable
private fun MailNote(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.switchboard.soft,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.xxxl),
    )
}

@Composable
private fun MailBody(mail: MailItem) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    val clock = LocalTalkClock.current
    val sender = Copy.mailSender(mail.sender, mail.senderHidden)
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = sp.xl, end = sp.xl, top = sp.sm, bottom = sp.xxl),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(sp.lg)) {
            Avatar(if (mail.senderHidden) mail.source.label else sender, null, behind = c.surface)
            Column(Modifier.semantics(mergeDescendants = true) { }) {
                Text(sender, style = MaterialTheme.typography.titleMedium, color = if (mail.senderHidden) c.soft else c.ink)
                Text(clock.dayAndClock(mail.receivedAtMs), style = MaterialTheme.typography.labelMedium, color = c.soft)
                Copy.mailAccount(mail.accountLabel)?.let {
                    Text(it, style = MaterialTheme.typography.labelMedium, color = c.soft)
                }
            }
        }
        Text(
            mail.subject,
            style = MaterialTheme.typography.headlineMedium,
            color = c.ink,
            modifier = Modifier.padding(top = sp.xxl + sp.xs).semantics { heading() },
        )
        mail.requestedAction?.let { action ->
            Row(
                Modifier.padding(top = sp.lg),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(sp.sm),
            ) {
                Icon(TalkIcons.Check, contentDescription = null, tint = c.teal, modifier = Modifier.size(MaterialTheme.sizes.iconSmall))
                Text(Copy.mailRequested(action, mail.source), style = MaterialTheme.typography.bodySmall, color = c.ink)
            }
        }
        if (mail.senderHidden) {
            Column(
                Modifier
                    .padding(top = sp.xl)
                    .fillMaxWidth()
                    .clip(SwitchboardShapes.card)
                    .background(c.raised)
                    .padding(horizontal = sp.lg, vertical = sp.lg),
            ) {
                Text("${mail.source.label} hid the sender", style = MaterialTheme.typography.titleSmall, color = c.ink)
                Text(
                    "To see who mail is from here, turn on Extended notifications in ${mail.source.label}'s settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.soft,
                    modifier = Modifier.padding(top = sp.xs),
                )
            }
        }
        Text(
            Copy.mailNoBody(mail.source),
            style = MaterialTheme.typography.bodySmall,
            color = c.soft,
            modifier = Modifier.padding(top = sp.xl),
        )
    }
}

@Composable
private fun MailBoard(mail: MailItem, onAction: (MailAction) -> Unit, onOpen: () -> Unit) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    BoardPanel {
        Column(Modifier.padding(start = sp.lg, end = sp.lg, top = sp.md + sp.hair, bottom = sp.lg)) {
            Text(
                "Mail can't be answered from Kainos Talk.",
                style = MaterialTheme.typography.bodySmall,
                color = c.soft,
                modifier = Modifier.padding(bottom = sp.md),
            )
            if (mail.actions.isNotEmpty()) {
                Row(Modifier.padding(bottom = sp.md), horizontalArrangement = Arrangement.spacedBy(sp.sm)) {
                    mail.actions.forEach { available ->
                        MailActionButton(available.action, onAction, Modifier.weight(1f))
                    }
                }
            }
            BigButton(Copy.openIn(mail.source), onOpen, icon = TalkIcons.Open)
        }
    }
}

@Composable
private fun MailActionButton(action: MailAction, onAction: (MailAction) -> Unit, modifier: Modifier) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val icon = when (action) {
        MailAction.ARCHIVE -> TalkIcons.Archive
        MailAction.TRASH -> TalkIcons.Trash
        MailAction.MARK_READ -> TalkIcons.MailOpen
    }
    Column(
        modifier
            .heightIn(min = s.bigButton)
            .clip(SwitchboardShapes.iconButton)
            .background(c.surface)
            .border(s.hairline, c.outline, SwitchboardShapes.iconButton)
            .clickable(role = Role.Button, onClick = { onAction(action) })
            .padding(vertical = MaterialTheme.spacing.sm, horizontal = MaterialTheme.spacing.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, contentDescription = null, tint = c.teal, modifier = Modifier.size(s.iconSmall))
        Text(Copy.mailAction(action), style = MaterialTheme.typography.labelLarge, color = c.teal, textAlign = TextAlign.Center)
    }
}
