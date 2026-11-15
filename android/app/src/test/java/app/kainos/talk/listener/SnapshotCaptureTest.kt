package app.kainos.talk.listener

import android.app.Notification
import android.os.UserHandle
import android.service.notification.StatusBarNotification
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.core.DumpCapture
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SnapshotCaptureTest {
    @Test fun detailedExtrasAreCopiedOnlyDuringCapture() {
        val notification = Notification.Builder(ApplicationProvider.getApplicationContext(), "chat")
            .setContentTitle("A title").setContentText("A message").build()
        val sbn = StatusBarNotification("com.whatsapp", "com.whatsapp", 1, null, 1, 0, 0, notification, UserHandle.getUserHandleForUid(0), 1L)
        val off = SnapshotReader.read(sbn)
        assertTrue(off.extras.isEmpty())
        assertEquals("A title", off.title)
        assertEquals("A message", off.text)
        DumpCapture.open()
        try {
            val on = SnapshotReader.read(sbn)
            assertTrue(on.extras.isNotEmpty())
            assertEquals(off, on.copy(extras = emptyList()))
        } finally { DumpCapture.close() }
        assertTrue(SnapshotReader.read(sbn).extras.isEmpty())
    }
}
