package app.kainos.talk.store

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.MailAction
import app.kainos.talk.core.MailUpdate
import app.kainos.talk.core.ParsedMessage
import app.kainos.talk.core.RemovalReason
import app.kainos.talk.core.Shape
import app.kainos.talk.core.Source
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MessageStoreTest {
    private lateinit var db: TalkDatabase
    private lateinit var store: MessageStore
    private val dao get() = db.dao()

    private val key = "whatsapp|0|s:123456789012345@lid"
    private val one = ParsedMessage("Alice", "key:Alice", "one", 1_000, outgoing = false)
    private val two = ParsedMessage("Alice", "key:Alice", "two", 2_000, outgoing = false)
    private val mine = ParsedMessage(null, null, "mine", 1_500, outgoing = true)

    private fun update(vararg messages: ParsedMessage) = ChatUpdate(
        conversationKey = key,
        source = Source.WHATSAPP,
        title = "Alice",
        isGroup = false,
        messages = messages.toList(),
        replyAction = null,
        markReadAction = null,
        shape = Shape.MESSAGING_STYLE,
    )

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), TalkDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        store = MessageStore(db)
    }

    @After
    fun close() = db.close()

    @Test
    fun theSyncReadsOnlyTheNewestMessagesOldestFirst() = runTest {
        store.applyChat(update(one, mine, two))
        assertEquals(listOf("mine", "two"), dao.observeLatestMessages(key, 2).first().map { it.text })
        assertEquals(listOf("one", "mine", "two"), dao.observeMessages(key).first().map { it.text })
    }

    @Test
    fun identicalRepostsDoNotWriteOrNotifyObservers() = runBlocking {
        val chat = update(one)
        val mail = MailUpdate("mail", Source.PROTON_MAIL, "account", "label", "Alice", false,
            "subject", 5000, emptyList(), Shape.EXPECTED)
        store.applyChat(chat)
        store.applyMail(mail)
        val sql = db.openHelper.writableDatabase
        sql.execSQL("CREATE TABLE write_audit (kind TEXT)")
        sql.execSQL("CREATE TRIGGER chat_write AFTER UPDATE ON conversations BEGIN INSERT INTO write_audit VALUES ('chat'); END")
        sql.execSQL("CREATE TRIGGER mail_write AFTER UPDATE ON mail BEGIN INSERT INTO write_audit VALUES ('mail'); END")
        val chatEvents = Channel<ConversationEntity?>(Channel.UNLIMITED)
        val mailEvents = Channel<MailEntity?>(Channel.UNLIMITED)
        val jobs = listOf(
            launch { dao.observeConversation(key).collect { chatEvents.send(it) } },
            launch { dao.observeMailItem("mail").collect { mailEvents.send(it) } },
        )
        try {
            withTimeout(5000) { chatEvents.receive(); mailEvents.receive() }
            store.applyChat(chat)
            store.applyMail(mail)
            sql.query("SELECT COUNT(*) FROM write_audit").use { it.moveToFirst(); assertEquals(0, it.getInt(0)) }
            assertEquals(null, withTimeoutOrNull(300) { chatEvents.receive() })
            assertEquals(null, withTimeoutOrNull(300) { mailEvents.receive() })
        } finally { jobs.forEach { it.cancelAndJoin() } }
    }

    @Test
    fun applyingTheSameSnapshotTwiceChangesNothing() = runTest {
        assertEquals(MessageStore.ChatApplied(inserted = 1, confirmedReplies = 0), store.applyChat(update(one)))
        assertEquals(MessageStore.ChatApplied(inserted = 0, confirmedReplies = 0), store.applyChat(update(one)))
        assertEquals(MessageStore.ChatApplied(inserted = 1, confirmedReplies = 0), store.applyChat(update(one, two)))
        assertEquals(listOf("one", "two"), dao.messages(key).map { it.text })
    }

    @Test
    fun messagesStayAfterTheNotificationIsRemoved() = runTest {
        store.applyChat(update(one, two))
        store.conversationRemoved(key, RemovalReason.APP_CANCEL)

        assertEquals(listOf("one", "two"), dao.messages(key).map { it.text })
        assertEquals(RemovalReason.APP_CANCEL, dao.conversation(key)?.lastRemovalReason)

        // The app posts again later with only the new unread message; history is kept.
        val three = ParsedMessage("Alice", "key:Alice", "three", 3_000, outgoing = false)
        store.applyChat(update(three))
        assertEquals(listOf("one", "two", "three"), dao.messages(key).map { it.text })
        assertEquals(null, dao.conversation(key)?.lastRemovalReason)
    }

    @Test
    fun unreadCountsIncomingMessagesOnlyUntilMarkedRead() = runTest {
        store.applyChat(update(one, mine, two))
        val row = dao.observeConversationRows().first().single()
        assertEquals(2, row.unreadCount)
        assertEquals("two", row.lastText)
        assertEquals(2_000L, row.conversation.lastActivityMs)

        store.markConversationRead(key)
        assertEquals(0, dao.observeConversationRows().first().single().unreadCount)

        store.applyChat(update(one, mine, two))
        assertEquals(0, dao.observeConversationRows().first().single().unreadCount)
    }

    @Test
    fun hubReplyIsConfirmedByTheAppsEchoInsteadOfDuplicated() = runTest {
        store.applyChat(update(one))
        val localId = store.addLocalReply(key, "pong", nowMs = 10_000)
        store.finishReply(localId, sent = true)
        assertEquals(MessageStatus.SENT, dao.messages(key).last().status)

        val echo = ParsedMessage(null, null, "pong", 10_400, outgoing = true)
        assertEquals(MessageStore.ChatApplied(inserted = 0, confirmedReplies = 1), store.applyChat(update(one, echo)))
        assertEquals(MessageStore.ChatApplied(inserted = 0, confirmedReplies = 0), store.applyChat(update(one, echo)))

        val messages = dao.messages(key)
        assertEquals(listOf("one", "pong"), messages.map { it.text })
        assertEquals(MessageStatus.CONFIRMED, messages.last().status)
    }

    @Test
    fun confirmationIsNotUndoneByALateSendResult() = runTest {
        val localId = store.addLocalReply(key, "pong", nowMs = 10_000)
        store.applyChat(update(ParsedMessage(null, null, "pong", 10_100, outgoing = true)))
        store.finishReply(localId, sent = true)
        assertEquals(MessageStatus.CONFIRMED, dao.messages(key).single().status)
    }

    @Test
    fun mailRepostKeepsReadStateAndRequestedAction() = runTest {
        val mail = MailUpdate(
            mailKey = "protonmail|0|dXNlcklk|482118337",
            source = Source.PROTON_MAIL,
            accountKey = "dXNlcklk",
            accountLabel = "me@proton.me",
            sender = "Alice Example",
            senderHidden = false,
            subject = "Quarterly report",
            receivedAtMs = 5_000,
            actions = emptyList(),
            shape = Shape.EXPECTED,
        )
        assertEquals(true, store.applyMail(mail))
        store.setMailRequestedAction(mail.mailKey, MailAction.ARCHIVE)
        store.markMailRead(mail.mailKey)
        assertEquals(false, store.applyMail(mail.copy(receivedAtMs = 6_000)))

        val stored = dao.mail(mail.mailKey)!!
        assertEquals(true, stored.read)
        assertEquals(MailAction.ARCHIVE, stored.requestedAction)
        assertEquals(5_000L, stored.receivedAtMs)
        assertEquals(1, dao.observeMail().first().size)
    }
}
