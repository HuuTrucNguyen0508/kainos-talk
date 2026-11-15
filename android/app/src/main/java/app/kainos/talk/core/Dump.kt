package app.kainos.talk.core

/** Detailed extras are copied only while a diagnostics dump is being viewed. */
object DumpCapture {
    private val viewers = java.util.concurrent.atomic.AtomicInteger()
    val enabled: Boolean get() = viewers.get() > 0
    fun open() { viewers.incrementAndGet() }
    fun close() { viewers.decrementAndGet() }
}

/** One extras key, its runtime type, and its value. */
data class ExtraEntry(val key: String, val type: String, val value: ExtraValue)

sealed interface ExtraValue {
    /** Message text, names, subjects: hidden unless the user reveals them. */
    data class Content(val raw: String) : ExtraValue

    /** An identifier (shortcut id, tag, group): hidden as a shape that keeps separators and suffixes. */
    data class Identifier(val raw: String) : ExtraValue

    /** Numbers, booleans, class names and other values that carry no message content. */
    data class Plain(val shown: String) : ExtraValue

    /** A Bundle (one item) or an array of Bundles or Persons (several items). */
    data class Nested(val items: List<List<ExtraEntry>>) : ExtraValue

    data object Null : ExtraValue
}

/** One notification as the dump screen shows it. Held in memory only, never stored. */
data class DumpRecord(
    val seq: Long,
    val snapshot: NotificationSnapshot,
    /** What the adapter did with it, for example "chat", "mail" or "ignored: group summary". */
    val outcome: String,
    val removedReason: Int? = null,
)

object Redaction {
    private val SUFFIX = Regex("(@[A-Za-z0-9.\\-]+)$")

    /** "4915551234@s.whatsapp.net" becomes "#########@s.whatsapp.net"; letters become "x". */
    fun identifierShape(raw: String): String {
        val suffix = SUFFIX.find(raw)?.value.orEmpty()
        val body = raw.removeSuffix(suffix).map { c ->
            when {
                c.isDigit() -> '#'
                c.isLetter() -> 'x'
                else -> c
            }
        }.joinToString("")
        return body + suffix
    }

    fun content(raw: String): String = "<${raw.length} chars>"

    fun show(value: String?, reveal: Boolean): String = when {
        value == null -> "null"
        reveal -> value
        else -> content(value)
    }

    fun showId(value: String?, reveal: Boolean): String = when {
        value == null -> "null"
        reveal -> value
        else -> identifierShape(value)
    }
}

/** Turns dump records into readable lines and into the redacted export file. */
object DumpFormat {

    fun fields(record: DumpRecord, reveal: Boolean): List<Pair<String, String>> {
        val s = record.snapshot
        return listOf(
            "package" to s.packageName,
            "outcome" to record.outcome,
            "removed reason" to (record.removedReason?.toString() ?: "still posted"),
            "key" to keyShape(s, reveal),
            "user" to s.userId.toString(),
            "id" to s.id.toString(),
            "tag" to Redaction.showId(s.tag, reveal),
            "channel id" to (s.channelId ?: "null"),
            "category" to (s.category ?: "null"),
            "template" to (s.template ?: "null"),
            "flags" to flagsText(s.flags),
            "group key" to Redaction.showId(s.groupKey, reveal),
            "group" to Redaction.showId(s.group, reveal),
            "sort key" to Redaction.showId(s.sortKey, reveal),
            "shortcut id" to Redaction.showId(s.shortcutId, reveal),
            "post time" to s.postTimeMs.toString(),
            "when" to s.whenMs.toString(),
            "content intent" to if (s.hasContentIntent) "present" else "absent",
            "messages" to s.messages.size.toString(),
        )
    }

    fun actionLines(record: DumpRecord): List<String> {
        val s = record.snapshot
        return (s.actions + s.wearableActions).map { a ->
            val inputs = if (a.remoteInputs.isEmpty()) {
                "no RemoteInput"
            } else {
                a.remoteInputs.joinToString { "resultKey=${it.resultKey} allowFreeFormInput=${it.allowFreeFormInput} choices=${it.choiceCount}" }
            }
            val where = if (a.fromWearable) "wearable" else "action"
            "$where[${a.index}] title=\"${a.title}\" semantic=${a.semanticAction} showsUI=${a.showsUserInterface} $inputs"
        }
    }

    fun extraLines(entries: List<ExtraEntry>, reveal: Boolean, indent: String = ""): List<String> =
        entries.flatMap { entry ->
            when (val v = entry.value) {
                is ExtraValue.Nested -> listOf("$indent${entry.key}: ${entry.type} (${v.items.size} item(s))") +
                    v.items.flatMapIndexed { i, item ->
                        listOf("$indent  [$i]") + extraLines(item, reveal, "$indent    ")
                    }
                else -> listOf("$indent${entry.key}: ${entry.type} = ${valueText(v, reveal)}")
            }
        }

    /** The export is always redacted: it is meant to be shared. */
    fun exportJson(records: List<DumpRecord>): String = buildString {
        append("[\n")
        records.forEachIndexed { i, record ->
            append("  {\n")
            fields(record, reveal = false).forEach { (k, v) -> append("    ${q(k)}: ${q(v)},\n") }
            append("    \"actions\": [")
            append(actionLines(record).joinToString(", ") { q(it) })
            append("],\n")
            append("    \"extras\": [")
            append(extraLines(record.snapshot.extras, reveal = false).joinToString(", ") { q(it) })
            append("]\n")
            append(if (i == records.lastIndex) "  }\n" else "  },\n")
        }
        append("]\n")
    }

    private fun valueText(v: ExtraValue, reveal: Boolean): String = when (v) {
        is ExtraValue.Content -> Redaction.show(v.raw, reveal)
        is ExtraValue.Identifier -> Redaction.showId(v.raw, reveal)
        is ExtraValue.Plain -> v.shown
        is ExtraValue.Nested -> "${v.items.size} item(s)"
        ExtraValue.Null -> "null"
    }

    /** The system key is user|package|id|tag|uid; only the tag can carry a chat identifier. */
    private fun keyShape(s: NotificationSnapshot, reveal: Boolean): String {
        if (reveal) return s.key
        val parts = s.key.split("|")
        return if (parts.size >= 5) {
            (parts.take(3) + Redaction.showId(parts[3], false) + parts.drop(4)).joinToString("|")
        } else {
            Redaction.identifierShape(s.key)
        }
    }

    private fun flagsText(flags: Int): String {
        val names = buildList {
            if (flags and NotificationFlags.ONGOING_EVENT != 0) add("ONGOING_EVENT")
            if (flags and NotificationFlags.FOREGROUND_SERVICE != 0) add("FOREGROUND_SERVICE")
            if (flags and NotificationFlags.LOCAL_ONLY != 0) add("LOCAL_ONLY")
            if (flags and NotificationFlags.GROUP_SUMMARY != 0) add("GROUP_SUMMARY")
        }
        return "0x${flags.toString(16)}" + if (names.isEmpty()) "" else " (${names.joinToString()})"
    }

    private fun q(value: String): String = buildString {
        append('"')
        value.forEach { c ->
            when {
                c == '"' -> append("\\\"")
                c == '\\' -> append("\\\\")
                c == '\n' -> append("\\n")
                c == '\r' -> append("\\r")
                c == '\t' -> append("\\t")
                c < ' ' -> append("\\u%04x".format(c.code))
                else -> append(c)
            }
        }
        append('"')
    }
}
