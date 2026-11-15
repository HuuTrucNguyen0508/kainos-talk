package app.kainos.talk.core

/**
 * The one source the app reads: texts, from whichever app is the phone's default SMS app. It
 * starts every conversation key, fills the database's sourceId column and names the source to
 * the PC. Older versions also stored other apps' chats and mail; nothing reads those rows.
 */
const val SMS_SOURCE = "sms"

/** How well a notification matched what the adapter expected. */
enum class Shape {
    /** A MessagingStyle notification, read through its message list. */
    MESSAGING_STYLE,

    /** Written by older versions for other apps' layouts; kept so their rows still read. */
    LEGACY_TEXT,

    /** Written by older versions for mail; kept so their rows still read. */
    EXPECTED,

    /** Not the expected shape: kept as plain title and text so nothing is dropped. */
    FALLBACK,
}

sealed interface ParseResult {
    data class Chat(val update: ChatUpdate) : ParseResult
    data class Ignored(val reason: String) : ParseResult
}

/** Points at an action on the live notification. The listener resolves it to the real action. */
data class ActionRef(val index: Int, val fromWearable: Boolean, val title: String?)

data class ChatUpdate(
    /** Stable across updates and re-posts; includes the Android user. */
    val conversationKey: String,
    val title: String,
    val isGroup: Boolean,
    /** Oldest first. A snapshot of what the notification currently shows, not only new messages. */
    val messages: List<ParsedMessage>,
    val replyAction: ActionRef?,
    val shape: Shape,
)

enum class MediaKind { IMAGE, VIDEO, VOICE, AUDIO, DOCUMENT, LOCATION, CONTACT, POLL, GIF, STICKER, OTHER }

data class ParsedMessage(
    val senderName: String?,
    val senderKey: String?,
    /** As the notification showed it, bidi isolates removed. May be empty for media. */
    val text: String,
    val timeMs: Long,
    val outgoing: Boolean,
    val media: MediaKind? = null,
    /** The picture or file the notification carried, readable only while it is posted. Not part of identity. */
    val dataUri: String? = null,
)
