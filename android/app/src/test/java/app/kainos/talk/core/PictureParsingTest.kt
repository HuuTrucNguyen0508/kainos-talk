package app.kainos.talk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PictureParsingTest {
    @Test
    fun aPictureKeepsItsAddressSoItCanBeCopiedWhileTheNotificationIsUp() {
        val messages = parseStyleMessages(
            snapshot(
                template = MESSAGING_STYLE,
                messages = listOf(
                    incoming("", 1_000, "Mum", mime = "image/jpeg", uri = "content://com.google.android.apps.messaging/p/1"),
                    incoming("", 2_000, "Mum", mime = "audio/ogg", uri = "content://com.google.android.apps.messaging/a/2"),
                ),
            ),
        )
        assertEquals("content://com.google.android.apps.messaging/p/1", messages[0].dataUri)
        assertNull("only pictures are kept", messages[1].dataUri)
    }

    @Test
    fun theAddressIsNotPartOfAMessagesIdentity() {
        val message = ParsedMessage("Mum", "k", "", 1_000, outgoing = false, media = MediaKind.IMAGE)
        assertEquals(messageDedupKey("c", message), messageDedupKey("c", message.copy(dataUri = "content://x/1")))
    }
}
