package app.kainos.talk.core

/** Builds snapshots for adapter tests. Defaults describe an empty, non-summary notification. */
fun snapshot(
    packageName: String = "com.whatsapp",
    userId: Int = 0,
    id: Int = 1,
    tag: String? = null,
    postTimeMs: Long = 1_700_000_000_000,
    whenMs: Long = 1_700_000_000_000,
    channelId: String? = null,
    category: String? = null,
    flags: Int = 0,
    group: String? = null,
    shortcutId: String? = null,
    template: String? = null,
    title: String? = null,
    text: String? = null,
    subText: String? = null,
    bigText: String? = null,
    conversationTitle: String? = null,
    isGroupConversation: Boolean = false,
    messages: List<SnapshotMessage> = emptyList(),
    actions: List<SnapshotAction> = emptyList(),
    extras: List<ExtraEntry> = emptyList(),
) = NotificationSnapshot(
    packageName = packageName,
    userId = userId,
    key = "$userId|$packageName|$id|$tag|10123",
    id = id,
    tag = tag,
    postTimeMs = postTimeMs,
    whenMs = whenMs,
    channelId = channelId,
    category = category,
    flags = flags,
    groupKey = "$userId|$packageName|g:$group",
    group = group,
    sortKey = null,
    shortcutId = shortcutId,
    template = template,
    title = title,
    text = text,
    subText = subText,
    bigText = bigText,
    textLines = emptyList(),
    tickerText = null,
    conversationTitle = conversationTitle,
    isGroupConversation = isGroupConversation,
    selfName = "Me",
    messages = messages,
    actions = actions,
    wearableActions = emptyList(),
    hasContentIntent = true,
    extras = extras,
)

const val MESSAGING_STYLE = "android.app.Notification\$MessagingStyle"

fun incoming(text: String?, timeMs: Long, sender: String, mime: String? = null, uri: String? = null) =
    SnapshotMessage(text, timeMs, sender, "key:$sender", isSelf = false, dataMimeType = mime, dataUri = uri)

fun own(text: String, timeMs: Long) = SnapshotMessage(text, timeMs, null, null, isSelf = true)

val replyAction = SnapshotAction(
    index = 0,
    title = "Reply",
    semanticAction = SemanticAction.REPLY,
    showsUserInterface = false,
    remoteInputs = listOf(SnapshotRemoteInput("reply_key", "Reply", allowFreeFormInput = true, choiceCount = 0)),
)

val markReadAction = SnapshotAction(
    index = 1,
    title = "Mark as read",
    semanticAction = SemanticAction.MARK_AS_READ,
    showsUserInterface = false,
    remoteInputs = emptyList(),
)

fun plainAction(index: Int, title: String) = SnapshotAction(index, title, SemanticAction.NONE, false, emptyList())
