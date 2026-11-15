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
        Pair("ink on surface: headings, body text, computer names", { it.ink }, { it.surface }, text),
        Pair("ink on board: warning titles, computer names", { it.ink }, { it.board }, text),
        Pair("soft on surface: captions, step descriptions", { it.soft }, { it.surface }, text),
        Pair("soft on board: warning text", { it.soft }, { it.board }, text),
        Pair("teal on surface: links, fact labels", { it.teal }, { it.surface }, text),
        Pair("teal on board: links in a warning, Connect", { it.teal }, { it.board }, text),
        Pair("alert on surface: pairing problems, refused", { it.alert }, { it.surface }, text),
        Pair("lampInk on lamp: step number", { it.lampInk }, { it.lamp }, text),
        Pair("soft on surface: unlit step number", { it.soft }, { it.surface }, text),
        Pair("onTeal on teal: big button, app mark", { it.onTeal }, { it.teal }, text),
        Pair("lampEdge on surface: lamp bezel", { it.lampEdge }, { it.surface }, ui),
        Pair("outline on surface: unlit lamp ring, not-connected dot", { it.outline }, { it.surface }, ui),
        Pair("teal on surface: connected dot", { it.teal }, { it.surface }, ui),
        Pair("teal on board: big button on the board", { it.teal }, { it.board }, ui),
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
