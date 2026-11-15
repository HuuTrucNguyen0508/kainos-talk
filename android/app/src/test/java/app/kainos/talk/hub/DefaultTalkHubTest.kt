package app.kainos.talk.hub

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.core.*
import app.kainos.talk.core.adapters.defaultWatchedApps
import app.kainos.talk.listener.*
import app.kainos.talk.store.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import android.graphics.Bitmap
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DefaultTalkHubTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val db = Room.inMemoryDatabaseBuilder(context, TalkDatabase::class.java).allowMainThreadQueries().build()
    private val store = MessageStore(db)
    private val live = LiveNotifications()
    private val images = NotificationImages(context)
    private val hub = DefaultTalkHub(context, WatchedApps(defaultWatchedApps()), db.dao(), store, live,
        NotificationDumpLog(), ConnectionTracker(), Dispatchers.IO, images)
    private val message = ParsedMessage("Alice", "alice", "photo", 1000, false)
    private fun update(key: String) = ChatUpdate(key, Source.WHATSAPP, key, false, listOf(message), null, null, Shape.MESSAGING_STYLE)
    private fun entry(id: String) = LiveEntry(TargetKind.CHAT, LiveNotification(id, "com.whatsapp", null, emptyList(), emptyList()))

    @After fun close() { db.close(); File(context.filesDir, "media").deleteRecursively() }

    @Test fun latePictureSaveReEmitsTheThread() = runBlocking {
        val key = "whatsapp|late-picture"
        store.applyChat(update(key))
        val events = Channel<ChatThread?>(Channel.UNLIMITED)
        val job = launch { hub.thread(key).collect { events.send(it) } }
        try {
            assertNull(withTimeout(5000) { events.receive() }!!.messages.single().imageId)
            val image = File(context.cacheDir, "late-picture.png")
            image.outputStream().use { Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 90, it) }
            val dedup = messageDedupKey(key, message)
            images.save(dedup, image.toURI().toString())
            assertEquals("notif:$dedup", withTimeout(5000) { events.receive() }!!.messages.single().imageId)
        } finally { job.cancelAndJoin() }
    }

    @Test fun anotherChatsLiveHandleDoesNotReEmitButAReplacementHandleDoes() = runBlocking {
        val key = "whatsapp|B"
        store.applyChat(update(key))
        live.put(key, entry("B"))
        val events = Channel<ChatThread?>(Channel.UNLIMITED)
        val job = launch { hub.thread(key).collect { events.send(it) } }
        try {
            withTimeout(5000) { events.receive() }
            live.put("whatsapp|A", entry("A"))
            assertNull(withTimeoutOrNull(300) { events.receive() })
            live.put(key, entry("B-new-intent"))
            assertNotNull(withTimeout(5000) { events.receive() })
        } finally { job.cancelAndJoin() }
    }
    @Test fun anotherMailsLiveHandleDoesNotReEmitButAReplacementHandleDoes() = runBlocking {
        val key = "mail-B"
        store.applyMail(MailUpdate(key, Source.PROTON_MAIL, "account", "label", "Alice", false,
            "subject", 1000, emptyList(), Shape.EXPECTED))
        live.put(key, entry("B").copy(kind = TargetKind.MAIL))
        val events = Channel<MailItem?>(Channel.UNLIMITED)
        val job = launch { hub.mailItem(key).collect { events.send(it) } }
        try {
            withTimeout(5000) { events.receive() }
            live.put("mail-A", entry("A").copy(kind = TargetKind.MAIL))
            assertNull(withTimeoutOrNull(300) { events.receive() })
            live.put(key, entry("B-new-intent").copy(kind = TargetKind.MAIL))
            assertNotNull(withTimeout(5000) { events.receive() })
        } finally { job.cancelAndJoin() }
    }

}
