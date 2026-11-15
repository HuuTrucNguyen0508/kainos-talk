package app.kainos.talk.sync

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.InputStream

/** Pictures sent to the PC: JPEG, at most [MAX_SIDE] pixels on the longer side, within one sync frame. */
object Jpeg {
    const val MAX_SIDE = 1600

    /** Leaves room in a 1.5 MB frame for base64 (4/3) and the JSON around it. */
    const val MAX_BYTES = 900_000

    /** Decodes the picture [open] reads (twice: size first, then pixels) and shrinks it to fit. */
    fun shrink(open: () -> InputStream?): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val input = open() ?: return null
        input.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
        val bitmap = open()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return null
        val longer = maxOf(bitmap.width, bitmap.height)
        val scaled = if (longer > MAX_SIDE) {
            Bitmap.createScaledBitmap(bitmap, bitmap.width * MAX_SIDE / longer, bitmap.height * MAX_SIDE / longer, true)
        } else {
            bitmap
        }
        for (quality in listOf(82, 65, 45)) {
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= MAX_BYTES) return out.toByteArray()
        }
        return null
    }
}
