package app.kainos.talk.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.kainos.talk.talkGraph
import app.kainos.talk.ui.talk.TalkApp
import app.kainos.talk.ui.theme.KainosTheme

/** Hosts the Pocket Switchboard UI. Diagnostics is reachable from the inbox menu. */
class MainActivity : ComponentActivity() {
    private val hub by lazy { talkGraph().hub }
    private val sync by lazy { talkGraph().sync }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            KainosTheme {
                TalkApp(hub, sync = sync)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // The user may have just granted or revoked access in system settings.
        hub.refreshAccess()
        talkGraph().ensureListenerBound()
        // A sync that stopped (the PC refused this phone) gets another go when the app is opened.
        talkGraph().sync.start()
    }
}
