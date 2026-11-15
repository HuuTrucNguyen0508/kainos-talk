package app.kainos.talk.core.adapters

import app.kainos.talk.core.Source
import app.kainos.talk.core.WatchedApps
import org.junit.Assert.assertEquals
import org.junit.Test

class DefaultAppsTest {
    @Test
    fun messengerAndTheKnownSmsAppsAreWatched() {
        val watched = WatchedApps(defaultWatchedApps())
        assertEquals(Source.MESSENGER, watched["com.facebook.orca"]?.source)
        for (pkg in KNOWN_SMS_PACKAGES) assertEquals(Source.SMS, watched[pkg]?.source)
        assertEquals(
            listOf(Source.WHATSAPP, Source.WHATSAPP_BUSINESS, Source.DISCORD, Source.MESSENGER, Source.PROTON_MAIL, Source.SMS),
            watched.sources,
        )
    }

    @Test
    fun anUnusualDefaultSmsAppIsWatchedFirst() {
        val apps = defaultWatchedApps("org.fossify.messages")
        val sms = apps.filter { it.source == Source.SMS }.map { it.packageName }
        assertEquals(listOf("org.fossify.messages") + KNOWN_SMS_PACKAGES, sms)
    }

    @Test
    fun aDefaultSmsAppThatIsAlsoAChatAppIsNotReadTwice() {
        val apps = defaultWatchedApps("com.whatsapp")
        assertEquals(Source.WHATSAPP, apps.single { it.packageName == "com.whatsapp" }.source)
        assertEquals(KNOWN_SMS_PACKAGES, apps.filter { it.source == Source.SMS }.map { it.packageName })
    }
}
