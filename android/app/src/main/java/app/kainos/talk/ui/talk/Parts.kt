package app.kainos.talk.ui.talk

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import app.kainos.talk.core.Source
import app.kainos.talk.ui.theme.SwitchboardShapes
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard
import app.kainos.talk.ui.theme.switchboardType

/**
 * Glyph-like text (jack letters, tile letters, initials) keeps its size at any font scale: it
 * sits in a fixed shape and its meaning is carried by the parent's TalkBack label.
 */
@Composable
@ReadOnlyComposable
internal fun TextStyle.asGlyph(maxScale: Float = 1f): TextStyle {
    val scale = LocalDensity.current.fontScale
    if (scale <= maxScale) return this
    val shrink = maxScale / scale
    return copy(fontSize = fontSize * shrink, lineHeight = lineHeight * shrink)
}

/** Which app a conversation came through: a coloured jack whose shape and letter name the line. */
@Composable
internal fun Jack(source: Source, behind: Color?, modifier: Modifier = Modifier, inline: Boolean = false) {
    val line = Line.of(source)
    val s = MaterialTheme.sizes
    val height = if (inline) s.jackInline else s.jack
    val width = when {
        line != Line.MAIL -> height
        inline -> s.jackMailInlineWidth
        else -> s.jackMailWidth
    }
    val shape = line.jackShape(inline)
    Box(
        modifier
            .size(width, height)
            .then(if (behind != null) Modifier.border(s.jackBorder, behind, shape).padding(s.jackBorder) else Modifier)
            .clip(shape)
            .background(line.color)
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            jackLetter(source),
            style = MaterialTheme.switchboardType.jack.asGlyph(),
            color = MaterialTheme.switchboard.onLine,
        )
    }
}

/**
 * The conversation's tile: initials on the board colour with an edge rim. Notifications reach
 * the hub without a usable picture, so every tile is the initials tile, drawn on purpose.
 */
@Composable
internal fun Avatar(name: String, source: Source?, behind: Color, modifier: Modifier = Modifier, small: Boolean = false) {
    val s = MaterialTheme.sizes
    val c = MaterialTheme.switchboard
    val size = if (small) s.avatarSmall else s.avatar
    val shape = if (small) SwitchboardShapes.avatarSmall else SwitchboardShapes.avatar
    Box(modifier.size(size).clearAndSetSemantics { }) {
        Box(
            Modifier
                .size(size)
                .clip(shape)
                .background(c.board)
                .border(s.hairline, c.edge, shape),
            contentAlignment = Alignment.Center,
        ) {
            val style = if (small) MaterialTheme.switchboardType.avatarSmall else MaterialTheme.switchboardType.avatar
            Text(initials(name), style = style.asGlyph(), color = c.teal, maxLines = 1)
        }
        if (source != null) {
            val overhang = s.jackOffset
            Jack(source, behind = behind, modifier = Modifier.align(Alignment.BottomEnd).offset(overhang, overhang))
        }
    }
}

/**
 * The amber unread lamp. A muted conversation's lamp is unlit: a hollow ring with the count.
 * [behind] draws the 2 dp gap ring used where the lamp overlaps a tile.
 */
@Composable
internal fun Lamp(count: Int, modifier: Modifier = Modifier, lit: Boolean = true, behind: Color? = null, maxFontScale: Float = Float.MAX_VALUE) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val ring = behind?.let { Modifier.background(it, SwitchboardShapes.lamp).padding(s.jackBorder) } ?: Modifier
    Box(
        modifier
            .then(ring)
            .heightIn(min = if (behind != null) s.lamp - s.jackBorder * 2 else s.lamp)
            .widthIn(min = if (behind != null) s.lamp - s.jackBorder * 2 else s.lamp)
            .clip(SwitchboardShapes.lamp)
            .then(
                if (lit) {
                    Modifier.background(c.lamp).border(s.hairline, c.lampEdge, SwitchboardShapes.lamp)
                } else {
                    Modifier.border(s.border, c.outline, SwitchboardShapes.lamp)
                },
            )
            .padding(horizontal = if (behind != null) MaterialTheme.spacing.xs else MaterialTheme.spacing.xs + s.hairline * 2)
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            count.toString(),
            style = MaterialTheme.switchboardType.lamp.asGlyph(maxFontScale),
            color = if (lit) c.lampInk else c.soft,
            textAlign = TextAlign.Center,
        )
    }
}

/** The screen header: 64 dp tall below the status bar, on the surface colour. */
@Composable
internal fun TalkTopBar(modifier: Modifier = Modifier, startPadding: Dp = MaterialTheme.spacing.xs, content: @Composable RowScope.() -> Unit) {
    Row(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.switchboard.surface)
            .windowInsetsPadding(WindowInsets.statusBars)
            .heightIn(min = MaterialTheme.sizes.appBar)
            .padding(start = startPadding, end = MaterialTheme.spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
internal fun TalkIconButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = MaterialTheme.switchboard.ink) {
    IconButton(onClick = onClick, modifier = modifier) {
        Icon(icon, contentDescription = label, tint = tint)
    }
}

/** A teal text link with a trailing icon, 48 dp tall: "Open in WhatsApp". */
@Composable
internal fun LinkButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = TalkIcons.Open) {
    TextButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = MaterialTheme.sizes.touch),
        contentPadding = PaddingValues(),
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.switchboard.teal)
        if (icon != null) {
            Icon(
                icon,
                contentDescription = null,
                tint = MaterialTheme.switchboard.teal,
                modifier = Modifier.padding(start = MaterialTheme.spacing.sm).size(MaterialTheme.sizes.iconSmall),
            )
        }
    }
}

/** The board's main button: full width, 56 dp, teal. */
@Composable
internal fun BigButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val c = MaterialTheme.switchboard
    Button(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().heightIn(min = MaterialTheme.sizes.bigButton),
        shape = SwitchboardShapes.bigButton,
        colors = ButtonDefaults.buttonColors(containerColor = c.teal, contentColor = c.onTeal),
    ) {
        Text(text, style = MaterialTheme.switchboardType.bigButton, textAlign = TextAlign.Center)
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.padding(start = MaterialTheme.spacing.md))
        }
    }
}

/** The sage panel every screen ends on. Its top edge is a hairline; it pads for the gesture bar. */
@Composable
internal fun BoardPanel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.switchboard
    val line = MaterialTheme.sizes.hairline
    Column(
        modifier
            .fillMaxWidth()
            .background(c.board)
            .drawBehind { drawLine(c.edge, Offset(0f, 0f), Offset(size.width, 0f), line.toPx()) }
            .windowInsetsPadding(WindowInsets.navigationBars),
        content = content,
    )
}

/** A one-line row of secondary text that ellipsizes. */
@Composable
internal fun SoftLine(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier, maxLines: Int = 1) {
    Text(text, style = style, color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis, modifier = modifier)
}
