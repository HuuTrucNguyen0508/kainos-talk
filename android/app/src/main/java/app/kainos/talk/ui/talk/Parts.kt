package app.kainos.talk.ui.talk

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import app.kainos.talk.ui.theme.SwitchboardShapes
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard
import app.kainos.talk.ui.theme.switchboardType

/** The app mark: a teal tile with the socket ring and contact, from the desktop rail. */
@Composable
internal fun AppMark(size: Dp, tile: Color, glyph: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val unit = this.size.width / 30f
        drawRoundRect(tile, cornerRadius = CornerRadius(8.5f * unit))
        drawCircle(glyph, radius = 7f * unit, style = Stroke(2.6f * unit))
        drawCircle(glyph, radius = 2.6f * unit)
    }
}

/** The amber lamp with a number in it; an unlit lamp is a hollow ring. The parent carries the TalkBack label. */
@Composable
internal fun Lamp(count: Int, modifier: Modifier = Modifier, lit: Boolean = true) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    Box(
        modifier
            .heightIn(min = s.lamp)
            .widthIn(min = s.lamp)
            .clip(SwitchboardShapes.lamp)
            .then(
                if (lit) {
                    Modifier.background(c.lamp).border(s.hairline, c.lampEdge, SwitchboardShapes.lamp)
                } else {
                    Modifier.border(s.border, c.outline, SwitchboardShapes.lamp)
                },
            )
            .padding(horizontal = MaterialTheme.spacing.xs + s.hairline * 2)
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(count.toString(), style = MaterialTheme.switchboardType.lamp, color = if (lit) c.lampInk else c.soft, textAlign = TextAlign.Center)
    }
}

/** The screen header: 64 dp tall below the status bar, on the surface colour. */
@Composable
internal fun TalkTopBar(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.switchboard.surface)
            .windowInsetsPadding(WindowInsets.statusBars)
            .heightIn(min = MaterialTheme.sizes.appBar)
            .padding(horizontal = MaterialTheme.spacing.xxl),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/** A teal text link, 48 dp tall. */
@Composable
internal fun LinkButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = MaterialTheme.sizes.touch),
        contentPadding = PaddingValues(),
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.switchboard.teal)
    }
}

/** The board's main button: full width, 56 dp, teal. */
@Composable
internal fun BigButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = MaterialTheme.switchboard
    Button(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().heightIn(min = MaterialTheme.sizes.bigButton),
        shape = SwitchboardShapes.bigButton,
        colors = ButtonDefaults.buttonColors(containerColor = c.teal, contentColor = c.onTeal),
    ) {
        Text(text, style = MaterialTheme.switchboardType.bigButton, textAlign = TextAlign.Center)
    }
}

/** The sage panel a screen ends on. Its top edge is a hairline; it pads for the gesture bar. */
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
