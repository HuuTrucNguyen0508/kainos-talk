package app.kainos.talk.listener

import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import app.kainos.talk.talkGraph

/**
 * The only way notifications enter the hub. The system binds it while notification access is
 * granted; no foreground service is needed.
 */
class KainosNotificationListener : NotificationListenerService() {
    private val ingest get() = applicationContext.talkGraph().ingest

    override fun onListenerConnected() {
        val active = runCatching { activeNotifications?.toList() }.getOrNull().orEmpty()
        ingest.onConnected(active)
    }

    override fun onListenerDisconnected() {
        ingest.onDisconnected()
        requestRebind(ComponentName(this, KainosNotificationListener::class.java))
    }

    override fun onNotificationPosted(sbn: StatusBarNotification, rankingMap: RankingMap?) {
        ingest.onPosted(sbn)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap?, reason: Int) {
        ingest.onRemoved(sbn, reason)
    }
}
