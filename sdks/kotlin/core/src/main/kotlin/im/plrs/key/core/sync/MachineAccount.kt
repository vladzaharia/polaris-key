// The `account_required` exit (WIRE-CONTRACT-V5 11.5): the `/sync` 403 and the host's report of the same code from a
// route the machine does not drive (a key ring call, a file transfer).

package im.plrs.key.core.sync

/** What the host calls when a route other than `/sync` answered `account_required`, and what a relaunch carries. */
public interface SyncAccount {
    /**
     * The same transition as the `/sync` 403. Nothing happens with no subject or when already blocked this way. A request
     * in flight is abandoned, so its answer is for the host to drop ([SyncExchange.awaiting]).
     */
    public fun accountRequired(signInUrl: String? = null)

    /** Whether the device holds the ring's root ([SyncSession.setRoot]); a relaunch carries it. */
    public val hasRoot: Boolean
}

internal class MachineAccount(private val p: MachineParts) : SyncAccount {
    private val core get() = p.core

    override val hasRoot: Boolean get() = core.root

    override fun accountRequired(signInUrl: String?) {
        if (core.s.subject == null || core.s.blocked == "account_required") return
        leave(signInUrl)
    }

    /**
     * The subject's partition is deleted whole (pending, held, snapshot, cursor, clientId, E2E bookkeeping), the root is
     * forgotten and the device stays blocked, across a relaunch, until `signIn`. The unsynced count is reported; its edits
     * are not kept (no `unsyncedData`).
     */
    fun leave(signInUrl: String?) {
        p.session.leave("accountRequired", true)
        core.root = false
        core.s.blocked = "account_required"
        core.events.add(SyncEvent.SignInOffered(signInUrl))
    }
}
