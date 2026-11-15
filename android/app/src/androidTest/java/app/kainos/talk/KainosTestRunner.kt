package app.kainos.talk

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import app.kainos.talk.core.Source
import app.kainos.talk.core.SourceKind
import app.kainos.talk.core.WatchedApp
import app.kainos.talk.core.adapters.MessagingStyleAdapter
import app.kainos.talk.core.adapters.defaultWatchedApps

/** Starts the hub with [TestTalkApp], which also watches the fake sender. */
class KainosTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader?, className: String?, context: Context?): Application =
        super.newApplication(cl, TestTalkApp::class.java.name, context)
}

class TestTalkApp : KainosTalkApp() {
    override fun watchedApps(): List<WatchedApp> =
        defaultWatchedApps() + WatchedApp(FAKE_PACKAGE, FAKE_SOURCE, MessagingStyleAdapter(FAKE_SOURCE))

    companion object {
        /** The test APK itself posts as the fake chat app. */
        const val FAKE_PACKAGE = "app.kainos.talk.test"
        val FAKE_SOURCE = Source("fake", "Fake sender", SourceKind.CHAT, canReply = true, hasMailActions = false)
    }
}
