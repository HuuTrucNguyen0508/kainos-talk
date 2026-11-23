package app.kainos.talk.sync

import android.provider.CallLog
import android.telephony.TelephonyManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallTrackerTest {
    @Test
    fun anIncomingCallRingsGetsItsNumberAndNameLaterIsAnsweredAndEnds() {
        val tracker = CallTracker()
        tracker.onState(PhoneState.RINGING, null, 1_000)
        val ringing = tracker.call.value!!
        assertEquals(CallPhase.RINGING, ringing.phase)
        assertEquals(true, ringing.incoming)
        assertNull(ringing.number)

        tracker.onState(PhoneState.RINGING, "+33612345678", 1_050)
        assertEquals(ringing.copy(number = "+33612345678"), tracker.call.value)
        tracker.onState(PhoneState.RINGING, null, 1_060)
        assertEquals("a later broadcast without the number keeps it", "+33612345678", tracker.call.value!!.number)
        tracker.describe(ringing.id, "+33612345678", "Maman", "sms|t:4")
        assertEquals(ringing.copy(number = "+33612345678", name = "Maman", key = "sms|t:4"), tracker.call.value)

        tracker.onState(PhoneState.OFFHOOK, null, 5_000)
        assertEquals(ringing.copy(phase = CallPhase.ACTIVE, number = "+33612345678", name = "Maman", key = "sms|t:4", sinceMs = 5_000), tracker.call.value)

        tracker.onState(PhoneState.IDLE, null, 9_000)
        assertNull(tracker.call.value)
        tracker.describe(ringing.id, "+33612345678", "Late", null)
        assertNull("a lookup that finishes after the call is dropped", tracker.call.value)
    }

    @Test
    fun aCallThePcDialledShowsItsNumberAndOneDialledOnThePhoneDoesNot() {
        val tracker = CallTracker()
        assertEquals(true, tracker.expectOutgoing("+33612345678", 1_000))
        assertEquals("a second dial before the call starts is refused", false, tracker.expectOutgoing("+33600000000", 1_500))
        tracker.onState(PhoneState.OFFHOOK, null, 2_000)
        val dialled = tracker.call.value!!
        assertEquals(LiveCall(dialled.id, CallPhase.ACTIVE, incoming = false, number = "+33612345678", name = null, key = null, sinceMs = 2_000), dialled)
        tracker.onState(PhoneState.IDLE, null, 3_000)

        tracker.onState(PhoneState.OFFHOOK, null, 4_000)
        val fromPhone = tracker.call.value!!
        assertNotEquals(dialled.id, fromPhone.id)
        assertNull("the PC's number is used once", fromPhone.number)
    }

    @Test
    fun aDialLongAgoIsNotTakenForTheNextCallAndAFailedOneFreesTheNext() {
        val tracker = CallTracker()
        tracker.expectOutgoing("+33612345678", 1_000)
        tracker.onState(PhoneState.OFFHOOK, null, 60_000)
        assertNull(tracker.call.value!!.number)
        tracker.onState(PhoneState.IDLE, null, 61_000)

        tracker.expectOutgoing("+33612345678", 70_000)
        tracker.cancelOutgoing()
        assertEquals(true, tracker.expectOutgoing("+33600000000", 70_100))
    }

    @Test
    fun aCallWaitingDuringAnotherIsKnownAndTheFirstCallComesBack() {
        val tracker = CallTracker()
        tracker.onState(PhoneState.RINGING, "+33612345678", 1_000)
        tracker.onState(PhoneState.OFFHOOK, null, 2_000)
        val first = tracker.call.value!!
        assertEquals(false, tracker.waiting)

        tracker.onState(PhoneState.RINGING, "0699999999", 3_000)
        assertEquals(CallPhase.RINGING, tracker.call.value!!.phase)
        assertEquals("0699999999", tracker.call.value!!.number)
        assertEquals(true, tracker.waiting)

        tracker.onState(PhoneState.OFFHOOK, null, 4_000)
        assertEquals(first, tracker.call.value)
        assertEquals(false, tracker.waiting)
    }

    @Test
    fun onlyTheSimDecidesSoAMessengerOrWhatsAppCallNeverReachesThePc() {
        // Android announces another app's call (Messenger, WhatsApp) like a SIM call, without its number.
        assertEquals(PhoneState.IDLE, simCallState(listOf(TelephonyManager.CALL_STATE_IDLE)))
        assertEquals(PhoneState.RINGING, simCallState(listOf(TelephonyManager.CALL_STATE_RINGING)))
        assertEquals(PhoneState.OFFHOOK, simCallState(listOf(TelephonyManager.CALL_STATE_OFFHOOK)))
        assertEquals("no SIM", PhoneState.IDLE, simCallState(emptyList()))
        assertEquals("a second SIM rings during a call", PhoneState.RINGING, simCallState(listOf(TelephonyManager.CALL_STATE_OFFHOOK, TelephonyManager.CALL_STATE_RINGING)))
        assertEquals(PhoneState.OFFHOOK, simCallState(listOf(TelephonyManager.CALL_STATE_IDLE, TelephonyManager.CALL_STATE_OFFHOOK)))

        // While a Messenger call rings during a SIM call, the SIM call stays the one on the PC.
        val tracker = CallTracker()
        tracker.onState(simCallState(listOf(TelephonyManager.CALL_STATE_RINGING)), "+33612345678", 1_000)
        tracker.onState(simCallState(listOf(TelephonyManager.CALL_STATE_OFFHOOK)), null, 2_000)
        val simCall = tracker.call.value!!
        tracker.onState(simCallState(listOf(TelephonyManager.CALL_STATE_OFFHOOK)), null, 3_000)
        assertEquals(simCall, tracker.call.value)
        assertEquals(false, tracker.waiting)
    }

    @Test
    fun anIdleReadingBeforeTheDialledCallStartsKeepsItsNumber() {
        // Each SIM's watcher reports the state it starts with, which can land between the PC's dial and the call.
        val tracker = CallTracker()
        tracker.expectOutgoing("+33612345678", 1_000)
        tracker.onState(PhoneState.IDLE, null, 1_100)
        assertEquals("a second dial is still refused", false, tracker.expectOutgoing("+33600000000", 1_200))
        tracker.onState(PhoneState.OFFHOOK, null, 2_000)
        assertEquals("+33612345678", tracker.call.value!!.number)
    }

    @Test
    fun callLogTypesMapToWhatThePcShows() {
        assertEquals(CallKind.INCOMING, callKind(CallLog.Calls.INCOMING_TYPE))
        assertEquals(CallKind.INCOMING, callKind(CallLog.Calls.ANSWERED_EXTERNALLY_TYPE))
        assertEquals(CallKind.OUTGOING, callKind(CallLog.Calls.OUTGOING_TYPE))
        assertEquals(CallKind.MISSED, callKind(CallLog.Calls.MISSED_TYPE))
        assertEquals(CallKind.DECLINED, callKind(CallLog.Calls.REJECTED_TYPE))
        assertNull(callKind(CallLog.Calls.VOICEMAIL_TYPE))
        assertNull(callKind(CallLog.Calls.BLOCKED_TYPE))
    }
}
