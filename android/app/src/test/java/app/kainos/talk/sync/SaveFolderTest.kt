package app.kainos.talk.sync

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.ui.RobolectricTalkApp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.OutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = RobolectricTalkApp::class)
class SaveFolderTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()

    private class RecordingSink : IncomingFileSink {
        val names = mutableListOf<String>()
        val handle = object : IncomingFileHandle {
            override val output: OutputStream = ByteArrayOutputStream()
            override fun commit() = SavedFile(Uri.parse("content://downloads/1"), names.last(), null)
            override fun abort() = Unit
        }

        override fun create(name: String, mime: String?): IncomingFileHandle {
            names += name
            return handle
        }
    }

    @Test
    fun withoutAChoiceFilesSaveToDownloads() {
        val folder = SaveFolder(app)
        val downloads = RecordingSink()
        assertNull(folder.tree())
        assertFalse(folder.isLost())

        val handle = ChosenFolderSink(app, folder, downloads).create("report.pdf", "application/pdf")

        assertSame(downloads.handle, handle)
        assertEquals(listOf("report.pdf"), downloads.names)
        assertEquals("Downloads", handle!!.commit().folder)
    }

    @Test
    fun aChosenFolderThisAppMayNoLongerWriteToFallsBackToDownloadsAndSaysSo() {
        // A choice whose access was revoked, as after the folder's permission is removed in Settings.
        app.getSharedPreferences("save-folder", Context.MODE_PRIVATE).edit()
            .putString("tree", "content://com.android.externalstorage.documents/tree/primary%3AKainos%20files")
            .commit()
        val folder = SaveFolder(app)
        val downloads = RecordingSink()

        assertNull(folder.tree())
        assertTrue(folder.isLost())
        assertSame(downloads.handle, ChosenFolderSink(app, folder, downloads).create("a.txt", null))

        folder.useDownloads()
        assertFalse(folder.isLost())
    }
}
