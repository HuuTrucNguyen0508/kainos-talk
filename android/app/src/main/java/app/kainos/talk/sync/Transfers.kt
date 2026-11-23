package app.kainos.talk.sync

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import app.kainos.talk.R
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Immediate result of asking [SyncClient] to send clipboard text, shared text, or files. */
enum class OutboxResult {
    QUEUED,
    NOT_CONNECTED,
    UNCHANGED,
    EMPTY,
    TOO_LONG,
}

/** An opened outgoing file with known byte size, ready to stream to the PC. */
class OutgoingFile(
    val name: String,
    val size: Long,
    val mime: String?,
    val stream: InputStream,
    private val onClose: () -> Unit = {},
) : Closeable {
    override fun close() {
        runCatching { stream.close() }
        runCatching { onClose() }
    }
}

/** One item queued for the live sync session's outbox. */
internal sealed interface OutgoingRequest {
    data class Clip(val text: String) : OutgoingRequest
    data class ShareText(val text: String) : OutgoingRequest
    data class SendUris(val uris: List<Uri>) : OutgoingRequest
    data class SendFiles(val files: List<OutgoingFile>) : OutgoingRequest
}

/** Opens a shared Android content URI into an [OutgoingFile] with display name, size and MIME type. */
fun interface OutgoingFileSource {
    fun open(uri: Uri): OutgoingFile?
}

/** Metadata of a file received from the PC after it has been finalized in Downloads. */
data class SavedFile(
    val uri: Uri,
    val displayName: String,
    val mime: String?,
)

/** One open incoming file being written before `fileEnd` commits it. */
interface IncomingFileHandle {
    val output: OutputStream
    fun commit(): SavedFile
    fun abort()
}

/** Creates pending download targets for incoming files from the PC. */
fun interface IncomingFileSink {
    fun create(name: String, mime: String?): IncomingFileHandle?
}

/** Writes clipboard text received from the PC. */
fun interface ClipboardBridge {
    fun setText(text: String)
}

/** Announces a file saved from the PC so the user can tap to open it. */
fun interface FileNotifier {
    fun notifyReceived(file: SavedFile)
}

/**
 * Per-connection transfer engine: drains outgoing requests sequentially through [send] (one file
 * at a time, 256 KiB chunks so other frames interleave) and receives at most one incoming file at
 * a time from the PC. Dropping the connection aborts any partial incoming file and never resumes.
 */
internal class TransferSession(
    private val send: suspend (String) -> Unit,
    private val outgoingFiles: OutgoingFileSource,
    private val incomingFiles: IncomingFileSink,
    private val fileNotifier: FileNotifier,
    private val onIncomingClip: (String) -> Unit,
) {
    private sealed interface OutgoingOutcome {
        data object Ok : OutgoingOutcome
        data class Failed(val error: String?) : OutgoingOutcome
        data object Cancelled : OutgoingOutcome
    }

    private data class ActiveOutgoing(
        val id: String,
        val done: CompletableDeferred<OutgoingOutcome>,
    )

    private class ActiveIncoming(
        val id: String,
        val expectedSize: Long,
        val handle: IncomingFileHandle,
        var receivedBytes: Long = 0L,
    )

    @Volatile
    private var activeOutgoing: ActiveOutgoing? = null
    private var activeIncoming: ActiveIncoming? = null

    suspend fun drainOutbox(requests: ReceiveChannel<OutgoingRequest>) {
        for (request in requests) {
            when (request) {
                is OutgoingRequest.Clip -> send(SyncProtocol.clip(request.text))
                is OutgoingRequest.ShareText -> send(SyncProtocol.shareText(request.text))
                is OutgoingRequest.SendUris -> {
                    for (uri in request.uris) {
                        val opened = withContext(Dispatchers.IO) { runCatching { outgoingFiles.open(uri) }.getOrNull() } ?: continue
                        sendOneFile(opened)
                    }
                }
                is OutgoingRequest.SendFiles -> {
                    try {
                        for (file in request.files) sendOneFile(file)
                    } finally {
                        request.files.forEach(OutgoingFile::close)
                    }
                }
            }
        }
    }

    private suspend fun sendOneFile(file: OutgoingFile) {
        file.use {
            if (file.size !in 0L..SyncProtocol.MAX_FILE_SIZE) return
            val id = UUID.randomUUID().toString()
            val done = CompletableDeferred<OutgoingOutcome>()
            activeOutgoing = ActiveOutgoing(id, done)
            try {
                val safeName = SyncProtocol.safeFileName(file.name).take(SyncProtocol.MAX_FILE_NAME)
                val safeMime = file.mime?.takeIf { it.isNotBlank() }?.take(SyncProtocol.MAX_MIME)
                send(SyncProtocol.fileOffer(id, safeName, file.size, safeMime))
                val buffer = ByteArray(SyncProtocol.MAX_CHUNK_BYTES)
                var sent = 0L
                while (true) {
                    if (done.isCompleted) return
                    val count = try {
                        withContext(Dispatchers.IO) { readChunk(file.stream, buffer) }
                    } catch (_: IOException) {
                        send(SyncProtocol.fileCancel(id))
                        return
                    }
                    if (count == 0) break
                    if (sent + count > file.size) {
                        send(SyncProtocol.fileCancel(id))
                        return
                    }
                    if (done.isCompleted) return
                    send(SyncProtocol.fileChunk(id, buffer, count))
                    sent += count
                }
                if (done.isCompleted) return
                if (sent != file.size) {
                    send(SyncProtocol.fileCancel(id))
                    return
                }
                send(SyncProtocol.fileEnd(id))
                done.await()
            } finally {
                if (activeOutgoing?.id == id) activeOutgoing = null
            }
        }
    }

    suspend fun onFrame(frame: PcFrame) {
        when (frame) {
            is PcFrame.Clip -> onIncomingClip(frame.text)
            is PcFrame.FileOffer -> onFileOffer(frame)
            is PcFrame.FileChunk -> onFileChunk(frame)
            is PcFrame.FileEnd -> onFileEnd(frame)
            is PcFrame.FileResult -> {
                val outcome = if (frame.ok) OutgoingOutcome.Ok else OutgoingOutcome.Failed(frame.error)
                activeOutgoing?.takeIf { it.id == frame.id }?.done?.complete(outcome)
            }
            is PcFrame.FileCancel -> {
                if (activeIncoming?.id == frame.id) abortIncoming()
                activeOutgoing?.takeIf { it.id == frame.id }?.done?.complete(OutgoingOutcome.Cancelled)
            }
            else -> Unit
        }
    }

    private suspend fun onFileOffer(offer: PcFrame.FileOffer) {
        // A new offer while another incoming file is open discards the open one.
        abortIncoming()
        val safeName = SyncProtocol.safeFileName(offer.name)
        val handle = withContext(Dispatchers.IO) {
            runCatching { incomingFiles.create(safeName, offer.mime) }.getOrNull()
        }
        if (handle == null) {
            send(SyncProtocol.fileResult(offer.id, "could not create file"))
            return
        }
        activeIncoming = ActiveIncoming(offer.id, offer.size, handle)
    }

    private suspend fun onFileChunk(chunk: PcFrame.FileChunk) {
        val current = activeIncoming ?: return
        if (current.id != chunk.id) return
        val bytes = try {
            Base64.getDecoder().decode(chunk.data)
        } catch (_: IllegalArgumentException) {
            abortIncoming()
            send(SyncProtocol.fileResult(chunk.id, "invalid chunk"))
            return
        }
        if (bytes.size > SyncProtocol.MAX_CHUNK_BYTES) {
            abortIncoming()
            send(SyncProtocol.fileResult(chunk.id, "chunk too large"))
            return
        }
        if (current.receivedBytes + bytes.size > current.expectedSize) {
            abortIncoming()
            send(SyncProtocol.fileResult(chunk.id, "file larger than offered"))
            return
        }
        val written = withContext(Dispatchers.IO) {
            runCatching { current.handle.output.write(bytes) }.isSuccess
        }
        if (!written) {
            abortIncoming()
            send(SyncProtocol.fileResult(chunk.id, "could not write file"))
            return
        }
        current.receivedBytes += bytes.size
    }

    private suspend fun onFileEnd(end: PcFrame.FileEnd) {
        val current = activeIncoming ?: return
        if (current.id != end.id) return
        activeIncoming = null
        if (current.receivedBytes != current.expectedSize) {
            withContext(Dispatchers.IO) { current.handle.abort() }
            send(SyncProtocol.fileResult(end.id, "size mismatch"))
            return
        }
        val saved = withContext(Dispatchers.IO) {
            runCatching { current.handle.commit() }.getOrNull()
        }
        if (saved == null) {
            withContext(Dispatchers.IO) { current.handle.abort() }
            send(SyncProtocol.fileResult(end.id, "could not save file"))
            return
        }
        send(SyncProtocol.fileResult(end.id, null))
        runCatching { fileNotifier.notifyReceived(saved) }
    }

    fun abortIncoming() {
        val current = activeIncoming ?: return
        activeIncoming = null
        runCatching { current.handle.abort() }
    }

    private fun readChunk(stream: InputStream, buffer: ByteArray): Int {
        var total = 0
        while (total < buffer.size) {
            val read = stream.read(buffer, total, buffer.size - total)
            if (read < 0) break
            total += read
        }
        return total
    }
}

/** Adds ` (1)`, ` (2)`... before the extension when [name] already exists. */
internal fun uniqueFileName(name: String, exists: (String) -> Boolean): String {
    if (!exists(name)) return name
    val dot = name.lastIndexOf('.')
    val (stem, ext) = if (dot > 0) name.substring(0, dot) to name.substring(dot) else name to ""
    var n = 1
    while (true) {
        val candidate = "$stem ($n)$ext"
        if (!exists(candidate)) return candidate
        n++
    }
}

class AndroidClipboard(private val context: Context) : ClipboardBridge {
    override fun setText(text: String) {
        runCatching {
            val manager = context.getSystemService(ClipboardManager::class.java) ?: return
            manager.setPrimaryClip(ClipData.newPlainText("Kainos Talk", text))
        }
    }
}

class ContentResolverFileSource(private val context: Context) : OutgoingFileSource {
    override fun open(uri: Uri): OutgoingFile? {
        val resolver = context.contentResolver
        var displayName: String? = null
        var queriedSize: Long? = null
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIdx >= 0 && !cursor.isNull(nameIdx)) displayName = cursor.getString(nameIdx)
                    if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) queriedSize = cursor.getLong(sizeIdx)
                }
            }
        }
        val mime = runCatching { resolver.getType(uri) }.getOrNull()?.takeIf { it.isNotBlank() }?.take(SyncProtocol.MAX_MIME)
        val rawName = displayName?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment?.takeIf { it.isNotBlank() } ?: "file"
        val name = SyncProtocol.safeFileName(rawName).take(SyncProtocol.MAX_FILE_NAME)

        val knownSize = queriedSize?.takeIf { it >= 0L }
        if (knownSize != null) {
            if (knownSize > SyncProtocol.MAX_FILE_SIZE) return null
            val stream = runCatching { resolver.openInputStream(uri) }.getOrNull() ?: return null
            return OutgoingFile(name, knownSize, mime, stream)
        }

        val afd = runCatching { resolver.openAssetFileDescriptor(uri, "r") }.getOrNull()
        if (afd != null) {
            val length = afd.length
            if (length >= 0L) {
                if (length > SyncProtocol.MAX_FILE_SIZE) {
                    runCatching { afd.close() }
                    return null
                }
                val stream = runCatching { afd.createInputStream() }.getOrElse {
                    runCatching { afd.close() }
                    return null
                }
                return OutgoingFile(name, length, mime, stream) { afd.close() }
            }
            runCatching { afd.close() }
        }

        // Virtual or streaming providers may report unknown size; spool once to learn exact size.
        val source = runCatching { resolver.openInputStream(uri) }.getOrNull() ?: return null
        val temp = runCatching { File.createTempFile("kainos-share-", ".tmp", context.cacheDir) }.getOrElse {
            runCatching { source.close() }
            return null
        }
        val copied = try {
            source.use { input ->
                temp.outputStream().use { out ->
                    val buf = ByteArray(65_536)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > SyncProtocol.MAX_FILE_SIZE) return@use -1L
                        out.write(buf, 0, n)
                    }
                    total
                }
            }
        } catch (_: IOException) {
            -1L
        }
        if (copied < 0L) {
            temp.delete()
            return null
        }
        return OutgoingFile(name, copied, mime, temp.inputStream()) { temp.delete() }
    }
}

class MediaStoreDownloadSink(private val context: Context) : IncomingFileSink {
    override fun create(name: String, mime: String?): IncomingFileHandle? {
        val resolver = context.contentResolver
        val uri = insertPending(name, mime) ?: (if (mime != null) insertPending(name, null) else null) ?: return null
        val output = runCatching { resolver.openOutputStream(uri, "w") }.getOrNull()
        if (output == null) {
            runCatching { resolver.delete(uri, null, null) }
            return null
        }
        return object : IncomingFileHandle {
            override val output: OutputStream = output
            private var finalized = false

            override fun commit(): SavedFile {
                output.flush()
                output.close()
                val done = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                resolver.update(uri, done, null, null)
                finalized = true
                var actualName = name
                var actualMime = mime
                runCatching {
                    resolver.query(
                        uri,
                        arrayOf(MediaStore.Downloads.DISPLAY_NAME, MediaStore.Downloads.MIME_TYPE),
                        null,
                        null,
                        null,
                    )?.use { c ->
                        if (c.moveToFirst()) {
                            c.getString(0)?.takeIf { it.isNotBlank() }?.let { actualName = it }
                            c.getString(1)?.takeIf { it.isNotBlank() }?.let { actualMime = it }
                        }
                    }
                }
                return SavedFile(uri, actualName, actualMime)
            }

            override fun abort() {
                if (finalized) return
                finalized = true
                runCatching { output.close() }
                runCatching { resolver.delete(uri, null, null) }
            }
        }
    }

    private fun insertPending(name: String, mime: String?): Uri? {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
            if (!mime.isNullOrBlank()) put(MediaStore.Downloads.MIME_TYPE, mime)
        }
        return runCatching { context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) }.getOrNull()
    }
}

class AndroidFileNotifier(private val context: Context) : FileNotifier {
    override fun notifyReceived(file: SavedFile) {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT),
        )
        val notificationId = nextId.incrementAndGet()
        val open = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(file.uri, file.mime ?: "*/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pending = PendingIntent.getActivity(
            context,
            notificationId,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_file_received)
            .setContentTitle(file.displayName)
            .setContentText("Saved to Downloads")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        manager.notify(notificationId, notification)
    }

    companion object {
        const val CHANNEL_ID = "pc_files"
        const val CHANNEL_NAME = "Files from your PC"
        private val nextId = AtomicInteger(1000)
    }
}
