package app.kainos.talk.ui

import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MediaKind
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.hub.AvailableMailAction
import app.kainos.talk.hub.ChatCapabilities
import app.kainos.talk.hub.ChatThread
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.MailItem
import app.kainos.talk.hub.ReplyFailure
import app.kainos.talk.hub.ThreadMessage
import app.kainos.talk.store.MessageStatus
import app.kainos.talk.ui.talk.TalkClock
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.Locale

/**
 * The people, chats and mail from `design/pocket-switchboard/index.html`, as the hub would
 * report them. "Now" is Thursday 12 November 2026, 08:12, as in the mockup's status bar.
 */
object MockupData {
    private val zone = ZoneOffset.UTC
    val NOW: Long = at(12, 8, 12)
    val clock = TalkClock(NOW, zone, is24Hour = true, locale = Locale.UK)

    const val ALLOTMENT = "whatsapp|0|s:allotment@g.us"
    const val PAVLO = "discord|0|s:pavlo"
    const val TIDEWATER = "discord|0|s:tidewater"
    const val INES = "whatsapp|0|s:ines@lid"
    const val DAD = "whatsapp|0|s:dad@lid"
    const val LOW_TIDE = "discord|0|s:lowtide"
    const val YUSUF = "whatsapp|0|s:yusuf@lid"
    const val MIRA = "messenger|0|s:mira"
    const val GARAGE = "sms|0|s:garage"
    const val HALDEN = "protonmail|0|halden"
    const val NORTHLINE = "protonmail|0|northline"
    const val HIDDEN = "protonmail|0|hidden"

    fun at(day: Int, hour: Int, minute: Int): Long =
        ZonedDateTime.of(2026, 11, day, hour, minute, 0, 0, zone).toInstant().toEpochMilli()

    private fun chat(
        key: String,
        source: Source,
        title: String,
        time: Long,
        unread: Int = 0,
        group: Boolean = false,
        muted: Boolean = false,
        text: String? = null,
        sender: String? = null,
        outgoing: Boolean = false,
        media: MediaKind? = null,
    ) = InboxItem.Chat(key, source, title, group, time, unread, muted, text, sender, outgoing, media, notificationLive = true)

    private val protonActions = listOf(
        AvailableMailAction(MailAction.ARCHIVE, "Archive"),
        AvailableMailAction(MailAction.TRASH, "Trash"),
        AvailableMailAction(MailAction.MARK_READ, "Mark read"),
    )

    private fun mail(
        key: String,
        sender: String?,
        subject: String,
        time: Long,
        read: Boolean,
        actions: List<AvailableMailAction> = protonActions,
    ) = MailItem(
        key = key,
        source = Source.PROTON_MAIL,
        accountKey = "acct",
        accountLabel = "robin@proton.me",
        sender = sender,
        senderHidden = sender == null,
        subject = subject,
        receivedAtMs = time,
        read = read,
        requestedAction = null,
        notificationLive = actions.isNotEmpty(),
        actions = actions,
        shape = Shape.EXPECTED,
    )

    private fun incoming(id: Long, sender: String?, text: String, time: Long, media: MediaKind? = null) =
        ThreadMessage(id, sender, text, time, outgoing = false, status = MessageStatus.INCOMING, media = media, read = true)

    private fun outgoing(id: Long, text: String, time: Long, status: MessageStatus) =
        ThreadMessage(id, null, text, time, outgoing = true, status = status, media = null, read = true)

    private val canReply = ChatCapabilities(canReply = true, replyBlocked = null, canMarkReadInApp = true)

    val allotment = ChatThread(
        key = ALLOTMENT,
        source = Source.WHATSAPP,
        title = "Allotment crew",
        isGroup = true,
        muted = false,
        shape = Shape.MESSAGING_STYLE,
        messages = listOf(
            incoming(1, "Mirela Antić", "Frost took the last of the courgettes. Beds 3 and 4 need clearing before the weekend.", at(12, 7, 58)),
            incoming(2, "Mirela Antić", "", at(12, 7, 58), MediaKind.IMAGE),
            incoming(3, "Tomasz Wrona", "I can bring the wheelbarrow Saturday", at(12, 8, 2)),
            outgoing(4, "I'm in for Saturday. What time?", at(12, 8, 4), MessageStatus.CONFIRMED),
            incoming(5, "Odile Marchetti", "10 works for me. Who has the shed key?", at(12, 8, 7)),
        ),
        capabilities = canReply,
        notificationRemovedReason = null,
    )

    val pavlo = ChatThread(
        key = PAVLO,
        source = Source.DISCORD,
        title = "pavlo.k",
        isGroup = false,
        muted = false,
        shape = Shape.FALLBACK,
        messages = listOf(
            incoming(20, "pavlo.k", "morning! are you around later?", at(11, 21, 40)),
            incoming(21, "pavlo.k", "did the tile loader fix make it into main?", at(12, 8, 1)),
        ),
        capabilities = ChatCapabilities(canReply = false, replyBlocked = ReplyFailure.NO_REPLY_ACTION, canMarkReadInApp = false),
        notificationRemovedReason = null,
    )

    val halden = mail(HALDEN, "Halden Housing Co-op", "Minutes from Tuesday's meeting", at(12, 7, 44), read = false)
    val northline = mail(NORTHLINE, "Northline Rail", "Your ticket for 14 November", at(11, 18, 20), read = true)
    val hidden = mail(HIDDEN, null, "New message", at(12, 6, 30), read = false, actions = emptyList())

    /** The inbox exactly as the mockup lists it. */
    fun hub(): FakeTalkHub = FakeTalkHub(now = { NOW }).apply {
        chats.value = listOf(
            chat(ALLOTMENT, Source.WHATSAPP, "Allotment crew", at(12, 8, 7), 3, group = true, text = "10 works for me. Who has the shed key?", sender = "Odile"),
            chat(PAVLO, Source.DISCORD, "pavlo.k", at(12, 8, 1), 2, text = "did the tile loader fix make it into main?", sender = "pavlo.k"),
            chat(TIDEWATER, Source.DISCORD, "Tidewater Makers #print-queue", at(12, 7, 30), 12, group = true, muted = true, text = "the 0.4 nozzle is free again if anyone needs it", sender = "ossian"),
            chat(MIRA, Source.MESSENGER, "Mira Okafor", at(12, 7, 45), 1, text = "Still up for climbing on Saturday?", sender = "Mira Okafor"),
            chat(INES, Source.WHATSAPP, "Ines Castell", at(12, 7, 12), 1, media = MediaKind.VOICE),
            chat(GARAGE, Source.SMS, "Garage Delaunay", at(11, 16, 40), text = "Your car is ready. We close at 18:30.", sender = "Garage Delaunay"),
            chat(DAD, Source.WHATSAPP, "Dad", at(11, 19, 5), text = "See you Sunday then", outgoing = true),
            chat(LOW_TIDE, Source.DISCORD, "Low Tide Radio #gig-chat", at(10, 22, 15), group = true, text = "doors at 7, we're on at 8:40", sender = "marisol"),
            chat(YUSUF, Source.WHATSAPP, "Yusuf Adeyemi", at(9, 12, 0), media = MediaKind.STICKER),
        )
        threads.value = mapOf(ALLOTMENT to allotment, PAVLO to pavlo)
        mails.value = mapOf(HALDEN to halden, NORTHLINE to northline)
    }
}
