// `client.cloudConnect.nearby` -- nearby approval (CC-15.K4; WIRE-CONTRACT-V5 section 15.6.1): a signed-in
// device approves a device that cannot sign itself in, over the local network, with a code both screens show.
// Mirrors Node's `CloudNearby` (packages/sdk-node/src/connect/cloudConnect.ts).
//
//   request(options)    D, the device with no sign-in: browse for approvers nearby and list them for the
//                       person to tap (`choose`)
//   onRequest(handler)  M, a signed-in device: advertise while the person has "Approve a nearby device" open
//                       (or has allowed background approval) and hand each session that reaches the code to
//                       the handler
//
// Rules this file keeps:
//  - nearby is gated by the Identity service's discovery (`nearby` and its endpoints), never by Connect: it
//    works with Connect off. A product that does not serve it gets the typed N/A (`product`);
//  - it carries the vouch over the LAN and calls no route: the host calls `nearby/start`, `poll` and
//    `approve` and gives the answers to the handles;
//  - a runtime with no mDNS adapter answers `nearby-unsupported` (Android until the `:android` glue supplies
//    one; the JVM desktop has its own); so does an adapter that cannot start;
//  - sign-out stops every advert and closes every request (after Connect, before the device leaves it): an
//    epoch checked before and after a start, and the handle added to the stop set in the same atomic step as
//    the last check, so a sign-out that lands while a start is in flight leaves nothing behind (B2a);
//  - `stopAll` never waits for a host callback that blocks past the sign-out bound; `forceStop` drops every
//    socket at once.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.boolValue
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsUnavailableException
import im.plrs.key.core.peer.nearby.ApproverSource
import im.plrs.key.core.peer.nearby.NearbyApprovalHandler
import im.plrs.key.core.peer.nearby.NearbyApprover
import im.plrs.key.core.peer.nearby.NearbyApproverHandle
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyErrorReason
import im.plrs.key.core.peer.nearby.NearbyException
import im.plrs.key.core.peer.nearby.NearbyRequest
import im.plrs.key.core.peer.nearby.NearbyRequestOptions
import im.plrs.key.core.peer.nearby.NearbyRequester
import im.plrs.key.core.peer.nearby.RequesterSigner
import im.plrs.key.core.peer.nearby.RequesterSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/** The Identity discovery members that name nearby approval. */
private const val START = "nearbyStart"
private const val POLL = "nearbyPoll"
private const val APPROVE = "nearbyApprove"

/** The handle a host holds; `stop()` also takes it out of the set the sign-out stops. */
private class ApproverHandle(private val inner: NearbyApproverHandle, private val forget: () -> Unit) : NearbyApproverHandle by inner {
    override suspend fun stop() {
        forget()
        inner.stop()
    }

    override fun toString(): String = "NearbyApproverHandle"
}

public class CloudNearby internal constructor(
    private val connect: ConnectClient,
    private val core: im.plrs.key.core.CoreContext,
    private val now: () -> Long,
) {
    private val lock = Any()
    private val approvers = LinkedHashSet<NearbyApproverHandle>()
    private val requests = LinkedHashSet<NearbyRequest>()

    /** Bumped by every `stopAll`: a start that began before it must not outlive it. */
    private var epoch = 0

    override fun toString(): String = "CloudNearby"

    private fun unsupported(detail: String, reason: String): PolarisException {
        val u = Unsupported(Feature.identityNearby, reason, detail)
        val code = if (reason == UnsupportedReason.product) ErrorCode.serviceUnavailable else ErrorCode.nearbyUnsupported
        return PolarisException(code, "Nearby approval is not available here.", detail = detail, unsupported = u)
    }

    /** Discovery names `nearby` and [endpoints] on the Identity fragment, else the typed N/A. */
    private suspend fun fragment(fresh: Boolean, endpoints: List<String>) {
        if (fresh || core.discoveryDocument() == null) {
            try {
                core.discover()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // An unreachable Worker is not "nearby is off": what discovery last said stands.
            }
        }
        core.requireService(ServiceSlug.identity, Feature.identityNearby)
        val f = core.discoveryDocument()?.services?.get(ServiceSlug.identity)
        if (f == null || !f.enabled || f.extras["nearby"].boolValue != true || endpoints.any { f.endpoints[it].isNullOrEmpty() }) {
            throw unsupported("This product's discovery does not name nearby approval.", UnsupportedReason.product)
        }
    }

    /** Android has no mDNS adapter of its own yet: without one in the options, nearby is `nearby-unsupported` there. */
    private fun requireRuntime(mdns: MdnsAdapter?) {
        if (RuntimeFamily.isAndroid && mdns == null) {
            throw unsupported("This runtime has no local-network discovery adapter; pass one in the options.", UnsupportedReason.runtime)
        }
    }

    /** An adapter that cannot start (no socket on 5353) is the typed N/A, not a crash. */
    private fun wrap(e: Throwable): Nothing {
        if (e is MdnsUnavailableException) throw unsupported(e.message ?: "Local-network discovery is not available.", UnsupportedReason.dependency)
        throw e
    }

    private suspend fun signedIn(): Boolean = core.token() != null && core.storedSubject() != null

    private fun stoppedError() = NearbyException(NearbyErrorReason.closed, "Nearby approval was stopped.")

    /** Keep [add] only if no sign-out landed since [epochAtStart]; the check and the add are one atomic step. */
    private inline fun register(epochAtStart: Int, add: () -> Unit): Boolean = synchronized(lock) {
        if (epochAtStart != epoch) {
            false
        } else {
            add()
            true
        }
    }

    private fun epochNow(): Int = synchronized(lock) { epoch }

    /**
     * D, the device with no sign-in: browse for approvers nearby and list them for the person to tap
     * ([NearbyRequest.choose]). [NearbyRequestOptions.request] is the handle `nearby/start` answered. Throws the
     * typed N/A when the product serves no nearby approval or this runtime cannot browse, and a `closed`
     * [NearbyException] when a sign-out ([stopAll]) landed while it was starting.
     */
    public suspend fun request(options: NearbyRequestOptions): NearbyRequest {
        val epochAtStart = epochNow()
        fragment(true, listOf(START, POLL))
        requireRuntime(options.mdns)
        synchronized(lock) { requests.removeAll { it.closed } }
        if (epochAtStart != epochNow()) throw stoppedError()
        val source = object : RequesterSource {
            override val slug: String = core.product

            override fun now(): Long = this@CloudNearby.now()

            override suspend fun signer(): RequesterSigner = connect.nearbySigner()
        }
        val r = try {
            NearbyRequester.start(source, options)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            wrap(e)
        }
        if (!register(epochAtStart) { requests.add(r) }) {
            runCatching { r.close() }
            throw stoppedError()
        }
        return r
    }

    /**
     * M, a signed-in device: advertise while the person has "Approve a nearby device" open (`prompt`) or has
     * allowed background approval with the permission granted (`prompt = false` with `background = true`), and
     * hand each session that reaches the code to [handler]. Returns the handle that stops, pauses and resumes it.
     * Throws `account_required` when the device is signed out (also when the sign-out landed while this was
     * starting), and the typed N/A when the product serves no nearby approval.
     */
    public suspend fun onRequest(handler: NearbyApprovalHandler, options: NearbyApproverOptions): NearbyApproverHandle {
        val epochAtStart = epochNow()
        fragment(true, listOf(APPROVE))
        requireRuntime(options.mdns)
        if (!signedIn() || epochAtStart != epochNow()) throw signedOut()
        val source = object : ApproverSource {
            override val slug: String = core.product

            override fun now(): Long = this@CloudNearby.now()

            override suspend fun signedIn(): Boolean = this@CloudNearby.signedIn()

            override suspend fun nearbyServed(): Boolean = try {
                fragment(true, listOf(APPROVE))
                true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
        }
        val h = try {
            NearbyApprover.start(source, handler, options)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            wrap(e)
        }
        // The sign-out may have landed while the advert was starting, before the handle was kept: the epoch is
        // read again after the sign-in read, and the handle joins the set in the same atomic step.
        val still = try {
            signedIn()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        if (!still || !register(epochAtStart) { approvers.add(h) }) {
            runCatching { h.stop() }
            throw signedOut()
        }
        return ApproverHandle(h) { synchronized(lock) { approvers.remove(h) } }
    }

    private fun signedOut() = PolarisException(ErrorCode.accountRequired, "Sign in before approving a nearby device.")

    /** Stop every advert and close every request. The sign-out step; also `client.close()`. */
    internal suspend fun stopAll() {
        val (hs, rs) = synchronized(lock) {
            epoch++
            approvers.toList() to requests.toList()
        }
        coroutineScope {
            val jobs = hs.map { async { runCatching { it.stop() } } } + rs.map { async { runCatching { it.close() } } }
            jobs.awaitAll()
        }
        synchronized(lock) {
            approvers.removeAll(hs.toSet())
            requests.removeAll(rs.toSet())
        }
    }

    /** The sign-out bound ran out: drop every socket and listener now, with no goodbye. */
    internal fun forceStop() {
        val (hs, rs) = synchronized(lock) {
            epoch++
            val out = approvers.toList() to requests.toList()
            approvers.clear()
            requests.clear()
            out
        }
        for (h in hs) h.destroy()
        for (r in rs) r.destroy()
    }
}
