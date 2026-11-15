package app.kainos.talk.core

enum class SourceKind { CHAT, MAIL }

/**
 * One account the hub shows. WhatsApp and WhatsApp Business are separate sources because they
 * are separate accounts. [canReply] and [hasMailActions] say what the source can ever do;
 * whether a given conversation can do it right now depends on its live notification.
 */
data class Source(
    val id: String,
    val label: String,
    val kind: SourceKind,
    val canReply: Boolean,
    val hasMailActions: Boolean,
) {
    companion object {
        val WHATSAPP = Source("whatsapp", "WhatsApp", SourceKind.CHAT, canReply = true, hasMailActions = false)
        val WHATSAPP_BUSINESS =
            Source("whatsapp-business", "WhatsApp Business", SourceKind.CHAT, canReply = true, hasMailActions = false)
        val DISCORD = Source("discord", "Discord", SourceKind.CHAT, canReply = true, hasMailActions = false)
        val PROTON_MAIL = Source("protonmail", "Proton Mail", SourceKind.MAIL, canReply = false, hasMailActions = true)
        val MESSENGER = Source("messenger", "Messenger", SourceKind.CHAT, canReply = true, hasMailActions = false)

        /** Texts, read from whichever app is the phone's default SMS app. */
        val SMS = Source("sms", "SMS", SourceKind.CHAT, canReply = true, hasMailActions = false)
    }
}

/** A pure function from a snapshot to what the hub should do with it. */
fun interface SourceAdapter {
    fun parse(snapshot: NotificationSnapshot): ParseResult
}

/** One watched package, the account it belongs to, and the adapter that reads it. */
data class WatchedApp(val packageName: String, val source: Source, val adapter: SourceAdapter)

class WatchedApps(apps: List<WatchedApp>) {
    private val byPackage = apps.associateBy { it.packageName }

    val packages: Set<String> get() = byPackage.keys
    val sources: List<Source> = apps.map { it.source }.distinct()

    operator fun get(packageName: String): WatchedApp? = byPackage[packageName]

    fun sourceById(id: String): Source? = sources.firstOrNull { it.id == id }
}

/** How well a notification matched what the adapter expected. */
enum class Shape {
    /** A MessagingStyle notification, read through its message list. */
    MESSAGING_STYLE,

    /** A known non-MessagingStyle layout (title/text) that the adapter recognised. */
    LEGACY_TEXT,

    /** The expected shape for this source, for example a Proton mail with its three actions. */
    EXPECTED,

    /** Not the expected shape: kept as plain title and text so nothing is dropped. */
    FALLBACK,
}

sealed interface ParseResult {
    data class Chat(val update: ChatUpdate) : ParseResult
    data class Mail(val update: MailUpdate) : ParseResult
    data class Ignored(val reason: String) : ParseResult
}

/** Points at an action on the live notification. The listener resolves it to the real action. */
data class ActionRef(val index: Int, val fromWearable: Boolean, val title: String?)

data class ChatUpdate(
    /** Stable across updates and re-posts; includes package and Android user. */
    val conversationKey: String,
    val source: Source,
    val title: String,
    val isGroup: Boolean,
    /** Oldest first. A snapshot of what the notification currently shows, not only new messages. */
    val messages: List<ParsedMessage>,
    val replyAction: ActionRef?,
    val markReadAction: ActionRef?,
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

enum class MailAction { ARCHIVE, TRASH, MARK_READ }

/** A mail action and the title the source app gave it (localised by that app). */
data class MailActionRef(val action: MailAction, val ref: ActionRef)

data class MailUpdate(
    val mailKey: String,
    val source: Source,
    val accountKey: String,
    val accountLabel: String?,
    /** Null when the source hid the sender (Proton "Extended notifications" off). */
    val sender: String?,
    val senderHidden: Boolean,
    val subject: String,
    val receivedAtMs: Long,
    /** Empty when the action list did not have the expected shape: only Open is offered then. */
    val actions: List<MailActionRef>,
    val shape: Shape,
)
