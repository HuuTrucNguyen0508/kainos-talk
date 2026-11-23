package app.kainos.talk.ui

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.KainosTalkApp
import app.kainos.talk.sync.AndroidFileNotifier
import app.kainos.talk.sync.DeviceIdentity
import app.kainos.talk.sync.OutboxResult
import app.kainos.talk.sync.Pkcs12Identity
import app.kainos.talk.sync.SavedFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

class RobolectricTalkApp : KainosTalkApp() {
    override fun deviceIdentity(): DeviceIdentity =
        Pkcs12Identity(javaClass.classLoader!!.getResourceAsStream("sync/phone.p12")!!, "kainos-test")
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = RobolectricTalkApp::class)
class ShareAndClipboardTest {
    @Test
    fun extractsTextAndFilePayloadsFromShareIntents() {
        val textIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "https://example.com/watch?v=42")
        }
        assertEquals(SharePayload.Text("https://example.com/watch?v=42"), extractSharePayload(textIntent))

        val uri1 = Uri.parse("content://example/photo.jpg")
        val uri2 = Uri.parse("content://example/doc.pdf")
        val textFileIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri1)
        }
        assertEquals(SharePayload.Files(listOf(uri1)), extractSharePayload(textFileIntent))

        val multiIntent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri1, uri2))
        }
        assertEquals(SharePayload.Files(listOf(uri1, uri2)), extractSharePayload(multiIntent))

        assertNull(extractSharePayload(Intent(Intent.ACTION_VIEW)))
    }

    @Test
    fun sharedFilesRequireContentUrisOutsideTheApp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val ownAuthorities = ownProviderAuthorities(app)
        val ownAuthority = "${app.packageName}.androidx-startup"
        assertFalse(canOpenSharedUri(Uri.parse("file:///shared/report.pdf"), ownAuthorities))
        assertFalse(canOpenSharedUri(Uri.parse("content://$ownAuthority/report.pdf"), ownAuthorities))
        assertFalse(canOpenSharedUri(Uri.parse("content://10@$ownAuthority/report.pdf"), ownAuthorities))
        assertFalse(canOpenSharedUri(Uri.parse("content:///report.pdf"), ownAuthorities))
        assertTrue(canOpenSharedUri(Uri.parse("content://media/external/downloads/42"), ownAuthorities))
    }

    @Test
    fun queuedFilesAreSendingAndReportUnreadableFiles() {
        val text = SharePayload.Text("https://example.com")
        val files = SharePayload.Files(listOf(Uri.parse("content://example/report.pdf"), Uri.parse("content://example/notes.txt")))
        assertEquals("Sent to PC", shareResultMessage(text, OutboxResult.QUEUED))
        assertEquals("Sending to PC", shareResultMessage(files, OutboxResult.QUEUED))
        assertEquals("Sending to PC. Could not read 1 of 2 shared files", shareResultMessage(files, OutboxResult.QUEUED, unreadable = 1))
    }

    @Test
    fun shareActivityReportsNotConnectedAndFinishes() {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "https://example.com")
        }
        val controller = Robolectric.buildActivity(ShareActivity::class.java, intent).create()
        assertTrue(controller.get().isFinishing)
        assertEquals("PC is not connected", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun clipboardActivityReportsNotConnectedOnFocusAndFinishes() {
        val controller = Robolectric.buildActivity(ClipboardSendActivity::class.java).create()
        controller.get().onWindowFocusChanged(true)
        assertTrue(controller.get().isFinishing)
        assertEquals("PC is not connected", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun fileNotifierPostsOnFilesChannelOnlyWhenPermitted() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val manager = app.getSystemService(NotificationManager::class.java)
        val notifier = AndroidFileNotifier(app)
        val file = SavedFile(Uri.parse("content://media/external/downloads/42"), "report.pdf", "application/pdf")

        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        notifier.notifyReceived(file)
        assertEquals(0, shadowOf(manager).allNotifications.size)

        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        notifier.notifyReceived(file)
        val channel = manager.getNotificationChannel(AndroidFileNotifier.CHANNEL_ID)
        assertEquals(AndroidFileNotifier.CHANNEL_NAME, channel?.name?.toString())
        val posted = shadowOf(manager).allNotifications
        assertEquals(1, posted.size)
        val openIntent = shadowOf(posted[0].contentIntent).savedIntent
        assertEquals(Intent.ACTION_VIEW, openIntent.action)
        assertEquals(file.uri, openIntent.data)
        assertEquals("application/pdf", openIntent.type)
        assertTrue((openIntent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0)
    }
}
