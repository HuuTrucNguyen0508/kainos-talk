package app.kainos.talk.ui

import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import app.kainos.talk.sync.SyncStatus
import app.kainos.talk.ui.talk.TalkApp
import app.kainos.talk.ui.theme.KainosTheme
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Every screen, in light and dark, and Connect to PC at 200% font. Record with
 * `./gradlew :app:recordRoborazziDebug`, check with `verifyRoborazziDebug`.
 * The phone is the mockup's: 412 x 915 dp.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ScreenshotTest(private val dark: Boolean, private val fontScale: Float) {
    @get:Rule
    val compose = createComposeRule()

    private val variant = (if (dark) "dark" else "light") + if (fontScale != 1f) "_font${(fontScale * 100).toInt()}" else ""

    private fun shoot(name: String, content: @Composable () -> Unit, act: () -> Unit = {}) {
        compose.setContent {
            KainosTheme(dark = dark) {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale), content = content)
            }
        }
        act()
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("src/test/screenshots/${name}_$variant.png")
    }

    private fun onlyAtNormalScale() = assumeTrue(fontScale == 1f)

    @Test
    fun setup() {
        onlyAtNormalScale()
        val hub = FakeTalkHub().apply { accessState.value = accessState.value.copy(listenerGranted = false) }
        shoot("setup", { TalkApp(hub, FakeSync()) })
    }

    @Test
    fun connectPc() {
        shoot("connect_pc", { TalkApp(FakeTalkHub(), FakeSync()) })
    }

    @Test
    fun connectPcCode() {
        onlyAtNormalScale()
        shoot("connect_pc_code", { TalkApp(FakeTalkHub(), FakeSync()) }) {
            compose.onNodeWithContentDescription("Connect to studio-desktop").performClick()
        }
    }

    @Test
    fun connectPcPaired() {
        onlyAtNormalScale()
        shoot("connect_pc_paired", { TalkApp(FakeTalkHub(), FakeSync(SyncStatus.Connected("studio-desktop"))) })
    }

    @Test
    fun connectPcAsksToRunInTheBackground() {
        onlyAtNormalScale()
        val hub = FakeTalkHub().apply { accessState.value = accessState.value.copy(runsInBackground = false, autostartSettings = Intent("autostart")) }
        shoot("connect_pc_background", { TalkApp(hub, FakeSync(SyncStatus.Connected("studio-desktop"))) })
    }

    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0} font={1}")
        fun variants() = listOf(
            arrayOf<Any>(false, 1f),
            arrayOf<Any>(true, 1f),
            arrayOf<Any>(false, 2f),
            arrayOf<Any>(true, 2f),
        )
    }
}
