package app.kainos.talk.ui.talk

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.ui.theme.sizes
import app.kainos.talk.ui.theme.spacing
import app.kainos.talk.ui.theme.switchboard

/**
 * First run: what Kainos Talk reads and keeps, then the two Android steps. Sideloaded installs
 * must allow restricted settings before Android lets them have notification access.
 */
@Composable
fun SetupScreen(hub: TalkHub) {
    val context = LocalContext.current
    val access by hub.access.collectAsStateWithLifecycle()
    var step by rememberSaveable { mutableIntStateOf(1) }
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing

    fun launch(vararg intents: Intent) {
        for (intent in intents) {
            try {
                context.startActivity(intent)
                return
            } catch (_: ActivityNotFoundException) {
                // Some phones lack the detail page; try the next one.
            }
        }
    }

    Scaffold(
        containerColor = c.surface,
        bottomBar = {
            BoardPanel {
                Box(Modifier.padding(start = sp.lg, end = sp.lg, top = sp.md + sp.hair, bottom = sp.lg)) {
                    if (step == 1) {
                        BigButton("Open App info", onClick = {
                            launch(access.appInfoSettings)
                            step = 2
                        })
                    } else {
                        BigButton("Open notification access", onClick = {
                            launch(access.listenerDetailSettings, access.listenerListSettings)
                        })
                    }
                }
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .windowInsetsPadding(WindowInsets.statusBars)
                .verticalScroll(rememberScrollState())
                .padding(start = sp.xxl, end = sp.xxl, top = sp.lg + sp.hair, bottom = sp.xxl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(sp.md)) {
                AppMark(MaterialTheme.sizes.appMark, c.teal, c.onTeal)
                Text("Kainos Talk", style = MaterialTheme.typography.titleMedium, color = c.ink)
            }
            Text(
                "One inbox, made from your notifications",
                style = MaterialTheme.typography.displaySmall,
                color = c.ink,
                modifier = Modifier.padding(top = sp.xxl + sp.hair).semantics { heading() },
            )
            Text(
                "Kainos Talk never signs in to your accounts. It reads the notifications your chat, text and mail apps already post on this phone and lists them in one place.",
                style = MaterialTheme.typography.bodyLarge,
                color = c.ink,
                modifier = Modifier.padding(top = sp.md),
            )
            Column(Modifier.padding(top = sp.xl)) {
                Fact("Reads", "Notifications from WhatsApp, Discord, Messenger, your SMS app and Proton Mail: who it's from, the text and the time.")
                Fact("Ignores", "Notifications from every other app.")
                Fact("Keeps", "Everything on this phone. Nothing is uploaded and there is no account.")
            }
            Text(
                "Android needs two things from you",
                style = MaterialTheme.typography.titleLarge,
                color = c.ink,
                modifier = Modifier
                    .padding(top = sp.xl)
                    .fillMaxWidth()
                    .topRule()
                    .padding(top = sp.lg + sp.hair)
                    .semantics { heading() },
            )
            Column(Modifier.padding(top = sp.md)) {
                Step(
                    number = 1,
                    current = step == 1,
                    title = "Allow restricted settings",
                    how = "Android asks this for apps installed outside the Play Store. In App info, tap the three dots, then Allow restricted settings.",
                    last = false,
                ) {
                    if (step == 1) LinkButton("Already allowed? Skip this step", { step = 2 }, icon = null)
                }
                Step(
                    number = 2,
                    current = step == 2 && !access.listenerGranted,
                    title = "Turn on notification access",
                    how = "Switch on Kainos Talk in the list that opens.",
                    last = true,
                )
            }
        }
    }
}

@Composable
private fun Modifier.topRule(): Modifier {
    val edge = MaterialTheme.switchboard.edge
    val line = MaterialTheme.sizes.hairline
    return drawBehind { drawLine(edge, Offset(0f, 0f), Offset(size.width, 0f), line.toPx()) }
}

@Composable
private fun Fact(label: String, text: String) {
    val c = MaterialTheme.switchboard
    val sp = MaterialTheme.spacing
    Row(
        Modifier
            .fillMaxWidth()
            .topRule()
            .padding(vertical = sp.md - sp.hair / 2)
            .semantics(mergeDescendants = true) { },
        horizontalArrangement = Arrangement.spacedBy(sp.md),
    ) {
        Text(label, style = MaterialTheme.typography.titleSmall, color = c.teal, modifier = Modifier.width(MaterialTheme.sizes.factLabel))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = c.ink, modifier = Modifier.weight(1f))
    }
}

/** A numbered step whose lamp lights while it is the one to do. */
@Composable
private fun Step(number: Int, current: Boolean, title: String, how: String, last: Boolean, extra: @Composable () -> Unit = {}) {
    val c = MaterialTheme.switchboard
    val s = MaterialTheme.sizes
    val sp = MaterialTheme.spacing
    Row(
        Modifier
            .fillMaxWidth()
            .drawBehind {
                if (!last) {
                    val x = s.stepRail.toPx() / 2
                    drawLine(c.edge, Offset(x, (s.lamp + sp.xs).toPx()), Offset(x, size.height - sp.hair.toPx()), (s.hairline * 2).toPx())
                }
            }
            .padding(bottom = sp.md + sp.hair),
        horizontalArrangement = Arrangement.spacedBy(sp.md + sp.hair),
    ) {
        Box(Modifier.width(s.stepRail), contentAlignment = Alignment.TopCenter) {
            Lamp(number, lit = current)
        }
        Column(Modifier.weight(1f)) {
            Column(
                Modifier.clearAndSetSemantics {
                    contentDescription = "Step $number${if (current) ", to do now" else ""}: $title. $how"
                },
            ) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = c.ink)
                Text(how, style = MaterialTheme.typography.bodySmall, color = c.soft, modifier = Modifier.padding(top = sp.hair))
            }
            extra()
        }
    }
}
