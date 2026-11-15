package app.kainos.talk.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.Density
import app.kainos.talk.hub.ReplyFailure
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.sync.SyncStatus
import app.kainos.talk.ui.talk.ConnectPcScreen
import app.kainos.talk.ui.talk.LocalTalkClock
import app.kainos.talk.ui.talk.MailScreen
import app.kainos.talk.ui.talk.TalkApp
import app.kainos.talk.ui.talk.ThreadScreen
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
 * Every product screen with the mockup's data, in light and dark, and the inbox and thread at
 * 200% font. Record with `./gradlew :app:recordRoborazziDebug`, check with `verifyRoborazziDebug`.
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
                CompositionLocalProvider(
                    LocalDensity provides Density(density.density, fontScale),
                    LocalTalkClock provides MockupData.clock,
                    content = content,
                )
            }
        }
        act()
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("src/test/screenshots/${name}_$variant.png")
    }

    private fun onlyAtNormalScale() = assumeTrue(fontScale == 1f)

    @Test
    fun inbox() {
        val hub = MockupData.hub()
        shoot("inbox", { TalkApp(hub, MockupData.clock) })
    }

    @Test
    fun inboxFilteredToDiscord() {
        onlyAtNormalScale()
        val hub = MockupData.hub()
        shoot("inbox_discord", { TalkApp(hub, MockupData.clock) }) {
            compose.onNode(isSocket("Discord")).performClick()
        }
    }

    @Test
    fun thread() {
        val hub = MockupData.hub().apply { nextReply = ReplyResult.Failed(ReplyFailure.NOTIFICATION_GONE) }
        shoot("thread", { ThreadScreen(hub, MockupData.ALLOTMENT, onBack = {}) }) {
            val field = compose.onNodeWithContentDescription("Reply through WhatsApp")
            field.performTextInput("I have the key, I'll bring it")
            compose.onNodeWithContentDescription("Send through WhatsApp").performClick()
            compose.waitForIdle()
            field.performTextInput("Bringing the seed trays too")
        }
    }

    @Test
    fun threadWithoutReply() {
        val hub = MockupData.hub()
        shoot("thread_discord", { ThreadScreen(hub, MockupData.PAVLO, onBack = {}) })
    }

    @Test
    fun mail() {
        onlyAtNormalScale()
        val hub = MockupData.hub()
        shoot("mail", { MailScreen(hub, MockupData.HALDEN, onBack = {}) })
    }

    @Test
    fun mailSenderHidden() {
        onlyAtNormalScale()
        val hub = MockupData.hub().apply { mails.value = mails.value + (MockupData.HIDDEN to MockupData.hidden) }
        shoot("mail_hidden", { MailScreen(hub, MockupData.HIDDEN, onBack = {}) })
    }

    @Test
    fun setup() {
        onlyAtNormalScale()
        val hub = MockupData.hub().apply { accessState.value = accessState.value.copy(listenerGranted = false) }
        shoot("setup", { TalkApp(hub, MockupData.clock) })
    }

    @Test
    fun emptyInbox() {
        onlyAtNormalScale()
        val hub = FakeTalkHub(now = { MockupData.NOW })
        shoot("empty", { TalkApp(hub, MockupData.clock) })
    }

    @Test
    fun inboxRunInBackground() {
        onlyAtNormalScale()
        val hub = MockupData.hub().apply { accessState.value = accessState.value.copy(runsInBackground = false, autostartSettings = android.content.Intent("autostart")) }
        shoot("inbox_background", { TalkApp(hub, MockupData.clock) })
    }

    @Test
    fun connectPc() {
        shoot("connect_pc", { ConnectPcScreen(FakeSync(), onBack = {}) })
    }

    @Test
    fun connectPcCode() {
        onlyAtNormalScale()
        shoot("connect_pc_code", { ConnectPcScreen(FakeSync(), onBack = {}) }) {
            compose.onNodeWithContentDescription("Connect to theaden-desktop").performClick()
        }
    }

    @Test
    fun connectPcPaired() {
        onlyAtNormalScale()
        shoot("connect_pc_paired", { ConnectPcScreen(FakeSync(SyncStatus.Connected("theaden-desktop")), onBack = {}) })
    }

    companion object {
        fun isSocket(label: String) = hasContentDescription(label, substring = true) and
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)

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
