package app.kainos.talk.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Gaps and padding, on the 4 dp grid (the mockup's odd values are rounded to it). */
@Immutable
data class Spacing(
    val hair: Dp = 2.dp,
    val xs: Dp = 4.dp,
    val sm: Dp = 8.dp,
    val md: Dp = 12.dp,
    val lg: Dp = 16.dp,
    val xl: Dp = 20.dp,
    val xxl: Dp = 24.dp,
    val xxxl: Dp = 32.dp,
    /** Top margin of the empty-inbox notice. */
    val stage: Dp = 72.dp,
)

/** Component sizes from the mockup. Touch targets never go below [touch]. */
@Immutable
data class Sizes(
    val touch: Dp = 48.dp,
    val appBar: Dp = 64.dp,
    /** Space above the tile inside a socket. */
    val socketTop: Dp = 10.dp,
    val icon: Dp = 24.dp,
    val iconSmall: Dp = 18.dp,
    val iconTiny: Dp = 16.dp,
    val appMark: Dp = 32.dp,
    val appMarkLarge: Dp = 56.dp,
    val avatar: Dp = 48.dp,
    val avatarSmall: Dp = 40.dp,
    val jack: Dp = 22.dp,
    val jackMailWidth: Dp = 26.dp,
    val jackInline: Dp = 18.dp,
    val jackMailInlineWidth: Dp = 22.dp,
    /** How far a jack sits outside its avatar's corner. */
    val jackOffset: Dp = 6.dp,
    val jackBorder: Dp = 2.dp,
    val lamp: Dp = 22.dp,
    /** Where a lamp sits over a tile's top-right corner. */
    val lampOverhangX: Dp = 10.dp,
    val lampOverhangY: Dp = 7.dp,
    val tile: Dp = 44.dp,
    val tileGlyph: Dp = 26.dp,
    val socketHeight: Dp = 84.dp,
    val indicatorWidth: Dp = 28.dp,
    val indicatorHeight: Dp = 3.dp,
    val rowMinHeight: Dp = 72.dp,
    /** Where row dividers start: avatar plus gap plus row padding. */
    val rowDividerInset: Dp = 80.dp,
    val hairline: Dp = 1.dp,
    val border: Dp = 1.5.dp,
    val bubbleMaxWidth: Dp = 300.dp,
    val mediaThumb: Dp = 40.dp,
    val originGlyph: Dp = 28.dp,
    val field: Dp = 52.dp,
    val bigButton: Dp = 56.dp,
    val signalWidth: Dp = 180.dp,
    val signalHeight: Dp = 2.dp,
    val signalPulse: Dp = 48.dp,
    val signalPulseStart: Dp = 56.dp,
    val factLabel: Dp = 72.dp,
    val stepRail: Dp = 22.dp,
    val caret: Dp = 2.dp,
)
