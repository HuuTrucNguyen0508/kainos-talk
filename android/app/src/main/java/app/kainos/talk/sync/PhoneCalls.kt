package app.kainos.talk.sync

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.ContactsContract
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import java.util.UUID

/** The phone's calls as the PC sees them, and the actions the PC can take on them. */
interface CallControl {
    /** The call on this phone now; null when there is none or calls are not allowed. */
    val current: StateFlow<LiveCall?>

    /** The newest calls, newest first; empty without call log access. */
    val log: Flow<List<CallEntry>>

    /**
     * Each action returns why it failed, or null once Android took it. [call] and [phase] are what
     * the PC showed: a call that ended or changed meanwhile is left alone.
     */
    fun answer(call: String): String?
    fun hangUp(call: String, phase: CallPhase): String?
    fun dial(number: String): String?

    /** Reads the call log again and watches it anew, after the user allowed it. */
    fun refresh()
}

/** Before calls are wired up (and in tests that are only about texts). */
object NoCalls : CallControl {
    override val current: StateFlow<LiveCall?> = MutableStateFlow(null)
    override val log: Flow<List<CallEntry>> = MutableStateFlow(emptyList())
    override fun answer(call: String) = "calls are not set up"
    override fun hangUp(call: String, phase: CallPhase) = "calls are not set up"
    override fun dial(number: String) = "calls are not set up"
    override fun refresh() = Unit
}

/**
 * Calls on this phone, for the PC. The call itself stays on the phone and its sound goes to the
 * PC over Bluetooth hands-free; this only reports the call and presses its buttons.
 *
 * Android tells an app that is not the phone app only three states (idle, ringing, off the hook)
 * and, with call log access, the ringing number. [CallTracker] turns those into one [LiveCall].
 */
class PhoneCalls(private val context: Context, private val sms: SmsStore, private val scope: CoroutineScope) : CallControl {
    private val telecom = context.getSystemService(TelecomManager::class.java)
    private val telephony = context.getSystemService(TelephonyManager::class.java)
    private val subscriptions = context.getSystemService(SubscriptionManager::class.java)
    private val tracker = CallTracker()

    /** A tablet or a phone without calling has no SIM calls, and its telephony calls throw. */
    private val hasSims = context.packageManager.let {
        it.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_CALLING) && it.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_SUBSCRIPTION)
    }

    /**
     * Each SIM's call state, which is what the PC follows. Android's phone-state broadcast says the
     * same for another app's call (Messenger, WhatsApp), and stays quiet when a SIM call ends while
     * that app's call is on hold. Needs READ_PHONE_STATE.
     */
    @SuppressLint("MissingPermission")
    private fun simStates(): List<Int> =
        if (!hasSims) emptyList()
        else subscriptions.activeSubscriptionInfoList.orEmpty().map { telephony.createForSubscriptionId(it.subscriptionId).callStateForSubscription }

    /** The SIMs whose call state is watched, by subscription id. */
    private var watched: Map<Int, Pair<TelephonyManager, TelephonyCallback>> = emptyMap()

    /** Watches each SIM's call state, once READ_PHONE_STATE is granted and again whenever the SIMs change. */
    @SuppressLint("MissingPermission")
    @Synchronized
    private fun watchSims() {
        if (!hasSims || !granted(Manifest.permission.READ_PHONE_STATE)) return
        val ids = subscriptions.activeSubscriptionInfoList.orEmpty().map { it.subscriptionId }.toSet()
        for ((id, sim) in watched) if (id !in ids) sim.first.unregisterTelephonyCallback(sim.second)
        watched = ids.associateWith { id ->
            watched[id] ?: run {
                val sim = telephony.createForSubscriptionId(id)
                val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) = onPhoneState(number = null)
                }
                sim.registerTelephonyCallback(context.mainExecutor, callback)
                sim to callback
            }
        }
        // A SIM taken out mid-call reports nothing more: the remaining ones decide now.
        onPhoneState(number = null)
    }

    private fun onPhoneState(number: String?) {
        tracker.onState(simCallState(simStates()), number, System.currentTimeMillis())
        describeCurrent()
    }

    /** Text conversations by phone number, to link a call to its conversation on the PC. */
    private val conversations = sms.conversations.stateIn(scope, SharingStarted.Eagerly, emptyList())

    override val current: StateFlow<LiveCall?> = tracker.call

    init {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                @Suppress("DEPRECATION") // Still the only way a non-dialer app learns the ringing number.
                val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
                onPhoneState(number?.takeIf { it.isNotBlank() })
            }
        }
        // A system broadcast: it reaches a receiver that is not exported.
        context.registerReceiver(receiver, IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED), Context.RECEIVER_NOT_EXPORTED)
        if (hasSims) {
            subscriptions.addOnSubscriptionsChangedListener(
                context.mainExecutor,
                object : SubscriptionManager.OnSubscriptionsChangedListener() {
                    override fun onSubscriptionsChanged() = watchSims()
                },
            )
        }
    }

    private val refreshes = MutableStateFlow(0)

    override fun refresh() {
        refreshes.value++
        watchSims()
    }

    /** Watching the call log needs its permission; asked for later, the watch starts again. */
    @OptIn(ExperimentalCoroutinesApi::class)
    override val log: Flow<List<CallEntry>> = refreshes.flatMapLatest { changes() }
        .conflate()
        .map { readLog() }
        .onStart { emit(emptyList()) }
        .flowOn(Dispatchers.IO)
        // Conversations can come after the log: each one that does links its calls.
        .combine(conversations) { entries, _ -> entries.map { it.copy(key = keyOf(it.number)) } }
        .distinctUntilChanged()

    /**
     * The caller's name and conversation, looked up away from the main thread so the call shows on
     * the PC at once; kept only if the same call is still on.
     */
    private fun describeCurrent() {
        val call = tracker.call.value ?: return
        val number = call.number ?: return
        if (call.name != null || call.key != null) return
        scope.launch(Dispatchers.IO) { tracker.describe(call.id, number, nameOf(number), keyOf(number)) }
    }

    private fun changes(): Flow<Unit> = callbackFlow {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                trySend(Unit)
            }
        }
        // The call log provider announces its changes on content://call_log, above the calls table.
        val registered = runCatching { context.contentResolver.registerContentObserver(CallLog.CONTENT_URI, true, observer) }.isSuccess
        trySend(Unit)
        awaitClose { if (registered) context.contentResolver.unregisterContentObserver(observer) }
    }

    @SuppressLint("MissingPermission")
    override fun answer(call: String): String? {
        if (!granted(Manifest.permission.ANSWER_PHONE_CALLS)) return "no permission to answer calls"
        val now = current.value
        if (now?.id != call || now.phase != CallPhase.RINGING) return "that call is no longer ringing"
        return attempt {
            @Suppress("DEPRECATION") // InCallService needs Kainos to be the phone app; this does not.
            telecom.acceptRingingCall()
        }
    }

    @SuppressLint("MissingPermission")
    override fun hangUp(call: String, phase: CallPhase): String? {
        if (!granted(Manifest.permission.ANSWER_PHONE_CALLS)) return "no permission to end calls"
        val now = current.value
        // Picked up on the phone just before Decline arrived, say: ending it would cut off the person.
        if (now?.id != call || now.phase != phase) return "that call changed on the phone"
        // endCall ends the call in progress, not one waiting: it would cut off the wrong person.
        if (tracker.waiting) return "decline it on the phone, since you are already on a call"
        return attempt {
            @Suppress("DEPRECATION")
            if (!telecom.endCall()) return "no call to end"
        }
    }

    @SuppressLint("MissingPermission")
    override fun dial(number: String): String? {
        if (!granted(Manifest.permission.CALL_PHONE)) return "no permission to make calls"
        if (!SmsInbox.isPhoneNumber(number)) return "not a phone number"
        if (current.value != null) return "already in a call"
        if (!tracker.expectOutgoing(number.trim(), System.currentTimeMillis())) return "already placing a call"
        return attempt { telecom.placeCall(Uri.fromParts("tel", number.trim(), null), Bundle()) }?.also { tracker.cancelOutgoing() }
    }

    private inline fun attempt(action: () -> Unit): String? = try {
        action()
        null
    } catch (e: SecurityException) {
        "Android refused: ${e.message ?: "no permission"}"
    } catch (e: Exception) {
        e.message ?: "failed"
    }

    private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun keyOf(number: String?): String? {
        val wanted = PhoneNumbers.key(number) ?: return null
        return conversations.value.firstOrNull { c -> !c.isGroup && c.numbers.any { PhoneNumbers.key(it) == wanted } }?.key
    }

    private fun nameOf(number: String?): String? {
        if (number == null || !granted(Manifest.permission.READ_CONTACTS)) return null
        return runCatching {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull()
    }

    private fun readLog(): List<CallEntry> {
        if (!granted(Manifest.permission.READ_CALL_LOG)) return emptyList()
        val columns = arrayOf(CallLog.Calls._ID, CallLog.Calls.TYPE, CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.DATE, CallLog.Calls.DURATION)
        return runCatching {
            context.contentResolver.query(CallLog.Calls.CONTENT_URI, columns, null, null, "${CallLog.Calls.DATE} DESC")?.use { c ->
                buildList {
                    while (size < SyncProtocol.MAX_CALL_LOG && c.moveToNext()) {
                        val kind = callKind(c.getInt(1)) ?: continue
                        val number = c.getString(2)?.takeIf { it.isNotBlank() }
                        add(CallEntry(c.getLong(0).toString(), kind, number, c.getString(3)?.takeIf { it.isNotBlank() }, key = null, c.getLong(4), c.getLong(5)))
                    }
                }
            }
        }.getOrNull() ?: emptyList()
    }
}

/** The call log's type as the PC shows it; voicemail, blocked and unknown types are left out. */
internal fun callKind(type: Int): CallKind? = when (type) {
    CallLog.Calls.INCOMING_TYPE, CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> CallKind.INCOMING
    CallLog.Calls.OUTGOING_TYPE -> CallKind.OUTGOING
    CallLog.Calls.MISSED_TYPE -> CallKind.MISSED
    CallLog.Calls.REJECTED_TYPE -> CallKind.DECLINED
    else -> null
}

/** The three states Android tells an app that is not the phone app. */
internal enum class PhoneState { IDLE, RINGING, OFFHOOK }

/** The phone's state from its SIMs' own (`TelephonyManager.CALL_STATE_*`, one per SIM); a SIM ringing comes first. */
internal fun simCallState(states: List<Int>): PhoneState = when {
    TelephonyManager.CALL_STATE_RINGING in states -> PhoneState.RINGING
    TelephonyManager.CALL_STATE_OFFHOOK in states -> PhoneState.OFFHOOK
    else -> PhoneState.IDLE
}

/**
 * Turns Android's phone states into the one call the PC shows. Ringing starts an incoming call;
 * off the hook makes a ringing call active, or starts an outgoing one; idle ends it. The ringing
 * number can come in a second broadcast, after the first one without it.
 */
internal class CallTracker {
    private val state = MutableStateFlow<LiveCall?>(null)
    val call: StateFlow<LiveCall?> = state

    /** A number the PC dialled, so the outgoing call that follows shows it. */
    private var expected: Pair<String, Long>? = null

    /** The call in progress while another one rings (call waiting). */
    private var underneath: LiveCall? = null

    /** A call rings while another is in progress. */
    val waiting: Boolean get() = underneath != null && state.value?.phase == CallPhase.RINGING

    /**
     * Holds the number the PC is about to dial, so the call that follows shows it. False while an
     * earlier dial is still waiting for its call: two quick dials place one call.
     */
    @Synchronized
    fun expectOutgoing(number: String, nowMs: Long): Boolean {
        if (expected?.let { nowMs - it.second < EXPECT_MS } == true) return false
        expected = number to nowMs
        return true
    }

    @Synchronized
    fun cancelOutgoing() {
        expected = null
    }

    /** The caller's name and conversation, found after the call showed; dropped if another call is on now. */
    @Synchronized
    fun describe(id: String, number: String, name: String?, key: String?) {
        val now = state.value ?: return
        if (now.id == id && now.number == number) state.value = now.copy(name = name, key = key)
    }

    @Synchronized
    fun onState(phoneState: PhoneState, number: String?, nowMs: Long) {
        val now = state.value
        state.value = when (phoneState) {
            PhoneState.RINGING -> when {
                // The same ringing call, now with its number.
                now?.phase == CallPhase.RINGING -> if (number != null && now.number == null) now.copy(number = number) else now
                else -> {
                    underneath = now
                    LiveCall(UUID.randomUUID().toString(), CallPhase.RINGING, incoming = true, number = number, name = null, key = null, sinceMs = nowMs)
                }
            }
            PhoneState.OFFHOOK -> when {
                now == null -> {
                    val dialled = expected?.takeIf { nowMs - it.second < EXPECT_MS }?.first
                    LiveCall(UUID.randomUUID().toString(), CallPhase.ACTIVE, incoming = false, number = dialled, name = null, key = null, sinceMs = nowMs)
                }
                // After call waiting the phone is off the hook either way: answered (the first call on hold)
                // or declined. The states can't tell which, so the bar goes back to the first call.
                now.phase == CallPhase.RINGING -> underneath ?: now.copy(phase = CallPhase.ACTIVE, sinceMs = nowMs)
                else -> now
            }
            PhoneState.IDLE -> null
        }
        if (phoneState != PhoneState.RINGING) underneath = null
        // Off the hook takes the dialled number; idle ends a call. An idle reading with no call is
        // nothing new, and leaves a dial that has not started yet to its own expiry.
        if (phoneState == PhoneState.OFFHOOK || (phoneState == PhoneState.IDLE && now != null)) expected = null
    }

    private companion object {
        /** A call off the hook this soon after the PC dialled is that call. */
        const val EXPECT_MS = 30_000L
    }
}
