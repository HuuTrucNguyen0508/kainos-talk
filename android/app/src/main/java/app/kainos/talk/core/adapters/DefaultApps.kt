package app.kainos.talk.core.adapters

/**
 * SMS apps read as texts: Google Messages, Samsung Messages and AOSP Messaging. Only the default
 * SMS app posts message notifications, so listing all of them costs nothing.
 */
val KNOWN_SMS_PACKAGES = listOf(
    "com.google.android.apps.messaging",
    "com.samsung.android.messaging",
    "com.android.messaging",
)

/**
 * The packages whose notifications are read. [defaultSmsPackage] is the phone's default SMS app
 * (from `Telephony.Sms.getDefaultSmsPackage`), so a less common SMS app is read too.
 */
fun smsPackages(defaultSmsPackage: String? = null): Set<String> =
    (listOfNotNull(defaultSmsPackage) + KNOWN_SMS_PACKAGES).toCollection(LinkedHashSet())
