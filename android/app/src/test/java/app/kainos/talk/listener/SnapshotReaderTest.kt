package app.kainos.talk.listener

import android.app.Notification
import android.os.UserHandle
import android.service.notification.StatusBarNotification
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SnapshotReaderTest {
    @Test fun aPlainNotificationIsReadAsItsTitleAndText() {
        val notification = Notification.Builder(ApplicationProvider.getApplicationContext(), "chat")
            .setContentTitle("Garage Delaunay").setContentText("Your car is ready").setCategory(Notification.CATEGORY_MESSAGE).build()
        val sbn = StatusBarNotification("com.google.android.apps.messaging", "com.google.android.apps.messaging", 1, null, 1, 0, 0, notification, UserHandle.getUserHandleForUid(0), 1L)
        val snapshot = SnapshotReader.read(sbn)
        assertEquals("com.google.android.apps.messaging", snapshot.packageName)
        assertEquals("Garage Delaunay", snapshot.title)
        assertEquals("Your car is ready", snapshot.text)
        assertEquals("msg", snapshot.category)
        assertEquals(emptyList<Any>(), snapshot.messages)
    }
}
