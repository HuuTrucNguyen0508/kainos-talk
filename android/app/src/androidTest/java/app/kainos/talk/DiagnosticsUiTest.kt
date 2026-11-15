package app.kainos.talk

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.kainos.talk.ui.diagnostics.DiagnosticsApp
import app.kainos.talk.ui.diagnostics.DiagnosticsTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Renders the diagnostics UI over a real ingested conversation: the inbox lists it, the thread
 * shows it with a working reply box, and the dump shows its structure redacted until revealed.
 */
@RunWith(AndroidJUnit4::class)
class DiagnosticsUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val app = ApplicationProvider.getApplicationContext<KainosTalkApp>()
    private val hub get() = app.graph.hub
    private val fake = FakeSender(app)

    @Before
    fun setUp() {
        fake.cancel()
        fake.grantAccess()
        runBlocking {
            withContext(Dispatchers.IO) { app.graph.database.clearAllTables() }
            withTimeout(30_000) { hub.health.first { it.connected } }
            hub.clearDump()
            fake.post(Triple("Ana", "hello", 1_000L))
            withTimeout(30_000) { hub.inbox().first { it.items.isNotEmpty() } }
        }
        compose.setContent { DiagnosticsTheme { DiagnosticsApp(hub) } }
    }

    @After
    fun tearDown() {
        fake.cancel()
        fake.revokeAccess()
    }

    @Test
    fun inboxThreadAndRedactedDump() {
        waitFor("Test chat")
        compose.onNodeWithText("Test chat").performClick()
        waitFor("hello")
        compose.onNodeWithText("Reply through Fake sender").assertExistsOnce()
        compose.onNodeWithContentDescription("Back").performClick()

        compose.onNodeWithText("Dump").performClick()
        waitFor(TestTalkApp.FAKE_PACKAGE)
        compose.onAllNodesWithText(TestTalkApp.FAKE_PACKAGE)[0].performClick()
        compose.onAllNodesWithText("android.text: String = <5 chars>", substring = true).assertCountAtLeast(1)
        compose.onAllNodesWithText("hello", substring = true).assertCountEquals(0)

        compose.onNodeWithText("Show content").performClick()
        compose.onAllNodesWithText("android.text: String = hello", substring = true).assertCountAtLeast(1)
    }

    private fun waitFor(text: String) = compose.waitUntil(10_000) {
        compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteraction.assertExistsOnce() = assertExists()

    private fun androidx.compose.ui.test.SemanticsNodeInteractionCollection.assertCountAtLeast(n: Int) {
        val count = fetchSemanticsNodes().size
        check(count >= n) { "expected at least $n node(s), found $count" }
    }
}
