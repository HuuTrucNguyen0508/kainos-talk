package app.kainos.talk.ui.talk

import androidx.compose.runtime.staticCompositionLocalOf
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MediaKind
import app.kainos.talk.core.Source
import app.kainos.talk.hub.ActionFailure
import app.kainos.talk.hub.ActionResult
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.OpenResult
import app.kainos.talk.hub.ReplyFailure
import app.kainos.talk.store.MessageStatus
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * What "now" is and how the user reads clock times. The activity provides the real clock and
 * the phone's 24-hour setting; screenshot tests provide a fixed one.
 */
data class TalkClock(
    val nowMs: Long,
    val zone: ZoneId = ZoneId.systemDefault(),
    val is24Hour: Boolean = true,
    val locale: Locale = Locale.getDefault(),
) {
    private fun at(ms: Long): ZonedDateTime = Instant.ofEpochMilli(ms).atZone(zone)
    private val today: LocalDate get() = at(nowMs).toLocalDate()
    private fun daysAgo(ms: Long): Long = ChronoUnit.DAYS.between(at(ms).toLocalDate(), today)

    fun clock(ms: Long): String =
        at(ms).format(DateTimeFormatter.ofPattern(if (is24Hour) "HH:mm" else "h:mm a", locale))

    /** Inbox times: the clock today, then Yesterday, a weekday for this week, then a date. */
    fun short(ms: Long): String {
        val days = daysAgo(ms)
        val date = at(ms)
        return when {
            days <= 0 -> clock(ms)
            days == 1L -> "Yesterday"
            days < 7 -> date.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)
            date.year == at(nowMs).year -> date.format(DateTimeFormatter.ofPattern("d MMM", locale))
            else -> date.format(DateTimeFormatter.ofPattern("d MMM yyyy", locale))
        }
    }

    /** Day separators in a thread, and the start of a chat's history. */
    fun day(ms: Long): String {
        val days = daysAgo(ms)
        val date = at(ms)
        return when {
            days <= 0 -> "Today"
            days == 1L -> "Yesterday"
            else -> longDate(ms).takeIf { date.year != at(nowMs).year }
                ?: date.format(DateTimeFormatter.ofPattern("EEEE d MMMM", locale))
        }
    }

    fun longDate(ms: Long): String = at(ms).let { date ->
        date.format(DateTimeFormatter.ofPattern(if (date.year == at(nowMs).year) "EEEE d MMMM" else "EEEE d MMMM yyyy", locale))
    }

    /** "Today, 07:44" for the mail view. */
    fun dayAndClock(ms: Long): String {
        val days = daysAgo(ms)
        val day = when {
            days <= 0 -> "Today"
            days == 1L -> "Yesterday"
            else -> at(ms).format(DateTimeFormatter.ofPattern("EEE d MMM", locale))
        }
        return "$day, ${clock(ms)}"
    }

    fun sameDay(a: Long, b: Long): Boolean = at(a).toLocalDate() == at(b).toLocalDate()
}

val LocalTalkClock = staticCompositionLocalOf { TalkClock(System.currentTimeMillis()) }

/** Every user-facing sentence the product screens build from hub states. */
internal object Copy {
    fun media(kind: MediaKind): String = when (kind) {
        MediaKind.IMAGE -> "Photo"
        MediaKind.VIDEO -> "Video"
        MediaKind.VOICE -> "Voice message"
        MediaKind.AUDIO -> "Audio"
        MediaKind.DOCUMENT -> "Document"
        MediaKind.LOCATION -> "Location"
        MediaKind.CONTACT -> "Contact"
        MediaKind.POLL -> "Poll"
        MediaKind.GIF -> "GIF"
        MediaKind.STICKER -> "Sticker"
        MediaKind.OTHER -> "Attachment"
    }

    /** The preview line of a chat row, without the media icon. */
    fun preview(chat: InboxItem.Chat): String {
        val body = chat.lastText?.takeIf { it.isNotBlank() } ?: chat.lastMedia?.let(::media) ?: ""
        return when {
            chat.lastOutgoing -> "You: $body"
            chat.isGroup && chat.lastSender != null -> "${chat.lastSender}: $body"
            else -> body
        }
    }

    fun mailSender(sender: String?, hidden: Boolean): String = if (hidden || sender == null) "Sender hidden" else sender

    fun mailAccount(label: String?): String? = label?.let { "To $it" }

    fun threadSubtitle(source: Source, isGroup: Boolean, muted: Boolean): String {
        val kind = if (isGroup) "${source.label} group" else source.label
        return if (muted) "$kind, muted" else kind
    }

    fun openIn(source: Source) = "Open in ${source.label}"

    fun viewIn(source: Source) = "View it in ${source.label}"

    const val loadingEarlier = "Loading earlier messages"

    fun earlierTitle(source: Source) = "Earlier messages are in ${source.label}"

    fun earlierBody(firstDay: String?) = if (firstDay == null) {
        "Kainos Talk shows what has arrived since it started listening."
    } else {
        "Kainos Talk shows what has arrived here since $firstDay."
    }

    fun replyPlaceholder(source: Source) = "Reply through ${source.label}"

    fun sendLabel(source: Source) = "Send through ${source.label}"

    fun notSent(source: Source, reason: ReplyFailure?): String = when (reason) {
        ReplyFailure.NOTIFICATION_GONE ->
            "Not sent. ${source.label}'s notification was cleared before this reply could go through it."
        ReplyFailure.NO_REPLY_ACTION -> "Not sent. ${source.label}'s notification has no reply button."
        ReplyFailure.NOT_SUPPORTED -> "Not sent. ${source.label} doesn't take replies from notifications."
        ReplyFailure.CANCELLED -> "Not sent. ${source.label} refused the reply."
        ReplyFailure.EMPTY_TEXT, null -> "Not sent."
    }

    /** Why the board offers "Open in …" instead of a reply field. */
    fun replyBlocked(source: Source, reason: ReplyFailure?): String = when (reason) {
        ReplyFailure.NOTIFICATION_GONE ->
            "${source.label}'s notification for this chat is gone, so a reply has to go through ${source.label}."
        ReplyFailure.NO_REPLY_ACTION -> "${source.label} didn't put a reply button on this notification."
        ReplyFailure.NOT_SUPPORTED -> "${source.label} can't be answered from Kainos Talk."
        ReplyFailure.CANCELLED -> "${source.label} refused the last reply."
        ReplyFailure.EMPTY_TEXT, null -> "Replies go through ${source.label}."
    }

    fun status(source: Source, outgoingStatus: MessageStatus): String? = when (outgoingStatus) {
        MessageStatus.INCOMING -> null
        MessageStatus.SENDING -> "Sending"
        MessageStatus.SENT -> "Sent"
        MessageStatus.CONFIRMED -> "Shown in ${source.label}"
        MessageStatus.FAILED -> "Not sent"
    }

    fun mailAction(action: MailAction): String = when (action) {
        MailAction.ARCHIVE -> "Archive"
        MailAction.TRASH -> "Trash"
        MailAction.MARK_READ -> "Mark read"
    }

    fun mailRequested(action: MailAction, source: Source): String = when (action) {
        MailAction.ARCHIVE -> "Archive requested. ${source.label} doesn't confirm it."
        MailAction.TRASH -> "Move to trash requested. ${source.label} doesn't confirm it."
        MailAction.MARK_READ -> "Mark read requested. ${source.label} doesn't confirm it."
    }

    fun actionFailed(result: ActionResult.Failed, source: Source): String = when (result.reason) {
        ActionFailure.NOTIFICATION_GONE -> "The notification is gone. Open ${source.label} to do this there."
        ActionFailure.NOT_AVAILABLE -> "${source.label}'s notification doesn't offer this."
        ActionFailure.CANCELLED -> "${source.label} refused. Open it to do this there."
    }

    fun opened(result: OpenResult, source: Source): String? = when (result) {
        OpenResult.OPENED_NOTIFICATION -> null
        OpenResult.OPENED_APP -> "Opened ${source.label}. Its notification is gone, so it may not land on this item."
        OpenResult.NOT_AVAILABLE -> "${source.label} isn't installed."
    }

    fun unread(count: Int): String = if (count == 1) "1 unread" else "$count unread"

    const val SENDER_HIDDEN_NOTE =
        "Proton Mail hid the sender. To see who mail is from, turn on Extended notifications in Proton Mail's settings."

    fun mailNoBody(source: Source) =
        "${source.label}'s notification carries only the sender and subject. The mail itself is in ${source.label}."
}

/** The initials an avatar shows: the first letters of the first two words, as on the desktop rail. */
internal fun initials(name: String): String {
    val words = name.trim().split(Regex("\\s+")).mapNotNull { w -> w.firstOrNull { it.isLetterOrDigit() } }
    return words.take(2).joinToString("").uppercase().ifEmpty { "?" }
}
