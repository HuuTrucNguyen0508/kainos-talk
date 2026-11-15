package app.kainos.talk.listener

import android.app.Notification
import android.app.Person
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import app.kainos.talk.core.ExtraEntry
import app.kainos.talk.core.ExtraValue
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.SnapshotAction
import app.kainos.talk.core.SnapshotMessage
import app.kainos.talk.core.SnapshotRemoteInput

/**
 * Copies what the hub needs out of a [StatusBarNotification]. Every read is defensive: posting
 * apps can leave extras missing, put nulls in arrays, or use unexpected types.
 */
object SnapshotReader {

    fun read(sbn: StatusBarNotification, captureExtras: Boolean = app.kainos.talk.core.DumpCapture.enabled): NotificationSnapshot {
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
            extras = if (captureExtras) runCatching { describe(extras, depth = 0) }.getOrDefault(emptyList()) else emptyList(),
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

    /** String values under these keys are structure, not content. */
    private val PLAIN_STRING_KEYS = setOf(
        Notification.EXTRA_TEMPLATE, "android.substName", "type", "android.reduced.images",
    )

    /** String values under these keys are identifiers: shown as a shape until revealed. */
    private val IDENTIFIER_KEYS = setOf("key", "uri", "android.shortcutId", "android.locusId")

    private const val MAX_DEPTH = 3

    @Suppress("DEPRECATION")
    private fun describe(bundle: Bundle, depth: Int): List<ExtraEntry> =
        bundle.keySet().sorted().map { key ->
            val value = runCatching { bundle.get(key) }.getOrNull()
            ExtraEntry(key, typeName(value), valueOf(key, value, depth))
        }

    private fun valueOf(key: String, value: Any?, depth: Int): ExtraValue = when (value) {
        null -> ExtraValue.Null
        is Boolean, is Number -> ExtraValue.Plain(value.toString())
        is CharSequence -> when (key) {
            in PLAIN_STRING_KEYS -> ExtraValue.Plain(value.toString())
            in IDENTIFIER_KEYS -> ExtraValue.Identifier(value.toString())
            else -> ExtraValue.Content(value.toString())
        }
        is Uri -> ExtraValue.Identifier(value.toString())
        is Bundle -> if (depth >= MAX_DEPTH) ExtraValue.Plain("Bundle") else ExtraValue.Nested(listOf(describe(value, depth + 1)))
        is Person -> ExtraValue.Nested(listOf(describePerson(value)))
        is Icon -> ExtraValue.Plain("Icon(type=${value.type})")
        is Bitmap -> ExtraValue.Plain("Bitmap(${value.width}x${value.height})")
        is Array<*> -> nested(key, value.toList(), depth)
        is List<*> -> nested(key, value, depth)
        is BooleanArray, is IntArray, is LongArray -> ExtraValue.Plain(typeName(value))
        else -> ExtraValue.Plain(value.javaClass.name)
    }

    private fun nested(key: String, items: List<*>, depth: Int): ExtraValue {
        if (depth >= MAX_DEPTH) return ExtraValue.Plain("${items.size} item(s)")
        return ExtraValue.Nested(
            items.map { item ->
                when (item) {
                    is Bundle -> describe(item, depth + 1)
                    is Person -> describePerson(item)
                    else -> listOf(ExtraEntry("value", typeName(item), valueOf(key, item, depth + 1)))
                }
            },
        )
    }

    private fun describePerson(p: Person): List<ExtraEntry> = listOf(
        ExtraEntry("name", "CharSequence", p.name?.let { ExtraValue.Content(it.toString()) } ?: ExtraValue.Null),
        ExtraEntry("key", "String", p.key?.let { ExtraValue.Identifier(it) } ?: ExtraValue.Null),
        ExtraEntry("uri", "String", p.uri?.let { ExtraValue.Identifier(it) } ?: ExtraValue.Null),
        ExtraEntry("isBot", "Boolean", ExtraValue.Plain(p.isBot.toString())),
        ExtraEntry("isImportant", "Boolean", ExtraValue.Plain(p.isImportant.toString())),
        ExtraEntry("icon", "Icon", ExtraValue.Plain(p.icon?.let { "Icon(type=${it.type})" } ?: "null")),
    )

    private fun typeName(value: Any?): String = when (value) {
        null -> "null"
        is Array<*> -> "${value.javaClass.componentType?.simpleName ?: "Object"}[]"
        else -> value.javaClass.simpleName.ifEmpty { value.javaClass.name }
    }
}
