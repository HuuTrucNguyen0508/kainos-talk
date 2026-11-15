package app.kainos.talk.ui.talk

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.kainos.talk.core.MediaKind

/**
 * The mockup's own line icons (24 grid, 1.8 stroke, round caps and joins), transcribed from the
 * SVG symbols in `design/pocket-switchboard/index.html`. They replace Material Symbols because
 * the approved design draws its own set; one family is used everywhere.
 */
internal object TalkIcons {
    private fun circle(cx: Float, cy: Float, r: Float) =
        "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0z"

    private fun roundRect(x: Float, y: Float, w: Float, h: Float, r: Float) =
        "M${x + r},${y}h${w - 2 * r}a$r,$r 0 0 1 $r,${r}v${h - 2 * r}a$r,$r 0 0 1 ${-r},${r}" +
            "h${-(w - 2 * r)}a$r,$r 0 0 1 ${-r},${-r}v${-(h - 2 * r)}a$r,$r 0 0 1 $r,${-r}z"

    private fun icon(name: String, mirror: Boolean = false, filled: List<String> = emptyList(), vararg strokes: String) =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f, autoMirror = mirror).apply {
            strokes.forEach {
                addPath(
                    pathData = addPathNodes(it),
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 1.8f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
            filled.forEach { addPath(pathData = addPathNodes(it), fill = SolidColor(Color.Black)) }
        }.build()

    val Back = icon("back", mirror = true, strokes = arrayOf("M19 12H5M11 6l-6 6 6 6"))
    val Search = icon("search", strokes = arrayOf(circle(10.5f, 10.5f, 6f), "M15 15l5 5"))
    val More = icon(
        "more",
        filled = listOf(circle(12f, 5.5f, 1.6f), circle(12f, 12f, 1.6f), circle(12f, 18.5f, 1.6f)),
    )
    val Close = icon("close", strokes = arrayOf("M6 6l12 12M18 6L6 18"))
    val Open = icon(
        "open",
        strokes = arrayOf(
            "M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10",
        ),
    )
    val Send = icon("send", mirror = true, strokes = arrayOf("M20.5 3.5L3.5 10.3l6.6 3.1 3.1 6.6zM10.1 13.4l4.3-4.2"))
    val BellOff = icon(
        "bell-off",
        strokes = arrayOf("M8.2 6.3A6 6 0 0 1 18 11v4M19 18.5H5.2l1.3-2V11c0-.9.2-1.8.6-2.6M10 21a2.2 2.2 0 0 0 4 0M4 4l16 16"),
    )
    val Image = icon(
        "image",
        strokes = arrayOf(roundRect(3.5f, 5f, 17f, 14f, 2.5f), circle(9f, 10f, 1.5f), "M4.5 17l4.5-4 3.5 3 3-2.5 4.5 3.5"),
    )
    val Video = icon(
        "video",
        strokes = arrayOf(roundRect(3.5f, 6f, 12f, 12f, 1.5f), "M15.5 10.5l5-3v9l-5-3"),
    )
    val Mic = icon("mic", strokes = arrayOf(roundRect(9f, 3.5f, 6f, 10f, 3f), "M6 11.5a6 6 0 0 0 12 0M12 17.5V21"))
    val Place = icon(
        "place",
        strokes = arrayOf("M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z", circle(12f, 10f, 2.3f)),
    )
    val File = icon(
        "file",
        strokes = arrayOf(
            "M7 3.5h7l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5zM14 3.5V8h4.5",
        ),
    )
    val Error = icon("error", filled = listOf(circle(12f, 16.2f, 1.1f)), strokes = arrayOf(circle(12f, 12f, 8.5f), "M12 7.6v5.2"))
    val Check = icon("check", strokes = arrayOf("M5 12.5l4.5 4.5L19 7.5"))
    val CheckDouble = icon("check-double", strokes = arrayOf("M2.5 12.5l4.5 4.5L16.5 7.5M11.5 16.5l.5.5 9.5-9.5"))
    val Clock = icon("clock", strokes = arrayOf(circle(12f, 12f, 8.5f), "M12 7.5V12l3 2"))
    val Archive = icon(
        "archive",
        strokes = arrayOf(roundRect(3.5f, 4.5f, 17f, 4.5f, 1f), "M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"),
    )
    val Trash = icon(
        "trash",
        strokes = arrayOf("M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5l1-12.5M10 11v6M14 11v6"),
    )
    val MailOpen = icon(
        "mail-open",
        strokes = arrayOf("M3.5 10l8.5-6 8.5 6v8.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5zM4 10.5l8 5.5 8-5.5"),
    )

    fun media(kind: MediaKind): ImageVector = when (kind) {
        MediaKind.IMAGE, MediaKind.GIF, MediaKind.STICKER -> Image
        MediaKind.VIDEO -> Video
        MediaKind.VOICE, MediaKind.AUDIO -> Mic
        MediaKind.LOCATION -> Place
        MediaKind.DOCUMENT, MediaKind.CONTACT, MediaKind.POLL, MediaKind.OTHER -> File
    }
}

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

/** The bare socket glyph: ring and contact without a tile ([viewBox] matches the mockup symbol). */
@Composable
internal fun SocketGlyph(size: Dp, color: Color, modifier: Modifier = Modifier, viewBox: Float = 28f, ring: Float = 9f, stroke: Float = 2.2f, dot: Float = 3.2f) {
    Canvas(modifier.size(size)) {
        val unit = this.size.width / viewBox
        val c = Offset(this.size.width / 2, this.size.height / 2)
        drawCircle(color, radius = ring * unit, center = c, style = Stroke(stroke * unit))
        drawCircle(color, radius = dot * unit, center = c)
    }
}
