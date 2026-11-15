package app.kainos.talk.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import app.kainos.talk.ui.theme.DarkSwitchboard
import app.kainos.talk.ui.theme.LightSwitchboard
import app.kainos.talk.ui.theme.SwitchboardColors
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WCAG 2.x contrast for every foreground/background pair the screens draw, computed from the
 * theme's own colour values. Writes the table to build/reports/contrast.md.
 */
class ContrastTest {
    private data class Pair(val use: String, val fg: (SwitchboardColors) -> Color, val bg: (SwitchboardColors) -> Color, val min: Double)

    private val text = 4.5
    private val ui = 3.0

    private val pairs = listOf(
        Pair("ink on surface: names, subjects, headings", { it.ink }, { it.surface }, text),
        Pair("ink on raised: incoming bubbles, hidden-sender card", { it.ink }, { it.raised }, text),
        Pair("ink on board: origin card title", { it.ink }, { it.board }, text),
        Pair("onOut on out: your bubbles, time and ticks", { it.onOut }, { it.out }, text),
        Pair("soft on surface: previews, times, captions", { it.soft }, { it.surface }, text),
        Pair("soft on raised: bubble time, media caption", { it.soft }, { it.raised }, text),
        Pair("soft on board: socket names, board hints, origin text", { it.soft }, { it.board }, text),
        Pair("teal on surface: links, active socket name, mail actions", { it.teal }, { it.surface }, text),
        Pair("teal on raised: sender names in bubbles", { it.teal }, { it.raised }, text),
        Pair("teal on board: initials, links on the origin card", { it.teal }, { it.board }, text),
        Pair("alert on surface: Not sent", { it.alert }, { it.surface }, text),
        Pair("lampInk on lamp: unread count", { it.lampInk }, { it.lamp }, text),
        Pair("onLine on wa: W jack and tile", { it.onLine }, { it.wa }, text),
        Pair("onLine on dc: D jack and tile", { it.onLine }, { it.dc }, text),
        Pair("onLine on pm: M jack and tile", { it.onLine }, { it.pm }, text),
        Pair("onLine on fm: F jack and tile", { it.onLine }, { it.fm }, text),
        Pair("onLine on sms: S jack and tile", { it.onLine }, { it.sms }, text),
        Pair("onTeal on teal: big button, send icon, app mark", { it.onTeal }, { it.teal }, text),
        Pair("surface on ink: snackbar (inverse surface)", { it.surface }, { it.ink }, text),
        Pair("lampEdge on surface: lamp bezel", { it.lampEdge }, { it.surface }, ui),
        Pair("lampEdge on board: lamp bezel on a socket", { it.lampEdge }, { it.board }, ui),
        Pair("outline on surface: muted lamp ring, action button border", { it.outline }, { it.surface }, ui),
        Pair("outline on board: reply field border", { it.outline }, { it.board }, ui),
        Pair("outline on raised: dashed media placeholder", { it.outline }, { it.raised }, ui),
        Pair("alert on surface: failed bubble border", { it.alert }, { it.surface }, ui),
        Pair("teal on board: send button, big button", { it.teal }, { it.board }, ui),
        Pair("wa on surface: jack", { it.wa }, { it.surface }, ui),
        Pair("wa on board: tile", { it.wa }, { it.board }, ui),
        Pair("dc on surface: jack", { it.dc }, { it.surface }, ui),
        Pair("dc on board: tile", { it.dc }, { it.board }, ui),
        Pair("pm on surface: jack", { it.pm }, { it.surface }, ui),
        Pair("pm on board: tile", { it.pm }, { it.board }, ui),
        Pair("fm on surface: jack", { it.fm }, { it.surface }, ui),
        Pair("fm on board: tile", { it.fm }, { it.board }, ui),
        Pair("sms on surface: jack", { it.sms }, { it.surface }, ui),
        Pair("sms on board: tile", { it.sms }, { it.board }, ui),
        Pair("teal on surface: active socket indicator", { it.teal }, { it.surface }, ui),
        Pair("ink on surface: icons", { it.ink }, { it.surface }, ui),
    )

    private fun ratio(a: Color, b: Color): Double {
        val (hi, lo) = listOf(a.luminance().toDouble(), b.luminance().toDouble()).sortedDescending()
        return (hi + 0.05) / (lo + 0.05)
    }

    private fun hex(c: Color) = "#%06X".format(c.value.toLong().ushr(32).toInt() and 0xFFFFFF)

    @Test
    fun everyPairMeetsWcagAa() {
        val rows = mutableListOf("| Pair | Min | Light | Dark |", "|---|---|---|---|")
        val failures = mutableListOf<String>()
        for (p in pairs) {
            val cells = listOf(LightSwitchboard, DarkSwitchboard).map { theme ->
                val r = ratio(p.fg(theme), p.bg(theme))
                if (r < p.min) failures += "${p.use} (${hex(p.fg(theme))} on ${hex(p.bg(theme))}): %.2f".format(r)
                "%.2f:1 (%s on %s)".format(r, hex(p.fg(theme)), hex(p.bg(theme)))
            }
            rows += "| ${p.use} | ${p.min}:1 | ${cells[0]} | ${cells[1]} |"
        }
        File("build/reports").mkdirs()
        File("build/reports/contrast.md").writeText(rows.joinToString("\n") + "\n")
        assertTrue("Below WCAG AA:\n" + failures.joinToString("\n"), failures.isEmpty())
    }
}
