package app.kainos.talk.hub

import app.kainos.talk.core.Source
import app.kainos.talk.sync.FakeSmsStore
import app.kainos.talk.ui.FakeTalkHub
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@OptIn(ExperimentalCoroutinesApi::class)
class SmsAwareRecoveryTest {
    @Test fun failureRecoversAndALaterSubscriberSeesFreshData() = runTest {
        val fake = FakeTalkHub()
        val fail = CompletableDeferred<Unit>()
        var subscriptions = 0
        val old = InboxItem.Chat("sms|rcs", Source.SMS, "Old", false, 1, 0, false, "old", null, false, null, false)
        val fresh = old.copy(title = "Fresh +33612345678", lastText = "fresh")
        fake.threads.value = mapOf("sms|rcs" to ChatThread("sms|rcs", Source.SMS, "RCS", false, false,
            app.kainos.talk.core.Shape.MESSAGING_STYLE, emptyList(),
            ChatCapabilities(false, ReplyFailure.NOTIFICATION_GONE, false), null))
        val base = object : TalkHub by fake {
            override fun inbox(sourceIds: Set<String>?): Flow<Inbox> = flow {
                subscriptions++
                if (subscriptions == 1) {
                    emit(Inbox(listOf(old), emptyMap()))
                    fail.await()
                    throw IOException("temporary provider failure")
                }
                emit(Inbox(listOf(fresh), emptyMap()))
                awaitCancellation()
            }
        }
        val hub = SmsAwareHub(base, FakeSmsStore(canSend = true), backgroundScope)
        val values = mutableListOf<ChatThread?>()
        val job = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            hub.thread("sms|rcs").toList(values)
        }
        runCurrent()
        assertEquals(1, values.size)
        fail.complete(Unit)
        runCurrent()
        assertEquals(1, subscriptions)
        advanceTimeBy(1000)
        runCurrent()
        assertEquals(2, subscriptions)
        assertEquals(2, values.size)
        assertFalse(values.first()!!.capabilities.canReply)
        assertTrue(values.last()!!.capabilities.canReply)
        // This subscriber reads notified.first() and would hang if the sharing job had died.
        assertEquals(ReplyResult.Sent, hub.sendReply("sms|rcs", "reply"))
        job.cancelAndJoin()
        advanceTimeBy(6000)
        runCurrent()
        val later = backgroundScope.async(UnconfinedTestDispatcher(testScheduler)) { hub.thread("sms|rcs").first() }
        runCurrent()
        assertTrue(later.await()!!.capabilities.canReply)
        assertEquals(3, subscriptions)
    }
}
