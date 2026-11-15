package app.kainos.talk.ui.diagnostics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.core.Shape
import app.kainos.talk.hub.MailItem
import app.kainos.talk.hub.TalkHub
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

private sealed interface MailState {
    data object Loading : MailState
    data object Missing : MailState
    data class Ready(val mail: MailItem) : MailState
    data class Error(val message: String) : MailState
}

/** One mail notification: sender, subject, account, and the source app's own actions. No body exists. */
@Composable
internal fun MailScreen(hub: TalkHub, mailKey: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val state by remember(mailKey) {
        hub.mailItem(mailKey)
            .map<MailItem?, MailState> { if (it == null) MailState.Missing else MailState.Ready(it) }
            .catch { emit(MailState.Error(it.message ?: it.javaClass.simpleName)) }
    }.collectAsStateWithLifecycle(initialValue = MailState.Loading)
    val say: (String) -> Unit = { message -> scope.launch { snackbar.showSnackbar(message) } }

    LaunchedEffect(mailKey) { hub.markMailRead(mailKey) }

    ScreenFrame(title = "Mail", snackbar = snackbar, onBack = onBack) { padding ->
        when (val s = state) {
            MailState.Loading -> Centered { CircularProgressIndicator() }
            MailState.Missing -> Centered { Text("This mail is no longer stored.") }
            is MailState.Error -> Centered { Text("The mail couldn't be read: ${s.message}") }
            is MailState.Ready -> {
                val mail = s.mail
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .verticalScroll(rememberScrollState())
                        .padding(Gap.md),
                    verticalArrangement = Arrangement.spacedBy(Gap.sm),
                ) {
                    Text(mail.subject.ifEmpty { "(no subject)" }, style = MaterialTheme.typography.titleLarge)
                    if (mail.senderHidden) {
                        Text("Sender hidden by ${mail.source.label}", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "To see senders here, turn on Extended notifications in ${mail.source.label}'s " +
                                "notification settings.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        Text("From ${mail.sender}", style = MaterialTheme.typography.titleMedium)
                    }
                    mail.accountLabel?.let { Text("To $it", style = MaterialTheme.typography.bodyMedium) }
                    Text("Received ${Labels.exactTime(mail.receivedAtMs)}", style = MaterialTheme.typography.bodyMedium)
                    mail.requestedAction?.let { Text(Labels.requested(it), style = MaterialTheme.typography.bodyMedium) }
                    Text(
                        "${mail.source.label} notifications carry no message text. Open the app to read the mail.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (mail.shape == Shape.FALLBACK) {
                        Text(
                            "This notification didn't match the expected layout, so only Open is offered.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }

                    Button(
                        onClick = { Labels.open(hub.openInApp(context, mailKey), mail.source.label)?.let(say) },
                        modifier = Modifier.fillMaxWidth().padding(top = Gap.sm),
                    ) {
                        Text("Open in ${mail.source.label}")
                    }
                    if (!mail.notificationLive) {
                        Text(
                            "The notification is gone, so Archive, Trash and Mark read are only available in the app.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    mail.actions.forEach { available ->
                        OutlinedButton(
                            onClick = { scope.launch { say(Labels.action(hub.mailAction(mailKey, available.action))) } },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            // The source app's own (localised) title, so the button says what it fires.
                            Text(available.title ?: Labels.mailAction(available.action))
                        }
                    }
                }
            }
        }
    }
}
