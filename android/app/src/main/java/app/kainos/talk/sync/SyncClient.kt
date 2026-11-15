package app.kainos.talk.sync

import android.content.Context
import android.os.Build
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import app.kainos.talk.core.Source
import app.kainos.talk.core.MailAction
import app.kainos.talk.hub.ActionResult
import app.kainos.talk.hub.InboxItem
import app.kainos.talk.hub.ReplyResult
import app.kainos.talk.hub.TalkHub
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.merge
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
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/** Where the phone stands with its PC. */
sealed interface SyncStatus {
    data object NotPaired : SyncStatus
    data class Connecting(val pcName: String) : SyncStatus
    data class Connected(val pcName: String) : SyncStatus

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
    data class Failed(val reason: String) : PairResult
}

/** What the "Connect to PC" screen needs; a fake stands in for it in UI tests. */
interface SyncControl {
    val status: StateFlow<SyncStatus>
    val discovered: StateFlow<List<FoundPc>>
    fun startDiscovery()
    fun stopDiscovery()

    /** Pairs with a PC found on the network; [onCode] gets the code both screens show. */
    suspend fun pair(pc: FoundPc, onCode: (String) -> Unit): PairResult
    fun forget()

    /** While pairing: the user compared the codes; true when they match, false to cancel. */
    fun confirmCode(matches: Boolean)

    /** Reads the SMS inbox again, after the user granted access to it. */
    fun refreshInbox()
}

/**
 * The phone end of PC sync: keeps one TLS connection to the paired PC while the app runs, sends
 * it every conversation and mail the inbox shows, and passes the PC's replies, reads and mail
 * actions to the hub. Nothing goes anywhere but the paired PC, at a local address.
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
) : SyncControl {
    private val settings = SyncSettings(context)
    private val discovery = PcDiscovery(context)
    override fun refreshInbox() = sms.refresh()
    private val statusState = MutableStateFlow<SyncStatus>(settings.load()?.let { SyncStatus.Connecting(it.pcName) } ?: SyncStatus.NotPaired)
    override val status: StateFlow<SyncStatus> = statusState
    override val discovered: StateFlow<List<FoundPc>> = discovery.found
    private var loop: Job? = null
    @Volatile private var pendingConfirmation: CompletableDeferred<Boolean>? = null

    fun start() {
        if (loop?.isActive == true || settings.load() == null) return
        loop = scope.launch(Dispatchers.IO) { connectLoop() }
    }

    override fun startDiscovery() = discovery.start()

    override fun stopDiscovery() = discovery.stop()

    override fun forget() {
        settings.clear()
        val job = loop
        loop = null
        scope.launch { job?.cancelAndJoin() }
        statusState.value = SyncStatus.NotPaired
    }

    override suspend fun pair(pc: FoundPc, onCode: (String) -> Unit): PairResult = pairAt(pc.hosts, pc.fingerprint, pc.name, onCode)

    /**
     * Pairs with the PC at [host]. When the PC's mDNS record named its certificate, the one TLS
     * shows must be the same.
     */
    internal suspend fun pairAt(hosts: List<String>, expectedFingerprint: String?, name: String, onCode: (String) -> Unit): PairResult = withContext(Dispatchers.IO) {
        val local = hosts.filter { SyncProtocol.isLocalAddress(it) }
        if (local.isEmpty()) return@withContext PairResult.Failed("That computer is not on your local network.")
        var seen: String? = null
        val (host, socket) = try {
            openFirst(local, TrustOnFirstUse { seen = it })
        } catch (e: Exception) {
            return@withContext PairResult.Failed("Can't reach $name. Check that Kainos Talk is open on it and both are on the same Wi-Fi.")
        }
        if (expectedFingerprint != null && seen != expectedFingerprint) {
            runCatching { socket.close() }
            return@withContext PairResult.Failed("Another device answered for $name. Try again.")
        }
        val confirmation = CompletableDeferred<Boolean>()
        pendingConfirmation = confirmation
        try {
            socket.use {
                val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
                val writer = OutputStreamWriter(socket.outputStream, Charsets.UTF_8)
                val nonce = randomToken(16)
                writer.write(SyncProtocol.pair(deviceName(), nonce) + "\n")
                writer.flush()
                val code = (SyncProtocol.parse(reader.readLine() ?: "") as? PcFrame.PairCode)
                    ?: return@withContext PairResult.Failed("The PC is busy pairing another phone. Try again in a minute.")
                onCode(SyncProtocol.pairingCode(seen!!, identity.fingerprint, nonce, code.nonce))
                socket.soTimeout = PAIRING_TIMEOUT_MS
                coroutineScope {
                    // The user's "Codes match" (or Cancel) and the PC's answer can come in any order.
                    val confirm = launch {
                        if (confirmation.await()) {
                            writer.write(SyncProtocol.pairConfirm() + "\n")
                            writer.flush()
                        } else {
                            runCatching { socket.close() }
                        }
                    }
                    val answer = runCatching { SyncProtocol.parse(reader.readLine() ?: "") }.getOrNull()
                    confirm.cancel()
                    when (answer) {
                        is PcFrame.Paired -> {
                            loop?.cancelAndJoin()
                            settings.save(PairedPc(host, seen!!, answer.deviceId, pcName = name))
                            statusState.value = SyncStatus.Connecting(name)
                            start()
                            PairResult.Paired
                        }
                        else -> PairResult.Refused
                    }
                }
            }
        } catch (e: Exception) {
            PairResult.Failed("The connection to the PC dropped. Try again.")
        } finally {
            pendingConfirmation = null
        }
    }

    /** The user compared the codes: true when they match ("Codes match"), false to cancel. */
    override fun confirmCode(matches: Boolean) {
        pendingConfirmation?.complete(matches)
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
            val onLan = withTimeoutOrNull(if (withoutLan) LAN_PROBE_MS else lanWaitMs) { lanAvailable.first { it } } != null
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
                val outcome = session(pc, candidates) {
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

    /** One connection, until it drops. [addresses] are where discovery last saw the PC. */
    private suspend fun session(pc: PairedPc, addresses: List<String>, onWelcome: () -> Unit): Outcome = coroutineScope {
        val (host, socket) = openFirst((listOf(pc.host) + addresses).distinct(), Pinned(pc.fingerprint))
        // Remember where it answered, as the first place to try next time.
        if (host != pc.host) settings.save(pc.copy(host = host))
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
            send(SyncProtocol.hello(pc.deviceId))
            val welcome = when (val answer = SyncProtocol.parse(reader.readLine() ?: return@coroutineScope Outcome.CLOSED)) {
                is PcFrame.Welcome -> {
                    val name = answer.name.ifBlank { pc.host }
                    if (name != pc.pcName) settings.save(pc.copy(pcName = name))
                    statusState.value = SyncStatus.Connected(name)
                    onWelcome()
                    answer
                }
                // Only "unknown phone" means the PC forgot this phone. Anything else (another
                // protocol version during an update, say) is retried like a dropped connection.
                is PcFrame.Denied -> return@coroutineScope if (answer.reason == "unknown phone") Outcome.DENIED else Outcome.MISMATCH
                else -> return@coroutineScope Outcome.CLOSED
            }
            val syncer = launch { syncConversations(welcome, ::send) }
            try {
                while (isActive) {
                    val line = withContext(Dispatchers.IO) { reader.readLine() } ?: break
                    when (val frame = SyncProtocol.parse(line)) {
                        PcFrame.Ping -> send(SyncProtocol.pong())
                        is PcFrame.GetImage -> launch {
                            val jpeg = withContext(Dispatchers.IO) { runCatching { pictures(frame.id) }.getOrNull() }
                            send(SyncProtocol.image(frame.id, jpeg, if (jpeg == null) "not available" else null))
                        }
                        is PcFrame.Read -> if (frame.key in mailKeys) hub.markMailRead(frame.key) else hub.markRead(frame.key)
                        is PcFrame.MailAction -> launch {
                            val action = when (frame.action) {
                                "archive" -> MailAction.ARCHIVE
                                "trash" -> MailAction.TRASH
                                else -> MailAction.MARK_READ
                            }
                            val error = when (val result = hub.mailAction(frame.key, action)) {
                                ActionResult.Requested -> null
                                is ActionResult.Failed -> result.reason.name.lowercase().replace('_', ' ')
                            }
                            send(SyncProtocol.replyResult(frame.id, error))
                        }
                        is PcFrame.Send -> launch {
                            val error = withContext(Dispatchers.IO) { sms.send(frame.to, frame.text) }
                            send(SyncProtocol.replyResult(frame.id, error))
                        }
                        is PcFrame.Reply -> launch {
                            val error = when (val result = hub.sendReply(frame.key, frame.text)) {
                                ReplyResult.Sent -> null
                                is ReplyResult.Failed -> result.reason.name.lowercase().replace('_', ' ')
                            }
                            send(SyncProtocol.replyResult(frame.id, error))
                        }
                        else -> Unit
                    }
                }
            } finally {
                syncer.cancel()
            }
            Outcome.CLOSED_AFTER_WELCOME
        } finally {
            closer.cancel()
        }
    }

    /**
     * Every conversation and mail the phone shows right now, newest first. Each one's own flow is
     * subscribed while it is in the list: a new message that only reorders the list or changes a
     * preview does not resubscribe them all.
     */
    private fun fromHub(): Flow<Pair<List<SyncConversation>, List<SyncMail>>> = channelFlow {
        val lists = hub.inbox(null)
            .map { inbox ->
                inbox.items.filterIsInstance<InboxItem.Chat>().take(SyncProtocol.MAX_CONVERSATIONS) to
                    inbox.items.filterIsInstance<InboxItem.Mail>().take(SyncProtocol.MAX_CONVERSATIONS)
            }
            .stateIn(this)
        lists
            .map { (chats, mails) -> chats.mapTo(HashSet()) { it.key } to mails.mapTo(HashSet()) { it.key } }
            .distinctUntilChanged()
            .flatMapLatest { (chatKeys, mailKeys) ->
                val threads = if (chatKeys.isEmpty()) flowOf(emptyMap()) else combine(chatKeys.map { key -> hub.thread(key, SyncProtocol.MAX_MESSAGES).map { key to it } }) { it.toMap() }
                val details = if (mailKeys.isEmpty()) flowOf(emptyMap()) else combine(mailKeys.map { key -> hub.mailItem(key).map { key to it } }) { it.toMap() }
                combine(lists, threads, details) { (chats, mails), threadByKey, detailByKey ->
                    // The list already holds other conversations; the flows for them are on their way.
                    if (chats.mapTo(HashSet()) { it.key } != chatKeys || mails.mapTo(HashSet()) { it.key } != mailKeys) return@combine null
                    val conversations = chats.mapNotNull { chat ->
                        val thread = threadByKey[chat.key] ?: return@mapNotNull null
                        SyncConversation(
                            key = chat.key,
                            title = chat.title,
                            isGroup = chat.isGroup,
                            unread = chat.unreadCount,
                            lastActivityMs = chat.timeMs,
                            canReply = thread.capabilities.canReply,
                            messages = thread.messages.takeLast(SyncProtocol.MAX_MESSAGES).map {
                                SyncMessage(it.id.toString(), it.senderName, it.text, it.timeMs, it.outgoing, it.status.name.lowercase(), it.media?.name?.lowercase(), it.imageId)
                            },
                            source = chat.source.id,
                            sourceLabel = chat.source.label,
                        )
                    }
                    val mailItems = mails.map { item ->
                        SyncMail(
                            key = item.key,
                            source = item.source.id,
                            sourceLabel = item.source.label,
                            sender = if (item.senderHidden) null else item.sender,
                            subject = item.subject,
                            account = item.accountLabel,
                            timeMs = item.timeMs,
                            read = item.read,
                            actions = detailByKey[item.key]?.actions.orEmpty().map { actionName(it.action) },
                            requested = item.requestedAction?.let(::actionName),
                        )
                    }
                    conversations to mailItems
                }.filterNotNull()
            }
            .collect { send(it) }
    }

    /**
     * Sends every conversation and mail the PC does not hold yet ([welcome] says what it kept from
     * an earlier connection), then each again whenever it changes. The hub already merges the SMS
     * inbox with notified chats, so the PC sees what this phone shows.
     */
    internal suspend fun syncConversations(welcome: PcFrame.Welcome = PcFrame.Welcome(""), send: suspend (String) -> Unit) {
        val chats = Mirror(welcome.conversations, SyncConversation::key, SyncProtocol::conversation, SyncProtocol::removed)
        val mail = Mirror(welcome.mails, SyncMail::key, SyncProtocol::mail, SyncProtocol::mailRemoved)
        fromHub().conflate().collect { (conversations, mails) ->
            chats.update(conversations, send)
            mail.update(mails, send)
            mailKeys = mail.keys()
        }
    }

    /**
     * What the PC holds of one kind (conversations or mails). What was sent is kept as values, not
     * frames: comparing them is cheap, and a frame is only built for one that changed. A frame is
     * a function of every field, so equal values mean equal frames.
     */
    private class Mirror<T>(
        /** Frame hashes the PC kept from an earlier connection; each is checked once, then dropped. */
        held: Map<String, String>,
        private val keyOf: (T) -> String,
        private val frame: (T) -> String,
        private val removed: (String) -> String,
    ) {
        private val held = HashMap(held)
        private val sent = HashMap<String, T>()

        fun keys(): Set<String> = sent.keys.toSet()

        suspend fun update(items: List<T>, send: suspend (String) -> Unit) {
            for (item in items) {
                val key = keyOf(item)
                if (sent[key] == item) continue
                val line = frame(item)
                val pcHash = held.remove(key)
                if (pcHash == null || pcHash != SyncProtocol.frameHash(line)) send(line)
                sent[key] = item
            }
            val current = items.mapTo(HashSet(), keyOf)
            for (key in (sent.keys + held.keys) - current) {
                send(removed(key))
                sent.remove(key)
                held.remove(key)
            }
        }
    }

    /** Mail keys the PC knows, so its "read" goes to the right place. */
    @Volatile private var mailKeys: Set<String> = emptySet()

    private fun actionName(action: MailAction) = when (action) {
        MailAction.ARCHIVE -> "archive"
        MailAction.TRASH -> "trash"
        MailAction.MARK_READ -> "markRead"
    }


    /** The first of [hosts] that answers, and its socket. */
    private fun openFirst(hosts: List<String>, trust: X509TrustManager): Pair<String, SSLSocket> {
        var last: Exception? = null
        for (host in hosts.filter { SyncProtocol.isLocalAddress(it) }) {
            try {
                return host to openSocket(host, trust)
            } catch (e: Exception) {
                last = e
            }
        }
        throw last ?: java.io.IOException("no local address")
    }

    private fun openSocket(host: String, trust: X509TrustManager): SSLSocket {
        val context = SSLContext.getInstance("TLSv1.3")
        // The phone's own certificate goes along on every connection: it is how the PC knows it.
        context.init(identity.keyManagers(), arrayOf(trust), SecureRandom())
        val socket = context.socketFactory.createSocket() as SSLSocket
        try {
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
