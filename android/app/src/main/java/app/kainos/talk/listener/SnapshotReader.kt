package app.kainos.talk.listener

import android.app.Notification
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.SnapshotAction
import app.kainos.talk.core.SnapshotMessage
import app.kainos.talk.core.SnapshotRemoteInput

/**
 * Copies what the hub needs out of a [StatusBarNotification]. Every read is defensive: posting
 * apps can leave extras missing, put nulls in arrays, or use unexpected types.
 */
object SnapshotReader {

    fun read(sbn: StatusBarNotification): NotificationSnapshot {
        val n = sbn.notification
        val extras = n.extras ?: Bundle.EMPTY
        val style = runCatching { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n) }.getOrNull()
        val messages = styleMessages(style).ifEmpty { rawMessages(extras) }
        return NotificationSnapshot(
            packageName = sbn.packageName,
            userId = userIdOf(sbn),
            key = sbn.key,
            id = sbn.id,
            tag = sbn.tag,
            postTimeMs = sbn.postTime,
            whenMs = n.`when`,
            channelId = n.channelId,
            category = n.category,
            flags = n.flags,
            groupKey = sbn.groupKey,
            group = n.group,
            sortKey = n.sortKey,
            shortcutId = n.shortcutId,
            template = extras.getString(Notification.EXTRA_TEMPLATE),
            title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
            text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString(),
            bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
            textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.mapNotNull { it?.toString() }.orEmpty(),
            tickerText = n.tickerText?.toString(),
            conversationTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString(),
            isGroupConversation = extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false),
            selfName = style?.user?.name?.toString()
                ?: extras.getCharSequence(Notification.EXTRA_SELF_DISPLAY_NAME)?.toString(),
            messages = messages,
            actions = n.actions.orEmpty().mapIndexedNotNull { i, a -> a?.let { action(i, it, fromWearable = false) } },
            wearableActions = wearableActions(n).mapIndexed { i, a -> action(i, a, fromWearable = true) },
            hasContentIntent = n.contentIntent != null,
        )
    }

    @Suppress("DEPRECATION")
    private fun userIdOf(sbn: StatusBarNotification): Int = sbn.userId

    @Suppress("DEPRECATION")
    fun wearableActions(n: Notification): List<Notification.Action> =
        runCatching { Notification.WearableExtender(n).actions.orEmpty() }.getOrDefault(emptyList())

    private fun styleMessages(style: NotificationCompat.MessagingStyle?): List<SnapshotMessage> {
        if (style == null) return emptyList()
        val user = style.user
        return style.messages.mapNotNull { m ->
            val person = m.person
            val isSelf = person == null ||
                (person.key != null && person.key == user.key) ||
                (person.key == null && user.key == null && person.name?.toString() == user.name?.toString())
            SnapshotMessage(
                text = m.text?.toString(),
                timeMs = m.timestamp,
                senderName = if (isSelf) null else person?.name?.toString(),
                senderKey = if (isSelf) null else person?.key,
                isSelf = isSelf,
                dataMimeType = m.dataMimeType,
                dataUri = m.dataUri?.toString(),
            )
        }
    }

    /** Reads `android.messages` directly when the template is not MessagingStyle. */
    private fun rawMessages(extras: Bundle): List<SnapshotMessage> {
        val bundles = runCatching {
            extras.getParcelableArray(Notification.EXTRA_MESSAGES, Parcelable::class.java)
        }.getOrNull() ?: return emptyList()
        val parsed = runCatching {
            Notification.MessagingStyle.Message.getMessagesFromBundleArray(bundles)
        }.getOrNull() ?: return emptyList()
        return parsed.map { m ->
            val person = m.senderPerson
            SnapshotMessage(
                text = m.text?.toString(),
                timeMs = m.timestamp,
                senderName = person?.name?.toString(),
                senderKey = person?.key,
                isSelf = person == null,
                dataMimeType = m.dataMimeType,
                dataUri = m.dataUri?.toString(),
            )
        }
    }

    private fun action(index: Int, a: Notification.Action, fromWearable: Boolean) = SnapshotAction(
        index = index,
        title = a.title?.toString(),
        semanticAction = a.semanticAction,
        // Only NotificationCompat records this, in the action extras; it defaults to true there.
        showsUserInterface = a.extras?.getBoolean("android.support.action.showsUserInterface", true) ?: true,
        remoteInputs = a.remoteInputs.orEmpty().mapNotNull { ri ->
            ri?.let {
                SnapshotRemoteInput(
                    resultKey = it.resultKey,
                    label = it.label?.toString(),
                    allowFreeFormInput = it.allowFreeFormInput,
                    choiceCount = it.choices?.size ?: 0,
                )
            }
        },
        fromWearable = fromWearable,
    )
}
