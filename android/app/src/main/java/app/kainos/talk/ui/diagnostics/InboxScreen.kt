package app.kainos.talk.ui.diagnostics

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.Inbox
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.TalkHub
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

private sealed interface InboxState {
    data object Loading : InboxState
    data class Ready(val inbox: Inbox) : InboxState
    data class Error(val message: String) : InboxState
}

/** Every chat and mail item in one list, with a filter per source. */
@Composable
internal fun InboxScreen(
    hub: TalkHub,
    bottomBar: @Composable () -> Unit,
    onOpenChat: (String) -> Unit,
    onOpenMail: (String) -> Unit,
) {
    var filter by rememberSaveable { mutableStateOf<String?>(null) }
    val flow = remember(filter) {
        hub.inbox(filter?.let { setOf(it) })
            .map<Inbox, InboxState> { InboxState.Ready(it) }
            .catch { emit(InboxState.Error(it.message ?: it.javaClass.simpleName)) }
    }
    val state by flow.collectAsStateWithLifecycle(initialValue = InboxState.Loading)
    val totals by remember { hub.inbox() }.collectAsStateWithLifecycle(initialValue = null)

    ScreenFrame(title = "Inbox", bottomBar = bottomBar) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = Gap.md),
                horizontalArrangement = Arrangement.spacedBy(Gap.sm),
            ) {
                item {
                    FilterChip(
                        selected = filter == null,
                        onClick = { filter = null },
                        label = { Text(chipLabel("All", totals?.totalUnread)) },
                    )
                }
                items(hub.sources, key = { it.id }) { source ->
                    FilterChip(
                        selected = filter == source.id,
                        onClick = { filter = source.id },
                        label = { Text(chipLabel(source.label, totals?.unreadBySource?.get(source.id))) },
                    )
                }
            }
            when (val s = state) {
                InboxState.Loading -> Centered { CircularProgressIndicator() }
                is InboxState.Error -> Centered { Text("The inbox couldn't be read: ${s.message}") }
                is InboxState.Ready -> if (s.inbox.items.isEmpty()) {
                    Centered {
                        Text(
                            "No messages yet. They appear here when WhatsApp, Discord, Messenger, your SMS app or " +
                                "Proton Mail post a notification while notification access is on.",
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(s.inbox.items, key = { it.key }) { item ->
                            when (item) {
                                is InboxItem.Chat -> ChatRow(item) { onOpenChat(item.key) }
                                is InboxItem.Mail -> MailRow(item) { onOpenMail(item.key) }
                            }
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
}

private fun chipLabel(label: String, unread: Int?): String = if (unread != null && unread > 0) "$label ($unread)" else label

@Composable
private fun ChatRow(item: InboxItem.Chat, onClick: () -> Unit) {
    val preview = buildString {
        if (item.lastOutgoing) append("You: ") else if (item.isGroup && item.lastSender != null) append("${item.lastSender}: ")
        append(Labels.messageText(item.lastText, item.lastMedia))
    }
    val meta = buildList {
        add(item.source.label)
        if (item.muted) add("muted")
        if (!item.notificationLive) add("notification gone")
    }.joinToString(", ")
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = {
            Text(
                item.title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontWeight = if (item.unreadCount > 0) FontWeight.SemiBold else null,
            )
        },
        supportingContent = {
            Text("$preview\n$meta", maxLines = 3, overflow = TextOverflow.Ellipsis)
        },
        trailingContent = {
            Column(horizontalAlignment = Alignment.End) {
                Text(Labels.time(item.timeMs), style = MaterialTheme.typography.labelMedium)
                if (item.unreadCount > 0) Text("${item.unreadCount} unread", style = MaterialTheme.typography.labelMedium)
            }
        },
    )
}

@Composable
private fun MailRow(item: InboxItem.Mail, onClick: () -> Unit) {
    val meta = buildList {
        add(item.source.label)
        item.accountLabel?.let(::add)
        item.requestedAction?.let { add(Labels.requested(it).lowercase()) }
    }.joinToString(", ")
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = {
            Text(
                item.sender ?: "Sender hidden",
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontWeight = if (!item.read) FontWeight.SemiBold else null,
            )
        },
        supportingContent = { Text("${item.subject.ifEmpty { "(no subject)" }}\n$meta", maxLines = 3, overflow = TextOverflow.Ellipsis) },
        trailingContent = {
            Column(horizontalAlignment = Alignment.End) {
                Text(Labels.time(item.timeMs), style = MaterialTheme.typography.labelMedium)
                if (!item.read) Text("Unread", style = MaterialTheme.typography.labelMedium)
            }
        },
    )
}

@Composable
internal fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().padding(Gap.lg), contentAlignment = Alignment.Center) { content() }
}
