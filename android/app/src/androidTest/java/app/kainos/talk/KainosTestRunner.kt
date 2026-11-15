package app.kainos.talk

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import app.kainos.talk.core.adapters.smsPackages

/** Starts the app with [TestTalkApp], which also reads the fake sender as an SMS app. */
class KainosTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader?, className: String?, context: Context?): Application =
        super.newApplication(cl, TestTalkApp::class.java.name, context)
}

class TestTalkApp : KainosTalkApp() {
    override fun watchedPackages(): Set<String> = smsPackages() + FAKE_PACKAGE

    companion object {
        /** The test APK itself posts as the fake SMS app. */
        const val FAKE_PACKAGE = "app.kainos.talk.test"
    }
}
