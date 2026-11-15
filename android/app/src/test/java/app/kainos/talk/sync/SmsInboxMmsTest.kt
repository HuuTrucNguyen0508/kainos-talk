package app.kainos.talk.sync

import android.Manifest
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** SmsInbox reads each received or sent MMS's addresses and parts once, not on every change. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SmsInboxMmsTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Before
    fun setUp() {
        Provider.imageReady = true
        Provider.addressState = "ready"
        Provider.partsUnavailable = false
        Provider.stall = null
        Provider.stalled = CountDownLatch(1)
        Provider.addressQueries.set(0)
        Provider.partQueries.set(0)
        for (authority in listOf("sms", "mms", "mms-sms")) Robolectric.buildContentProvider(Provider::class.java).create(authority)
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).grantPermissions(Manifest.permission.READ_SMS)
    }

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun unchangedMmsAreNotQueriedAgain() = runBlocking {
        val inbox = SmsInbox(ApplicationProvider.getApplicationContext(), scope)
        val queries = mutableListOf<Pair<Int, Int>>()
        val reads = withTimeout(10_000) {
            inbox.conversations
                .onEach {
                    queries += Provider.addressQueries.get() to Provider.partQueries.get()
                    if (queries.size == 1) inbox.refresh()
                }
                .take(2)
                .toList()
        }
        assertEquals("the first read queries all three MMS", 3 to 3, queries[0])
        assertEquals("the second queries only the one still sending", 4 to 4, queries[1])
        assertEquals("the same conversation both times", reads[0], reads[1])
        val texts = reads[1].single().messages.map { it.text to it.status }
        assertEquals(listOf("Photo from the beach" to "incoming", "Thanks!" to "sent", "On my way" to "sending"), texts)
        assertEquals("mms-part:11", reads[1].single().messages.first().image)
    }

    private suspend fun reread(inbox: SmsInbox, change: () -> Unit): List<List<SyncConversation>> =
        withTimeout(10_000) {
            var count = 0
            inbox.conversations.onEach {
                if (++count == 1) { change(); inbox.refresh() }
            }.take(2).toList()
        }

    @Test fun captionThenImageUnderTheSameIdIsReloadedOnMmsChange() = runBlocking {
        Provider.imageReady = false
        val context = ApplicationProvider.getApplicationContext<Application>()
        val inbox = SmsInbox(context, scope)
        val reads = reread(inbox) {
            Provider.imageReady = true
            context.contentResolver.notifyChange(Uri.parse("content://mms/1/part"), null)
            shadowOf(Looper.getMainLooper()).idle()
        }
        assertEquals(null, reads[0].single().messages.first().image)
        assertEquals("mms-part:11", reads[1].single().messages.first().image)
        assertEquals("only id 1 and the pending MMS reload", 5, Provider.partQueries.get())
    }

    @Test fun unknownMmsChangeReloadsAllContents() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val reads = reread(SmsInbox(context, scope)) {
            Provider.imageReady = false
            context.contentResolver.notifyChange(Uri.parse("content://mms/part/11"), null)
            shadowOf(Looper.getMainLooper()).idle()
        }
        assertEquals(null, reads[1].single().messages.first().image)
        assertEquals(6, Provider.partQueries.get())
    }

    @Test fun incompleteOrFailedAddressesAreNotCached() = runBlocking {
        for (state in listOf("empty", "null", "throw")) {
            Provider.addressQueries.set(0)
            Provider.addressState = state
            val reads = reread(SmsInbox(ApplicationProvider.getApplicationContext(), scope)) {
                Provider.addressState = "ready"
            }
            assertEquals(null, reads[0].single().messages.first().sender)
            assertEquals("+33612345678", reads[1].single().messages.first().sender)
            assertEquals(5, Provider.addressQueries.get())
        }
    }

    @Test fun nullPartQueryIsNotCached() = runBlocking {
        Provider.partsUnavailable = true
        val reads = reread(SmsInbox(ApplicationProvider.getApplicationContext(), scope)) {
            Provider.partsUnavailable = false
        }
        assertEquals("", reads[0].single().messages.first().text)
        assertEquals("Photo from the beach", reads[1].single().messages.first().text)
    }

    @Test fun invalidationDoesNotWaitForARunningScanAndTheNextReadSeesIt() = runBlocking {
        Provider.imageReady = false
        val context = ApplicationProvider.getApplicationContext<Application>()
        val release = CountDownLatch(1)
        Provider.stall = release
        val reads = Channel<List<SyncConversation>>(Channel.UNLIMITED)
        SmsInbox(context, scope).conversations.onEach { reads.trySend(it) }.launchIn(scope)
        assertEquals("the scan is mid-provider-query", true, Provider.stalled.await(10, TimeUnit.SECONDS))

        // The main thread (this one) delivers the MMS change while the scan is blocked.
        Provider.imageReady = true
        val started = System.nanoTime()
        context.contentResolver.notifyChange(Uri.parse("content://mms/1/part"), null)
        shadowOf(Looper.getMainLooper()).idle()
        val tookMs = (System.nanoTime() - started) / 1_000_000
        release.countDown()
        assertEquals("invalidating waited for the provider scan: ${tookMs}ms", true, tookMs < 1_000)

        val stale = withTimeout(10_000) { reads.receive() }
        assertEquals("the scan that began before the change", null, stale.single().messages.first().image)
        val fresh = withTimeout(10_000) { reads.receive() }
        assertEquals("the next read reflects the invalidation", "mms-part:11", fresh.single().messages.first().image)
    }

    /** The SMS provider's tables, as much as SmsInbox reads: one thread with three MMS. */
    class Provider : ContentProvider() {
        override fun onCreate() = true

        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
            val path = uri.pathSegments
            if (uri.authority == "mms" && path == listOf("1", "addr")) {
                when (addressState) {
                    "null" -> { addressQueries.incrementAndGet(); return null }
                    "throw" -> { addressQueries.incrementAndGet(); error("address provider unavailable") }
                    "empty" -> { addressQueries.incrementAndGet(); return MatrixCursor(projection!!) }
                }
            }
            if (partsUnavailable && uri.authority == "mms" && path == listOf("part") && selectionArgs?.single() == "1") return null
            val rows: List<Map<String, Any?>> = when {
                uri.authority == "sms" -> emptyList()
                uri.authority == "mms-sms" && path == listOf("canonical-addresses") -> listOf(mapOf("_id" to 1L, "address" to "+33612345678"))
                uri.authority == "mms-sms" && path == listOf("conversations") -> listOf(mapOf("_id" to 5L, "recipient_ids" to "1"))
                uri.authority == "mms" && path.isEmpty() -> MMS.map { (id, box, date) -> mapOf("_id" to id, "thread_id" to 5L, "date" to date, "msg_box" to box, "read" to 1) }
                uri.authority == "mms" && path.getOrNull(1) == "addr" -> {
                    addressQueries.incrementAndGet()
                    listOf(mapOf("address" to "+33612345678", "type" to if (path[0] == "1") 137 else 151))
                }
                uri.authority == "mms" && path == listOf("part") -> {
                    partQueries.incrementAndGet()
                    val part = selectionArgs?.single()
                    val snapshot = if (part == "1") imageReady else true
                    when (part) {
                        "1" -> listOf(mapOf("_id" to 10L, "ct" to "text/plain", "text" to "Photo from the beach"), *if (snapshot) arrayOf(mapOf("_id" to 11L, "ct" to "image/jpeg", "text" to null)) else emptyArray())
                        "2" -> listOf(mapOf("_id" to 20L, "ct" to "text/plain", "text" to "Thanks!"))
                        else -> listOf(mapOf("_id" to 30L, "ct" to "text/plain", "text" to "On my way"))
                    }
                }
                else -> emptyList()
            }
            stall?.takeIf { uri.authority == "mms" && path == listOf("part") && selectionArgs?.single() == "1" }?.let {
                stall = null
                stalled.countDown()
                it.await(10, TimeUnit.SECONDS)
            }
            val columns = projection?.map { it }?.toTypedArray() ?: arrayOf("_id")
            return MatrixCursor(columns).apply { rows.forEach { row -> addRow(columns.map { row[it] }) } }
        }

        override fun getType(uri: Uri): String? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

        companion object {
            @Volatile var imageReady = true
            @Volatile var addressState = "ready"
            @Volatile var partsUnavailable = false
            /** When set, the next query for MMS 1's parts reads its rows, then waits for this latch. */
            @Volatile var stall: CountDownLatch? = null
            @Volatile var stalled = CountDownLatch(1)
            val addressQueries = AtomicInteger()
            val partQueries = AtomicInteger()

            /** (id, box, date in seconds): received, sent, and one still in the outbox. */
            val MMS = listOf(Triple(1L, 1, 100L), Triple(2L, 2, 200L), Triple(3L, 4, 300L))
        }
    }
}
