package app.kainos.talk.core.adapters

import org.junit.Assert.assertEquals
import org.junit.Test

class DefaultAppsTest {
    @Test
    fun theKnownSmsAppsAreRead() {
        assertEquals(
            listOf("com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.messaging"),
            smsPackages().toList(),
        )
    }

    @Test
    fun anUnusualDefaultSmsAppIsReadFirst() {
        assertEquals(
            listOf("org.fossify.messages", "com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.messaging"),
            smsPackages("org.fossify.messages").toList(),
        )
    }

    @Test
    fun aKnownDefaultSmsAppIsReadOnce() {
        assertEquals(
            listOf("com.samsung.android.messaging", "com.google.android.apps.messaging", "com.android.messaging"),
            smsPackages("com.samsung.android.messaging").toList(),
        )
    }

    @Test
    fun otherChatAndMailAppsAreNotRead() {
        val read = smsPackages()
        for (pkg in listOf("com.whatsapp", "com.whatsapp.w4b", "com.discord", "com.facebook.orca", "ch.protonmail.android")) {
            assertEquals(pkg, false, pkg in read)
        }
    }
}
