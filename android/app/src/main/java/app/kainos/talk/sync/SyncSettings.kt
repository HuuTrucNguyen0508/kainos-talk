package app.kainos.talk.sync

import android.content.Context

/** The PC this phone is paired with. */
data class PairedPc(
    /** Where the PC was last found: a cache, not its identity. It is looked up again by [fingerprint]. */
    val host: String,
    /** SHA-256 of the PC's certificate: the only one this phone accepts from it. */
    val fingerprint: String,
    val deviceId: String,
    val pcName: String,
)

/** Kept in the app's private storage, which is excluded from backups and device transfer. */
class SyncSettings(context: Context) {
    private val prefs = context.getSharedPreferences("sms-sync", Context.MODE_PRIVATE)

    fun load(): PairedPc? {
        // A pairing from protocol 1 (a shared secret) is dropped: the phone pairs again.
        if (prefs.contains("secret")) {
            clear()
            return null
        }
        val host = prefs.getString("host", null) ?: return null
        return PairedPc(
            host = host,
            fingerprint = prefs.getString("fingerprint", null) ?: return null,
            deviceId = prefs.getString("deviceId", null) ?: return null,
            pcName = prefs.getString("pcName", null) ?: host,
        )
    }

    fun save(pc: PairedPc) {
        prefs.edit()
            .putString("host", pc.host)
            .putString("fingerprint", pc.fingerprint)
            .putString("deviceId", pc.deviceId)
            .putString("pcName", pc.pcName)
            .commit()
    }

    fun clear() {
        prefs.edit().clear().commit()
    }
}
