package app.kainos.talk.sync

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.InputStream
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import javax.net.ssl.KeyManager
import javax.net.ssl.KeyManagerFactory
import javax.security.auth.x500.X500Principal

/**
 * This phone's own key and certificate, which it shows the PC on every connection. The PC pins
 * the certificate when pairing, so no secret is shared, stored or sent.
 */
interface DeviceIdentity {
    /** SHA-256 of the certificate, upper-case hex: what the PC remembers. */
    val fingerprint: String

    fun keyManagers(): Array<KeyManager>
}

/**
 * The key lives in Android's key store: it is made on first use, never leaves the phone (in
 * secure hardware where the phone has it), and Android signs a self-signed certificate for it.
 */
class KeystoreIdentity : DeviceIdentity {
    private val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    init {
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).apply {
                initialize(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
                        .setCertificateSubject(X500Principal("CN=Kainos Talk phone"))
                        .build(),
                )
            }.generateKeyPair()
        }
    }

    override val fingerprint: String = SyncProtocol.certFingerprint(store.getCertificate(ALIAS).encoded)

    override fun keyManagers(): Array<KeyManager> =
        KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, null) }.keyManagers

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "kainos-sms-sync"
    }
}

/** A key and certificate from a PKCS#12 file: for tests, where Android's key store is missing. */
class Pkcs12Identity(input: InputStream, password: String) : DeviceIdentity {
    private val password = password.toCharArray()
    private val store = KeyStore.getInstance("PKCS12").apply { input.use { load(it, this@Pkcs12Identity.password) } }

    override val fingerprint: String = SyncProtocol.certFingerprint(store.getCertificate(store.aliases().nextElement()).encoded)

    override fun keyManagers(): Array<KeyManager> =
        KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }.keyManagers
}
