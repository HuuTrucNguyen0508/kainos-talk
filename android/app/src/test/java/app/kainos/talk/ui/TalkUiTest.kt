package app.kainos.talk.ui

import android.content.Intent
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.kainos.talk.sync.PairResult
import app.kainos.talk.sync.SyncStatus
import app.kainos.talk.ui.talk.TalkApp
import app.kainos.talk.ui.theme.KainosTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Drives the app through a fake hub and a fake sync the way a user would, and checks what they were asked. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TalkUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val hub = FakeTalkHub()
    private val sync = FakeSync()

    private fun start() = compose.setContent { KainosTheme { TalkApp(hub, sync) } }

    @Test
    fun withoutNotificationAccessTheSetupStepsShowThenConnectToPc() {
        hub.accessState.value = hub.accessState.value.copy(listenerGranted = false)
        start()
        compose.onNodeWithText("Answer your texts from your computer").assertIsDisplayed()
        compose.onNodeWithText("Open App info").assertExists()
        compose.onNodeWithText("Already allowed? Skip this step").performClick()
        compose.onNodeWithText("Open notification access").assertExists()

        hub.accessState.value = hub.accessState.value.copy(listenerGranted = true)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Connect to studio-desktop").assertIsDisplayed()
    }

    @Test
    fun pairsWithThePickedComputerAndCanForgetIt() {
        start()
        compose.onNodeWithContentDescription("Connect to studio-desktop").performClick()
        compose.onNodeWithContentDescription("Code 4 8 2 1 9 3").assertExists()
        assertEquals(listOf("studio-desktop"), sync.pairedWith)
        compose.onNodeWithText("Codes match").performClick()
        assertEquals(listOf(true), sync.confirmations)
        compose.onNodeWithText("Now press Connect on the computer.").assertExists()
        sync.status.value = SyncStatus.Connected("studio-desktop")
        sync.answer.complete(PairResult.Paired)
        compose.waitForIdle()
        compose.onNodeWithText("Connected. Your texts show on this computer.").assertExists()
        compose.onNodeWithText("Allow file notifications").assertExists()
        compose.onNodeWithText("Forget this computer").performClick()
        assertTrue(sync.forgotten)
        compose.onNodeWithContentDescription("Connect to studio-desktop").assertExists()
    }

    @Test
    fun warnsWhenNotificationsStopArriving() {
        hub.listening.value = false
        start()
        compose.onAllNodesWithText("Kainos Talk stopped receiving notifications").assertCountEquals(0)
        compose.mainClock.advanceTimeBy(5_000)
        compose.onNodeWithText("Kainos Talk stopped receiving notifications").assertExists()
        compose.onNodeWithText("Open notification access").assertExists()
        compose.onAllNodesWithText("Autostart").assertCountEquals(0)
    }

    @Test
    fun onXiaomiTheStoppedWarningOffersAutostart() {
        hub.listening.value = false
        hub.accessState.value = hub.accessState.value.copy(autostartSettings = Intent("autostart"))
        start()
        compose.mainClock.advanceTimeBy(5_000)
        compose.onNodeWithText("Autostart").assertExists()
    }

    @Test
    fun asksToRunInTheBackgroundWithAutostartOnXiaomi() {
        hub.accessState.value = hub.accessState.value.copy(runsInBackground = false, autostartSettings = Intent("autostart"))
        start()
        compose.onNodeWithText("Let Kainos Talk run in the background").assertExists()
        compose.onNodeWithText("Allow").assertExists()
        compose.onNodeWithText("Autostart").assertExists()
        hub.accessState.value = hub.accessState.value.copy(runsInBackground = true)
        compose.waitForIdle()
        compose.onAllNodesWithText("Let Kainos Talk run in the background").assertCountEquals(0)
    }
}
