package app.kainos.talk.ui.talk

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.ActionResult
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.ReplyFailure
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.theme.SwitchboardShapes
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard
import app.kainos.talk.ui.theme.switchboardType
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlin.math.max

private sealed interface ThreadState {
    data object Loading : ThreadState
    data object Missing : ThreadState

    /** The newest messages, at most [limit] of them. A full page means older ones may still be in the hub. */
    data class Ready(val thread: ChatThread, val limit: Int) : ThreadState {
        val complete: Boolean get() = thread.messages.size < limit
    }

    data class Failed(val message: String) : ThreadState
}

/** What the thread's list shows, oldest first. */
private sealed interface Entry {
    val key: String

    data object Origin : Entry {
        override val key = "origin"
    }

    /** Above the oldest loaded message while older ones may still be in the hub. */
    data object Older : Entry {
        override val key = "older"
    }

    data class Day(val label: String, val atMs: Long) : Entry {
        override val key = "day-$atMs"
    }

    data class Message(val message: ThreadMessage, val showSender: Boolean, val continued: Boolean) : Entry {
        override val key = "m-${message.id}"
    }
}

private fun entries(thread: ChatThread, complete: Boolean, clock: TalkClock): List<Entry> = buildList {
    add(if (complete) Entry.Origin else Entry.Older)
    var previous: ThreadMessage? = null
    thread.messages.forEach { m ->
        val newDay = previous == null || !clock.sameDay(previous!!.timeMs, m.timeMs)
        if (newDay) add(Entry.Day(clock.day(m.timeMs), m.timeMs))
        val sameSender = !newDay && previous?.outgoing == m.outgoing && previous?.senderName == m.senderName
        add(Entry.Message(m, showSender = thread.isGroup && !m.outgoing && !sameSender, continued = sameSender))
        previous = m
    }
}

/** One conversation, newest at the bottom, with the reply field on the board when the app allows it. */
@OptIn(ExperimentalCoroutinesApi::class)
@Composable
fun ThreadScreen(hub: TalkHub, conversationKey: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    // How many of the newest messages to read; scrolling up to the oldest one raises it a page at a time.
    val limit = rememberSaveable(conversationKey) { mutableIntStateOf(PAGE) }
    val state by remember(hub, conversationKey) {
        snapshotFlow { limit.intValue }
            .flatMapLatest { l ->
                hub.thread(conversationKey, l).map<ChatThread?, ThreadState> { if (it == null) ThreadState.Missing else ThreadState.Ready(it, l) }
            }
            .catch { emit(ThreadState.Failed(it.message ?: it.javaClass.simpleName)) }
    }.collectAsStateWithLifecycle(ThreadState.Loading)
    val thread = (state as? ThreadState.Ready)?.thread
    // The reason the most recent reply failed; the hub stores the FAILED status but not why.
    var lastFailure by remember(conversationKey) { mutableStateOf<ReplyFailure?>(null) }
    val say: (String) -> Unit = { scope.launch { snackbar.showSnackbar(it) } }
    val open: () -> Unit = {
        thread?.let { t -> Copy.opened(hub.openInApp(context, conversationKey), t.source)?.let(say) }
    }

    // Opening the thread reads it in the hub only; the source app is not told. A newer message
    // reads it again, and so does a late one that sorts before the newest: the newest id is then
    // unchanged and a full page keeps its size, so only the unread count shows it.
    val newestId = thread?.messages?.lastOrNull()?.id
    val unread = thread?.unread ?: 0
    var readThrough by remember(conversationKey) { mutableStateOf<Long?>(null) }
    LaunchedEffect(conversationKey, newestId, unread) {
        if (thread != null && (unread > 0 || newestId != readThrough)) {
            readThrough = newestId
            hub.markRead(conversationKey)
        }
    }

    Scaffold(
        containerColor = MaterialTheme.switchboard.surface,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            ThreadTopBar(
                thread,
                onBack = onBack,
                onOpen = open,
                onMute = { muted -> scope.launch { hub.setMuted(conversationKey, muted) } },
                onMarkReadInApp = {
                    scope.launch {
                        val t = thread ?: return@launch
                        when (val r = hub.markReadInApp(conversationKey)) {
                            ActionResult.Requested -> say("Asked ${t.source.label} to mark this chat read.")
                            is ActionResult.Failed -> say(Copy.actionFailed(r, t.source))
                        }
                    }
                },
            )
        },
        bottomBar = {
            if (thread != null) {
                ReplyBoard(
                    thread,
                    onSend = { text ->
                        scope.launch {
                            val result = hub.sendReply(conversationKey, text)
                            lastFailure = (result as? ReplyResult.Failed)?.reason
                        }
                    },
                    onOpen = open,
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (val s = state) {
                ThreadState.Loading -> CircularProgressIndicator(color = MaterialTheme.switchboard.teal, modifier = Modifier.align(Alignment.Center))
                ThreadState.Missing -> CenterNote("This conversation is no longer in Kainos Talk.")
                is ThreadState.Failed -> CenterNote("Kainos Talk couldn't read this conversation: ${s.message}")
                is ThreadState.Ready -> Messages(s.thread, s.complete, lastFailure, open) {
                    // Once per page: the next request waits until this one's messages are in.
                    if (limit.intValue == s.limit) limit.intValue = s.limit + PAGE
                }
            }
        }
    }
}

@Composable
private fun CenterNote(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.switchboard.soft,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.xxxl),
    )
}

@Composable
private fun ThreadTopBar(
    thread: ChatThread?,
    onBack: () -> Unit,
    onOpen: () -> Unit,
    onMute: (Boolean) -> Unit,
    onMarkReadInApp: () -> Unit,
) {
    val c = MaterialTheme.switchboard
    var menu by remember { mutableStateOf(false) }
    TalkTopBar {
        TalkIconButton(TalkIcons.Back, "Back", onBack)
        if (thread == null) return@TalkTopBar
        Avatar(thread.title, thread.source, behind = c.surface, small = true, modifier = Modifier.padding(start = MaterialTheme.spacing.xs))
        Column(
            Modifier
                .weight(1f)
                .padding(start = MaterialTheme.spacing.md + MaterialTheme.spacing.xs)
                .semantics(mergeDescendants = true) { heading() },
        ) {
            Text(thread.title, style = MaterialTheme.typography.titleLarge, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                Copy.threadSubtitle(thread.source, thread.isGroup, thread.muted),
                style = MaterialTheme.typography.labelMedium,
                color = c.soft,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        TalkIconButton(TalkIcons.Open, Copy.openIn(thread.source), onOpen)
        Box {
            TalkIconButton(TalkIcons.More, "More options", { menu = true })
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(if (thread.muted) "Unmute in Kainos Talk" else "Mute in Kainos Talk", style = MaterialTheme.typography.bodyLarge) },
                    onClick = {
                        menu = false
                        onMute(!thread.muted)
                    },
                )
                if (thread.capabilities.canMarkReadInApp) {
                    DropdownMenuItem(
                        text = { Text("Mark read in ${thread.source.label}", style = MaterialTheme.typography.bodyLarge) },
                        onClick = {
                            menu = false
                            onMarkReadInApp()
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun Messages(thread: ChatThread, complete: Boolean, lastFailure: ReplyFailure?, onOpen: () -> Unit, onNearOldest: () -> Unit) {
    val clock = LocalTalkClock.current
    val list = remember(thread, complete, clock) { entries(thread, complete, clock).asReversed() }
    val newestFailedId = thread.messages.lastOrNull { it.status == MessageStatus.FAILED }?.id
    val sp = MaterialTheme.spacing
    val listState = rememberLazyListState()
    // Follow new messages, including your own reply, unless you have scrolled back to read.
    val newest = thread.messages.lastOrNull()?.id
    LaunchedEffect(newest) { if (listState.firstVisibleItemIndex <= FOLLOW_WITHIN) listState.animateScrollToItem(0) }
    // Older messages join at the top of a reversed list, so the rows on screen keep their place.
    val nearOldest by rememberUpdatedState(onNearOldest)
    LaunchedEffect(listState, complete, thread.messages.size) {
        if (complete) return@LaunchedEffect
        snapshotFlow {
            val info = listState.layoutInfo
            val top = info.visibleItemsInfo.lastOrNull()?.index ?: return@snapshotFlow false
            top >= info.totalItemsCount - 1 - LOAD_WITHIN
        }.filter { it }.collect { nearOldest() }
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        state = listState,
        reverseLayout = true,
        contentPadding = PaddingValues(start = sp.lg, end = sp.lg, top = sp.xs, bottom = sp.md),
    ) {
        items(list, key = { it.key }) { entry ->
            when (entry) {
                Entry.Origin -> OriginCard(thread, clock, onOpen)
                Entry.Older -> OlderLoading()
                is Entry.Day -> Text(
                    entry.label,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.switchboard.soft,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = sp.md, bottom = sp.sm).semantics { heading() },
                )
                is Entry.Message -> Bubble(
                    thread,
                    entry,
                    failure = if (entry.message.id == newestFailedId) lastFailure else null,
                    onOpen = onOpen,
                )
            }
        }
    }
}

/** Where this chat's history in Kainos Talk begins, and the way to everything before it. */
@Composable
private fun OriginCard(thread: ChatThread, clock: TalkClock, onOpen: () -> Unit) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    val first = thread.messages.firstOrNull()?.timeMs
    Row(
        Modifier
            .fillMaxWidth()
            .clip(SwitchboardShapes.card)
            .background(c.board)
            .padding(start = sp.lg, end = sp.lg, top = sp.md + MaterialTheme.sizes.hairline * 2, bottom = sp.xs),
        horizontalArrangement = Arrangement.spacedBy(sp.md),
    ) {
        SocketGlyph(MaterialTheme.sizes.originGlyph, c.teal)
        Column(Modifier.weight(1f)) {
            Text(Copy.earlierTitle(thread.source), style = MaterialTheme.typography.titleSmall, color = c.ink)
            Text(
                Copy.earlierBody(first?.let(clock::longDate)),
                style = MaterialTheme.typography.bodySmall,
                color = c.soft,
                modifier = Modifier.padding(top = sp.hair),
            )
            LinkButton(Copy.openIn(thread.source), onOpen)
        }
    }
}

@Composable
private fun OlderLoading() {
    val label = Copy.loadingEarlier
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = MaterialTheme.spacing.md)
            .clearAndSetSemantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            color = MaterialTheme.switchboard.soft,
            strokeWidth = MaterialTheme.sizes.border,
            modifier = Modifier.size(MaterialTheme.sizes.iconSmall),
        )
    }
}

@Composable
private fun Bubble(thread: ChatThread, entry: Entry.Message, failure: ReplyFailure?, onOpen: () -> Unit) {
    val m = entry.message
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val sp = MaterialTheme.spacing
    val clock = LocalTalkClock.current
    val failed = m.status == MessageStatus.FAILED
    val shape = if (m.outgoing) SwitchboardShapes.bubbleOut else SwitchboardShapes.bubbleIn
    val (bg, fg, meta) = when {
        failed -> Triple(c.surface, c.ink, c.soft)
        m.outgoing -> Triple(c.out, c.onOut, c.onOut)
        else -> Triple(c.raised, c.ink, c.soft)
    }
    val status = Copy.status(thread.source, m.status)
    val media = m.media
    val spoken = listOfNotNull(
        if (m.outgoing) "You" else m.senderName,
        media?.let(Copy::media),
        m.text.takeIf { it.isNotBlank() },
        clock.clock(m.timeMs),
        status,
    ).joinToString(", ")

    Column(
        Modifier.fillMaxWidth().padding(top = if (entry.continued) sp.xs else sp.sm),
        horizontalAlignment = if (m.outgoing) Alignment.End else Alignment.Start,
    ) {
        Column(
            Modifier
                .widthIn(max = s.bubbleMaxWidth)
                .clip(shape)
                .background(bg)
                .then(if (failed) Modifier.border(s.border, c.alert, shape) else Modifier)
                .then(
                    if (media != null) {
                        Modifier
                            .clickable(onClickLabel = Copy.viewIn(thread.source), onClick = onOpen)
                            .clearAndSetSemantics {
                                contentDescription = "$spoken. ${Copy.viewIn(thread.source)}"
                                role = Role.Button
                                onClick(Copy.viewIn(thread.source)) { onOpen(); true }
                            }
                    } else {
                        Modifier.clearAndSetSemantics { contentDescription = spoken }
                    },
                )
                .padding(horizontal = sp.md, vertical = sp.sm),
        ) {
            if (entry.showSender && m.senderName != null) {
                Text(m.senderName, style = MaterialTheme.switchboardType.sender, color = c.teal)
            }
            val trailing: @Composable () -> Unit = { BubbleMeta(m, meta) }
            if (media != null) {
                MediaLabel(thread, media, fg, trailing = if (m.text.isBlank()) trailing else null)
                if (m.text.isNotBlank()) TimedText(m.text, MaterialTheme.switchboardType.bubble, fg, trailing)
            } else {
                TimedText(m.text, MaterialTheme.switchboardType.bubble, fg, trailing)
            }
        }
        if (failed) FailNote(thread, failure, onOpen)
    }
}

/** The time and, for your own messages, how far the reply got. */
@Composable
private fun BubbleMeta(m: ThreadMessage, color: Color) {
    if (m.status == MessageStatus.FAILED) return
    val icon: ImageVector? = when (m.status) {
        MessageStatus.SENDING -> TalkIcons.Clock
        MessageStatus.SENT -> TalkIcons.Check
        MessageStatus.CONFIRMED -> TalkIcons.CheckDouble
        else -> null
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.xs)) {
        Text(LocalTalkClock.current.clock(m.timeMs), style = MaterialTheme.typography.labelSmall, color = color)
        if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(MaterialTheme.sizes.iconTiny))
    }
}

/** Media never reaches the hub, so it shows as a label with the way to see it. */
@Composable
private fun MediaLabel(thread: ChatThread, media: app.kainos.talk.core.MediaKind, color: Color, trailing: (@Composable () -> Unit)?) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val dash = s.border
    Row(
        Modifier.heightIn(min = s.mediaThumb),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.md),
    ) {
        Box(
            Modifier
                .size(s.mediaThumb)
                .drawBehind {
                    val w = dash.toPx()
                    drawRoundRect(
                        color = c.outline,
                        topLeft = androidx.compose.ui.geometry.Offset(w / 2, w / 2),
                        size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w),
                        cornerRadius = CornerRadius(s.mediaThumb.toPx() * 0.3f),
                        style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(w * 3, w * 2))),
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(TalkIcons.media(media), contentDescription = null, tint = c.soft)
        }
        Column(Modifier.weight(1f, fill = false)) {
            Text(Copy.media(media), style = MaterialTheme.typography.titleSmall, color = color)
            Text(Copy.viewIn(thread.source), style = MaterialTheme.typography.labelMedium, color = c.soft)
        }
        Icon(TalkIcons.Open, contentDescription = null, tint = c.teal, modifier = Modifier.size(s.iconSmall))
        trailing?.invoke()
    }
}

@Composable
private fun FailNote(thread: ChatThread, failure: ReplyFailure?, onOpen: () -> Unit) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    Row(
        Modifier.widthIn(max = MaterialTheme.sizes.bubbleMaxWidth).padding(top = sp.sm),
        horizontalArrangement = Arrangement.spacedBy(sp.sm),
    ) {
        Icon(TalkIcons.Error, contentDescription = null, tint = c.alert, modifier = Modifier.size(MaterialTheme.sizes.iconSmall))
        Column {
            Text(Copy.notSent(thread.source, failure), style = MaterialTheme.typography.labelMedium, color = c.alert)
            LinkButton(Copy.openIn(thread.source), onOpen)
        }
    }
}

/**
 * Text with a trailing time that tucks into the last line when it fits, as chat apps do, and
 * drops below the text when it does not.
 */
@Composable
private fun TimedText(text: String, style: TextStyle, color: Color, trailing: @Composable () -> Unit) {
    val holder = remember { arrayOfNulls<TextLayoutResult>(1) }
    val gap = MaterialTheme.spacing.md
    Layout(
        content = {
            Text(text, style = style, color = color, onTextLayout = { holder[0] = it })
            trailing()
        },
    ) { measurables, constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val body = measurables[0].measure(loose)
        // A failed reply has no time, so the trailing slot can be empty.
        val meta = measurables.getOrNull(1)?.measure(Constraints(maxWidth = loose.maxWidth))
        if (meta == null) return@Layout layout(body.width, body.height) { body.placeRelative(0, 0) }
        val text = holder[0]
        val lastLineRight = text?.takeIf { it.lineCount > 0 }?.let { it.getLineRight(it.lineCount - 1).toInt() } ?: body.width
        val gapPx = gap.roundToPx()
        val inline = lastLineRight + gapPx + meta.width <= loose.maxWidth
        val width = if (inline) max(body.width, lastLineRight + gapPx + meta.width) else max(body.width, meta.width)
        val height = if (inline) max(body.height, meta.height) else body.height + meta.height
        layout(width, height) {
            body.placeRelative(0, 0)
            meta.placeRelative(width - meta.width, height - meta.height)
        }
    }
}

/** The bottom board in a thread: the reply field when the app takes replies, otherwise the way out. */
@Composable
private fun ReplyBoard(thread: ChatThread, onSend: (String) -> Unit, onOpen: () -> Unit) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val sp = MaterialTheme.spacing
    BoardPanel(Modifier.imePadding()) {
        if (!thread.capabilities.canReply) {
            Column(Modifier.padding(start = sp.lg, end = sp.lg, top = sp.md, bottom = sp.lg)) {
                Text(
                    Copy.replyBlocked(thread.source, thread.capabilities.replyBlocked),
                    style = MaterialTheme.typography.bodySmall,
                    color = c.soft,
                    modifier = Modifier.padding(bottom = sp.md),
                )
                BigButton(Copy.openIn(thread.source), onOpen, icon = TalkIcons.Open)
            }
            return@BoardPanel
        }
        var text by rememberSaveable(thread.key) { mutableStateOf("") }
        val canSend = text.isNotBlank()
        val send = {
            if (canSend) {
                onSend(text.trim())
                text = ""
            }
        }
        Row(
            Modifier.padding(start = sp.md, end = sp.md, top = sp.md, bottom = sp.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(sp.md),
        ) {
            Row(
                Modifier
                    .weight(1f)
                    .heightIn(min = s.field)
                    .clip(SwitchboardShapes.field)
                    .background(c.surface)
                    .border(s.hairline, c.outline, SwitchboardShapes.field)
                    .padding(horizontal = sp.md + sp.hair, vertical = sp.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(sp.md),
            ) {
                Jack(thread.source, behind = null, inline = true)
                Box(Modifier.weight(1f)) {
                    val placeholder = Copy.replyPlaceholder(thread.source)
                    if (text.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = c.soft)
                    BasicTextField(
                        value = text,
                        onValueChange = { text = it },
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.ink),
                        cursorBrush = SolidColor(c.teal),
                        maxLines = 5,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder },
                    )
                }
            }
            val label = Copy.sendLabel(thread.source)
            Box(
                Modifier
                    .size(s.field)
                    .clip(SwitchboardShapes.sendButton)
                    .background(if (canSend) c.teal else c.edge)
                    .clickable(enabled = canSend, onClickLabel = label, onClick = send)
                    .clearAndSetSemantics {
                        contentDescription = label
                        role = Role.Button
                        if (canSend) onClick(label) { send(); true } else disabled()
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(TalkIcons.Send, contentDescription = null, tint = if (canSend) c.onTeal else c.soft)
            }
        }
    }
}

/** How many items from the bottom still count as "reading the newest". */
private const val FOLLOW_WITHIN = 2

/** Messages read from the hub per page, newest first. */
internal const val PAGE = 200

/** How many rows below the oldest loaded one start reading the next page. */
private const val LOAD_WITHIN = 30
