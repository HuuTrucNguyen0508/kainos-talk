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
    /** The PC's Tailscale addresses, from its last welcome: where to look when it isn't on this Wi-Fi. */
    val tailnet: List<String> = emptyList(),
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
            tailnet = prefs.getString("tailnet", null).orEmpty().split(' ').filter { SyncProtocol.isTailnetAddress(it) },
        )
    }

    fun save(pc: PairedPc) = synchronized(LOCK) {
        prefs.edit()
            .putString("host", pc.host)
            .putString("fingerprint", pc.fingerprint)
            .putString("deviceId", pc.deviceId)
            .putString("pcName", pc.pcName)
            .putString("tailnet", pc.tailnet.joinToString(" "))
            .commit()
    }

    fun clear() = synchronized(LOCK) {
        prefs.edit().clear().commit()
    }

    /**
     * Saves [updated] only while [expected] is still the pairing on disk: a session must not bring
     * back a PC the user just forgot, or overwrite a new pairing. True when it was saved.
     */
    fun replace(expected: PairedPc, updated: PairedPc): Boolean = synchronized(LOCK) {
        if (load() != expected) return false
        save(updated)
        true
    }

    private companion object {
        /** One for every instance: they share the same file. */
        val LOCK = Any()
    }
}
