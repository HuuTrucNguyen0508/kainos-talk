package app.kainos.talk.core

import android.app.Notification
import android.service.notification.NotificationListenerService
import org.junit.Assert.assertEquals
import org.junit.Test

/** The core copies a few platform constants so it can run without Android; keep them in sync. */
class PlatformConstantsTest {
    @Test
    fun flagsMatchThePlatform() {
        assertEquals(Notification.FLAG_ONGOING_EVENT, NotificationFlags.ONGOING_EVENT)
        assertEquals(Notification.FLAG_FOREGROUND_SERVICE, NotificationFlags.FOREGROUND_SERVICE)
        assertEquals(Notification.FLAG_LOCAL_ONLY, NotificationFlags.LOCAL_ONLY)
        assertEquals(Notification.FLAG_GROUP_SUMMARY, NotificationFlags.GROUP_SUMMARY)
    }

    @Test
    fun semanticActionsMatchThePlatform() {
        assertEquals(Notification.Action.SEMANTIC_ACTION_NONE, SemanticAction.NONE)
        assertEquals(Notification.Action.SEMANTIC_ACTION_REPLY, SemanticAction.REPLY)
        assertEquals(Notification.Action.SEMANTIC_ACTION_MARK_AS_READ, SemanticAction.MARK_AS_READ)
    }

    @Test
    fun removalReasonsMatchThePlatform() {
        assertEquals(NotificationListenerService.REASON_CLICK, RemovalReason.CLICK)
        assertEquals(NotificationListenerService.REASON_CANCEL, RemovalReason.CANCEL)
        assertEquals(NotificationListenerService.REASON_CANCEL_ALL, RemovalReason.CANCEL_ALL)
        assertEquals(NotificationListenerService.REASON_APP_CANCEL, RemovalReason.APP_CANCEL)
        assertEquals(NotificationListenerService.REASON_LISTENER_CANCEL, RemovalReason.LISTENER_CANCEL)
        assertEquals(NotificationListenerService.REASON_GROUP_SUMMARY_CANCELED, RemovalReason.GROUP_SUMMARY_CANCELED)
    }
}
