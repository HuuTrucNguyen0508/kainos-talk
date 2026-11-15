package app.kainos.talk.ui.diagnostics

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/**
 * Stock Material 3: the wallpaper colour scheme with the default type and shapes. The product
 * UI brings its own theme; this one deliberately has no identity.
 */
@Composable
fun DiagnosticsTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val dark = isSystemInDarkTheme()
    val scheme = when {
        dark -> runCatching { dynamicDarkColorScheme(context) }.getOrDefault(darkColorScheme())
        else -> runCatching { dynamicLightColorScheme(context) }.getOrDefault(lightColorScheme())
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

/** The only spacing values the diagnostics screens use, on the 4 dp grid. */
object Gap {
    val xs = 4.dp
    val sm = 8.dp
    val md = 16.dp
    val lg = 24.dp
}
