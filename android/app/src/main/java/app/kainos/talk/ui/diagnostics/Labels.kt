package app.kainos.talk.ui.diagnostics

import android.text.format.DateUtils
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MediaKind
import app.kainos.talk.core.RemovalReason
import app.kainos.talk.hub.ActionFailure
import app.kainos.talk.hub.ActionResult
import app.kainos.talk.hub.OpenResult
import app.kainos.talk.hub.ReplyFailure
import app.kainos.talk.store.MessageStatus
import java.text.DateFormat
import java.util.Date

/** Plain-language strings for hub states, shared by the diagnostics screens. */
internal object Labels {
    fun time(ms: Long?): String = if (ms == null || ms <= 0) {
        "never"
    } else {
        DateUtils.getRelativeTimeSpanString(ms, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
    }

    fun exactTime(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM).format(Date(ms))

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

    /** What the message shows: its text, or the media type when the text is empty. */
    fun messageText(text: String?, media: MediaKind?): String = when {
        !text.isNullOrBlank() -> text
        media != null -> "${media(media)} (open the app to see it)"
        else -> ""
    }

    fun status(status: MessageStatus): String? = when (status) {
        MessageStatus.INCOMING -> null
        MessageStatus.SENDING -> "Sending"
        MessageStatus.SENT -> "Sent, not yet shown by the app"
        MessageStatus.CONFIRMED -> "Shown by the app"
        MessageStatus.FAILED -> "Not sent"
    }

    fun replyBlocked(reason: ReplyFailure): String = when (reason) {
        ReplyFailure.NOTIFICATION_GONE ->
            "The app's notification for this chat is gone, so a reply can't be sent from here. Open the app to reply."
        ReplyFailure.NO_REPLY_ACTION -> "This notification has no reply button. Open the app to reply."
        ReplyFailure.NOT_SUPPORTED -> "This app doesn't accept replies from notifications."
        ReplyFailure.CANCELLED -> "The app refused the reply. Open the app to reply."
        ReplyFailure.EMPTY_TEXT -> "Type a message first."
    }

    fun removal(reason: Int): String = when (reason) {
        RemovalReason.CLICK -> "Notification opened from the shade"
        RemovalReason.CANCEL -> "Notification dismissed"
        RemovalReason.CANCEL_ALL -> "Notification cleared with all others"
        RemovalReason.APP_CANCEL -> "Notification removed by the app, often because it was read there"
        RemovalReason.LISTENER_CANCEL -> "Notification removed by Kainos Talk"
        RemovalReason.GROUP_SUMMARY_CANCELED -> "Notification group cleared"
        else -> "Notification removed (reason $reason)"
    }

    fun action(result: ActionResult): String = when (result) {
        ActionResult.Requested -> "Requested. The app doesn't report back, so check it there if it matters."
        is ActionResult.Failed -> when (result.reason) {
            ActionFailure.NOTIFICATION_GONE -> "The notification is gone. Open the app instead."
            ActionFailure.NOT_AVAILABLE -> "The notification doesn't offer this action."
            ActionFailure.CANCELLED -> "The app refused the action. Open the app instead."
        }
    }

    fun open(result: OpenResult, appLabel: String): String? = when (result) {
        OpenResult.OPENED_NOTIFICATION -> null
        OpenResult.OPENED_APP -> "Opened $appLabel. The notification is gone, so it may not land on this item."
        OpenResult.NOT_AVAILABLE -> "$appLabel isn't installed."
    }

    fun mailAction(action: MailAction): String = when (action) {
        MailAction.ARCHIVE -> "Archive"
        MailAction.TRASH -> "Trash"
        MailAction.MARK_READ -> "Mark read"
    }

    fun requested(action: MailAction): String = when (action) {
        MailAction.ARCHIVE -> "Archive requested"
        MailAction.TRASH -> "Move to trash requested"
        MailAction.MARK_READ -> "Mark read requested"
    }
}
