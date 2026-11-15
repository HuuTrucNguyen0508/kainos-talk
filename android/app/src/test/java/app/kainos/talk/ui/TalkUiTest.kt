package app.kainos.talk.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import app.kainos.talk.core.MailAction
import app.kainos.talk.hub.ReplyFailure
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.ui.ScreenshotTest.Companion.isSocket
import org.junit.Assert.assertTrue
import app.kainos.talk.sync.PairResult
import app.kainos.talk.sync.SyncStatus
import app.kainos.talk.ui.talk.TalkApp
import app.kainos.talk.ui.theme.KainosTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Drives the product UI through a fake hub the way a user would, and checks what the hub was asked. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TalkUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val hub = MockupData.hub()

    private fun start() = compose.setContent { KainosTheme { TalkApp(hub, MockupData.clock) } }

    private fun row(title: String) = compose.onNode(hasContentDescription("$title,", substring = true) and hasClick())

    private fun hasClick() = SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsActions.OnClick)

    @Test
    fun warnsWhenNotificationsStopArriving() {
        hub.healthState.value = hub.healthState.value.copy(connected = false)
        start()
        compose.onAllNodesWithText("Kainos Talk stopped receiving notifications").assertCountEquals(0)
        compose.mainClock.advanceTimeBy(5_000)
        compose.onNodeWithText("Kainos Talk stopped receiving notifications").assertExists()
        compose.onNodeWithText("Open notification access").assertExists()
        compose.onAllNodesWithText("Autostart").assertCountEquals(0)
    }

    @Test
    fun onXiaomiTheStoppedWarningOffersAutostart() {
        hub.healthState.value = hub.healthState.value.copy(connected = false)
        hub.accessState.value = hub.accessState.value.copy(autostartSettings = android.content.Intent("autostart"))
        start()
        compose.mainClock.advanceTimeBy(5_000)
        compose.onNodeWithText("Autostart").assertExists()
    }

    @Test
    fun asksToRunInTheBackgroundWithAutostartOnXiaomi() {
        hub.accessState.value = hub.accessState.value.copy(runsInBackground = false, autostartSettings = android.content.Intent("autostart"))
        start()
        compose.onNodeWithText("Let Kainos Talk run in the background").assertExists()
        compose.onNodeWithText("Allow").assertExists()
        compose.onNodeWithText("Autostart").assertExists()
        hub.accessState.value = hub.accessState.value.copy(runsInBackground = true)
        compose.waitForIdle()
        compose.onAllNodesWithText("Let Kainos Talk run in the background").assertCountEquals(0)
    }

    @Test
    fun connectToPcPairsWithThePickedComputerAndCanForgetIt() {
        val sync = FakeSync()
        compose.setContent { KainosTheme { TalkApp(hub, MockupData.clock, sync = sync) } }
        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Connect to PC").performClick()
        compose.onNodeWithContentDescription("Connect to theaden-desktop").performClick()
        compose.onNodeWithContentDescription("Code 4 8 2 1 9 3").assertExists()
        assertEquals(listOf("theaden-desktop"), sync.pairedWith)
        compose.onNodeWithText("Codes match").performClick()
        assertEquals(listOf(true), sync.confirmations)
        compose.onNodeWithText("Now press Connect on the computer.").assertExists()
        sync.status.value = SyncStatus.Connected("theaden-desktop")
        sync.answer.complete(PairResult.Paired)
        compose.waitForIdle()
        compose.onNodeWithText("Connected. Your inbox shows on this computer.").assertExists()
        compose.onNodeWithText("Forget this computer").performClick()
        assertTrue(sync.forgotten)
        compose.onNodeWithContentDescription("Connect to theaden-desktop").assertExists()
    }

    @Test
    fun socketsFilterTheInboxByLine() {
        start()
        row("Allotment crew").assertIsDisplayed()
        compose.onNode(isSocket("All lines")).assertIsSelected()

        compose.onNode(isSocket("Discord")).performClick()
        compose.onNode(isSocket("Discord")).assertIsSelected()
        row("pavlo.k").assertIsDisplayed()
        row("Low Tide Radio #gig-chat").assertExists()
        compose.onAllNodesWithContentDescription("Allotment crew,", substring = true).assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Halden Housing Co-op,", substring = true).assertCountEquals(0)

        compose.onNode(isSocket("Messenger")).performClick()
        row("Mira Okafor").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("pavlo.k,", substring = true).assertCountEquals(0)

        compose.onNode(isSocket("SMS")).performClick()
        row("Garage Delaunay").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Mira Okafor,", substring = true).assertCountEquals(0)

        compose.onNode(isSocket("Mail")).performClick()
        row("Halden Housing Co-op").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("pavlo.k,", substring = true).assertCountEquals(0)

        compose.onNode(isSocket("All lines")).performClick()
        row("Allotment crew").assertIsDisplayed()
    }

    @Test
    fun socketsAndRowsTellTalkBackTheSourceAndUnreadCount() {
        start()
        compose.onNodeWithContentDescription("All lines, 8 unread").assertExists()
        compose.onNodeWithContentDescription("Messenger, 1 unread").assertExists()
        compose.onNodeWithContentDescription("WhatsApp, 4 unread").assertExists()
        // The muted server's 12 do not count towards Discord's lamp.
        compose.onNodeWithContentDescription("Discord, 2 unread").assertExists()
        compose.onNodeWithContentDescription("Mail, 1 unread").assertExists()
        row("Allotment crew").assert(hasContentDescription("Allotment crew, WhatsApp group, 3 unread", substring = true))
        row("Tidewater Makers #print-queue").assert(hasContentDescription("Discord group, muted, 12 unread", substring = true))
        row("Halden Housing Co-op").assert(hasContentDescription("Halden Housing Co-op, Proton Mail, unread", substring = true))
    }

    @Test
    fun openingAChatShowsItsThreadAndMarksItReadInTheHubOnly() {
        start()
        row("Allotment crew").performClick()
        compose.onNodeWithText("Earlier messages are in WhatsApp").assertIsDisplayed()
        compose.onNodeWithContentDescription("Mirela Antić, Frost took the last", substring = true).assertExists()
        compose.onNodeWithContentDescription("Photo", substring = true).assert(hasContentDescription("View it in WhatsApp", substring = true))
        compose.waitForIdle()
        assertEquals(listOf(MockupData.ALLOTMENT), hub.readKeys.distinct())

        compose.onNodeWithContentDescription("Back").performClick()
        row("Allotment crew").assertIsDisplayed()
    }

    @Test
    fun aReplyGoesThroughTheHubAndShowsAsSent() {
        start()
        row("Allotment crew").performClick()
        compose.onNodeWithContentDescription("Send through WhatsApp").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Reply through WhatsApp").performTextInput("Bringing the seed trays too")
        compose.onNodeWithContentDescription("Send through WhatsApp").performClick()
        compose.waitForIdle()

        assertEquals(listOf(MockupData.ALLOTMENT to "Bringing the seed trays too"), hub.sentReplies)
        compose.onNodeWithContentDescription("You, Bringing the seed trays too, 08:12, Sent").assertExists()
        compose.onAllNodesWithText("Not sent", substring = true).assertCountEquals(0)
    }

    @Test
    fun aFailedReplySaysWhyAndOffersTheApp() {
        hub.nextReply = ReplyResult.Failed(ReplyFailure.NOTIFICATION_GONE)
        start()
        row("Allotment crew").performClick()
        compose.onNodeWithContentDescription("Reply through WhatsApp").performTextInput("I have the key, I'll bring it")
        compose.onNodeWithContentDescription("Send through WhatsApp").performClick()
        compose.waitForIdle()

        compose.onNodeWithContentDescription("You, I have the key, I'll bring it, 08:12, Not sent").assertExists()
        compose.onNodeWithText("Not sent. WhatsApp's notification was cleared before this reply could go through it.").assertIsDisplayed()
        // The origin card and the failure both lead to WhatsApp; the failure's link is the newest one.
        val links = compose.onAllNodesWithText("Open in WhatsApp")
        links.assertCountEquals(2)
        links[1].performClick()
        assertEquals(listOf(MockupData.ALLOTMENT), hub.opened)
    }

    @Test
    fun aChatWithoutAReplyActionOffersTheAppInstead() {
        start()
        row("pavlo.k").performClick()
        compose.onNodeWithText("Discord didn't put a reply button on this notification.").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Reply through Discord").assertCountEquals(0)
        // The origin card's link and the board's button.
        compose.onAllNodes(hasText("Open in Discord") and hasClick()).assertCountEquals(2)
        compose.onAllNodesWithText("Open in Discord")[1].performClick()
        assertEquals(listOf(MockupData.PAVLO), hub.opened)
    }

    @Test
    fun mailShowsNoBodyAndFiresProtonsActions() {
        start()
        row("Halden Housing Co-op").performClick()
        compose.onNodeWithText("Minutes from Tuesday's meeting").assertIsDisplayed()
        compose.onNodeWithText("Proton Mail's notification carries only the sender and subject. The mail itself is in Proton Mail.")
            .assertIsDisplayed()
        compose.waitForIdle()
        assertEquals(true, hub.mails.value.getValue(MockupData.HALDEN).read)

        compose.onNodeWithText("Archive").performClick()
        compose.waitForIdle()
        assertEquals(listOf(MockupData.HALDEN to MailAction.ARCHIVE), hub.requestedMailActions)
        compose.onAllNodesWithText("Archive requested. Proton Mail doesn't confirm it.").fetchSemanticsNodes().let {
            check(it.isNotEmpty()) { "the requested state is not shown" }
        }
        // Proton removed its notification with the action, so the buttons are gone.
        compose.onAllNodesWithText("Trash").assertCountEquals(0)
        compose.onNodeWithText("Open in Proton Mail").performClick()
        assertEquals(listOf(MockupData.HALDEN), hub.opened)
    }

    @Test
    fun mailWithAHiddenSenderPointsToProtonsSetting() {
        hub.mails.value = hub.mails.value + (MockupData.HIDDEN to MockupData.hidden)
        start()
        row("Sender hidden").performClick()
        compose.onNodeWithText("Proton Mail hid the sender").assertIsDisplayed()
        compose.onNodeWithText("Extended notifications", substring = true).assertIsDisplayed()
        compose.onAllNodesWithText("Archive").assertCountEquals(0)
    }

    @Test
    fun withoutNotificationAccessTheSetupStepsShow() {
        hub.accessState.value = hub.accessState.value.copy(listenerGranted = false)
        start()
        compose.onNodeWithText("One inbox, made from your notifications").assertIsDisplayed()
        compose.onNodeWithText("Open App info").assertExists()
        compose.onNodeWithText("Already allowed? Skip this step").performClick()
        compose.onNodeWithText("Open notification access").assertExists()

        hub.accessState.value = hub.accessState.value.copy(listenerGranted = true)
        compose.waitForIdle()
        row("Allotment crew").assertIsDisplayed()
    }

    @Test
    fun anEmptyInboxIsListeningAndDiagnosticsStayReachable() {
        hub.chats.value = emptyList()
        hub.mails.value = emptyMap()
        hub.installed = { it != "protonmail" }
        start()
        compose.onNodeWithText("Listening for new messages").assertIsDisplayed()
        compose.onNodeWithContentDescription("WhatsApp: Listening").assertExists()
        compose.onNodeWithContentDescription("Proton Mail: Not installed").assertExists()

        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Diagnostics").performClick()
        compose.onNodeWithText("Dump").assertIsDisplayed()
    }

    @Test
    fun mutingAConversationFromTheThread() {
        start()
        row("Allotment crew").performClick()
        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Mute in Kainos Talk").performClick()
        compose.onNodeWithText("WhatsApp group, muted").assertIsDisplayed()
    }

    @Test
    fun searchFindsByMessageText() {
        start()
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNode(hasContentDescription("Search chats and mail") and SemanticsMatcher.keyIsDefined(SemanticsProperties.EditableText))
            .performTextInput("nozzle")
        row("Tidewater Makers #print-queue").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Allotment crew,", substring = true).assertCountEquals(0)
    }
}
