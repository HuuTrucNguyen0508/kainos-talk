package app.kainos.talk

import android.content.ComponentName
import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import app.kainos.talk.fake.FakeSenderReceiver
import app.kainos.talk.listener.KainosNotificationListener

/** Drives the fake SMS app (the test APK's receiver) and the listener grant from a test. */
class FakeSender(private val app: KainosTalkApp) {
    private val listener = ComponentName(app, KainosNotificationListener::class.java).flattenToString()

    fun grantAccess() {
        shell("pm grant ${TestTalkApp.FAKE_PACKAGE} android.permission.POST_NOTIFICATIONS")
        shell("cmd notification allow_listener $listener")
    }

    fun revokeAccess() = shell("cmd notification disallow_listener $listener")

    /** Posts the whole conversation as (sender, text, time); an empty sender is the user. */
    fun post(vararg messages: Triple<String, String, Long>) = command(FakeSenderReceiver.ACTION_POST) {
        putExtra(FakeSenderReceiver.EXTRA_SENDERS, messages.map { it.first }.toTypedArray())
        putExtra(FakeSenderReceiver.EXTRA_TEXTS, messages.map { it.second }.toTypedArray())
        putExtra(FakeSenderReceiver.EXTRA_TIMES, messages.map { it.third }.toLongArray())
    }

    fun cancel() = command(FakeSenderReceiver.ACTION_CANCEL)

    private fun command(action: String, extras: Intent.() -> Unit = {}) {
        val intent = Intent(action)
            .setComponent(ComponentName(TestTalkApp.FAKE_PACKAGE, FakeSenderReceiver::class.java.name))
            .apply(extras)
        app.sendBroadcast(intent)
    }

    private fun shell(command: String) {
        val output = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes() }
    }
}
