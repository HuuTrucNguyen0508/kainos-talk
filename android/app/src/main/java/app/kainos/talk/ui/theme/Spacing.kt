package app.kainos.talk.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Gaps and padding, on the 4 dp grid (the mockup's odd values are rounded to it). */
@Immutable
data class Spacing(
    val hair: Dp = 2.dp,
    val xs: Dp = 4.dp,
    val md: Dp = 12.dp,
    val lg: Dp = 16.dp,
    val xl: Dp = 20.dp,
    val xxl: Dp = 24.dp,
)

/** Component sizes from the mockup. Touch targets never go below [touch]. */
@Immutable
data class Sizes(
    val touch: Dp = 48.dp,
    val appBar: Dp = 64.dp,
    val iconTiny: Dp = 16.dp,
    val appMark: Dp = 32.dp,
    val lamp: Dp = 22.dp,
    val rowMinHeight: Dp = 72.dp,
    val hairline: Dp = 1.dp,
    val border: Dp = 1.5.dp,
    val bigButton: Dp = 56.dp,
    val factLabel: Dp = 72.dp,
    val stepRail: Dp = 22.dp,
)

