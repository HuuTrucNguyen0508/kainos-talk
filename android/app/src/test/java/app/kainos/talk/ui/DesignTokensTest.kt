package app.kainos.talk.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The product screens take every size and colour from the theme (ui/theme). A raw `12.dp`,
 * `14.sp` or `Color(0x…)` in a screen file fails here; add a named token to the theme instead.
 */
class DesignTokensTest {
    private val screens = File("src/main/java/app/kainos/talk/ui/talk")
    private val raw = Regex("""\b\d+(\.\d+)?\.(dp|sp)\b|Color\(0x""")

    // Vector icons declare their 24-unit viewport in dp; that is the drawing grid, not layout.
    private val allowed = Regex("""ImageVector\.Builder\(.*24\.dp, 24\.dp""")

    @Test
    fun screensUseOnlyThemeTokens() {
        val files = screens.listFiles { f -> f.extension == "kt" }.orEmpty()
        assertTrue("no screen files found in ${screens.absolutePath}", files.isNotEmpty())
        val offences = files.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                if (raw.containsMatchIn(line) && !allowed.containsMatchIn(line)) "${file.name}:${i + 1}: ${line.trim()}" else null
            }
        }
        assertTrue("Raw values outside the theme:\n" + offences.joinToString("\n"), offences.isEmpty())
    }
}
