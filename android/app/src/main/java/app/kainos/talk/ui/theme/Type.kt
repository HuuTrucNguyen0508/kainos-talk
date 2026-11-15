package app.kainos.talk.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.kainos.talk.R

/** Atkinson Hyperlegible (Braille Institute, SIL OFL 1.1) is the only typeface. Licence: assets/licenses. */
val Atkinson = FontFamily(
    Font(R.font.atkinson_hyperlegible_regular, FontWeight.Normal),
    Font(R.font.atkinson_hyperlegible_bold, FontWeight.Bold),
)

private fun style(size: Int, line: Int, weight: FontWeight = FontWeight.Normal, tracking: Double = 0.0) = TextStyle(
    fontFamily = Atkinson,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
    letterSpacing = tracking.em,
)

/**
 * The mockup's type scale mapped onto Material roles. Every size the mockup uses has one role;
 * the switchboard-only styles (bubble text, jack letters, lamp counts) live in [SwitchboardType].
 */
val SwitchboardTypography = Typography(
    // First-run heading (30/36 in the mockup).
    displaySmall = style(30, 36, FontWeight.Bold, -0.012),
    // Mail subject.
    headlineMedium = style(28, 34, FontWeight.Bold, -0.01),
    // Screen titles: "Inbox", "Listening for new messages".
    headlineSmall = style(22, 28, FontWeight.Bold, -0.005),
    // Thread title, first-run section heading.
    titleLarge = style(18, 24, FontWeight.Bold),
    // Row names, sender in the mail view, step titles.
    titleMedium = style(16, 22, FontWeight.Bold),
    // Origin card heading.
    titleSmall = style(15, 21, FontWeight.Bold),
    // Lede and the reply field.
    bodyLarge = style(16, 24),
    // Facts, empty-state copy.
    bodyMedium = style(15, 22),
    // Previews, hints, step descriptions.
    bodySmall = style(14, 20),
    // Text buttons.
    labelLarge = style(14, 20, FontWeight.Bold),
    // Thread subtitle, failure notes, mail time.
    labelMedium = style(13, 18),
    // Times, socket names, day separators.
    labelSmall = style(12, 16),
)

@Immutable
data class SwitchboardTextStyles(
    val bubble: TextStyle,
    val rowName: TextStyle,
    val sender: TextStyle,
    val bigButton: TextStyle,
    val tileLetter: TextStyle,
    val avatar: TextStyle,
    val avatarSmall: TextStyle,
    val jack: TextStyle,
    val lamp: TextStyle,
)

val SwitchboardType = SwitchboardTextStyles(
    bubble = style(15, 21),
    rowName = style(16, 24),
    sender = style(13, 18, FontWeight.Bold),
    bigButton = style(16, 22, FontWeight.Bold),
    tileLetter = style(19, 22, FontWeight.Bold),
    avatar = style(16, 20, FontWeight.Bold),
    avatarSmall = style(14, 18, FontWeight.Bold),
    jack = style(11, 14, FontWeight.Bold),
    lamp = style(12, 16, FontWeight.Bold),
)
