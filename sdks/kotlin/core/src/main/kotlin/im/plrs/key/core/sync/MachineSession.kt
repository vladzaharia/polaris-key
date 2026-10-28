// The machine's session: sign-in and sign-out, the principal-change exit, the clock, the network and
// the ring's lock state (Python `sign_in`, `sign_out`, `_leave`, `advance`, `set_network`, `set_root`).

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_PENDING_DAYS
import im.plrs.key.core.SYNC_SIGNOUT_FLUSH_MS

/** Who is signed in, what the clock and the network say, and whether the ring has its root. */
public interface SyncSession {
    public fun signIn(subject: String): CallResult

    public fun signOut(discardUnsynced: Boolean = false): CallResult

    /** `online` or `offline`. A request in flight must be answered first. */
    public fun setNetwork(state: String)

    /** Move the clock, firing debounce commits and the sign-out flush deadline in time order. */
    public fun advance(ms: Long)

    /** The ring's root arrived (unlock) or went away (lock). */
    public fun setRoot(present: Boolean)

    /** What discovery says about `services.sync.encryption`; null forgets it. */
    public fun setDiscovery(discovery: SyncDiscovery?)
}

private const val DAY_MS = 86_400_000L

internal class MachineSession(private val p: MachineParts) : SyncSession {
    private val core get() = p.core
    private val routing get() = p.routing

    override fun signIn(subject: String): CallResult {
        if (core.s.subject == subject) return CallResult.Ok
        if (core.s.subject != null) leave("signOut", false)
        p.journal.commitAllDrafts()
        val before = p.layers.valueMap()
        core.s.blocked = null
        core.signingOut = null
        expirePartitions()
        val part = core.partitionFor(subject)
        part.signedOutAt = null
        val local = core.partitionFor(LOCAL_PARTITION)
        val moving = local.device.keys.filter { routing.syncs(it) }.sorted()
        // A sign-in change re-sends every parked edit (R5), except one a moved local edit replaces.
        moving.forEach { p.journal.dropParkedByLocalEdit(part, it) }
        p.journal.unpark(part) { true }
        for (key in moving) p.journal.moveDeviceEntry(part, key, local.device.getValue(key))
        moving.forEach { local.device.remove(it) }
        core.s.subject = subject
        core.pullWanted = true
        core.needSnapshot = false
        p.layers.emitChanges(before, emptyMap(), "remote")
        p.pump.kick()
        return CallResult.Ok
    }

    override fun signOut(discardUnsynced: Boolean): CallResult {
        if (core.s.subject == null) return CallResult.Ok
        p.journal.commitAllDrafts()
        val canFlush = !discardUnsynced && core.network == "online" && core.s.blocked == null && core.mayTalk() &&
            p.reads.sendable(core.active()) > 0
        if (canFlush) {
            core.signingOut = SigningOut(core.now + SYNC_SIGNOUT_FLUSH_MS, discardUnsynced)
            p.pump.kick()
        } else {
            leave("signOut", discardUnsynced)
        }
        return CallResult.Ok
    }

    /** Sign-out, and every principal change handled like it. */
    fun leave(reason: String, discard: Boolean) {
        if (core.s.subject == null) return
        p.journal.commitAllDrafts()
        val before = p.layers.valueMap()
        val part = core.active()
        val unsynced = part.pending.size + part.held.size
        if (discard) {
            part.pending = mutableListOf()
            part.held = linkedMapOf()
        }
        if (core.opts.onSignOut == "clear" || reason != "signOut") {
            part.settings = linkedMapOf()
            part.records = linkedMapOf()
            part.cursor = 0
        }
        part.signedOutAt = core.now
        core.s.subject = null
        core.signingOut = null
        core.inFlight = null
        core.needSnapshot = false
        core.pullWanted = false
        core.events.add(SyncEvent.SignedOut(reason, unsynced))
        if (unsynced > 0 && !discard) core.events.add(SyncEvent.UnsyncedData(unsynced))
        p.layers.emitChanges(before, emptyMap(), "remote")
    }

    fun expirePartitions() {
        val gone = core.s.partitions.filter { (name, part) ->
            name != LOCAL_PARTITION && name != core.s.subject && part.signedOutAt?.let { core.now - it >= SYNC_PENDING_DAYS * DAY_MS } == true
        }
        gone.keys.forEach { core.s.partitions.remove(it) }
    }

    /** A lock, an unlock or a discovery answer changed what may be sent. */
    private fun gateChanged() {
        val so = core.signingOut
        if (so != null && core.s.subject != null && !core.mayTalk()) leave("signOut", so.discard) else p.pump.kick()
    }

    override fun setRoot(present: Boolean) {
        if (core.root == present) return
        core.root = present
        gateChanged()
    }

    override fun setDiscovery(discovery: SyncDiscovery?) {
        val before = core.advertised
        core.advertised = discovery?.let { it.encryption ?: "omitted" }
        if (core.advertised == "e2e" && core.requiresE2e()) core.s.e2eSeen = true
        if (before != core.advertised) gateChanged()
    }

    override fun setNetwork(state: String) {
        check(!(state == "offline" && core.inFlight != null)) { "network: a request is in flight; respond first" }
        core.network = state
        if (state == "online") {
            core.pullWanted = true
            p.pump.kick()
        }
    }

    override fun advance(ms: Long) {
        val target = core.now + ms
        while (true) {
            val draftDue = core.drafts.values.map { it.due }.filter { it <= target }.minOrNull()
            val so = core.signingOut?.takeIf { it.deadline <= target }
            val next = listOfNotNull(draftDue, so?.deadline).minOrNull() ?: break
            core.now = next
            fire(next, so)
        }
        core.now = target
    }

    /** The sign-out deadline wins a tie with a debounce commit; otherwise the due drafts commit and the pump runs. */
    private fun fire(at: Long, so: SigningOut?) {
        if (so != null && so.deadline == at) {
            core.inFlight = null
            leave("signOut", so.discard)
        } else {
            core.drafts.filter { it.value.due == at }.keys.sorted().forEach { p.journal.commitDraft(it) }
            p.pump.kick()
        }
    }
}
