package app.kainos.talk.ui.talk

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import app.kainos.talk.ui.theme.SwitchboardShapes
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard
import app.kainos.talk.ui.theme.switchboardType

/**
 * The board under the inbox: four sockets (All and one per line). The active socket's tab hangs
 * from the list into the board; each socket carries its line's unread lamp.
 */
@Composable
internal fun SocketBoard(selected: Line?, unread: Map<Line, Int>, onSelect: (Line?) -> Unit, modifier: Modifier = Modifier) {
    BoardPanel(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = MaterialTheme.spacing.lg)
                .padding(bottom = MaterialTheme.spacing.sm)
                .selectableGroup(),
        ) {
            Socket(null, selected == null, unread.values.sum(), onSelect, Modifier.weight(1f))
            Line.sockets.forEach { line ->
                Socket(line, selected == line, unread[line] ?: 0, onSelect, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Socket(line: Line?, active: Boolean, unread: Int, onSelect: (Line?) -> Unit, modifier: Modifier) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val label = line?.socketLabel ?: "All"
    val description = buildString {
        append(if (line == null) "All lines" else label)
        if (unread > 0) append(", ${Copy.unread(unread)}")
    }
    Box(
        modifier
            .heightIn(min = s.socketHeight)
            .selectable(selected = active, role = Role.Tab, onClick = { onSelect(line) })
            .clearAndSetSemantics {
                contentDescription = description
                role = Role.Tab
                selected = active
            }
            .drawBehind {
                if (!active) return@drawBehind
                drawOutline(SwitchboardShapes.socketTab.createOutline(size, layoutDirection, this), c.surface)
                val w = s.indicatorWidth.toPx()
                val h = s.indicatorHeight.toPx()
                drawRoundRect(
                    color = c.teal,
                    topLeft = Offset((size.width - w) / 2, size.height - h),
                    size = Size(w, h),
                    cornerRadius = CornerRadius(h),
                )
            },
    ) {
        Column(
            Modifier.fillMaxWidth().padding(top = s.socketTop, bottom = MaterialTheme.spacing.md),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.xs),
        ) {
            Box {
                Box(
                    Modifier.size(s.tile).clip(SwitchboardShapes.tile).background(line?.color ?: c.teal),
                    contentAlignment = Alignment.Center,
                ) {
                    if (line == null) {
                        SocketGlyph(s.tileGlyph, c.onTeal, viewBox = 30f, ring = 8f, stroke = 2.4f, dot = 3f)
                    } else {
                        Text(line.letter, style = MaterialTheme.switchboardType.tileLetter.asGlyph(), color = c.onLine)
                    }
                }
                if (unread > 0) {
                    Lamp(
                        unread,
                        behind = if (active) c.surface else c.board,
                        // The socket's TalkBack label carries the count; past 130% the lamp would hide the tile.
                        maxFontScale = TILE_LAMP_MAX_SCALE,
                        modifier = Modifier.align(Alignment.TopEnd).offset(x = s.lampOverhangX, y = -s.lampOverhangY),
                    )
                }
            }
            val style = MaterialTheme.typography.labelSmall
            Text(
                label,
                style = style,
                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                color = if (active) c.teal else c.soft,
                textAlign = TextAlign.Center,
                maxLines = 1,
                // At very large font sizes a long name shrinks a little rather than breaking mid-word.
                autoSize = TextAutoSize.StepBased(minFontSize = style.fontSize * LABEL_MIN_SHRINK, maxFontSize = style.fontSize),
            )
        }
    }
}

private const val TILE_LAMP_MAX_SCALE = 1.3f
// Six sockets share the width: at 200% font a long name needs to shrink to about half to fit.
private const val LABEL_MIN_SHRINK = 0.5f
