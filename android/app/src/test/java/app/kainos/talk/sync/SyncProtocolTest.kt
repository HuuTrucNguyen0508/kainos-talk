package app.kainos.talk.sync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SyncProtocolTest {
    /** The vectors the desktop's tests check too. Unit tests run from android/app. */
    private val vectors = JSONObject(File("../../protocol/sms-sync-vectors.json").readText())

    @Test
    fun pairingCodesMatchTheDesktop() {
        val pairing = vectors.getJSONArray("pairing")
        for (i in 0 until pairing.length()) {
            val v = pairing.getJSONObject(i)
            assertEquals(
                v.getString("code"),
                SyncProtocol.pairingCode(v.getString("pcFingerprint"), v.getString("phoneFingerprint"), v.getString("phoneNonce"), v.getString("pcNonce")),
            )
        }
    }

    @Test
    fun frameHashesMatchTheDesktop() {
        val hashes = vectors.getJSONArray("frameHash")
        for (i in 0 until hashes.length()) {
            val v = hashes.getJSONObject(i)
            assertEquals(v.getString("frame"), v.getString("hash"), SyncProtocol.frameHash(v.getString("frame")))
        }
    }

    @Test
    fun senderKindMatchesTheVectors() {
        val cases = vectors.getJSONArray("senderKind")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val v = cases.getJSONObject(i)
            val address = v.getString("address")
            assertEquals(
                "\"$address\" contact=${v.getBoolean("isContact")} group=${v.getBoolean("isGroup")}",
                v.getString("sender"),
                senderKind(address, v.getBoolean("isContact"), v.getBoolean("isGroup")).wire,
            )
        }
    }

    @Test
    fun aWelcomeCarriesWhatThePcHolds() {
        assertEquals(PcFrame.Welcome("PC"), SyncProtocol.parse("""{"t":"welcome","name":"PC"}"""))
        assertEquals(
            PcFrame.Welcome("PC", mapOf("sms|0|s:mum" to "b6dd71f0d853d309", "sms|0|s:read" to "")),
            SyncProtocol.parse("""{"t":"welcome","name":"PC","conversations":{"sms|0|s:mum":"b6dd71f0d853d309","sms|0|s:read":"","bad":5},"mails":{"protonmail|0|h":"e3b0c44298fc1c14"}}"""),
        )
    }

    @Test
    fun onlyLocalAddressesAreLocal() {
        val addresses = vectors.getJSONObject("addresses")
        val local = addresses.getJSONArray("local")
        for (i in 0 until local.length()) assertTrue(local.getString(i), SyncProtocol.isLocalAddress(local.getString(i)))
        val remote = addresses.getJSONArray("remote")
        for (i in 0 until remote.length()) assertEquals(remote.getString(i), false, SyncProtocol.isLocalAddress(remote.getString(i)))
        assertEquals(false, SyncProtocol.isLocalAddress("192.168.01.1"))
        assertEquals(false, SyncProtocol.isLocalAddress("192.168.1.300"))
    }

    @Test
    fun pcFramesAreCheckedBeforeUse() {
        assertEquals(PcFrame.Reply("r1", "sms|0|s:mum", "On my way"), SyncProtocol.parse("""{"t":"reply","id":"r1","key":"sms|0|s:mum","text":"On my way"}"""))
        assertEquals(PcFrame.Paired("d"), SyncProtocol.parse("""{"t":"paired","deviceId":"d"}"""))
        assertEquals(PcFrame.Ping, SyncProtocol.parse("""{"t":"ping"}"""))
        assertNull("the phone no longer carries mail", SyncProtocol.parse("""{"t":"mailAction","id":"m1","key":"protonmail|0|h","action":"archive"}"""))
        assertNull(SyncProtocol.parse("""{"t":"reply","id":"r1","key":"k"}"""))
        assertNull(SyncProtocol.parse("""{"t":"reply","id":5,"key":"k","text":"x"}"""))
        assertNull(SyncProtocol.parse("not json"))
        assertNull(SyncProtocol.parse("""{"t":"format-disk"}"""))
    }

    @Test
    fun conversationFramesCarryWhatTheDesktopChecks() {
        val frame = JSONObject(
            SyncProtocol.conversation(
                SyncConversation(
                    key = "sms|0|s:mum",
                    title = "Mum",
                    isGroup = false,
                    unread = 1,
                    lastActivityMs = 5,
                    canReply = true,
                    messages = (1..250).map { SyncMessage("$it", if (it % 2 == 0) null else "Mum", "text $it", it.toLong(), it % 2 == 0, "incoming", null) },
                ),
            ),
        )
        assertEquals("conversation", frame.getString("t"))
        val conversation = frame.getJSONObject("conversation")
        assertEquals("sms" to "SMS", conversation.getString("source") to conversation.getString("sourceLabel"))
        assertEquals("a conversation nobody classified is a person", "person", conversation.getString("sender"))
        val messages = conversation.getJSONArray("messages")
        assertEquals(SyncProtocol.MAX_MESSAGES, messages.length())
        assertEquals("250", messages.getJSONObject(messages.length() - 1).getString("id"))
        assertTrue(messages.getJSONObject(0).isNull("media"))
        assertEquals("""{"t":"replyResult","id":"r","ok":false,"error":"notification gone"}""", SyncProtocol.replyResult("r", "notification gone"))
    }

    @Test
    fun everyConversationFrameSaysWhoItComesFrom() {
        fun line(sender: SenderKind) = SyncProtocol.conversation(
            SyncConversation("sms|t:1", "36679", isGroup = false, unread = 0, lastActivityMs = 1, canReply = true, messages = emptyList(), sender = sender),
        )
        assertTrue(line(SenderKind.SERVICE), line(SenderKind.SERVICE).contains(""""sender":"service""""))
        assertEquals("service", JSONObject(line(SenderKind.SERVICE)).getJSONObject("conversation").getString("sender"))
        assertTrue(line(SenderKind.PERSON), line(SenderKind.PERSON).contains(""""sender":"person""""))
        assertEquals("person", JSONObject(line(SenderKind.PERSON)).getJSONObject("conversation").getString("sender"))
    }
}
