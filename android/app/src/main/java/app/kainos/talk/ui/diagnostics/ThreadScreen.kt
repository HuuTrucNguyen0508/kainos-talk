package app.kainos.talk.ui.diagnostics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.hub.ThreadMessage
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

private sealed interface ThreadState {
    data object Loading : ThreadState
    data object Missing : ThreadState
    data class Ready(val thread: ChatThread) : ThreadState
    data class Error(val message: String) : ThreadState
}

private fun Flow<ChatThread?>.asState(): Flow<ThreadState> =
    map<ChatThread?, ThreadState> { if (it == null) ThreadState.Missing else ThreadState.Ready(it) }
        .catch { emit(ThreadState.Error(it.message ?: it.javaClass.simpleName)) }

/** One conversation, oldest first, with a reply box that only works while the app's notification exists. */
@Composable
internal fun ThreadScreen(hub: TalkHub, conversationKey: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val state by remember(conversationKey) { hub.thread(conversationKey).asState() }
        .collectAsStateWithLifecycle(initialValue = ThreadState.Loading)
    val thread = (state as? ThreadState.Ready)?.thread
    var menuOpen by remember { mutableStateOf(false) }
    val say: (String) -> Unit = { message -> scope.launch { snackbar.showSnackbar(message) } }

    // Opening the thread is reading it, in the hub only; the source app is not told.
    LaunchedEffect(conversationKey, thread?.messages?.size) { hub.markRead(conversationKey) }

    ScreenFrame(
        title = thread?.title ?: "Conversation",
        snackbar = snackbar,
        onBack = onBack,
        actions = {
            if (thread != null) {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Outlined.MoreVert, contentDescription = "More actions")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Open in ${thread.source.label}") },
                        onClick = {
                            menuOpen = false
                            Labels.open(hub.openInApp(context, conversationKey), thread.source.label)?.let(say)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Mark read in ${thread.source.label}") },
                        enabled = thread.capabilities.canMarkReadInApp,
                        onClick = {
                            menuOpen = false
                            scope.launch { say(Labels.action(hub.markReadInApp(conversationKey))) }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(if (thread.muted) "Unmute in Kainos Talk" else "Mute in Kainos Talk") },
                        onClick = {
                            menuOpen = false
                            scope.launch { hub.setMuted(conversationKey, !thread.muted) }
                        },
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            when (val s = state) {
                ThreadState.Loading -> Centered { CircularProgressIndicator() }
                ThreadState.Missing -> Centered { Text("This conversation is no longer stored.") }
                is ThreadState.Error -> Centered { Text("The conversation couldn't be read: ${s.message}") }
                is ThreadState.Ready -> {
                    ThreadBody(s.thread, Modifier.weight(1f))
                    HorizontalDivider()
                    ReplyBox(s.thread) { text ->
                        scope.launch {
                            val result = hub.sendReply(conversationKey, text)
                            if (result is ReplyResult.Failed) say(Labels.replyBlocked(result.reason))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadBody(thread: ChatThread, modifier: Modifier) {
    val list = rememberLazyListState()
    LaunchedEffect(thread.messages.size) {
        if (thread.messages.isNotEmpty()) list.scrollToItem(thread.messages.lastIndex)
    }
    if (thread.messages.isEmpty()) {
        Column(modifier) { Centered { Text("No messages stored for this conversation.") } }
        return
    }
    LazyColumn(
        state = list,
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(Gap.md),
        verticalArrangement = Arrangement.spacedBy(Gap.md),
    ) {
        thread.notificationRemovedReason?.let { reason ->
            item(key = "removed") {
                Text(Labels.removal(reason), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
            }
        }
        items(thread.messages, key = { it.id }) { MessageRow(it) }
    }
}

@Composable
private fun MessageRow(message: ThreadMessage) {
    val align = if (message.outgoing) Alignment.End else Alignment.Start
    Column(Modifier.fillMaxWidth(), horizontalAlignment = align) {
        val who = if (message.outgoing) "You" else message.senderName ?: "Unknown sender"
        Text("$who, ${Labels.exactTime(message.timeMs)}", style = MaterialTheme.typography.labelMedium)
        Text(Labels.messageText(message.text, message.media), style = MaterialTheme.typography.bodyLarge)
        Labels.status(message.status)?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
    }
}

@Composable
private fun ReplyBox(thread: ChatThread, onSend: (String) -> Unit) {
    var text by rememberSaveable(thread.key) { mutableStateOf("") }
    val blocked = thread.capabilities.replyBlocked
    val send = {
        if (text.isNotBlank()) {
            onSend(text)
            text = ""
        }
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(Gap.md),
        horizontalArrangement = Arrangement.spacedBy(Gap.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            enabled = blocked == null,
            label = { Text("Reply through ${thread.source.label}") },
            supportingText = blocked?.let { { Text(Labels.replyBlocked(it)) } },
            minLines = 1,
            maxLines = 4,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
        )
        Button(onClick = send, enabled = blocked == null && text.isNotBlank()) { Text("Send") }
    }
}
