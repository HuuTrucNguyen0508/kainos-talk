package app.kainos.talk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DumpFormatTest {
    private val record = DumpRecord(
        seq = 0,
        snapshot = snapshot(
            tag = "4915551234@s.whatsapp.net",
            channelId = "individual_chat_defaults_5",
            shortcutId = "4915551234@s.whatsapp.net",
            template = MESSAGING_STYLE,
            title = "Alice Example",
            text = "secret words",
            actions = listOf(replyAction),
            extras = listOf(
                ExtraEntry("android.text", "String", ExtraValue.Content("secret words")),
                ExtraEntry("android.template", "String", ExtraValue.Plain(MESSAGING_STYLE)),
                ExtraEntry(
                    "android.messages",
                    "Parcelable[]",
                    ExtraValue.Nested(
                        listOf(
                            listOf(
                                ExtraEntry("text", "String", ExtraValue.Content("secret words")),
                                ExtraEntry("time", "Long", ExtraValue.Plain("1700000000000")),
                            ),
                        ),
                    ),
                ),
            ),
        ),
        outcome = "chat (messaging_style, 1 message(s))",
    )

    @Test
    fun identifierShapeKeepsSeparatorsAndSuffix() {
        assertEquals("##########@s.whatsapp.net", Redaction.identifierShape("4915551234@s.whatsapp.net"))
        assertEquals("###############@lid", Redaction.identifierShape("123456789012345@lid"))
        assertEquals("xxxx_##", Redaction.identifierShape("chat_42"))
    }

    @Test
    fun exportIsRedactedButKeepsStructure() {
        val json = DumpFormat.exportJson(listOf(record))
        assertFalse(json.contains("secret"))
        assertFalse(json.contains("4915551234"))
        assertFalse(json.contains("Alice"))
        assertTrue(json.contains("\"shortcut id\": \"##########@s.whatsapp.net\""))
        assertTrue(json.contains("\"channel id\": \"individual_chat_defaults_5\""))
        assertTrue(json.contains("android.text: String = <12 chars>"))
        assertTrue(json.contains("android.template: String = $MESSAGING_STYLE"))
        assertTrue(json.contains("resultKey=reply_key allowFreeFormInput=true"))
        assertTrue(json.contains("\"key\": \"0|com.whatsapp|1|##########@s.whatsapp.net|10123\""))
    }

    @Test
    fun revealShowsContentOnScreen() {
        val lines = DumpFormat.extraLines(record.snapshot.extras, reveal = true)
        assertEquals(
            listOf(
                "android.text: String = secret words",
                "android.template: String = $MESSAGING_STYLE",
                "android.messages: Parcelable[] (1 item(s))",
                "  [0]",
                "    text: String = secret words",
                "    time: Long = 1700000000000",
            ),
            lines,
        )
    }
}
