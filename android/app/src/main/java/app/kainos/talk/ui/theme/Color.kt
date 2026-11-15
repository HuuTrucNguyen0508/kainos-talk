package app.kainos.talk.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * The Pocket Switchboard palette, copied token for token from
 * `android/design/pocket-switchboard/index.html` (TOKENS-LIGHT and TOKENS-DARK).
 * The names follow the mockup so the two can be compared line by line.
 */
@Immutable
data class SwitchboardColors(
    /** The list and screen background. */
    val surface: Color,
    /** The sage panel at the bottom of a screen, warning strips, the list of computers. */
    val board: Color,
    /** Hairlines: the board's top edge, setup rules and the step rail. */
    val edge: Color,
    /** A step above the surface; Material's surface variant and container. */
    val raised: Color,
    /** Body text. */
    val ink: Color,
    /** Secondary text: previews, times, captions. */
    val soft: Color,
    /** The accent: buttons, links, the connected lamp. */
    val teal: Color,
    val onTeal: Color,
    /** The amber unread lamp. */
    val lamp: Color,
    val lampInk: Color,
    val lampEdge: Color,
    val alert: Color,
    /** The unlit lamp ring and the not-connected dot. */
    val outline: Color,
)

val LightSwitchboard = SwitchboardColors(
    surface = Color(0xFFF6F8F7),
    board = Color(0xFFDDE4E1),
    edge = Color(0xFFC5D0CC),
    raised = Color(0xFFE8EDEB),
    ink = Color(0xFF1C2A2D),
    soft = Color(0xFF4B5C5F),
    teal = Color(0xFF0E6B66),
    onTeal = Color(0xFFF6F8F7),
    lamp = Color(0xFFE6A11A),
    lampInk = Color(0xFF1C2A2D),
    lampEdge = Color(0xFF8A5A00),
    alert = Color(0xFFB3261E),
    outline = Color(0xFF6C807D),
)

val DarkSwitchboard = SwitchboardColors(
    surface = Color(0xFF0E1619),
    board = Color(0xFF162024),
    edge = Color(0xFF24343A),
    raised = Color(0xFF1B282D),
    ink = Color(0xFFD6E2DF),
    soft = Color(0xFF93A6A6),
    teal = Color(0xFF4CBCB1),
    onTeal = Color(0xFF0E1619),
    lamp = Color(0xFFF0B42E),
    lampInk = Color(0xFF162024),
    lampEdge = Color(0xFFF0B42E),
    alert = Color(0xFFF2A59F),
    outline = Color(0xFF6F8585),
)

/** Material roles mapped onto the switchboard tokens, so stock components (menus, snackbars) match. */
internal fun SwitchboardColors.toMaterial(dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = teal,
        onPrimary = onTeal,
        primaryContainer = board,
        onPrimaryContainer = ink,
        inversePrimary = if (dark) LightSwitchboard.teal else DarkSwitchboard.teal,
        secondary = soft,
        onSecondary = surface,
        secondaryContainer = board,
        onSecondaryContainer = ink,
        tertiary = lampEdge,
        onTertiary = surface,
        tertiaryContainer = lamp,
        onTertiaryContainer = lampInk,
        background = surface,
        onBackground = ink,
        surface = surface,
        onSurface = ink,
        surfaceVariant = raised,
        onSurfaceVariant = soft,
        surfaceTint = teal,
        inverseSurface = ink,
        inverseOnSurface = surface,
        error = alert,
        onError = surface,
        errorContainer = if (dark) Color(0xFF8C1D18) else Color(0xFFF9DEDC),
        onErrorContainer = if (dark) Color(0xFFF9DEDC) else Color(0xFF410E0B),
        outline = outline,
        outlineVariant = edge,
        scrim = Color.Black,
        surfaceBright = surface,
        surfaceDim = board,
        surfaceContainerLowest = surface,
        surfaceContainerLow = surface,
        surfaceContainer = raised,
        surfaceContainerHigh = board,
        surfaceContainerHighest = edge,
    )
}
