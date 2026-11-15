package app.kainos.talk.ui.talk

import kotlinx.coroutines.delay
import androidx.compose.ui.platform.LocalContext
import android.content.Intent
import android.content.ActivityNotFoundException
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.Inbox
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.ListenerHealth
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard
import app.kainos.talk.ui.theme.switchboardType
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

private sealed interface InboxState {
    data object Loading : InboxState
    data class Ready(val inbox: Inbox) : InboxState
    data class Failed(val message: String) : InboxState
}

/** Chats and mail from every line in one list, with the socket board to filter by line. */
@Composable
fun InboxScreen(
    hub: TalkHub,
    onOpenChat: (String) -> Unit,
    onOpenMail: (String) -> Unit,
    onDiagnostics: () -> Unit,
    onConnectPc: (() -> Unit)? = null,
) {
    val state by remember(hub) {
        hub.inbox()
            .map<Inbox, InboxState> { InboxState.Ready(it) }
            .catch { emit(InboxState.Failed(it.message ?: it.javaClass.simpleName)) }
    }.collectAsStateWithLifecycle(InboxState.Loading)
    val health by hub.health.collectAsStateWithLifecycle(null)
    var filter by rememberSaveable { mutableStateOf<Line?>(null) }
    var query by rememberSaveable { mutableStateOf<String?>(null) }
    if (query != null) BackHandler { query = null }

    val lineOf = remember(hub) { hub.sources.associate { it.id to Line.of(it) } }
    val ready = (state as? InboxState.Ready)?.inbox
    val unreadByLine = ready?.unreadBySource.orEmpty().entries
        .groupBy({ lineOf[it.key] ?: Line.OTHER }, { it.value })
        .mapValues { it.value.sum() }

    Scaffold(
        containerColor = MaterialTheme.switchboard.surface,
        topBar = {
            val q = query
            if (q == null) {
                InboxTopBar(onSearch = { query = "" }, onDiagnostics = onDiagnostics, onConnectPc = onConnectPc)
            } else {
                SearchBar(q, onChange = { query = it }, onClose = { query = null })
            }
        },
        bottomBar = { SocketBoard(filter, unreadByLine, onSelect = { filter = it }) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
        KeepRunning(hub, health)
        Box(Modifier.fillMaxSize()) {
            when (val s = state) {
                InboxState.Loading -> CircularProgressIndicator(
                    color = MaterialTheme.switchboard.teal,
                    modifier = Modifier.align(Alignment.Center),
                )
                is InboxState.Failed -> Notice(
                    title = "Kainos Talk couldn't read its message list",
                    body = "${s.message}. Restart the app; if this keeps happening, the Diagnostics screen in the menu shows what the listener sees.",
                )
                is InboxState.Ready -> {
                    val items = s.inbox.items
                        .filter { filter == null || Line.of(it.source) == filter }
                        .filter { item -> query.isNullOrBlank() || item.matches(query!!) }
                    when {
                        items.isNotEmpty() -> InboxList(items, onOpenChat, onOpenMail)
                        !query.isNullOrBlank() -> Notice("Nothing matches “$query”", "Search looks at names, subjects and message text.")
                        filter != null -> Notice(
                            "No ${filter!!.socketLabel} messages yet",
                            "They appear here when ${appNameOf(hub, filter!!)} notifies you.",
                        )
                        else -> Listening(hub, health)
                    }
                }
            }
        }
        }
    }
}

/**
 * Warns when messages would silently stop: the listener is not running although access is on
 * (Android unbinds it after an update, and some phones never bind it again), or the phone may
 * stop the app to save battery.
 */
@Composable
private fun KeepRunning(hub: TalkHub, health: ListenerHealth?) {
    val access by hub.access.collectAsStateWithLifecycle()
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
        settled && access.listenerGranted && health?.connected == false -> WarningStrip(
            title = "Kainos Talk stopped receiving notifications",
            body = if (access.autostartSettings != null) {
                "The phone stopped it, for example when you swiped it away. Turn its notification access off, then on again. " +
                    "To stop this happening, turn on Autostart for Kainos Talk."
            } else {
                "Android turned it off, often after an update. Turn Kainos Talk's notification access off, then on again."
            },
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.lg)) {
                LinkButton("Open notification access", onClick = { open(access.listenerDetailSettings, access.listenerListSettings) }, icon = null)
                if (access.autostartSettings != null) LinkButton("Autostart", onClick = { open(access.autostartSettings) }, icon = null)
            }
        }
        !access.runsInBackground -> WarningStrip(
            title = "Let Kainos Talk run in the background",
            body = "Otherwise the phone may stop it to save battery, and new messages stop arriving here and on your computer.",
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.lg)) {
                LinkButton("Allow", onClick = { open(*access.backgroundSettings.toTypedArray(), access.appInfoSettings) }, icon = null)
                if (access.autostartSettings != null) LinkButton("Autostart", onClick = { open(access.autostartSettings) }, icon = null)
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
            .padding(start = sp.lg, end = sp.lg, top = sp.md),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = c.ink, modifier = Modifier.semantics { heading() })
        Text(body, style = MaterialTheme.typography.bodyMedium, color = c.soft, modifier = Modifier.padding(top = sp.xs))
        actions()
    }
}

private const val LISTENER_GRACE_MS = 4_000L

private fun appNameOf(hub: TalkHub, line: Line): String =
    hub.sources.firstOrNull { Line.of(it) == line }?.label ?: line.socketLabel

private fun InboxItem.matches(q: String): Boolean = when (this) {
    is InboxItem.Chat -> listOfNotNull(title, lastText, lastSender)
    is InboxItem.Mail -> listOfNotNull(sender, subject, accountLabel)
}.any { it.contains(q.trim(), ignoreCase = true) }

@Composable
private fun InboxTopBar(onSearch: () -> Unit, onDiagnostics: () -> Unit, onConnectPc: (() -> Unit)?) {
    var menu by remember { mutableStateOf(false) }
    val c = MaterialTheme.switchboard
    TalkTopBar(startPadding = MaterialTheme.spacing.lg) {
        AppMark(MaterialTheme.sizes.appMark, c.teal, c.onTeal)
        Text(
            "Inbox",
            style = MaterialTheme.typography.headlineSmall,
            color = c.ink,
            modifier = Modifier.weight(1f).padding(start = MaterialTheme.spacing.md).semantics { heading() },
        )
        TalkIconButton(TalkIcons.Search, "Search", onSearch)
        Box {
            TalkIconButton(TalkIcons.More, "More options", { menu = true })
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (onConnectPc != null) {
                    DropdownMenuItem(
                        text = { Text("Connect to PC", style = MaterialTheme.typography.bodyLarge) },
                        onClick = {
                            menu = false
                            onConnectPc()
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Diagnostics", style = MaterialTheme.typography.bodyLarge) },
                    onClick = {
                        menu = false
                        onDiagnostics()
                    },
                )
            }
        }
    }
}

@Composable
private fun SearchBar(query: String, onChange: (String) -> Unit, onClose: () -> Unit) {
    val c = MaterialTheme.switchboard
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    TalkTopBar {
        TalkIconButton(TalkIcons.Back, "Close search", onClose)
        Box(Modifier.weight(1f).padding(horizontal = MaterialTheme.spacing.sm)) {
            if (query.isEmpty()) {
                Text("Search chats and mail", style = MaterialTheme.typography.bodyLarge, color = c.soft)
            }
            BasicTextField(
                value = query,
                onValueChange = onChange,
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.ink),
                cursorBrush = SolidColor(c.teal),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Search chats and mail" },
            )
        }
        if (query.isNotEmpty()) TalkIconButton(TalkIcons.Close, "Clear search", { onChange("") })
    }
}

@Composable
private fun InboxList(items: List<InboxItem>, onOpenChat: (String) -> Unit, onOpenMail: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize()) {
        itemsIndexed(items, key = { _, it -> it.key }) { index, item ->
            when (item) {
                is InboxItem.Chat -> ChatRow(item, divider = index > 0) { onOpenChat(item.key) }
                is InboxItem.Mail -> MailRow(item, divider = index > 0) { onOpenMail(item.key) }
            }
        }
    }
}

/** The shared row: avatar, two or three lines of text, then time and lamp, with an inset divider. */
@Composable
private fun InboxRow(
    name: String,
    avatarName: String,
    item: InboxItem,
    label: String,
    divider: Boolean,
    onClick: () -> Unit,
    meta: @Composable () -> Unit,
    lines: @Composable () -> Unit,
) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val sp = MaterialTheme.spacing
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = "Open", onClick = onClick)
            .clearAndSetSemantics { contentDescription = label }
            .drawBehind {
                if (divider) drawLine(c.edge, Offset(s.rowDividerInset.toPx(), 0f), Offset(size.width, 0f), s.hairline.toPx())
            }
            .heightIn(min = s.rowMinHeight)
            .padding(horizontal = sp.lg, vertical = sp.md),
        horizontalArrangement = Arrangement.spacedBy(sp.lg),
    ) {
        Avatar(avatarName, item.source, behind = c.surface)
        Column(Modifier.weight(1f)) {
            Text(
                name,
                style = MaterialTheme.switchboardType.rowName,
                fontWeight = if (item.unreadCount > 0) FontWeight.Bold else FontWeight.Normal,
                color = c.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            lines()
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(sp.xs)) { meta() }
    }
}

@Composable
private fun Meta(timeMs: Long, unread: Int, muted: Boolean) {
    val c = MaterialTheme.switchboard
    val bold = unread > 0 && !muted
    Row(
        Modifier.heightIn(min = MaterialTheme.sizes.icon),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.xs),
    ) {
        if (muted) Icon(TalkIcons.BellOff, contentDescription = null, tint = c.soft, modifier = Modifier.size(MaterialTheme.sizes.iconTiny))
        Text(
            LocalTalkClock.current.short(timeMs),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
            color = if (bold) c.ink else c.soft,
            maxLines = 1,
        )
    }
    if (unread > 0) Lamp(unread, lit = !muted)
}

@Composable
private fun ChatRow(chat: InboxItem.Chat, divider: Boolean, onClick: () -> Unit) {
    val c = MaterialTheme.switchboard
    val clock = LocalTalkClock.current
    val preview = Copy.preview(chat)
    val label = listOfNotNull(
        chat.title,
        Copy.threadSubtitle(chat.source, chat.isGroup, chat.muted),
        Copy.unread(chat.unreadCount).takeIf { chat.unreadCount > 0 },
        preview.takeIf { it.isNotEmpty() },
        clock.short(chat.timeMs),
    ).joinToString(", ")
    InboxRow(chat.title, chat.title, chat, label, divider, onClick, meta = { Meta(chat.timeMs, chat.unreadCount, chat.muted) }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val media = chat.lastMedia
            if (media != null && chat.lastText.isNullOrBlank()) {
                Icon(
                    TalkIcons.media(media),
                    contentDescription = null,
                    tint = if (chat.unreadCount > 0) c.ink else c.soft,
                    modifier = Modifier.padding(end = MaterialTheme.spacing.xs).size(MaterialTheme.sizes.iconTiny),
                )
            }
            SoftLine(preview, MaterialTheme.typography.bodySmall, if (chat.unreadCount > 0 && !chat.muted) c.ink else c.soft)
        }
    }
}

@Composable
private fun MailRow(mail: InboxItem.Mail, divider: Boolean, onClick: () -> Unit) {
    val c = MaterialTheme.switchboard
    val clock = LocalTalkClock.current
    val sender = Copy.mailSender(mail.sender, mail.senderHidden)
    val third = mail.requestedAction?.let { Copy.mailAction(it) + " requested" } ?: Copy.mailAccount(mail.accountLabel)
    val label = listOfNotNull(
        sender,
        mail.source.label,
        "unread".takeIf { !mail.read },
        mail.subject,
        third,
        clock.short(mail.timeMs),
    ).joinToString(", ")
    InboxRow(sender, if (mail.senderHidden) mail.source.label else sender, mail, label, divider, onClick, meta = { Meta(mail.timeMs, mail.unreadCount, false) }) {
        Text(
            mail.subject,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (!mail.read) FontWeight.Bold else FontWeight.Normal,
            color = c.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (third != null) SoftLine(third, MaterialTheme.typography.bodySmall, c.soft)
    }
}

/** A centred message for an empty filter, an empty search or a failure. */
@Composable
private fun Notice(title: String, body: String) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = MaterialTheme.spacing.xxxl, vertical = MaterialTheme.spacing.stage),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.switchboard.ink, modifier = Modifier.semantics { heading() })
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.switchboard.soft,
            modifier = Modifier.padding(top = MaterialTheme.spacing.sm),
        )
    }
}

/** The empty inbox right after setup: the hub is listening, and each line says whether it can hear. */
@Composable
private fun Listening(hub: TalkHub, health: ListenerHealth?) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val sp = MaterialTheme.spacing
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = sp.xxxl, end = sp.xxxl, top = sp.stage, bottom = sp.xxl),
    ) {
        AppMark(s.appMarkLarge, c.teal, c.onTeal, Modifier.padding(bottom = sp.xl))
        Text(
            "Listening for new messages",
            style = MaterialTheme.typography.headlineSmall,
            color = c.ink,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            "Nothing has arrived since setup. A message appears here as soon as one of these apps notifies you. " +
                "Anything older stays in the app it came from.",
            style = MaterialTheme.typography.bodyMedium,
            color = c.soft,
            modifier = Modifier.padding(top = sp.sm),
        )
        Box(
            Modifier
                .padding(top = sp.xxl)
                .size(s.signalWidth, s.signalHeight)
                .background(c.edge, MaterialTheme.shapes.extraSmall),
        ) {
            Box(
                Modifier
                    .offset(x = s.signalPulseStart)
                    .width(s.signalPulse)
                    .height(s.signalHeight)
                    .background(c.teal, MaterialTheme.shapes.extraSmall),
            )
        }
        Column(Modifier.padding(top = sp.xxxl)) {
            val lines = Line.sockets.mapNotNull { line ->
                hub.sources.filter { Line.of(it) == line }.takeIf { it.isNotEmpty() }?.let { line to it }
            }
            lines.forEachIndexed { index, (line, sources) ->
                val installed = sources.any { hub.isSourceAppInstalled(it.id) }
                val state = when {
                    !installed -> "Not installed"
                    health?.connected == true -> "Listening"
                    else -> "Not connected"
                }
                val name = sources.first().label
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = s.touch)
                        .drawBehind {
                            drawLine(c.edge, Offset(0f, 0f), Offset(size.width, 0f), s.hairline.toPx())
                            if (index == lines.lastIndex) {
                                drawLine(c.edge, Offset(0f, size.height), Offset(size.width, size.height), s.hairline.toPx())
                            }
                        }
                        .clearAndSetSemantics { contentDescription = "$name: $state" },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(s.icon), contentAlignment = Alignment.Center) {
                        Jack(sources.first(), behind = null, inline = true)
                    }
                    Text(
                        name,
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.ink,
                        modifier = Modifier.weight(1f).padding(start = sp.md),
                    )
                    Text(state, style = MaterialTheme.typography.bodySmall, color = c.soft)
                }
            }
        }
    }
}
