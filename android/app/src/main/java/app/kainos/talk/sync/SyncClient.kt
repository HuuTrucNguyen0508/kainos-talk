package app.kainos.talk.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.hub.TalkHub
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/** Where the phone stands with its PC. */
sealed interface SyncStatus {
    data object NotPaired : SyncStatus
    data class Connecting(val pcName: String) : SyncStatus
    /** [viaTailnet]: reached at one of the PC's Tailscale addresses, not on the Wi-Fi. */
    data class Connected(val pcName: String, val viaTailnet: Boolean = false) : SyncStatus

    /** Paired, but the PC could not be reached; retrying. */
    data class Offline(val pcName: String, val reason: String) : SyncStatus

    /** The PC runs another version of the sync protocol (one app was updated, not the other); retrying. */
    data class Mismatch(val pcName: String) : SyncStatus

    /** The PC no longer knows this phone (it was forgotten there). */
    data class Refused(val pcName: String) : SyncStatus
}

sealed interface PairResult {
    data object Paired : PairResult
    data object Refused : PairResult
    data object Cancelled : PairResult
    data class Failed(val reason: String) : PairResult
}

/** Where pairing stands; owned by [SyncClient] so rotation or a theme change keeps the code and socket alive. */
sealed interface PairingState {
    data object Idle : PairingState
    data class Connecting(val name: String) : PairingState
    data class Code(val code: String) : PairingState

    /** The user said the codes match; the computer has to say so too. */
    data class Confirmed(val code: String) : PairingState
    data class Problem(val message: String) : PairingState
}

/** What the "Connect to PC" screen needs; a fake stands in for it in UI tests. */
interface SyncControl {
    val status: StateFlow<SyncStatus>
    val discovered: StateFlow<List<FoundPc>>
    val pairing: StateFlow<PairingState>
    fun startDiscovery()
    fun stopDiscovery()

    /** Pairs with a PC found on the network; progress shows in [pairing]. */
    fun pair(pc: FoundPc)
    fun forget()

    /** While pairing: the user compared the codes; true when they match, false to cancel. */
    fun confirmCode(matches: Boolean)

    /** Reads the SMS inbox and the call log again, after the user granted access to them. */
    fun refreshInbox()
}

/**
 * The phone end of PC sync: keeps one TLS connection to the paired PC while the app runs, sends
 * it every text conversation the hub shows, and passes the PC's replies and reads to the hub.
 * Nothing goes anywhere but the paired PC, at a local or Tailscale address.
 */
class SyncClient(
    context: Context,
    private val hub: TalkHub,
    /** Sends new texts typed on the PC; the hub already shows the inbox's conversations. */
    private val sms: SmsStore,
    private val scope: CoroutineScope,
    /** This phone's key and certificate; tests bring their own. */
    private val identity: DeviceIdentity = KeystoreIdentity(),
    /** The PC's port; tests use another one. */
    private val port: Int = SyncProtocol.PORT,
    /** A picture by its id: MMS parts from the inbox, or pictures kept from notifications. */
    private val pictures: (String) -> ByteArray? = sms::image,
    private val lanAvailable: Flow<Boolean> = lanAvailability(context),
    /** How long to wait for Wi-Fi or Ethernet before trying anyway (the PC may be on this phone's hotspot or tether). */
    private val lanWaitMs: Long = LAN_WAIT_MS,
    /** The phone's calls: reported to the PC, and answered, ended or placed from it. */
    private val calls: CallControl = NoCalls,
    /** Clipboard writes from the PC. */
    private val clipboard: ClipboardBridge = AndroidClipboard(context),
    /** Opens shared content URIs for upload to the PC. */
    private val outgoingFiles: OutgoingFileSource = ContentResolverFileSource(context),
    /** Saves incoming files from the PC to the chosen folder, else Downloads. */
    private val incomingFiles: IncomingFileSink = ChosenFolderSink(context),
    /** Notifies the user when a file from the PC is saved. */
    private val fileNotifier: FileNotifier = AndroidFileNotifier(context),
    /** How long to wait for `fileResult` after `fileEnd`; tests use a shorter wait. */
    private val fileResultTimeoutMs: Long = TransferSession.RESULT_TIMEOUT_MS,
    /** Called when an outgoing file fails or times out waiting for the PC's answer. */
    private val onOutgoingFileFailure: (name: String, error: String) -> Unit = { name, error ->
        android.util.Log.w("SyncClient", "outgoing file failed ($name): $error")
    },
) : SyncControl {
    private class ActivePairing {
        val confirmation = CompletableDeferred<Boolean>()
        val cancelled = CompletableDeferred<Unit>()
        val mismatch = AtomicBoolean(false)
        @Volatile var socket: SSLSocket? = null
    }

    /** Separate queues so clipboard and shared text are never stuck behind a large file upload. */
    private class SessionOutbox(
        val texts: Channel<OutgoingText> = Channel(Channel.UNLIMITED),
        val files: Channel<OutgoingFiles> = Channel(Channel.UNLIMITED),
    )

    private val settings = SyncSettings(context)
    private val discovery = PcDiscovery(context)
    override fun refreshInbox() {
        sms.refresh()
        calls.refresh()
    }
    private val statusState = MutableStateFlow<SyncStatus>(settings.load()?.let { SyncStatus.Connecting(it.pcName) } ?: SyncStatus.NotPaired)
    override val status: StateFlow<SyncStatus> = statusState
    override val discovered: StateFlow<List<FoundPc>> = discovery.found
    private val pairingState = MutableStateFlow<PairingState>(PairingState.Idle)
    override val pairing: StateFlow<PairingState> = pairingState
    private var loop: Job? = null
    private var pairingJob: Job? = null
    private val pairingLock = Any()
    @Volatile private var activePairing: ActivePairing? = null
    @Volatile private var activeOutbox: SessionOutbox? = null
    @Volatile private var lastClipFromPc: String? = null

    /** True while a welcomed TLS session with the PC is open. */
    val isConnected: Boolean get() = activeOutbox != null

    /** Sends clipboard text to the PC, suppressing echo of text just received from it. */
    fun sendClip(text: String): OutboxResult {
        val outbox = activeOutbox ?: return OutboxResult.NOT_CONNECTED
        if (text.isEmpty()) return OutboxResult.EMPTY
        if (text.length > SyncProtocol.MAX_CLIP_CHARS) return OutboxResult.TOO_LONG
        if (text == lastClipFromPc) return OutboxResult.UNCHANGED
        lastClipFromPc = null
        return if (outbox.texts.trySend(OutgoingText.Clip(text)).isSuccess) OutboxResult.QUEUED else OutboxResult.NOT_CONNECTED
    }

    /** Sends text or a link from Android's share sheet to the PC. */
    fun shareText(text: String): OutboxResult {
        val outbox = activeOutbox ?: return OutboxResult.NOT_CONNECTED
        if (text.isEmpty()) return OutboxResult.EMPTY
        if (text.length > SyncProtocol.MAX_CLIP_CHARS) return OutboxResult.TOO_LONG
        return if (outbox.texts.trySend(OutgoingText.ShareText(text)).isSuccess) OutboxResult.QUEUED else OutboxResult.NOT_CONNECTED
    }

    /** Queues content URIs to stream to the PC; queues nothing when disconnected. */
    fun shareFiles(uris: List<Uri>): OutboxResult {
        val outbox = activeOutbox ?: return OutboxResult.NOT_CONNECTED
        if (uris.isEmpty()) return OutboxResult.EMPTY
        return if (outbox.files.trySend(OutgoingFiles.Uris(uris)).isSuccess) OutboxResult.QUEUED else OutboxResult.NOT_CONNECTED
    }

    /** Queues already-opened files (preserving temporary share URI grants after activity finish). */
    fun sharePreparedFiles(files: List<OutgoingFile>): OutboxResult {
        val outbox = activeOutbox ?: run {
            files.forEach(OutgoingFile::close)
            return OutboxResult.NOT_CONNECTED
        }
        if (files.isEmpty()) return OutboxResult.EMPTY
        if (outbox.files.trySend(OutgoingFiles.Prepared(files)).isSuccess) return OutboxResult.QUEUED
        files.forEach(OutgoingFile::close)
        return OutboxResult.NOT_CONNECTED
    }

    fun start() {
        if (loop?.isActive == true || settings.load() == null) return
        loop = scope.launch(Dispatchers.IO) { connectLoop() }
    }

    override fun startDiscovery() {
        val current = pairingState.value
        if (current is PairingState.Problem) pairingState.compareAndSet(current, PairingState.Idle)
        discovery.start()
    }

    override fun stopDiscovery() = discovery.stop()

    override fun forget() {
        settings.clear()
        val job = loop
        loop = null
        scope.launch { job?.cancelAndJoin() }
        val current = pairingState.value
        if (current is PairingState.Problem) pairingState.compareAndSet(current, PairingState.Idle)
        statusState.value = SyncStatus.NotPaired
    }

    override fun pair(pc: FoundPc) {
        synchronized(pairingLock) {
            val current = pairingState.value
            if (current is PairingState.Connecting || current is PairingState.Code || current is PairingState.Confirmed) return
            val attempt = ActivePairing()
            activePairing = attempt
            pairingState.value = PairingState.Connecting(pc.name)
            val previous = pairingJob
            pairingJob = scope.launch(Dispatchers.IO) {
                try {
                    previous?.join()
                    val result = runPairAt(pc.hosts, pc.fingerprint, pc.name, attempt) { code ->
                        if (!attempt.cancelled.isCompleted) {
                            pairingState.compareAndSet(PairingState.Connecting(pc.name), PairingState.Code(code))
                        }
                    }
                    val next = when (result) {
                        PairResult.Paired -> PairingState.Idle
                        PairResult.Cancelled -> if (attempt.mismatch.get()) {
                            PairingState.Problem(CODE_MISMATCH_MESSAGE)
                        } else {
                            PairingState.Idle
                        }
                        PairResult.Refused -> PairingState.Problem(
                            "The PC didn't connect. If its code didn't match, someone else may be on your network; otherwise try again.",
                        )
                        is PairResult.Failed -> PairingState.Problem(result.reason)
                    }
                    // The attempt ends and its outcome shows in one step, so a Cancel seen after
                    // the outcome never lands on the finished attempt.
                    synchronized(pairingLock) {
                        if (activePairing === attempt) activePairing = null
                        pairingState.value = next
                    }
                } finally {
                    synchronized(pairingLock) {
                        if (activePairing === attempt) activePairing = null
                    }
                }
            }
        }
    }

    /**
     * Pairs with the PC at [hosts]. When the PC's mDNS record named its certificate, the one TLS
     * shows must be the same.
     */
    internal suspend fun pairAt(hosts: List<String>, expectedFingerprint: String?, name: String, onCode: (String) -> Unit): PairResult {
        val attempt = ActivePairing()
        synchronized(pairingLock) { activePairing = attempt }
        return try {
            runPairAt(hosts, expectedFingerprint, name, attempt, onCode)
        } finally {
            synchronized(pairingLock) {
                if (activePairing === attempt) activePairing = null
            }
        }
    }

    private suspend fun runPairAt(
        hosts: List<String>,
        expectedFingerprint: String?,
        name: String,
        attempt: ActivePairing,
        onCode: (String) -> Unit,
    ): PairResult = withContext(Dispatchers.IO) {
        if (attempt.cancelled.isCompleted) return@withContext PairResult.Cancelled
        val local = hosts.filter { SyncProtocol.isLocalAddress(it) }
        if (local.isEmpty()) return@withContext PairResult.Failed("That computer is not on your local network.")
        val job = currentCoroutineContext()[Job]
        try {
            coroutineScope {
                // Closing the socket on Dispatchers.IO unblocks connect, handshake and readLine
                // when the user taps Cancel (even after "Codes match") or the coroutine is cancelled.
                val closer = launch(start = CoroutineStart.UNDISPATCHED) {
                    try {
                        attempt.cancelled.await()
                    } finally {
                        runCatching { attempt.socket?.close() }
                    }
                }
                try {
                    var seen: String? = null
                    val (host, socket) = try {
                        openFirst(
                            local,
                            TrustOnFirstUse { seen = it },
                            shouldStop = { attempt.cancelled.isCompleted || job?.isActive == false },
                        ) { sock ->
                            attempt.socket = sock
                            if (attempt.cancelled.isCompleted || job?.isActive == false) runCatching { sock.close() }
                        }
                    } catch (e: Exception) {
                        currentCoroutineContext().ensureActive()
                        return@coroutineScope if (attempt.cancelled.isCompleted) {
                            PairResult.Cancelled
                        } else {
                            PairResult.Failed("Can't reach $name. Check that Kainos Talk is open on it and both are on the same Wi-Fi.")
                        }
                    }
                    socket.use {
                        if (attempt.cancelled.isCompleted) return@coroutineScope PairResult.Cancelled
                        if (expectedFingerprint != null && seen != expectedFingerprint) {
                            return@coroutineScope PairResult.Failed("Another device answered for $name. Try again.")
                        }
                        val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
                        val writer = OutputStreamWriter(socket.outputStream, Charsets.UTF_8)
                        val nonce = randomToken(16)
                        writer.write(SyncProtocol.pair(deviceName(), nonce) + "\n")
                        writer.flush()
                        val code = when (val first = SyncProtocol.parse(reader.readLine() ?: "")) {
                            is PcFrame.PairCode -> first
                            is PcFrame.Denied -> return@coroutineScope PairResult.Failed(
                                when (first.reason) {
                                    "version" -> "This phone and $name run different versions of Kainos Talk. Update both, then connect."
                                    "paired" -> "$name is connected to another phone. To connect this one instead, click that phone's name in the dock on $name, choose Connect another phone…, and try again here."
                                    else -> "$name refused to connect."
                                },
                            )
                            else -> {
                                currentCoroutineContext().ensureActive()
                                return@coroutineScope if (attempt.cancelled.isCompleted) {
                                    PairResult.Cancelled
                                } else {
                                    PairResult.Failed("The PC is busy pairing another phone. Try again in a minute.")
                                }
                            }
                        }
                        onCode(SyncProtocol.pairingCode(seen!!, identity.fingerprint, nonce, code.nonce))
                        socket.soTimeout = PAIRING_TIMEOUT_MS
                        val confirmSent = AtomicBoolean(false)
                        val confirm = launch {
                            if (attempt.confirmation.await() && !attempt.cancelled.isCompleted) {
                                if (runCatching {
                                        writer.write(SyncProtocol.pairConfirm() + "\n")
                                        writer.flush()
                                    }.isSuccess
                                ) {
                                    confirmSent.set(true)
                                }
                            }
                        }
                        val answer = runCatching { SyncProtocol.parse(reader.readLine() ?: "") }.getOrNull()
                        if (answer is PcFrame.Paired) {
                            confirm.cancelAndJoin()
                        } else {
                            confirm.cancel()
                        }
                        currentCoroutineContext().ensureActive()
                        when {
                            // The PC already paired this phone, so a Cancel tapped as it answered
                            // comes too late: keeping the pairing matches what the PC saved.
                            answer is PcFrame.Paired && confirmSent.get() -> {
                                loop?.cancelAndJoin()
                                settings.save(PairedPc(host, seen!!, answer.deviceId, pcName = name))
                                statusState.value = SyncStatus.Connecting(name)
                                start()
                                PairResult.Paired
                            }
                            attempt.cancelled.isCompleted -> PairResult.Cancelled
                            else -> PairResult.Refused
                        }
                    }
                } finally {
                    closer.cancel()
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            currentCoroutineContext().ensureActive()
            if (attempt.cancelled.isCompleted) PairResult.Cancelled
            else PairResult.Failed("The connection to the PC dropped. Try again.")
        }
    }

    /** The user compared the codes: true when they match ("Codes match"), false to cancel at any step. */
    override fun confirmCode(matches: Boolean) {
        val attempt = activePairing
        if (matches) {
            if (attempt == null || attempt.cancelled.isCompleted) return
            if (attempt.confirmation.complete(true)) {
                val current = pairingState.value
                if (current is PairingState.Code) {
                    pairingState.compareAndSet(current, PairingState.Confirmed(current.code))
                }
            }
        } else {
            if (attempt == null) {
                // A screen left over from an attempt that is gone; a warning stays until read.
                synchronized(pairingLock) {
                    val current = pairingState.value
                    if (activePairing == null && (current is PairingState.Connecting || current is PairingState.Code || current is PairingState.Confirmed)) {
                        pairingState.value = PairingState.Idle
                    }
                }
                return
            }
            if (pairingState.value is PairingState.Code) attempt.mismatch.set(true)
            attempt.cancelled.complete(Unit)
            attempt.confirmation.complete(false)
        }
    }

    private suspend fun connectLoop() {
        var backoff = MIN_BACKOFF_MS
        var failed = false
        var candidates = emptyList<String>()
        // The PC last welcomed this phone with no Wi-Fi or Ethernet up (this phone's hotspot or a tether):
        // do not wait for them again until it welcomes the phone while one is up. Set on the welcome, not
        // on a clean close, since a hotspot link usually ends with a failed read. Forgetting the PC ends this loop.
        var withoutLan = false
        while (scope.isActive) {
            var pc = settings.load() ?: return
            statusState.value = SyncStatus.Offline(pc.pcName, "Waiting for Wi-Fi or Ethernet")
            // A phone sharing its own connection has no Wi-Fi or Ethernet to wait for: after a while, try anyway.
            // Nor does one that can reach the PC over Tailscale, from anywhere.
            val onLan = withTimeoutOrNull(if (withoutLan || pc.tailnet.isNotEmpty()) LAN_PROBE_MS else lanWaitMs) { lanAvailable.first { it } } != null
            statusState.value = SyncStatus.Connecting(pc.pcName)
            // The PC is known by its certificate. After a failure, look for it on the network: the
            // router may have given it a new address since.
            if (failed) {
                discovery.locate(pc.fingerprint, LOCATE_TIMEOUT_MS)?.let { found -> candidates = found.hosts }
            }
            failed = true
            // The PC answered at that address: a drop after this needs no search for it.
            var welcomed = false
            try {
                val outcome = session(pc, candidates, preferTailnet = !onLan) {
                    welcomed = true
                    withoutLan = !onLan
                    // A link that worked starts the next retry from the shortest wait, however it ends.
                    backoff = MIN_BACKOFF_MS
                }
                if (outcome == Outcome.DENIED) {
                    statusState.value = SyncStatus.Refused(pc.pcName)
                    return
                }
                if (outcome == Outcome.MISMATCH) {
                    statusState.value = SyncStatus.Mismatch(pc.pcName)
                } else {
                    backoff = MIN_BACKOFF_MS
                }
                failed = outcome != Outcome.CLOSED_AFTER_WELCOME
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                // Forget closes the socket, so its read fails; a forgotten PC is not offline.
                currentCoroutineContext().ensureActive()
                failed = !welcomed
                statusState.value = SyncStatus.Offline(pc.pcName, e.message ?: e.javaClass.simpleName)
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    private enum class Outcome { CLOSED, CLOSED_AFTER_WELCOME, DENIED, MISMATCH }

    /**
     * One connection, until it drops. [addresses] are where discovery last saw the PC. Its Tailscale
     * addresses come after those, or first when [preferTailnet] (no Wi-Fi or Ethernet is up).
     */
    private suspend fun session(pc: PairedPc, addresses: List<String>, preferTailnet: Boolean, onWelcome: () -> Unit): Outcome = coroutineScope {
        val lan = listOf(pc.host) + addresses
        val (host, socket) = openFirst((if (preferTailnet) pc.tailnet + lan else lan + pc.tailnet).distinct(), Pinned(pc.fingerprint))
        val viaTailnet = SyncProtocol.isTailnetAddress(host)
        var saved = pc
        fun remember(updated: PairedPc) {
            if (updated != saved && settings.replace(saved, updated)) saved = updated
        }
        // Remember where it answered on the Wi-Fi, as the first place to try next time.
        if (!viaTailnet) remember(saved.copy(host = host))
        // A blocking read ignores cancellation; closing the socket ends it (Forget, app exit).
        val closer = launch {
            try {
                awaitCancellation()
            } finally {
                runCatching { socket.close() }
            }
        }
        val lock = Mutex()
        val writer = OutputStreamWriter(socket.outputStream, Charsets.UTF_8)
        suspend fun send(line: String) = lock.withLock {
            withContext(Dispatchers.IO) {
                writer.write(line + "\n")
                writer.flush()
            }
        }
        try {
            // The PC pings every 60 s; silence for 90 s means the connection is dead.
            socket.soTimeout = 90_000
            val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
            val outbox = SessionOutbox()
            val transfers = TransferSession(
                send = ::send,
                outgoingFiles = outgoingFiles,
                incomingFiles = incomingFiles,
                fileNotifier = fileNotifier,
                onIncomingClip = { text ->
                    lastClipFromPc = text
                    clipboard.setText(text)
                },
                resultTimeoutMs = fileResultTimeoutMs,
                onOutgoingFailure = onOutgoingFileFailure,
            )
            send(SyncProtocol.hello(pc.deviceId))
            val welcome = when (val answer = SyncProtocol.parse(reader.readLine() ?: return@coroutineScope Outcome.CLOSED)) {
                is PcFrame.Welcome -> {
                    val name = answer.name.ifBlank { pc.host }
                    // A PC with Tailscale down for the moment sends none: the last ones known still count.
                    remember(saved.copy(pcName = name, tailnet = answer.tailnet.ifEmpty { saved.tailnet }))
                    activeOutbox = outbox
                    statusState.value = SyncStatus.Connected(name, viaTailnet)
                    onWelcome()
                    answer
                }
                // Only "unknown phone" means the PC forgot this phone. Anything else (another
                // protocol version during an update, say) is retried like a dropped connection.
                is PcFrame.Denied -> return@coroutineScope if (answer.reason == "unknown phone") Outcome.DENIED else Outcome.MISMATCH
                else -> return@coroutineScope Outcome.CLOSED
            }
            val syncer = launch { syncConversations(welcome, ::send) }
            val caller = launch { syncCalls(::send) }
            val textSender = launch { transfers.drainTexts(outbox.texts) }
            val fileSender = launch { transfers.drainFiles(outbox.files) }
            try {
                while (isActive) {
                    val line = withContext(Dispatchers.IO) { reader.readLine() } ?: break
                    when (val frame = SyncProtocol.parse(line)) {
                        PcFrame.Ping -> send(SyncProtocol.pong())
                        is PcFrame.GetImage -> launch {
                            val jpeg = withContext(Dispatchers.IO) { runCatching { pictures(frame.id) }.getOrNull() }
                            send(SyncProtocol.image(frame.id, jpeg, if (jpeg == null) "not available" else null))
                        }
                        is PcFrame.Read -> hub.markRead(frame.key)
                        is PcFrame.Send -> launch {
                            val error = withContext(Dispatchers.IO) { sms.send(frame.to, frame.text) }
                            send(SyncProtocol.replyResult(frame.id, error))
                        }
                        is PcFrame.Answer -> launch { send(SyncProtocol.replyResult(frame.id, withContext(Dispatchers.IO) { calls.answer(frame.call) })) }
                        is PcFrame.HangUp -> launch { send(SyncProtocol.replyResult(frame.id, withContext(Dispatchers.IO) { calls.hangUp(frame.call, frame.phase) })) }
                        is PcFrame.Dial -> launch {
                            val error = withContext(Dispatchers.IO) {
                                val number = frame.number ?: frame.key?.let(sms::addressOf)
                                if (number == null) "no single number for this conversation" else calls.dial(number)
                            }
                            send(SyncProtocol.replyResult(frame.id, error))
                        }
                        is PcFrame.Reply -> launch {
                            val error = when (val result = hub.sendReply(frame.key, frame.text)) {
                                ReplyResult.Sent -> null
                                is ReplyResult.Failed -> result.reason.name.lowercase().replace('_', ' ')
                            }
                            send(SyncProtocol.replyResult(frame.id, error))
                        }
                        is PcFrame.Clip,
                        is PcFrame.FileOffer,
                        is PcFrame.FileChunk,
                        is PcFrame.FileEnd,
                        is PcFrame.FileResult,
                        is PcFrame.FileCancel,
                        -> transfers.onFrame(frame)
                        else -> Unit
                    }
                }
            } finally {
                if (activeOutbox === outbox) activeOutbox = null
                outbox.texts.close()
                outbox.files.close()
                while (true) {
                    val pending = outbox.files.tryReceive().getOrNull() ?: break
                    if (pending is OutgoingFiles.Prepared) pending.files.forEach(OutgoingFile::close)
                }
                transfers.abortIncoming()
                syncer.cancel()
                caller.cancel()
                textSender.cancel()
                fileSender.cancel()
            }
            Outcome.CLOSED_AFTER_WELCOME
        } finally {
            closer.cancel()
        }
    }

    /**
     * Every conversation the phone shows right now, newest first. Each one's own flow is
     * subscribed while it is in the list: a new message that only reorders the list or changes a
     * preview does not resubscribe them all.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    private fun fromHub(): Flow<List<SyncConversation>> = channelFlow {
        val chats = hub.inbox().map { it.take(SyncProtocol.MAX_CONVERSATIONS) }.stateIn(this)
        chats
            .map { list -> list.mapTo(HashSet()) { it.key } }
            .distinctUntilChanged()
            .flatMapLatest { keys ->
                val threads = if (keys.isEmpty()) flowOf(emptyMap()) else combine(keys.map { key -> hub.thread(key, SyncProtocol.MAX_MESSAGES).map { key to it } }) { it.toMap() }
                combine(chats, threads) { list, threadByKey ->
                    // The list already holds other conversations; the flows for them are on their way.
                    if (list.mapTo(HashSet()) { it.key } != keys) return@combine null
                    list.mapNotNull { chat ->
                        val thread = threadByKey[chat.key] ?: return@mapNotNull null
                        SyncConversation(
                            key = chat.key,
                            title = chat.title,
                            isGroup = chat.isGroup,
                            unread = chat.unreadCount,
                            lastActivityMs = chat.timeMs,
                            canReply = thread.canReply,
                            sender = chat.sender,
                            messages = thread.messages.takeLast(SyncProtocol.MAX_MESSAGES).map {
                                SyncMessage(it.id.toString(), it.senderName, it.text, it.timeMs, it.outgoing, it.status.name.lowercase(), it.media?.name?.lowercase(), it.imageId)
                            },
                        )
                    }
                }.filterNotNull()
            }
            .collect { send(it) }
    }

    /**
     * Sends every conversation the PC does not hold yet ([welcome] says what it kept from an
     * earlier connection), then each again whenever it changes. The hub already merges the SMS
     * inbox with notified chats, so the PC sees what this phone shows.
     *
     * What was sent is kept as values, not frames: comparing them is cheap, and a frame is only
     * built for one that changed. A frame is a function of every field, so equal values mean equal frames.
     */
    internal suspend fun syncConversations(welcome: PcFrame.Welcome = PcFrame.Welcome(""), send: suspend (String) -> Unit) {
        // Frame hashes the PC kept from an earlier connection; each is checked once, then dropped.
        val held = HashMap(welcome.conversations)
        val sent = HashMap<String, SyncConversation>()
        fromHub().conflate().collect { conversations ->
            for (c in conversations) {
                if (sent[c.key] == c) continue
                val line = SyncProtocol.conversation(c)
                val pcHash = held.remove(c.key)
                if (pcHash == null || pcHash != SyncProtocol.frameHash(line)) send(line)
                sent[c.key] = c
            }
            val current = conversations.mapTo(HashSet()) { it.key }
            for (key in (sent.keys + held.keys) - current) {
                send(SyncProtocol.removed(key))
                sent.remove(key)
                held.remove(key)
            }
        }
    }

    /** Sends the call now and the call log after the welcome, then each again when it changes. */
    internal suspend fun syncCalls(send: suspend (String) -> Unit) = coroutineScope {
        launch { calls.current.collect { send(SyncProtocol.call(it)) } }
        calls.log.collect { send(SyncProtocol.callLog(it)) }
    }

    /** The first of [hosts] that answers, and its socket. */
    private fun openFirst(
        hosts: List<String>,
        trust: X509TrustManager,
        shouldStop: () -> Boolean = { false },
        onSocket: (SSLSocket) -> Unit = {},
    ): Pair<String, SSLSocket> {
        var last: Exception? = null
        for (host in hosts.filter { SyncProtocol.isLocalAddress(it) }) {
            if (shouldStop()) break
            try {
                return host to openSocket(host, trust, onSocket)
            } catch (e: Exception) {
                last = e
            }
        }
        throw last ?: java.io.IOException("no local address")
    }

    private fun openSocket(host: String, trust: X509TrustManager, onSocket: (SSLSocket) -> Unit = {}): SSLSocket {
        val context = SSLContext.getInstance("TLSv1.3")
        // The phone's own certificate goes along on every connection: it is how the PC knows it.
        context.init(identity.keyManagers(), arrayOf(trust), SecureRandom())
        val socket = context.socketFactory.createSocket() as SSLSocket
        try {
            onSocket(socket)
            socket.enabledProtocols = arrayOf("TLSv1.3")
            socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
            socket.soTimeout = HANDSHAKE_TIMEOUT_MS
            socket.startHandshake()
            socket.keepAlive = true
            return socket
        } catch (e: Exception) {
            runCatching { socket.close() }
            throw e
        }
    }

    private fun deviceName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .filter { it.isNotBlank() }
        .distinct()
        .joinToString(" ") { name -> name.replaceFirstChar { it.uppercase() } }
        .ifBlank { "Android phone" }

    private fun randomToken(bytes: Int): String = Base64.getEncoder().encodeToString(ByteArray(bytes).also { SecureRandom().nextBytes(it) })

    companion object {
        private const val MIN_BACKOFF_MS = 2_000L
        private const val MAX_BACKOFF_MS = 60_000L
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val HANDSHAKE_TIMEOUT_MS = 10_000
        private const val PAIRING_TIMEOUT_MS = 130_000
        private const val LOCATE_TIMEOUT_MS = 8_000L
        private const val LAN_WAIT_MS = 60_000L
        /** How long a reconnect looks for Wi-Fi or Ethernet once the PC has been reached without them. */
        private const val LAN_PROBE_MS = 500L
        internal const val CODE_MISMATCH_MESSAGE =
            "The codes didn't match, so this phone didn't connect. Another device on this Wi-Fi may have answered. Try again."
    }
}

/** Accepts only the PC certificate this phone paired with. */
private class Pinned(private val fingerprint: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("no certificate")
        if (SyncProtocol.certFingerprint(leaf.encoded) != fingerprint) throw CertificateException("not the paired PC")
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = throw CertificateException("client")
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * While pairing, any certificate is accepted and recorded: the pairing code, which both screens
 * show and the user compares, is what proves it is the right PC.
 */
private class TrustOnFirstUse(private val record: (String) -> Unit) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("no certificate")
        record(SyncProtocol.certFingerprint(leaf.encoded))
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = throw CertificateException("client")
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/** Observe all LAN transports, including isolated Wi-Fi without validated internet. */
internal fun lanAvailability(context: Context): Flow<Boolean> = callbackFlow {
    val manager = context.getSystemService(ConnectivityManager::class.java)
    val networks = mutableSetOf<Network>()
    val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            synchronized(networks) {
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) networks.add(network)
                else networks.remove(network)
                trySend(networks.isNotEmpty())
            }
        }
        override fun onLost(network: Network) {
            synchronized(networks) { networks.remove(network); trySend(networks.isNotEmpty()) }
        }
    }
    manager.registerNetworkCallback(NetworkRequest.Builder().clearCapabilities().build(), callback)
    synchronized(networks) {
        manager.allNetworks.forEach { network ->
            manager.getNetworkCapabilities(network)?.let { caps ->
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) networks.add(network)
            }
        }
        trySend(networks.isNotEmpty())
    }
    awaitClose { manager.unregisterNetworkCallback(callback) }
}.distinctUntilChanged()
