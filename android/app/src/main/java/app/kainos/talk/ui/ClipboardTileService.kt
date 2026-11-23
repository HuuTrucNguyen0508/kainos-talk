package app.kainos.talk.ui

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.kainos.talk.R
import app.kainos.talk.sync.SyncStatus
import app.kainos.talk.talkGraph

/**
 * Quick Settings tile ("Send clipboard to PC"). Android 10+ only lets the focused activity read
 * the clipboard, so tapping this tile collapses Quick Settings onto [ClipboardSendActivity].
 */
class ClipboardTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val status = talkGraph().sync.status.value
        tile.label = getString(R.string.tile_clipboard_label)
        if (status is SyncStatus.Connected) {
            tile.state = Tile.STATE_ACTIVE
            tile.subtitle = status.pcName
        } else {
            // Stay clickable when disconnected so tapping tells the user the PC is not connected.
            tile.state = Tile.STATE_INACTIVE
            tile.subtitle = "Not connected"
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        val intent = Intent(this, ClipboardSendActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pending = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            startActivityAndCollapse(pending)
        } else {
            startActivityAndCollapseLegacy(intent)
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun startActivityAndCollapseLegacy(intent: Intent) {
        startActivityAndCollapse(intent)
    }
}
