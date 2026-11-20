# Plan: phone calls on the PC

Status: built on 2026-11-19, in version 0.3.0. Risk 1 was proved first: an Android phone paired
with the PC as a hands-free unit, and a call worked both ways through the PC's speakers and
microphone. Pairing needs a Bluetooth agent on the PC (Hyprland has none by default), so the
desktop app should run one during pairing. The user wants Kainos Talk's texts to grow toward
3CX (calls and texts in one place on the PC), using their own number through the phone and keeping
the LAN-only rule. They picked this over a rented carrier number (Telnyx or Twilio) and over
porting their number.

## What the user gets

- An incoming call rings on the PC: caller name and number, Answer and Decline.
- Calls placed from the PC: a dial pad, or Call on a conversation in Texts.
- Call audio uses the PC's speakers and microphone (or a headset plugged into the PC).
- A call log next to the texts, per person: calls and texts in one timeline, as in 3CX.
- All of this works while the phone is in Bluetooth range and on the same LAN as the PC.

## Why audio goes over Bluetooth, not the LAN

Android does not let a normal app capture or inject the audio of a cellular call (the
`VOICE_CALL` audio source and `CAPTURE_AUDIO_OUTPUT` are reserved for system apps). So the
existing TLS link cannot carry the audio. Bluetooth hands-free (HFP) can: the phone treats the PC
like a car kit and sends the call audio to it. Microsoft Phone Link works the same way.

This PC already advertises the hands-free role (UUID `0x111e`, "Handsfree", from PipeWire 1.6's
own Bluetooth backend; checked on 2026-11-19 with `bluetoothctl show`), so it needs no oFono.

## Shape

```
 Phone (Kainos Android)                          PC (Kainos desktop)
 TelephonyCallback ─▶ call state ── TLS, LAN ──▶ SyncServer ─▶ call bar + call log
 TelecomManager    ◀─ answer/end/dial ─────────── buttons
 Call audio ═════════ Bluetooth HFP ═══════════▶ PipeWire (speakers, mic)
```

- **Control over the LAN link we already have.** New frames: `call` (state: ringing, active,
  ended; number; contact name; direction), `callAnswer`, `callEnd`, `callDial`, and `callLog` in the
  snapshot.
- **Audio over Bluetooth.** Kainos does not touch the audio. It checks that the phone is connected
  with the hands-free profile and warns when it isn't ("Call audio will stay on the phone").

## Wire format (protocol 5)

Both apps move to `SYNC_VERSION = 5` together: an older PC destroys the connection on any frame
type it does not know, so the bump is what keeps a new phone from being cut off by an old PC (the
phone shows "different versions" and retries, as today).

Phone to PC:

- `call`: `{ t: 'call', call: LiveCall | null }`, sent on every change and once after the welcome.
  `null` means no call. `LiveCall = { id, phase: 'ringing' | 'active', direction: 'incoming' |
  'outgoing', number: string | null, name: string | null, key: string | null, sinceMs }`. Android
  gives a normal app only IDLE, RINGING and OFFHOOK, so an outgoing call is `active` from the moment
  it is dialled. `key` is the SMS conversation with that number, when there is one.
- `callLog`: `{ t: 'callLog', calls: CallEntry[] }`, the newest 100 entries, sent after the welcome
  and whenever the call log changes. `CallEntry = { id, kind: 'incoming' | 'outgoing' | 'missed' |
  'declined', number: string | null, name: string | null, key: string | null, timeMs, seconds }`.
  Voicemail, blocked and unknown types map to `missed`/`declined` or are left out.
- Results of PC actions reuse `replyResult { id, ok, error }`.

PC to phone:

- `answer { id }`, `hangUp { id }` (also declines a ringing call), and `dial { id, number, key }`
  with exactly one of `number` and `key` set. A key is resolved on the phone with
  `SmsStore.addressOf`, and the number it gives is checked like a typed one.

Upgrading: a phone and a PC on different protocol versions refuse each other before the welcome,
so texts stop too until both apps are updated. The phone says so ("different versions"), both
while paired and while pairing.

## Known limits

- **Call waiting.** A second call ringing during a call shows on the PC, and Answer works (Android
  holds the first call). Decline is refused from the PC, because `TelecomManager.endCall` ends the
  call in progress, not the waiting one. Once the second call stops ringing, the bar shows the first
  call again: the phone's states can't tell whether it was answered or declined.
- **A call already going when the app starts** shows only from its next state change.
- **Keypad tones (voicemail menus)** are not sent from the PC. A normal app can't send them into a
  cellular call; PipeWire's hands-free `SendTones` might, and is untested.
- **Windows.** The call bar and the buttons work, but whether the sound reaches the PC depends on
  Windows acting as a Bluetooth hands-free device, which is untested.
- **Dual SIM.** Calls go out on the phone's default SIM for calls.

## Phone changes

- Permissions: `READ_PHONE_STATE`, `READ_CALL_LOG`, `ANSWER_PHONE_CALLS`, `CALL_PHONE`.
- Listen for call state with `TelephonyCallback`. Answer with `TelecomManager.acceptRingingCall`,
  end with `endCall`, and dial with `placeCall`. None of these needs Kainos to be the default dialer.
- Send recent entries from the call log in the snapshot, the same way as SMS history.

## PC changes

- Call bar: ringing, in-call timer, mute (PipeWire source mute), end.
- A dial pad, and Call on each conversation in Texts.
- One timeline per person for calls and texts. The Texts page may become "Phone".
- A Bluetooth hands-free status check through BlueZ over D-Bus.

## Risks to prove first

1. **Bluetooth audio quality and pairing** on this PC (manual test, before any code): pair the
   phone with the PC, make a call, check that both directions sound clear, and check that wideband
   speech (mSBC) is used.
2. Whether the phone keeps the hands-free link when another headset or the car connects.
3. `acceptRingingCall` is deprecated since Android 10 but still works; if a phone blocks it, the
   fallback is the hands-free answer command that PipeWire sends.

## Order

1. Manual Bluetooth call test (risk 1).
2. Protocol frames and test vectors.
3. Phone call state, control and call log.
4. PC call bar and dial pad (after a `/frontend-design` pass), then the combined timeline.
5. End-to-end run with a real phone.
