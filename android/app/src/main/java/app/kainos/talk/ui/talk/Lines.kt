package app.kainos.talk.ui.talk

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import app.kainos.talk.core.Source
import app.kainos.talk.core.SourceKind
import app.kainos.talk.ui.theme.SwitchboardShapes
import app.kainos.talk.ui.theme.switchboard

/**
 * A line on the board: the family of apps one socket filters to. WhatsApp and WhatsApp Business
 * are separate sources (accounts) but share the WhatsApp line. [OTHER] covers any source the
 * board has no socket for; it still shows under All. Messenger takes "F" (Facebook Messenger)
 * because Mail already has "M".
 */
enum class Line(val socketLabel: String, val letter: String) {
    WHATSAPP("WhatsApp", "W"),
    DISCORD("Discord", "D"),
    MESSENGER("Messenger", "F"),
    SMS("SMS", "S"),
    MAIL("Mail", "M"),
    OTHER("Other", "?"),
    ;

    companion object {
        val sockets = listOf(WHATSAPP, DISCORD, MESSENGER, SMS, MAIL)

        fun of(source: Source): Line = when {
            source.id.startsWith("whatsapp") -> WHATSAPP
            source.id == Source.DISCORD.id -> DISCORD
            source.id == Source.MESSENGER.id -> MESSENGER
            source.id == Source.SMS.id -> SMS
            source.kind == SourceKind.MAIL -> MAIL
            else -> OTHER
        }
    }
}

internal val Line.color: Color
    @Composable @ReadOnlyComposable get() = when (this) {
        Line.WHATSAPP -> MaterialTheme.switchboard.wa
        Line.DISCORD -> MaterialTheme.switchboard.dc
        Line.MESSENGER -> MaterialTheme.switchboard.fm
        Line.SMS -> MaterialTheme.switchboard.sms
        Line.MAIL -> MaterialTheme.switchboard.pm
        Line.OTHER -> MaterialTheme.switchboard.teal
    }

internal fun Line.jackShape(inline: Boolean): Shape = when (this) {
    Line.WHATSAPP -> SwitchboardShapes.jackWhatsApp
    Line.DISCORD, Line.OTHER -> if (inline) SwitchboardShapes.jackDiscordInline else SwitchboardShapes.jackDiscord
    Line.MESSENGER -> SwitchboardShapes.jackMessenger
    Line.SMS -> if (inline) SwitchboardShapes.jackSmsInline else SwitchboardShapes.jackSms
    Line.MAIL -> if (inline) SwitchboardShapes.jackMailInline else SwitchboardShapes.jackMail
}

/** The letter a jack shows: the line's, or the first letter of an unknown source's name. */
internal fun jackLetter(source: Source): String = Line.of(source).let { line ->
    if (line == Line.OTHER) source.label.take(1).uppercase() else line.letter
}
