package app.kainos.talk.listener

import android.content.Context
import android.net.Uri
import app.kainos.talk.sync.Jpeg
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Pictures from chat notifications (RCS photos, for example). The source app's picture is
 * readable only while its notification is posted, so a shrunk copy is kept in the app's private
 * storage, named after the message's dedup key. The newest [KEEP] are kept.
 */
class NotificationImages(context: Context) {
    private val dir = File(context.filesDir, "media").apply { mkdirs() }
    private val resolver = context.contentResolver

    /** Dedup keys with a saved picture, so a thread's messages need no file check each. */
    private val saved: MutableSet<String> by lazy {
        ConcurrentHashMap.newKeySet<String>().apply {
            dir.listFiles { f -> f.name.endsWith(".jpg") }?.forEach { add(it.name.removeSuffix(".jpg")) }
        }
    }

    private val version = MutableStateFlow(0L)
    val changes: StateFlow<Long> = version

    @Synchronized
    fun save(dedupKey: String, uri: String) {
        val file = fileFor(dedupKey) ?: return
        if (dedupKey in saved) return
        val jpeg = runCatching { Jpeg.shrink { resolver.openInputStream(Uri.parse(uri)) } }.getOrNull() ?: return
        val temp = File(dir, "${file.name}.tmp")
        temp.writeBytes(jpeg)
        if (temp.renameTo(file)) {
            saved += dedupKey
            version.update { it + 1 }
        }
        prune()
    }

    /** The picture's id for the PC, if one was saved for this message. */
    fun idFor(dedupKey: String): String? = if (dedupKey in saved) "$PREFIX$dedupKey" else null

    fun load(id: String): ByteArray? {
        if (!id.startsWith(PREFIX)) return null
        return fileFor(id.removePrefix(PREFIX))?.takeIf { it.exists() }?.readBytes()
    }

    /** Dedup keys are SHA-256 hex; anything else never names a file. */
    private fun fileFor(dedupKey: String): File? =
        if (DEDUP_KEY.matches(dedupKey)) File(dir, "$dedupKey.jpg") else null

    private fun prune() {
        val files = dir.listFiles { f -> f.name.endsWith(".jpg") }?.sortedByDescending { it.lastModified() } ?: return
        files.drop(KEEP).forEach {
            if (it.delete()) {
                saved -= it.name.removeSuffix(".jpg")
                version.update { it + 1 }
            }
        }
    }

    companion object {
        const val PREFIX = "notif:"
        private const val KEEP = 300
        private val DEDUP_KEY = Regex("^[0-9a-f]{64}$")
    }
}
