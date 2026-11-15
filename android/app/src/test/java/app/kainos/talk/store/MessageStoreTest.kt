package app.kainos.talk.store

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.kainos.talk.core.ChatUpdate
import app.kainos.talk.core.ParsedMessage
import app.kainos.talk.core.Shape
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

    private val key = "sms|0|s:conversation_7"
    private val one = ParsedMessage("Alice", "key:Alice", "one", 1_000, outgoing = false)
    private val two = ParsedMessage("Alice", "key:Alice", "two", 2_000, outgoing = false)
    private val mine = ParsedMessage(null, null, "mine", 1_500, outgoing = true)

    private fun update(vararg messages: ParsedMessage) = ChatUpdate(
        conversationKey = key,
        title = "Alice",
        isGroup = false,
        messages = messages.toList(),
        replyAction = null,
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
        store.applyChat(chat)
        val sql = db.openHelper.writableDatabase
        sql.execSQL("CREATE TABLE write_audit (kind TEXT)")
        sql.execSQL("CREATE TRIGGER chat_write AFTER UPDATE ON conversations BEGIN INSERT INTO write_audit VALUES ('chat'); END")
        val chatEvents = Channel<ConversationEntity?>(Channel.UNLIMITED)
        val job = launch { dao.observeConversation(key).collect { chatEvents.send(it) } }
        try {
            withTimeout(5000) { chatEvents.receive() }
            store.applyChat(chat)
            sql.query("SELECT COUNT(*) FROM write_audit").use { it.moveToFirst(); assertEquals(0, it.getInt(0)) }
            assertEquals(null, withTimeoutOrNull(300) { chatEvents.receive() })
        } finally { job.cancelAndJoin() }
    }

    @Test
    fun applyingTheSameSnapshotTwiceChangesNothing() = runTest {
        assertEquals(MessageStore.ChatApplied(inserted = 1, confirmedReplies = 0), store.applyChat(update(one)))
        assertEquals(MessageStore.ChatApplied(inserted = 0, confirmedReplies = 0), store.applyChat(update(one)))
        assertEquals(MessageStore.ChatApplied(inserted = 1, confirmedReplies = 0), store.applyChat(update(one, two)))
        assertEquals(listOf("one", "two"), dao.messages(key).map { it.text })
    }

    @Test
    fun aLaterPostWithOnlyTheNewMessageKeepsTheHistory() = runTest {
        store.applyChat(update(one, two))
        val three = ParsedMessage("Alice", "key:Alice", "three", 3_000, outgoing = false)
        store.applyChat(update(three))
        assertEquals(listOf("one", "two", "three"), dao.messages(key).map { it.text })
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
}
