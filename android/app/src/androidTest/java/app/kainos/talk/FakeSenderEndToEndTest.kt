package app.kainos.talk

import android.service.notification.NotificationListenerService
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.ReplyFailure
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.store.MessageStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The hub, end to end, against a fake chat app (the test APK, in its own process):
 * a posted MessagingStyle conversation is ingested, a repeated snapshot is de-duplicated, a
 * reply goes out through the notification's RemoteInput and comes back as the app's echo, and
 * a reply after the notification is cancelled fails with NOTIFICATION_GONE.
 */
@RunWith(AndroidJUnit4::class)
class FakeSenderEndToEndTest {
    private val app = ApplicationProvider.getApplicationContext<KainosTalkApp>()
    private val hub get() = app.graph.hub
    private val fake = FakeSender(app)

    @Before
    fun setUp() {
        fake.cancel()
        fake.grantAccess()
        runBlocking {
            withContext(Dispatchers.IO) { app.graph.database.clearAllTables() }
            withTimeout(TIMEOUT_MS) { hub.health.first { it.connected } }
        }
    }

    @After
    fun tearDown() {
        fake.cancel()
        fake.revokeAccess()
    }

    @Test
    fun ingestsDeduplicatesRepliesAndReportsAGoneNotification(): Unit = runBlocking {
        val hello = Triple("Ana", "hello", 1_000L)
        val second = Triple("Ana", "second", 2_000L)

        fake.post(hello)
        val key = withTimeout(TIMEOUT_MS) {
            hub.inbox(setOf(TestTalkApp.FAKE_SOURCE.id)).first { it.items.isNotEmpty() }.items.single().key
        }
        val chat = hub.inbox().first().items.single { it.key == key } as InboxItem.Chat
        assertEquals("Test chat", chat.title)
        assertEquals(1, chat.unreadCount)

        // The app re-posts the whole unread snapshot, twice; only "second" is new.
        fake.post(hello, second)
        awaitThread(key) { it.messages.size == 2 }
        fake.post(hello, second)

        assertEquals(ReplyResult.Sent, hub.sendReply(key, "pong"))
        val confirmed = awaitThread(key) { t -> t.messages.any { it.text == "pong" && it.status == MessageStatus.CONFIRMED } }
        assertEquals(listOf("hello", "second", "pong"), confirmed.messages.map { it.text })
        assertEquals(listOf(false, false, true), confirmed.messages.map { it.outgoing })
        assertEquals(listOf("Ana", "Ana", null), confirmed.messages.map { it.senderName })
        assertEquals(2, (hub.inbox().first().items.single { it.key == key } as InboxItem.Chat).unreadCount)

        fake.cancel()
        val gone = awaitThread(key) { it.capabilities.replyBlocked == ReplyFailure.NOTIFICATION_GONE }
        assertEquals(NotificationListenerService.REASON_APP_CANCEL, awaitThread(key) { it.notificationRemovedReason != null }.notificationRemovedReason)
        assertEquals(false, gone.capabilities.canReply)

        assertEquals(ReplyResult.Failed(ReplyFailure.NOTIFICATION_GONE), hub.sendReply(key, "late"))
        val after = awaitThread(key) { t -> t.messages.any { it.text == "late" && it.status == MessageStatus.FAILED } }
        assertEquals(listOf("hello", "second", "pong", "late"), after.messages.map { it.text })
    }

    private suspend fun awaitThread(key: String, condition: (ChatThread) -> Boolean): ChatThread =
        withTimeout(TIMEOUT_MS) { hub.thread(key).filterNotNull().first(condition) }

    private companion object {
        const val TIMEOUT_MS = 30_000L
    }
}
