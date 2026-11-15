package app.kainos.talk.core.adapters

import app.kainos.talk.core.ActionRef
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MailActionRef
import app.kainos.talk.core.MailUpdate
import app.kainos.talk.core.NotificationFlags
import app.kainos.talk.core.ParseResult
import app.kainos.talk.core.Shape
import app.kainos.talk.core.SnapshotAction
import app.kainos.talk.core.Source
import app.kainos.talk.core.plainAction
import app.kainos.talk.core.snapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class ProtonMailAdapterTest {
    private val adapter = ProtonMailAdapter()

    private val englishActions = listOf(plainAction(0, "Archive"), plainAction(1, "Trash"), plainAction(2, "Mark read"))

    private fun mail(
        title: String? = "Alice Example",
        channelId: String? = "v7_email_channel_id",
        actions: List<SnapshotAction> = englishActions,
        flags: Int = 0,
    ) = snapshot(
        packageName = "ch.protonmail.android",
        id = 482_118_337,
        postTimeMs = 1_700_000_123_000,
        channelId = channelId,
        flags = flags,
        group = "dXNlcklk",
        title = title,
        text = "Quarterly report",
        subText = "me@proton.me",
        actions = actions,
    )

    private fun parsedMail(s: app.kainos.talk.core.NotificationSnapshot): MailUpdate {
        val result = adapter.parse(s)
        check(result is ParseResult.Mail) { "expected mail, got $result" }
        return result.update
    }

    @Test
    fun newMailHasSenderSubjectAccountAndThreeActions() {
        assertEquals(
            MailUpdate(
                mailKey = "protonmail|0|dXNlcklk|482118337",
                source = Source.PROTON_MAIL,
                accountKey = "dXNlcklk",
                accountLabel = "me@proton.me",
                sender = "Alice Example",
                senderHidden = false,
                subject = "Quarterly report",
                receivedAtMs = 1_700_000_123_000,
                actions = listOf(
                    MailActionRef(MailAction.ARCHIVE, ActionRef(0, false, "Archive")),
                    MailActionRef(MailAction.TRASH, ActionRef(1, false, "Trash")),
                    MailActionRef(MailAction.MARK_READ, ActionRef(2, false, "Mark read")),
                ),
                shape = Shape.EXPECTED,
            ),
            parsedMail(mail()),
        )
    }

    @Test
    fun hiddenSenderIsReportedNotShownAsAName() {
        val update = parsedMail(mail(title = "New message"))
        assertEquals(null, update.sender)
        assertEquals(true, update.senderHidden)
        assertEquals("Quarterly report", update.subject)
    }

    @Test
    fun summaryAndNonMailChannelsAreSkipped() {
        assertEquals(ParseResult.Ignored("group summary"), adapter.parse(mail(flags = NotificationFlags.GROUP_SUMMARY)))
        assertEquals(
            ParseResult.Ignored("channel v7_login_channel_id"),
            adapter.parse(mail(channelId = "v7_login_channel_id")),
        )
        assertEquals(
            ParseResult.Ignored("ongoing"),
            adapter.parse(mail(channelId = "v7_content_search_channel_id", flags = NotificationFlags.ONGOING_EVENT)),
        )
    }

    @Test
    fun nonEnglishTitlesMapByProtonsFixedOrderAndKeepTheirOwnTitles() {
        val german = listOf(plainAction(0, "Archivieren"), plainAction(1, "Papierkorb"), plainAction(2, "Als gelesen markieren"))
        assertEquals(
            listOf(
                MailActionRef(MailAction.ARCHIVE, ActionRef(0, false, "Archivieren")),
                MailActionRef(MailAction.TRASH, ActionRef(1, false, "Papierkorb")),
                MailActionRef(MailAction.MARK_READ, ActionRef(2, false, "Als gelesen markieren")),
            ),
            parsedMail(mail(actions = german)).actions,
        )
    }

    @Test
    fun unexpectedActionShapeOffersOnlyOpen() {
        val two = parsedMail(mail(actions = englishActions.take(2)))
        assertEquals(emptyList<MailActionRef>(), two.actions)
        assertEquals(Shape.FALLBACK, two.shape)

        val mixed = parsedMail(mail(actions = listOf(plainAction(0, "Archive"), plainAction(1, "Delete"), plainAction(2, "Mark read"))))
        assertEquals(emptyList<MailActionRef>(), mixed.actions)
    }

    @Test
    fun unknownChannelIsKeptAsAFallbackMailWithoutActions() {
        val update = parsedMail(mail(channelId = "email_channel_v6"))
        assertEquals(Shape.FALLBACK, update.shape)
        assertEquals(emptyList<MailActionRef>(), update.actions)
        assertEquals("Alice Example", update.sender)
    }
}
