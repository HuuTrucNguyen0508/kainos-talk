package app.kainos.talk.sync

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import java.io.IOException
import java.io.OutputStream
import java.util.UUID

/**
 * The folder files from the PC save to, if the user chose one with Android's folder picker. Kept
 * apart from the pairing, so forgetting the PC keeps it. Without a usable choice, files save to
 * Downloads.
 */
class SaveFolder(context: Context) {
    private val context = context.applicationContext
    private val prefs = this.context.getSharedPreferences("save-folder", Context.MODE_PRIVATE)

    /** The chosen folder, while this app may still write to it. */
    fun tree(): Uri? {
        val uri = prefs.getString(KEY, null)?.let(Uri::parse) ?: return null
        val held = context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isWritePermission }
        return uri.takeIf { held }
    }

    /** The chosen folder's name; null when none was chosen or it can't be reached any more. */
    fun name(): String? {
        val tree = tree() ?: return null
        return runCatching {
            context.contentResolver.query(folderDocument(tree), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    /** True when a folder was chosen but can't be used now, so files go to Downloads instead. */
    fun isLost(): Boolean = prefs.contains(KEY) && name() == null

    /** Keeps write access to [tree] across restarts and saves files there from now on. */
    fun choose(tree: Uri) {
        context.contentResolver.takePersistableUriPermission(tree, FLAGS)
        val old = prefs.getString(KEY, null)?.let(Uri::parse)
        prefs.edit().putString(KEY, tree.toString()).commit()
        if (old != null && old != tree) release(old)
    }

    /** Saves files to Downloads again. */
    fun useDownloads() {
        val old = prefs.getString(KEY, null)?.let(Uri::parse)
        prefs.edit().remove(KEY).commit()
        if (old != null) release(old)
    }

    private fun release(tree: Uri) {
        runCatching { context.contentResolver.releasePersistableUriPermission(tree, FLAGS) }
    }

    companion object {
        private const val KEY = "tree"
        private const val FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

        internal fun folderDocument(tree: Uri): Uri =
            DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    }
}

/** Saves to the chosen [SaveFolder]; to [downloads] when there is none or it can't take the file. */
class ChosenFolderSink(
    context: Context,
    private val folder: SaveFolder = SaveFolder(context),
    private val downloads: IncomingFileSink = MediaStoreDownloadSink(context),
) : IncomingFileSink {
    private val resolver = context.applicationContext.contentResolver

    override fun create(name: String, mime: String?): IncomingFileHandle? {
        val tree = folder.tree()
        val label = tree?.let { folder.name() }
        if (tree != null && label != null) {
            createIn(tree, label, name, mime)?.let { return it }
        }
        return downloads.create(name, mime)
    }

    /**
     * Writes to a hidden temporary file, then renames it to [name]. The folder's provider picks a
     * free name ("name (1).ext") instead of replacing a file, as Downloads does.
     */
    private fun createIn(tree: Uri, label: String, name: String, mime: String?): IncomingFileHandle? {
        val parent = SaveFolder.folderDocument(tree)
        val temp = runCatching {
            DocumentsContract.createDocument(resolver, parent, "application/octet-stream", ".kainos-${UUID.randomUUID()}.part")
        }.getOrNull() ?: return null
        val output = runCatching { resolver.openOutputStream(temp, "w") }.getOrNull()
        if (output == null) {
            runCatching { DocumentsContract.deleteDocument(resolver, temp) }
            return null
        }
        return object : IncomingFileHandle {
            override val output: OutputStream = output
            private var finalized = false

            override fun commit(): SavedFile {
                output.flush()
                output.close()
                val saved = DocumentsContract.renameDocument(resolver, temp, name) ?: throw IOException("could not rename")
                finalized = true
                val actualName = runCatching {
                    resolver.query(saved, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
                }.getOrNull()?.takeIf { it.isNotBlank() } ?: name
                return SavedFile(saved, actualName, mime, folder = label)
            }

            override fun abort() {
                if (finalized) return
                finalized = true
                runCatching { output.close() }
                runCatching { DocumentsContract.deleteDocument(resolver, temp) }
            }
        }
    }
}
