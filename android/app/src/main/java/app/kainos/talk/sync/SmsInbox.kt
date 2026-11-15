package app.kainos.talk.sync

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.provider.Telephony
import android.telephony.SmsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.shareIn

/**
 * The phone's SMS inbox, read through Android's SMS provider: the history the notifications
 * never had, and sending without a notification. Needs READ_SMS (history), SEND_SMS (replies
 * and new texts) and, for names instead of numbers, READ_CONTACTS. Kainos Talk is not the
 * default SMS app, so it cannot change the provider: what the PC marks read is remembered here.
 * MMS and RCS are not in the SMS table; RCS chats still come from notifications.
 */
/** The SMS inbox as the hub and sync see it; [SmsInbox] on the phone, a fake in tests. */
interface SmsStore {
    /** The newest conversations, re-read whenever the inbox changes. Empty without access. */
    val conversations: Flow<List<SyncConversation>>

    /** The one number a conversation goes to, if it has exactly one. */
    fun addressOf(key: String): String?

    /** Sends a text; the error, or null once it is handed to Android. */
    fun send(to: String, text: String): String?

    /** Whether texts can be sent from Kainos Talk (SEND_SMS granted). */
    fun canSend(): Boolean

    /** A picture from a message, as a small JPEG, or null. */
    fun image(id: String): ByteArray?

    /** The user read this conversation in Kainos Talk (here or on the PC). */
    fun markRead(key: String)

    /** Reads the inbox again: after access was granted, or something was marked read. */
    fun refresh()
}

@OptIn(FlowPreview::class)
class SmsInbox(private val context: Context, scope: CoroutineScope) : SmsStore {
    private val refreshes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    override fun refresh() {
        refreshes.tryEmit(Unit)
    }

    /**
     * Shared, so the inbox, every open thread and the PC sync read the provider once per change.
     * One text fires several changes (it arrives, then the SMS app marks it seen and read): one read.
     */
    override val conversations: Flow<List<SyncConversation>> =
        merge(runCatching { changes() }.getOrDefault(flowOf(Unit)).catch { emit(Unit) }, refreshes)
            .debounce(CHANGE_QUIET_MS)
            .conflate()
            .map { runCatching { conversations() }.getOrDefault(emptyList()) }
            .flowOn(Dispatchers.IO)
            .shareIn(scope, SharingStarted.WhileSubscribed(5_000), replay = 1)

    private val prefs = context.getSharedPreferences("sms-read-on-pc", Context.MODE_PRIVATE)
    private val names = HashMap<String, String>()

    /**
     * Addresses and parts survive SMS-only changes. MMS notifications invalidate these entries.
     * The lock is held only to swap the map and bump the generation, never across provider IO: the
     * observer runs on the main thread. A read that began before an invalidation does not publish.
     */
    private val mmsLock = Any()
    private var mmsContents: Map<Pair<Long, Int>, MmsContent> = emptyMap()
    private var mmsGeneration = 0L

    fun canRead(): Boolean = granted(Manifest.permission.READ_SMS)

    override fun canSend(): Boolean = granted(Manifest.permission.SEND_SMS)

    private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Fires whenever the SMS provider changes: a text arrives, is sent, or is read on the phone. */
    private fun changes(): Flow<Unit> = callbackFlow {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                trySend(Unit)
            }
        }
        context.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, observer)
        val mmsObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) = onChange(selfChange, null)
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                invalidateMms(uri)
                trySend(Unit)
            }
        }
        runCatching { context.contentResolver.registerContentObserver(Telephony.Mms.CONTENT_URI, true, mmsObserver) }
        invalidateMms(null) // Changes while no one was subscribed were not observed.
        trySend(Unit)
        awaitClose {
            context.contentResolver.unregisterContentObserver(observer)
            context.contentResolver.unregisterContentObserver(mmsObserver)
        }
    }

    private fun invalidateMms(uri: Uri?) {
        val id = uri?.takeIf { it.authority == "mms" }?.pathSegments?.firstOrNull()?.toLongOrNull()
        synchronized(mmsLock) {
            mmsGeneration++
            mmsContents = if (id == null) emptyMap() else mmsContents.filterKeys { it.first != id }
        }
    }

    /** The newest conversations, SMS and MMS together, each with its newest messages, oldest first. */
    private fun conversations(): List<SyncConversation> {
        if (!canRead()) return emptyList()
        val rows = smsRows() + mmsRows()
        val recipients = threadRecipients()
        val canSend = canSend()
        return rows.groupBy { it.thread }
            .values
            .map { messages -> messages.sortedByDescending { it.date } }
            .sortedByDescending { it.first().date }
            .take(SyncProtocol.MAX_CONVERSATIONS)
            .map { newestFirst0 ->
                val newestFirst = newestFirst0.take(SyncProtocol.MAX_MESSAGES)
                val thread = newestFirst.first().thread
                // Android's own list of who is in the thread; message addresses only as a fallback,
                // since an incoming MMS also lists this phone's own number.
                val people = recipients[thread]?.takeIf { it.isNotEmpty() }
                    ?: newestFirst.flatMap { it.participants }.filter { it.isNotBlank() }.distinctBy { PhoneNumbers.key(it) ?: it }
                val title = people.joinToString(", ") { nameFor(it) }.ifBlank { "Unknown sender" }
                val readUpTo = prefs.getLong(thread.toString(), 0L)
                SyncConversation(
                    key = keyFor(thread),
                    title = title,
                    isGroup = people.size > 1,
                    unread = newestFirst.count { it.incoming && !it.read && it.date > readUpTo },
                    lastActivityMs = newestFirst.first().date,
                    // Group MMS replies would need MMS sending; Kainos Talk sends SMS only.
                    canReply = canSend && people.size == 1,
                    numbers = people,
                    messages = newestFirst.reversed().map { row ->
                        SyncMessage(
                            id = row.id,
                            sender = if (row.incoming) row.from?.let(::nameFor) else null,
                            text = row.body,
                            timeMs = row.date,
                            outgoing = !row.incoming,
                            status = row.status,
                            media = if (row.image != null) "image" else null,
                            image = row.image,
                        )
                    },
                )
            }
    }

    private fun smsRows(): List<Row> {
        val rows = mutableListOf<Row>()
        context.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf(Telephony.Sms._ID, Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ),
            null,
            null,
            "${Telephony.Sms.DATE} DESC LIMIT $MAX_ROWS",
        )?.use { c ->
            while (c.moveToNext()) {
                val address = c.getString(2).orEmpty()
                val type = c.getInt(5)
                val incoming = type == Telephony.Sms.MESSAGE_TYPE_INBOX
                rows += Row("sms:${c.getLong(0)}", c.getLong(1), listOf(address), if (incoming) address else null, c.getString(3).orEmpty(), c.getLong(4), incoming, statusOf(type), c.getInt(6) == 1, null)
            }
        }
        return rows
    }

    /** Picture messages and group texts. Dates are in seconds; text and pictures are parts. */
    private fun mmsRows(): List<Row> {
        val rows = mutableListOf<Row>()
        val known: Map<Pair<Long, Int>, MmsContent>
        val generation: Long
        synchronized(mmsLock) {
            known = mmsContents
            generation = mmsGeneration
        }
        val kept = HashMap<Pair<Long, Int>, MmsContent>()
        runCatching {
            context.contentResolver.query(
                Telephony.Mms.CONTENT_URI,
                arrayOf(Telephony.Mms._ID, Telephony.Mms.THREAD_ID, Telephony.Mms.DATE, Telephony.Mms.MESSAGE_BOX, Telephony.Mms.READ),
                null,
                null,
                "${Telephony.Mms.DATE} DESC LIMIT $MAX_MMS",
            )?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val box = c.getInt(3)
                    val incoming = box == Telephony.Mms.MESSAGE_BOX_INBOX
                    val cached = known[id to box]
                    val addresses = cached?.addresses ?: runCatching { mmsAddresses(id) }.getOrNull()
                    val parts = cached?.parts ?: runCatching { mmsParts(id) }.getOrNull()
                    val content = MmsContent(addresses ?: (null to emptyList()), parts ?: ("" to null))
                    // Still being sent or downloaded (no parts yet), or a draft: read it again next time.
                    if (box in FINAL_BOXES && addresses != null &&
                        (addresses.first != null || addresses.second.isNotEmpty()) && parts != null &&
                        (parts.first.isNotEmpty() || parts.second != null)
                    ) kept[id to box] = content
                    val (from, to) = content.addresses
                    val (text, image) = content.parts
                    val status = when (box) {
                        Telephony.Mms.MESSAGE_BOX_INBOX -> "incoming"
                        Telephony.Mms.MESSAGE_BOX_OUTBOX -> "sending"
                        Telephony.Mms.MESSAGE_BOX_FAILED -> "failed"
                        else -> "sent"
                    }
                    val participants = (listOfNotNull(from.takeIf { incoming }) + to).distinct()
                    rows += Row("mms:$id", c.getLong(1), participants, from.takeIf { incoming }, text, c.getLong(2) * 1000, incoming, status, c.getInt(4) == 1, image)
                }
            }
        }
        // An invalidation during the scan already queued its refresh; that read starts from its cache.
        synchronized(mmsLock) { if (mmsGeneration == generation) mmsContents = kept }
        return rows
    }

    /** The sender, and everyone else on the message, leaving out the phone's own placeholder. */
    private fun mmsAddresses(id: Long): Pair<String?, List<String>>? {
        var from: String? = null
        val to = mutableListOf<String>()
        context.contentResolver.query(Uri.parse("content://mms/$id/addr"), arrayOf("address", "type"), null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val address = c.getString(0)?.takeIf { it.isNotBlank() && it != "insert-address-token" } ?: continue
                if (c.getInt(1) == PDU_FROM) from = address else to += address
            }
        } ?: return null
        return from to to.distinct()
    }

    /** The text of a picture message, and its first picture's id. */
    private fun mmsParts(id: Long): Pair<String, String?>? {
        val text = StringBuilder()
        var image: String? = null
        context.contentResolver.query(Uri.parse("content://mms/part"), arrayOf("_id", "ct", "text"), "mid = ?", arrayOf(id.toString()), null)?.use { c ->
            while (c.moveToNext()) {
                val type = c.getString(1).orEmpty()
                when {
                    type == "text/plain" -> c.getString(2)?.let { if (text.isNotEmpty()) text.append('\n'); text.append(it) }
                    type.startsWith("image/") && image == null -> image = "mms-part:${c.getLong(0)}"
                }
            }
        } ?: return null
        return text.toString() to image
    }

    /** A picture from an MMS, shrunk for the PC (see [Jpeg]). */
    override fun image(id: String): ByteArray? {
        if (!canRead()) return null
        val part = id.removePrefix("mms-part:").toLongOrNull()?.takeIf { id.startsWith("mms-part:") } ?: return null
        val uri = Uri.parse("content://mms/part/$part")
        return Jpeg.shrink { context.contentResolver.openInputStream(uri) }
    }

    /** The PC read this conversation: remember its newest message, since the provider is read-only here. */
    override fun markRead(key: String) {
        val thread = threadOf(key) ?: return
        prefs.edit().putLong(thread.toString(), System.currentTimeMillis()).apply()
        refresh()
    }

    override fun addressOf(key: String): String? {
        val thread = threadOf(key) ?: return null
        return threadRecipients()[thread]?.singleOrNull()
    }

    /** Who is in each thread, from Android's own thread table (it leaves this phone's number out). */
    private fun threadRecipients(): Map<Long, List<String>> {
        val addresses = HashMap<String, String>()
        runCatching {
            context.contentResolver.query(Uri.parse("content://mms-sms/canonical-addresses"), arrayOf("_id", "address"), null, null, null)?.use { c ->
                while (c.moveToNext()) c.getString(1)?.let { addresses[c.getLong(0).toString()] = it }
            }
        }
        val threads = HashMap<Long, List<String>>()
        runCatching {
            context.contentResolver.query(Uri.parse("content://mms-sms/conversations?simple=true"), arrayOf("_id", "recipient_ids"), null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val ids = c.getString(1).orEmpty().split(' ').filter { it.isNotBlank() }
                    threads[c.getLong(0)] = ids.mapNotNull { addresses[it] }.distinctBy { PhoneNumbers.key(it) ?: it }
                }
            }
        }
        return threads
    }

    /**
     * Sends a text. Android itself records it in the SMS provider (the app is not the default SMS
     * app), so it shows up in the conversation through [changes].
     */
    override fun send(to: String, text: String): String? {
        if (!canSend()) return "no permission to send texts"
        if (!isPhoneNumber(to)) return "not a phone number"
        if (text.isBlank()) return "empty text"
        return try {
            val sms = context.getSystemService(SmsManager::class.java)
            val parts = sms.divideMessage(text)
            if (parts.size == 1) sms.sendTextMessage(to, null, text, null, null) else sms.sendMultipartTextMessage(to, null, parts, null, null)
            null
        } catch (e: Exception) {
            e.message ?: "could not send"
        }
    }

    private fun nameFor(address: String): String {
        if (!granted(Manifest.permission.READ_CONTACTS) || address.isBlank()) return address
        return names.getOrPut(address) {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(address))
            runCatching {
                context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                }
            }.getOrNull() ?: address
        }
    }

    private class MmsContent(val addresses: Pair<String?, List<String>>, val parts: Pair<String, String?>)

    private data class Row(
        val id: String,
        val thread: Long,
        /** The other people on the message. */
        val participants: List<String>,
        /** Who sent it, when it came in. */
        val from: String?,
        val body: String,
        val date: Long,
        val incoming: Boolean,
        val status: String,
        val read: Boolean,
        val image: String?,
    )

    companion object {
        /** Rows read per sync: enough for 100 busy conversations. */
        private const val MAX_ROWS = 5_000
        private const val MAX_MMS = 500
        private const val CHANGE_QUIET_MS = 300L
        private val FINAL_BOXES = setOf(Telephony.Mms.MESSAGE_BOX_INBOX, Telephony.Mms.MESSAGE_BOX_SENT)
        /** PduHeaders.FROM in an MMS address row. */
        private const val PDU_FROM = 137
        private const val PREFIX = "sms|t:"

        fun keyFor(thread: Long) = "$PREFIX$thread"

        fun threadOf(key: String): Long? = key.removePrefix(PREFIX).takeIf { key.startsWith(PREFIX) }?.toLongOrNull()

        /** An optional leading +, then digits with spaces, dashes, dots or brackets; 3 to 20 digits. */
        fun isPhoneNumber(text: String): Boolean =
            Regex("^\\+?[0-9 ().-]+$").matches(text.trim()) && text.count(Char::isDigit) in 3..20

        fun statusOf(type: Int): String = when (type) {
            Telephony.Sms.MESSAGE_TYPE_INBOX -> "incoming"
            Telephony.Sms.MESSAGE_TYPE_SENT -> "sent"
            Telephony.Sms.MESSAGE_TYPE_OUTBOX, Telephony.Sms.MESSAGE_TYPE_QUEUED -> "sending"
            Telephony.Sms.MESSAGE_TYPE_FAILED -> "failed"
            else -> "sent"
        }
    }
}
