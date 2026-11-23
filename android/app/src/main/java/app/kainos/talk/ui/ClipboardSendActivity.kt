package app.kainos.talk.ui

import android.app.Activity
import android.content.ClipboardManager
import android.widget.Toast
import app.kainos.talk.sync.OutboxResult
import app.kainos.talk.talkGraph

/**
 * See-through activity opened by [ClipboardTileService]. Reads the clipboard once its window has
 * focus (Android blocks background clipboard reads), sends it to the paired PC, toasts, and closes.
 */
class ClipboardSendActivity : Activity() {
    private var handled = false

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || handled) return
        handled = true
        sendClipboard()
        finish()
    }

    private fun sendClipboard() {
        val sync = talkGraph().sync
        if (!sync.isConnected) {
            toast("PC is not connected")
            return
        }
        val manager = getSystemService(ClipboardManager::class.java)
        val clip = manager?.primaryClip
        val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        if (text.isNullOrEmpty()) {
            toast("Clipboard is empty")
            return
        }
        val message = when (sync.sendClip(text)) {
            OutboxResult.QUEUED -> "Sent to PC"
            OutboxResult.UNCHANGED -> "Already on PC"
            OutboxResult.NOT_CONNECTED -> "PC is not connected"
            OutboxResult.TOO_LONG -> "Clipboard text is too long"
            OutboxResult.EMPTY -> "Clipboard is empty"
        }
        toast(message)
    }

    private fun toast(message: String) {
        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    }
}
