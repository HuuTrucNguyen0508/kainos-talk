package app.kainos.talk

import android.app.Application
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.service.notification.NotificationListenerService
import android.provider.Telephony
import app.kainos.talk.core.adapters.smsPackages
import app.kainos.talk.hub.DefaultTalkHub
import app.kainos.talk.hub.TalkHub
import app.kainos.talk.listener.ConnectionTracker
import app.kainos.talk.listener.KainosNotificationListener
import app.kainos.talk.listener.LiveNotifications
import app.kainos.talk.listener.NotificationImages
import app.kainos.talk.listener.NotificationIngest
import app.kainos.talk.store.MessageStore
import app.kainos.talk.store.TalkDatabase
import app.kainos.talk.hub.SmsAwareHub
import app.kainos.talk.sync.DeviceIdentity
import app.kainos.talk.sync.KeystoreIdentity
import app.kainos.talk.sync.PhoneCalls
import app.kainos.talk.sync.SmsInbox
import app.kainos.talk.sync.SyncClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

open class KainosTalkApp : Application() {
    val graph: AppGraph by lazy { AppGraph(this, watchedPackages(), deviceIdentity()) }

    /** The SMS apps whose notifications are read. The instrumented test adds its fake sender. */
    protected open fun watchedPackages(): Set<String> = smsPackages(Telephony.Sms.getDefaultSmsPackage(this))

    /** This phone's TLS certificate; Robolectric tests provide one without AndroidKeyStore. */
    protected open fun deviceIdentity(): DeviceIdentity = KeystoreIdentity()
}

/** Wires the hub together by hand; there are few enough parts that a DI framework would cost more. */
class AppGraph(context: Context, watched: Set<String>, identity: DeviceIdentity = KeystoreIdentity()) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** One sequential writer keeps database changes in callback order. */
    private val writer = Dispatchers.IO.limitedParallelism(1)

    val database: TalkDatabase = TalkDatabase.open(appContext)
    val store = MessageStore(database)
    val live = LiveNotifications()
    val connection = ConnectionTracker()

    /** Pictures from text notifications (RCS), copied while the SMS app still lets them be read. */
    val images = NotificationImages(appContext)

    val ingest = NotificationIngest(appContext.packageName, watched, store, live, connection, scope, writer, images)

    /** Android's SMS inbox, when the user allowed it: history, and sending without a notification. */
    val sms = SmsInbox(appContext, scope)

    val hub: TalkHub = SmsAwareHub(DefaultTalkHub(appContext, database.dao(), store, live, connection, writer, images), sms, scope)

    /**
     * Asks Android to bind the notification listener when access is granted but it is not
     * running. Reinstalling or updating the app kills it without the disconnect callback that
     * would ask for this, and some phones (HyperOS) then leave it unbound until access is
     * toggled by hand.
     */
    fun ensureListenerBound() {
        val component = ComponentName(appContext, KainosNotificationListener::class.java)
        val granted = appContext.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(component)
        if (granted && !connection.connected.value) NotificationListenerService.requestRebind(component)
    }

    /** The phone's calls, for the PC: what rings, and its buttons. */
    val calls = PhoneCalls(appContext, sms, scope)

    /** SMS sync with the paired PC; it runs whenever the app's process does. */
    val sync = SyncClient(appContext, hub, sms, scope, identity = identity, pictures = { id -> images.load(id) ?: sms.image(id) }, calls = calls).also { it.start() }
}

fun Context.talkGraph(): AppGraph = (applicationContext as KainosTalkApp).graph
