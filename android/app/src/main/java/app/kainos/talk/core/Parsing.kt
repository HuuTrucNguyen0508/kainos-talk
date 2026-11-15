package app.kainos.talk.core

import java.security.MessageDigest

/** Bidi isolates and marks that the platform wraps around names in `android.title`. */
private val BIDI_CONTROLS = Regex("[\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]")
private val WHITESPACE = Regex("\\s+")

fun cleanText(value: String?): String? = value?.replace(BIDI_CONTROLS, "")?.trim()?.takeIf { it.isNotEmpty() }

fun normalizeForMatch(text: String): String = text.replace(BIDI_CONTROLS, "").replace(WHITESPACE, " ").trim()

/**
 * Drops what should never turn into a message: ongoing and foreground-service
 * notifications and group summaries. Returns the reason, or null to continue.
 */
fun commonIgnoreReason(snapshot: NotificationSnapshot): String? = when {
    snapshot.hasFlag(NotificationFlags.GROUP_SUMMARY) -> "group summary"
    snapshot.hasFlag(NotificationFlags.FOREGROUND_SERVICE) -> "foreground service"
    snapshot.hasFlag(NotificationFlags.ONGOING_EVENT) -> "ongoing"
    else -> null
}

private val MEDIA_PREFIXES = listOf(
    "📷" to MediaKind.IMAGE,
    "🎥" to MediaKind.VIDEO,
    "📹" to MediaKind.VIDEO,
    "🎤" to MediaKind.VOICE,
    "🎵" to MediaKind.AUDIO,
    "📄" to MediaKind.DOCUMENT,
    "📍" to MediaKind.LOCATION,
    "👤" to MediaKind.CONTACT,
    "📊" to MediaKind.POLL,
    "👾" to MediaKind.GIF,
)

/**
 * Guesses the media type from the emoji label a chat app puts in front of the text, or from
 * the message's data MIME type. The emoji labels are unverified guesses at what chat apps use.
 */
fun mediaKindOf(text: String?, mimeType: String?): MediaKind? {
    val trimmed = text?.trimStart().orEmpty()
    MEDIA_PREFIXES.firstOrNull { (prefix, _) -> trimmed.startsWith(prefix) }?.let { return it.second }
    val mime = mimeType?.lowercase() ?: return null
    return when {
        mime == "image/gif" -> MediaKind.GIF
        mime == "image/webp" -> MediaKind.STICKER
        mime.startsWith("image/") -> MediaKind.IMAGE
        mime.startsWith("video/") -> MediaKind.VIDEO
        mime.startsWith("audio/") -> MediaKind.AUDIO
        else -> MediaKind.OTHER
    }
}

/** Converts MessagingStyle messages, dropping ones with neither text nor media. */
fun parseStyleMessages(snapshot: NotificationSnapshot): List<ParsedMessage> =
    snapshot.messages.mapNotNull { message ->
        val text = cleanText(message.text).orEmpty()
        val media = mediaKindOf(text, message.dataMimeType)
        if (text.isEmpty() && media == null && message.dataUri == null) return@mapNotNull null
        ParsedMessage(
            senderName = if (message.isSelf) null else cleanText(message.senderName),
            senderKey = if (message.isSelf) null else message.senderKey,
            text = text,
            timeMs = message.timeMs,
            outgoing = message.isSelf,
            media = media ?: if (text.isEmpty()) MediaKind.OTHER else null,
            dataUri = message.dataUri?.takeIf { message.dataMimeType?.startsWith("image/") == true },
        )
    }

/** Time for a message that came without its own timestamp (non-MessagingStyle layouts). */
fun legacyMessageTime(snapshot: NotificationSnapshot): Long =
    if (snapshot.whenMs > 0) snapshot.whenMs else snapshot.postTimeMs

private fun SnapshotAction.hasFreeFormInput() = remoteInputs.any { it.allowFreeFormInput }

private fun SnapshotAction.ref() = ActionRef(index, fromWearable, title)

private fun SnapshotAction.titleMatches(regex: Regex) = title?.let { regex.containsMatchIn(it) } == true

private val REPLY_TITLE = Regex("reply", RegexOption.IGNORE_CASE)

/**
 * The inline-reply action: a declared reply action with a free-form input first, then any
 * free-form input titled like "Reply", then any free-form input. Notification actions win over
 * WearableExtender ones.
 */
fun pickReplyAction(snapshot: NotificationSnapshot): ActionRef? {
    val candidates = (snapshot.actions + snapshot.wearableActions).filter { it.hasFreeFormInput() }
    return (
        candidates.firstOrNull { it.semanticAction == SemanticAction.REPLY }
            ?: candidates.firstOrNull { it.titleMatches(REPLY_TITLE) }
            ?: candidates.firstOrNull()
        )?.ref()
}

/**
 * Identity of one message within a conversation, stable across the repeated snapshots a chat
 * app posts. Repeats of the same message in later updates map to the same key.
 */
fun messageDedupKey(conversationKey: String, message: ParsedMessage): String {
    val sender = if (message.outgoing) "\u0001self" else message.senderKey ?: message.senderName.orEmpty()
    val raw = listOf(
        conversationKey,
        message.timeMs.toString(),
        sender,
        normalizeForMatch(message.text),
        message.media?.name.orEmpty(),
    ).joinToString("\u0000")
    val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }
}

/** Joins identity parts into a conversation key. */
fun stableKey(vararg parts: Any?): String = parts.joinToString("|") { it?.toString().orEmpty() }
