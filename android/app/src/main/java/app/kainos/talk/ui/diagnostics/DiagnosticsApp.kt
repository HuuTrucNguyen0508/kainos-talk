package app.kainos.talk.ui.diagnostics

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MailOutline
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.kainos.talk.hub.TalkHub

private enum class Tab(val label: String, val icon: ImageVector) {
    ACCESS("Access", Icons.Outlined.Lock),
    INBOX("Inbox", Icons.Outlined.MailOutline),
    DUMP("Dump", Icons.AutoMirrored.Outlined.List),
}

private enum class DetailKind { THREAD, MAIL }

/** Three tabs (access, inbox, dump) and two detail screens (thread, mail). No navigation library. */
@Composable
fun DiagnosticsApp(hub: TalkHub) {
    val access by hub.access.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(if (access.listenerGranted) Tab.INBOX else Tab.ACCESS) }
    var detailKind by rememberSaveable { mutableStateOf<DetailKind?>(null) }
    var detailKey by rememberSaveable { mutableStateOf<String?>(null) }
    val closeDetail = {
        detailKind = null
        detailKey = null
    }

    val key = detailKey
    when {
        detailKind == DetailKind.THREAD && key != null -> {
            BackHandler(onBack = closeDetail)
            ThreadScreen(hub, key, onBack = closeDetail)
        }
        detailKind == DetailKind.MAIL && key != null -> {
            BackHandler(onBack = closeDetail)
            MailScreen(hub, key, onBack = closeDetail)
        }
        else -> {
            val bottomBar: @Composable () -> Unit = {
                NavigationBar {
                    Tab.entries.forEach { t ->
                        NavigationBarItem(
                            selected = t == tab,
                            onClick = { tab = t },
                            icon = { Icon(t.icon, contentDescription = null) },
                            label = { Text(t.label) },
                        )
                    }
                }
            }
            when (tab) {
                Tab.ACCESS -> AccessScreen(hub, bottomBar)
                Tab.INBOX -> InboxScreen(
                    hub = hub,
                    bottomBar = bottomBar,
                    onOpenChat = {
                        detailKind = DetailKind.THREAD
                        detailKey = it
                    },
                    onOpenMail = {
                        detailKind = DetailKind.MAIL
                        detailKey = it
                    },
                )
                Tab.DUMP -> DumpScreen(hub, bottomBar)
            }
        }
    }
}

/** The shared frame: a pinned top app bar, optional back arrow, actions and a snackbar host. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ScreenFrame(
    title: String,
    snackbar: SnackbarHostState = remember { SnackbarHostState() },
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = actions,
                scrollBehavior = scroll,
            )
        },
        bottomBar = bottomBar,
        snackbarHost = { SnackbarHost(snackbar) },
        content = content,
    )
}
