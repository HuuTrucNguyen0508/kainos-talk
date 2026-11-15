package app.kainos.talk.core.adapters

import app.kainos.talk.core.Source
import app.kainos.talk.core.WatchedApp

/** Messenger's Android package. */
const val MESSENGER_PACKAGE = "com.facebook.orca"

/**
 * SMS apps read as the SMS source: Google Messages, Samsung Messages and AOSP Messaging. Only
 * the default SMS app posts message notifications, so listing all of them costs nothing.
 */
val KNOWN_SMS_PACKAGES = listOf(
    "com.google.android.apps.messaging",
    "com.samsung.android.messaging",
    "com.android.messaging",
)

/**
 * The real apps the hub reads. [defaultSmsPackage] is the phone's default SMS app (from
 * `Telephony.Sms.getDefaultSmsPackage`), so a less common SMS app is read too. Tests build
 * their own list instead.
 */
fun defaultWatchedApps(defaultSmsPackage: String? = null): List<WatchedApp> {
    val chat = listOf(
        WatchedApp("com.whatsapp", Source.WHATSAPP, WhatsAppAdapter(Source.WHATSAPP)),
        WatchedApp("com.whatsapp.w4b", Source.WHATSAPP_BUSINESS, WhatsAppAdapter(Source.WHATSAPP_BUSINESS)),
        WatchedApp("com.discord", Source.DISCORD, DiscordAdapter()),
        WatchedApp(MESSENGER_PACKAGE, Source.MESSENGER, ChatAppAdapter(Source.MESSENGER)),
        WatchedApp("ch.protonmail.android", Source.PROTON_MAIL, ProtonMailAdapter()),
    )
    val taken = chat.map { it.packageName }.toSet()
    // The default SMS app first: it is the one "Open" should go to.
    val sms = (listOfNotNull(defaultSmsPackage) + KNOWN_SMS_PACKAGES)
        .distinct()
        .filterNot { it in taken }
        .map { WatchedApp(it, Source.SMS, ChatAppAdapter(Source.SMS)) }
    return chat + sms
}
