package app.kainos.talk.sync

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class JpegTest {
    @Test fun encodedPicturesAreDecodedAndShrunk() {
        for (format in listOf(Bitmap.CompressFormat.PNG, Bitmap.CompressFormat.JPEG)) {
            val encoded = ByteArrayOutputStream().also {
                Bitmap.createBitmap(2000, 1000, Bitmap.Config.ARGB_8888).compress(format, 90, it)
            }.toByteArray()
            val result = Jpeg.shrink { encoded.inputStream() }
            assertNotNull(result)
            assertTrue(result!!.size <= Jpeg.MAX_BYTES)
            val decoded = BitmapFactory.decodeByteArray(result, 0, result.size)
            assertEquals(1600, decoded.width)
            assertEquals(800, decoded.height)
        }
    }
}
