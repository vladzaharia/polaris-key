// @pkey-feature connect.links
//
// The LAN browse hears a service once per browse and drops a name it does not accept yet (NsdManager does the same), so a
// peer that advertised before this device took in the contact must be found when the contact arrives: the browse restarts
// when the names it accepts change. The links and the roster have the same row in ConnectLocalLinksTest and ConnectLanTest.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class ConnectLanRebrowseTest : ConnectLanBase() {
    private class Held(initial: List<LiveContact>) {
        @Volatile
        var list: List<LiveContact> = initial
        val fns = CopyOnWriteArrayList<() -> Unit>()

        fun set(l: List<LiveContact>) {
            list = l
            for (f in fns) f()
        }
    }

    /** A fresh copy of each contact per call: the service zeroes what it replaces. */
    private fun copyOf(c: LiveContact) = LiveContact(
        c.id,
        c.agreeKey,
        c.agreeKeyBytes.copyOf(),
        c.secret.copyOf(),
        c.label,
        c.cats,
        c.reachable,
        c.pending,
    )

    private fun source(w: World, d: Device, held: Held): LanSource = LanSource(
        load = { w.peerSource(d, roster = listOf(d.id)) },
        now = { w.now },
        contacts = { held.list.map(::copyOf) },
        onContacts = { fn ->
            held.fns += fn
            ({ held.fns -= fn })
        },
    )

    @Test
    fun aContactThatAdvertisedBeforeThisDeviceTookItInIsStillFound() {
        val w = World()
        val (a, b) = w.a to w.b
        val secret = rnd()

        fun live(key: String) = LiveContact(
            contactId(key),
            key,
            Base64Url.decodeStrict(key)!!,
            secret.copyOf(),
            "Peer",
            listOf("docs"),
            true,
            false,
        )

        w.start(b, source(w, b, Held(listOf(live(a.agreeKey)))))
        val mine = Held(emptyList())
        // A browses like the OS does: B's contact name is refused (A holds no contact yet) and not reported again.
        val svc = w.start(a, source(w, a, mine), mdns = NsdLike(w.net))
        until { w.net.names().size == 3 }
        assertTrue(svc.contactPeerIds().isEmpty())
        mine.set(listOf(live(b.agreeKey)))
        until { svc.contactPeerIds().isNotEmpty() }
    }
}
