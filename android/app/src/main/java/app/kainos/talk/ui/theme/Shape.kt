package app.kainos.talk.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
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
    val bigButton = RoundedCornerShape(18.dp)
    val card = RoundedCornerShape(20.dp)
    val lamp = CircleShape
}
