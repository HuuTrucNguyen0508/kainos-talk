package app.kainos.talk.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

val SwitchboardMaterialShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(20.dp),
)

/** The mockup's named shapes. Corner sizes follow the CSS one for one. */
object SwitchboardShapes {
    val avatar = RoundedCornerShape(16.dp)
    val avatarSmall = RoundedCornerShape(14.dp)
    val tile = RoundedCornerShape(14.dp)
    val iconButton = RoundedCornerShape(16.dp)
    val field = RoundedCornerShape(18.dp)
    val sendButton = RoundedCornerShape(16.dp)
    val bigButton = RoundedCornerShape(18.dp)
    val card = RoundedCornerShape(20.dp)
    val mediaPlaceholder = RoundedCornerShape(12.dp)
    val lamp = CircleShape
    val bubbleIn = RoundedCornerShape(topStart = 6.dp, topEnd = 18.dp, bottomEnd = 18.dp, bottomStart = 18.dp)
    val bubbleOut = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomEnd = 6.dp, bottomStart = 18.dp)
    val indicator = RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp)

    /**
     * Line jacks: WhatsApp round, Discord a rounded square, Messenger a speech bubble (round with
     * one square corner), SMS an octagon (cut corners), Mail a wide envelope.
     */
    val jackWhatsApp = CircleShape
    val jackDiscord = RoundedCornerShape(7.dp)
    val jackMessenger = RoundedCornerShape(topStartPercent = 50, topEndPercent = 50, bottomEndPercent = 50, bottomStartPercent = 10)
    val jackSms = CutCornerShape(6.dp)
    val jackMail = RoundedCornerShape(4.dp)
    val jackDiscordInline = RoundedCornerShape(5.dp)
    val jackSmsInline = CutCornerShape(5.dp)
    val jackMailInline = RoundedCornerShape(3.dp)

    val socketTab: Shape = SocketTabShape(inset = 4.dp, flare = 16.dp, radius = 20.dp)
}

/**
 * The active socket: a surface-coloured tab that hangs from the list into the board, with
 * concave flares at the top so the list curves down into it. The outline deliberately reaches
 * [flare] beyond the composable's left and right edges, into the neighbouring sockets.
 */
class SocketTabShape(private val inset: Dp, private val flare: Dp, private val radius: Dp) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val i = with(density) { inset.toPx() }
        val f = with(density) { flare.toPx() }
        val r = with(density) { radius.toPx() }
        val w = size.width
        val h = size.height
        val path = Path().apply {
            moveTo(i - f, 0f)
            lineTo(w - i + f, 0f)
            // Right flare: a quarter circle centred outside the tab, cutting the corner away.
            arcTo(Rect(w - i, 0f, w - i + 2 * f, 2 * f), 270f, -90f, false)
            lineTo(w - i, h - r)
            arcTo(Rect(w - i - 2 * r, h - 2 * r, w - i, h), 0f, 90f, false)
            lineTo(i + r, h)
            arcTo(Rect(i, h - 2 * r, i + 2 * r, h), 90f, 90f, false)
            lineTo(i, f)
            arcTo(Rect(i - 2 * f, 0f, i, 2 * f), 0f, -90f, false)
            close()
        }
        return Outline.Generic(path)
    }
}
