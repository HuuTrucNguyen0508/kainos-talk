package app.kainos.talk.core.adapters

import app.kainos.talk.core.ActionRef
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MailActionRef
import app.kainos.talk.core.MailUpdate
import app.kainos.talk.core.NotificationSnapshot
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.Shape
import app.kainos.talk.core.SnapshotAction
import app.kainos.talk.core.Source
import app.kainos.talk.core.SourceAdapter
import app.kainos.talk.core.cleanText
import app.kainos.talk.core.commonIgnoreReason
import app.kainos.talk.core.stableKey

/**
 * Reads Proton Mail (`ch.protonmail.android`) new-mail notifications, read from the open-source
 * app: title is the sender, text is the subject, subText is the account address, the group is
 * the Proton user id, the id is a hash of the message id, and there are three broadcast actions
 * (Archive, Trash, Mark read). There is no body preview and no reply action.
 */
class ProtonMailAdapter(private val source: Source = Source.PROTON_MAIL) : SourceAdapter {

    override fun parse(snapshot: NotificationSnapshot): ParseResult {
        commonIgnoreReason(snapshot)?.let { return ParseResult.Ignored(it) }
        val channel = snapshot.channelId
        if (channel in IGNORED_CHANNELS) return ParseResult.Ignored("channel $channel")

        val title = cleanText(snapshot.title)
        val subject = cleanText(snapshot.text) ?: cleanText(snapshot.bigText)
        if (title == null && subject == null) return ParseResult.Ignored("no content")

        val recognised = channel == EMAIL_CHANNEL
        val senderHidden = title == null || title in HIDDEN_SENDER_TITLES
        val accountKey = snapshot.group ?: cleanText(snapshot.subText) ?: "default"
        val actions = if (recognised) resolveActions(snapshot.actions) else emptyList()
        return ParseResult.Mail(
            MailUpdate(
                mailKey = stableKey(source.id, snapshot.userId, accountKey, snapshot.id),
                source = source,
                accountKey = accountKey,
                accountLabel = cleanText(snapshot.subText),
                sender = if (senderHidden) null else title,
                senderHidden = senderHidden,
                subject = subject.orEmpty(),
                receivedAtMs = snapshot.postTimeMs,
                actions = actions,
                shape = if (recognised && actions.size == 3) Shape.EXPECTED else Shape.FALLBACK,
            ),
        )
    }

    companion object {
        const val EMAIL_CHANNEL = "v7_email_channel_id"
        val IGNORED_CHANNELS = setOf("v7_login_channel_id", "v7_content_search_channel_id", "v7_sending_channel_id")

        /** Title Proton uses when "Extended notifications" is off (English build only so far). */
        val HIDDEN_SENDER_TITLES = setOf("New message")

        private val ENGLISH_TITLES = mapOf(
            "archive" to MailAction.ARCHIVE,
            "trash" to MailAction.TRASH,
            "mark read" to MailAction.MARK_READ,
            "mark as read" to MailAction.MARK_READ,
        )
        private val ORDER = listOf(MailAction.ARCHIVE, MailAction.TRASH, MailAction.MARK_READ)

        /**
         * Exactly three input-free actions are expected. English titles map by name; a fully
         * non-English set maps by Proton's fixed order (Archive, Trash, Mark read) and the UI
         * shows Proton's own titles. Anything else gets no actions rather than a guess.
         */
        fun resolveActions(actions: List<SnapshotAction>): List<MailActionRef> {
            if (actions.size != 3 || actions.any { it.remoteInputs.isNotEmpty() }) return emptyList()
            val byTitle = actions.map { ENGLISH_TITLES[it.title?.trim()?.lowercase()] }
            val refs = { kinds: List<MailAction> ->
                actions.zip(kinds) { action, kind -> MailActionRef(kind, ActionRef(action.index, false, action.title)) }
            }
            return when {
                byTitle.all { it != null } && byTitle.toSet().size == 3 -> refs(byTitle.filterNotNull())
                byTitle.all { it == null } -> refs(ORDER)
                else -> emptyList()
            }
        }
    }
}
