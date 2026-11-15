package app.kainos.talk.sync

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.Executors

/**
 * A PC running Kainos Talk, found on the local network. [fingerprint] (its certificate's
 * SHA-256, from the mDNS record) is what identifies it; [host] is only where it is right now.
 */
data class FoundPc(val name: String, val hosts: List<String>, val fingerprint: String?, val serviceName: String = name)

/** Finds PCs that advertise `_kainos-talk._tcp` over mDNS, while the Connect screen is open. */
class PcDiscovery(context: Context) {
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val executor = Executors.newSingleThreadExecutor()
    private val state = MutableStateFlow<List<FoundPc>>(emptyList())
    val found: StateFlow<List<FoundPc>> = state
    private var listener: NsdManager.DiscoveryListener? = null
    private val watching = mutableMapOf<String, NsdManager.ServiceInfoCallback>()
    private val resolving = mutableSetOf<String>()

    private var users = 0

    /**
     * Where the PC with this certificate is now: discovery runs (alongside any the Connect
     * screen has open) until it shows up or [timeoutMs] passes.
     */
    suspend fun locate(fingerprint: String, timeoutMs: Long): FoundPc? {
        start()
        return try {
            withTimeoutOrNull(timeoutMs) { found.map { list -> list.firstOrNull { it.fingerprint == fingerprint } }.filterNotNull().first() }
        } finally {
            stop()
        }
    }

    /** Counted: discovery stops when the last user stops it. */
    @Synchronized
    fun start() {
        users++
        if (listener != null || nsd == null) return
        state.value = emptyList()
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(info: NsdServiceInfo) = watch(info)
            override fun onServiceLost(info: NsdServiceInfo) {
                state.update { list -> list.filterNot { it.serviceName == info.serviceName } }
            }
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }
        listener = discovery
        runCatching { nsd.discoverServices(SyncProtocol.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery) }
    }

    @Synchronized
    fun stop() {
        users = (users - 1).coerceAtLeast(0)
        if (users > 0) return
        listener?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
        listener = null
        if (Build.VERSION.SDK_INT >= 34) watching.values.forEach { runCatching { nsd?.unregisterServiceInfoCallback(it) } }
        watching.clear()
        resolving.clear()
    }

    @Synchronized
    private fun watch(info: NsdServiceInfo) {
        val name = info.serviceName
        if (name in watching || name in resolving || nsd == null) return
        val label = name.removePrefix("Kainos Talk on ")
        fun publish(addresses: List<String>, attributes: Map<String, ByteArray?>) {
            // Every local address the PC announced, IPv4 first; the client tries them in turn.
            val hosts = addresses.filter { SyncProtocol.isLocalAddress(it) }.distinct().sortedBy { it.contains(':') }
            if (hosts.isEmpty()) return
            val fingerprint = attributes["fp"]?.toString(Charsets.UTF_8)?.uppercase()?.takeIf { Regex("^[0-9A-F]{64}$").matches(it) }
            state.update { list -> list.filterNot { it.serviceName == name } + FoundPc(label, hosts, fingerprint, name) }
        }
        if (Build.VERSION.SDK_INT >= 34) {
            val callback = object : NsdManager.ServiceInfoCallback {
                override fun onServiceUpdated(updated: NsdServiceInfo) = publish(updated.hostAddresses.map { it.hostAddress.orEmpty() }, updated.attributes)
                override fun onServiceLost() {
                    state.update { list -> list.filterNot { it.serviceName == name } }
                }
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit
                override fun onServiceInfoCallbackUnregistered() = Unit
            }
            watching[name] = callback
            runCatching { nsd.registerServiceInfoCallback(info, executor, callback) }
        } else {
            resolving += name
            @Suppress("DEPRECATION")
            runCatching {
                nsd.resolveService(
                    info,
                    object : NsdManager.ResolveListener {
                        override fun onServiceResolved(resolved: NsdServiceInfo) {
                            synchronized(this@PcDiscovery) { resolving -= name }
                            publish(listOfNotNull(resolved.host?.hostAddress), resolved.attributes)
                        }
                        override fun onResolveFailed(failed: NsdServiceInfo, errorCode: Int) {
                            synchronized(this@PcDiscovery) { resolving -= name }
                        }
                    },
                )
            }
        }
    }
}
