package app.kainos.talk.sync

import org.json.JSONArray
import org.json.JSONObject
import app.kainos.talk.core.SMS_SOURCE
import java.security.MessageDigest

/**
 * SMS sync with Kainos Talk on the PC: JSON frames, one per line, over TLS on the local
 * network. The PC is the server (desktop/src/main/sms-sync.ts); this phone is the client.
 * `protocol/sms-sync-vectors.json` at the repo root holds test vectors both sides check.
 */
object SyncProtocol {
    /**
     * 2: each side proves itself with its own certificate (mutual TLS); no shared secret.
     * 3: every source the phone reads (chats and mail), not only texts. The phone now sends
     *    texts only, still as `conversation` frames with source "sms"; nothing changed on the wire.
     * 4: the welcome lists what the PC still holds, so a reconnect sends only what changed.
     */
    const val VERSION = 4
    const val PORT = 48090

    /** mDNS service type of a PC running Kainos Talk. */
    const val SERVICE_TYPE = "_kainos-talk._tcp."

    /** Conversations sent per sync, newest first, and messages per conversation. */
    const val MAX_CONVERSATIONS = 100
    const val MAX_MESSAGES = 200

    /**
     * The 6-digit code both screens show while pairing. It covers both devices' certificates, so
     * a device in the middle (with certificates of its own) makes the two codes differ.
     */
    fun pairingCode(pcFingerprint: String, phoneFingerprint: String, phoneNonce: String, pcNonce: String): String {
        val digest = sha256("${pcFingerprint.uppercase()}:${phoneFingerprint.uppercase()}:$phoneNonce:$pcNonce".toByteArray(Charsets.UTF_8))
        val first = ((digest[0].toLong() and 0xFF) shl 24) or ((digest[1].toLong() and 0xFF) shl 16) or
            ((digest[2].toLong() and 0xFF) shl 8) or (digest[3].toLong() and 0xFF)
        return (first % 1_000_000).toString().padStart(6, '0')
    }

    /**
     * What the PC holds of a conversation: the first 8 bytes of the SHA-256 of the frame
     * line it came in (UTF-8, no newline), in lower-case hex. Equal hashes mean the PC already has
     * this exact frame; a different one only means it is sent again.
     */
    fun frameHash(frame: String): String = sha256(frame.toByteArray(Charsets.UTF_8)).take(8).joinToString("") { "%02x".format(it) }

    /** SHA-256 of a DER certificate, upper-case hex without separators. */
    fun certFingerprint(der: ByteArray): String = sha256(der).joinToString("") { "%02X".format(it) }

    /**
     * Private, link-local and loopback address literals: the only ones this phone connects to.
     * A host name is never local here, so nothing is looked up in DNS.
     */
    fun isLocalAddress(address: String): Boolean {
        val ip = if (address.startsWith("::ffff:") && isIpv4(address.removePrefix("::ffff:"))) address.removePrefix("::ffff:") else address
        if (isIpv4(ip)) {
            val (a, b) = ip.split('.').map { it.toInt() }
            return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        if (isIpv6(ip)) {
            val lower = ip.lowercase()
            return lower == "::1" || Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(lower) || Regex("^fe[89ab][0-9a-f]:").containsMatchIn(lower)
        }
        return false
    }

    private fun isIpv4(text: String): Boolean {
        val parts = text.split('.')
        return parts.size == 4 && parts.all { it.isNotEmpty() && it.length <= 3 && it.all(Char::isDigit) && it.toInt() <= 255 && (it == "0" || !it.startsWith("0")) }
    }

    private fun isIpv6(text: String): Boolean =
        text.contains(':') && text.count { it == ':' } <= 7 && text.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == ':' } &&
            text.split("::").size <= 2

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    // --- Frames this phone sends ---

    fun pair(device: String, nonce: String): String = frame("pair") { put("v", VERSION); put("device", device.take(100)); put("nonce", nonce) }

    fun hello(deviceId: String): String = frame("hello") { put("v", VERSION); put("deviceId", deviceId) }

    /** The user saw the same code on both screens. */
    fun pairConfirm(): String = frame("pairConfirm") {}

    fun conversation(c: SyncConversation): String = frame("conversation") {
        put(
            "conversation",
            JSONObject()
                .put("source", SMS_SOURCE)
                .put("sourceLabel", "SMS")
                .put("key", c.key)
                .put("title", c.title.take(500))
                .put("isGroup", c.isGroup)
                .put("sender", c.sender.wire)
                .put("unread", c.unread)
                .put("lastActivityMs", c.lastActivityMs)
                .put("canReply", c.canReply)
                .put(
                    "messages",
                    JSONArray().apply {
                        c.messages.takeLast(MAX_MESSAGES).forEach { m ->
                            put(
                                JSONObject()
                                    .put("id", m.id)
                                    .put("sender", m.sender?.take(500) ?: JSONObject.NULL)
                                    .put("text", m.text.take(10_000))
                                    .put("timeMs", m.timeMs)
                                    .put("outgoing", m.outgoing)
                                    .put("status", m.status)
                                    .put("media", m.media ?: JSONObject.NULL)
                                    .put("image", m.image ?: JSONObject.NULL),
                            )
                        }
                    },
                ),
        )
    }

    fun removed(key: String): String = frame("removed") { put("key", key) }

    fun replyResult(id: String, error: String?): String = frame("replyResult") {
        put("id", id)
        put("ok", error == null)
        put("error", error ?: JSONObject.NULL)
    }

    fun pong(): String = frame("pong") {}

    /** A picture the PC asked for, as JPEG in base64, or why it is missing. */
    fun image(id: String, jpeg: ByteArray?, error: String?): String = frame("image") {
        put("id", id)
        put("mime", if (jpeg != null) "image/jpeg" else JSONObject.NULL)
        put("data", jpeg?.let { java.util.Base64.getEncoder().encodeToString(it) } ?: JSONObject.NULL)
        put("error", if (jpeg == null) (error ?: "not found") else JSONObject.NULL)
    }

    private inline fun frame(type: String, fill: JSONObject.() -> Unit): String = JSONObject().put("t", type).apply(fill).toString()

    // --- Frames the PC sends: untrusted input ---

    fun parse(line: String): PcFrame? {
        val o = try {
            JSONObject(line)
        } catch (_: Exception) {
            return null
        }
        fun text(name: String, max: Int = 10_000): String? = o.optString(name, "").takeIf { o.has(name) && o.get(name) is String && it.length <= max }
        return when (o.optString("t")) {
            "pairCode" -> text("nonce", 100)?.let { PcFrame.PairCode(it) }
            "paired" -> text("deviceId", 100)?.let { PcFrame.Paired(it) }
            "pairRefused" -> PcFrame.PairRefused
            "welcome" -> PcFrame.Welcome(text("name", 200) ?: "", held(o.optJSONObject("conversations")))
            "denied" -> PcFrame.Denied(text("reason", 200) ?: "")
            "reply" -> {
                val id = text("id", 100)
                val key = text("key", 500)
                val body = text("text", 5000)
                if (id != null && key != null && body != null) PcFrame.Reply(id, key, body) else null
            }
            "read" -> text("key", 500)?.let { PcFrame.Read(it) }
            "send" -> {
                val id = text("id", 100)
                val to = text("to", 40)
                val body = text("text", 5000)
                if (id != null && to != null && body != null) PcFrame.Send(id, to, body) else null
            }
            "ping" -> PcFrame.Ping
            "getImage" -> text("id", 100)?.let { PcFrame.GetImage(it) }
            else -> null
        }
    }

    /** A welcome's key-to-hash map; a malformed entry is left out. */
    private fun held(o: JSONObject?): Map<String, String> {
        if (o == null) return emptyMap()
        return buildMap {
            for (key in o.keys()) {
                val hash = o.opt(key)
                if (key.length <= 500 && hash is String && hash.length <= 64) put(key, hash)
            }
        }
    }
}

data class SyncMessage(
    val id: String,
    val sender: String?,
    val text: String,
    val timeMs: Long,
    val outgoing: Boolean,
    val status: String,
    val media: String?,
    /** A picture the PC can ask for with `getImage`, such as "mms-part:12". */
    val image: String? = null,
)

data class SyncConversation(
    val key: String,
    val title: String,
    val isGroup: Boolean,
    val unread: Int,
    val lastActivityMs: Long,
    val canReply: Boolean,
    val messages: List<SyncMessage>,
    /** The other people's phone numbers (inbox conversations). Kept on the phone; not sent. */
    val numbers: List<String> = emptyList(),
    /** Whether the PC files this under people or notices; conversations without an SMS address are people. */
    val sender: SenderKind = SenderKind.PERSON,
)

/** Matching phone numbers written differently ("+33 6 12…", "06 12…"): their last nine digits. */
object PhoneNumbers {
    private val NUMBER = Regex("\\+?[0-9][0-9 ().-]{6,}[0-9]")

    fun key(raw: String?): String? {
        val digits = raw?.filter(Char::isDigit) ?: return null
        return if (digits.length >= 7) digits.takeLast(9) else null
    }

    /** The first thing in [text] that looks like a phone number, such as a title "Sam, +33 6 39…". */
    fun find(text: String?): String? = text?.let { NUMBER.find(it)?.value }?.takeIf { key(it) != null }
}

sealed interface PcFrame {
    data class PairCode(val nonce: String) : PcFrame
    data class Paired(val deviceId: String) : PcFrame
    data object PairRefused : PcFrame
    /**
     * The PC accepted this phone. [conversations] is what it still holds from an earlier
     * connection: each key with the [SyncProtocol.frameHash] of the frame it holds.
     */
    data class Welcome(val name: String, val conversations: Map<String, String> = emptyMap()) : PcFrame
    data class Denied(val reason: String) : PcFrame
    data class Reply(val id: String, val key: String, val text: String) : PcFrame
    data class Read(val key: String) : PcFrame

    /** A new text to a number, typed on the PC. */
    data class Send(val id: String, val to: String, val text: String) : PcFrame
    data object Ping : PcFrame

    /** The PC wants a picture from a message to show it. */
    data class GetImage(val id: String) : PcFrame
}
