package app.kainos.talk.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

private val LocalSwitchboardColors = staticCompositionLocalOf { LightSwitchboard }
private val LocalSpacing = staticCompositionLocalOf { Spacing() }
private val LocalSizes = staticCompositionLocalOf { Sizes() }

/**
 * Kainos Talk's theme: the Pocket Switchboard palette in light and dark, Atkinson Hyperlegible,
 * and the mockup's shapes. No dynamic colour: the palette is the product's identity.
 */
@Composable
fun KainosTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) DarkSwitchboard else LightSwitchboard
    CompositionLocalProvider(
        LocalSwitchboardColors provides colors,
        LocalSpacing provides Spacing(),
        LocalSizes provides Sizes(),
    ) {
        MaterialTheme(
            colorScheme = colors.toMaterial(dark),
            typography = SwitchboardTypography,
            shapes = SwitchboardMaterialShapes,
        ) {
            CompositionLocalProvider(LocalTextStyle provides SwitchboardTypography.bodyMedium, content = content)
        }
    }
}

val MaterialTheme.switchboard: SwitchboardColors
    @Composable @ReadOnlyComposable get() = LocalSwitchboardColors.current

val MaterialTheme.spacing: Spacing
    @Composable @ReadOnlyComposable get() = LocalSpacing.current

val MaterialTheme.sizes: Sizes
    @Composable @ReadOnlyComposable get() = LocalSizes.current

val MaterialTheme.switchboardType: SwitchboardTextStyles
    @Composable @ReadOnlyComposable get() = SwitchboardType
