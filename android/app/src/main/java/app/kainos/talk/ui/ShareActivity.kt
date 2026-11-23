package app.kainos.talk.ui

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import app.kainos.talk.sync.ContentResolverFileSource
import app.kainos.talk.sync.OutboxResult
import app.kainos.talk.talkGraph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What another app shared to Kainos Talk through the Android share sheet. */
internal sealed interface SharePayload {
    data class Text(val text: String) : SharePayload
    data class Files(val uris: List<Uri>) : SharePayload
}

/** Extracts text/links or file URIs from an `ACTION_SEND` or `ACTION_SEND_MULTIPLE` intent. */
internal fun extractSharePayload(intent: Intent?): SharePayload? {
    if (intent == null) return null
    return when (intent.action) {
        Intent.ACTION_SEND -> {
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            val stream = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                ?: clipUris(intent).firstOrNull()
            when {
                intent.type == "text/plain" && !text.isNullOrEmpty() -> SharePayload.Text(text)
                stream != null -> SharePayload.Files(listOf(stream))
                !text.isNullOrEmpty() -> SharePayload.Text(text)
                else -> null
            }
        }
        Intent.ACTION_SEND_MULTIPLE -> {
            val streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                ?.takeIf { it.isNotEmpty() }
                ?: clipUris(intent)
            if (streams.isNotEmpty()) {
                SharePayload.Files(streams)
            } else {
                val texts = intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)
                    ?.map { it.toString() }
                    ?.filter { it.isNotEmpty() }
                    .orEmpty()
                if (texts.isNotEmpty()) SharePayload.Text(texts.joinToString("\n")) else null
            }
        }
        else -> null
    }
}

private fun clipUris(intent: Intent): List<Uri> {
    val clip = intent.clipData ?: return emptyList()
    return buildList {
        for (i in 0 until clip.itemCount) {
            clip.getItemAt(i).uri?.let(::add)
        }
    }
}

internal fun ownProviderAuthorities(context: Context): Set<String> =
    context.packageManager.getPackageInfo(
        context.packageName,
        PackageManager.PackageInfoFlags.of(
            (PackageManager.GET_PROVIDERS or PackageManager.MATCH_DISABLED_COMPONENTS).toLong(),
        ),
    ).providers.orEmpty().flatMap { it.authority.split(';') }.toSet()

internal fun canOpenSharedUri(uri: Uri, ownAuthorities: Set<String>): Boolean {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return false
    // Android strips the user ID from a cross-profile content URI before resolving its authority.
    val authority = uri.authority?.substringAfterLast('@')?.takeIf { it.isNotEmpty() } ?: return false
    return authority !in ownAuthorities
}

internal fun shareResultMessage(payload: SharePayload, result: OutboxResult, unreadable: Int = 0): String? =
    when (result) {
        OutboxResult.QUEUED -> when (payload) {
            is SharePayload.Text -> "Sent to PC"
            is SharePayload.Files -> if (unreadable == 0) "Sending to PC"
                else "Sending to PC. Could not read $unreadable of ${payload.uris.size} shared files"
        }
        OutboxResult.NOT_CONNECTED -> "PC is not connected"
        OutboxResult.TOO_LONG -> if (payload is SharePayload.Text) "Text is too long to send" else "File is too large to send"
        OutboxResult.EMPTY, OutboxResult.UNCHANGED -> null
    }

/**
 * Translucent share target with no UI of its own: passes shared text, links or files to the paired
 * PC, shows a short toast, and finishes.
 */
class ShareActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val payload = extractSharePayload(intent)
        if (payload == null) {
            finish()
            return
        }
        val sync = talkGraph().sync
        if (!sync.isConnected) {
            toast("PC is not connected")
            finish()
            return
        }
        when (payload) {
            is SharePayload.Text -> {
                shareResultMessage(payload, sync.shareText(payload.text))?.let(::toast)
                finish()
            }
            is SharePayload.Files -> {
                // Open shared content streams before finishing so temporary URI grants stay valid.
                scope.launch {
                    val source = ContentResolverFileSource(this@ShareActivity)
                    val opened = withContext(Dispatchers.IO) {
                        val ownAuthorities = ownProviderAuthorities(this@ShareActivity)
                        payload.uris.filter { canOpenSharedUri(it, ownAuthorities) }.mapNotNull(source::open)
                    }
                    val unreadable = payload.uris.size - opened.size
                    if (opened.isEmpty()) {
                        toast(if (unreadable == 1) "Could not read shared file" else "Could not read $unreadable shared files")
                    } else {
                        shareResultMessage(payload, sync.sharePreparedFiles(opened), unreadable)?.let(::toast)
                    }
                    finish()
                }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun toast(message: String) {
        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    }
}
