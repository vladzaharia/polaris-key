// @pkey-feature connect.local
//
// Local links end to end in :sdk (WIRE-CONTRACT-V5 section 15.12), two devices of one app over one fake LAN (real loopback TCP),
// with no account anywhere: the shower shows a code, the joiner types it (or scans its QR), both people confirm, each device
// stores a link; then the LAN service runs mode `l` under it. The pairing's guess accounting, the gate, the cap, the store and
// the lifecycle of a link (rename, reachable, remove, gate off) are checked here; the byte rows are :conformance's.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.MAX_LIVE_LOCAL_ADVERTS
import im.plrs.key.core.peer.MAX_LOCAL_LINKS
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

class ConnectLocalLinksTest : ConnectLanBase() {
    private val devs = ArrayList<Dev>()

    @After
    fun closeDevices() {
        for (d in devs) {
            runBlocking {
                d.links.detach()
                d.lan?.stop()
            }
            d.links.shutdown()
        }
        resetLocalBudgets()
    }

    private inner class Dev(val net: Network, val confirm: Boolean = true) {
        val storage = InMemoryDeviceKeyStorage()
        val store = LocalLinkStore("djdl") { storage }

        @Volatile var gate = true
        val subs = CopyOnWriteArrayList<() -> Unit>()
        val views = CopyOnWriteArrayList<() -> Unit>()
        val touched = CopyOnWriteArrayList<String>()
        val src = LocalSource(
            slug = "djdl",
            now = { System.currentTimeMillis() / 1000 },
            mono = { System.nanoTime() / 1e9 },
            allowed = { gate },
            store = store,
            notify = {
                for (f in views) f()
                for (f in subs) f()
            },
            onChange = { fn ->
                subs += fn
                ({ subs -= fn })
            },
            onView = { fn ->
                views += fn
                ({ views -= fn })
            },
            live = { if (gate) store.rows().map(::liveOfLocal) else emptyList() },
            touch = { touched += it.id },
        )
        val links = CloudLocalLinks(src)
        var lan: LanService? = null
        val codes = CopyOnWriteArrayList<LocalCode>()
        val linked = CopyOnWriteArrayList<LocalPaired>()
        val failed = CopyOnWriteArrayList<LocalPairFailure>()
        val inbound = CopyOnWriteArrayList<ConnectSession>()

        init {
            devs += this
        }

        fun onConfirm(offer: LocalOffer) {
            scope.launch { if (confirm) offer.confirm() else offer.decline() }
        }

        fun pairOptions(seconds: Double = 30.0) = LocalPairOptions(
            categories = listOf("docs", "music"),
            onCode = { codes += it },
            onConfirm = ::onConfirm,
            label = "Anna",
            onLinked = { linked += it },
            onFailed = { failed += it },
            seconds = seconds,
            mdns = net,
            host = "127.0.0.1",
            allowLoopback = true,
        )

        fun joinOptions(code: String? = null, qr: String? = null, browse: Double = 15.0) = LocalJoinOptions(
            categories = listOf("docs"),
            onConfirm = ::onConfirm,
            code = code,
            qr = qr,
            label = "Bo",
            browseSeconds = browse,
            mdns = net,
            allowLoopback = true,
        )

        fun startLan() {
            val s = LanSource(
                load = { throw LanException(LanErrorReason.no_identity, "no account") },
                now = { System.currentTimeMillis() / 1000 },
                slug = "djdl",
                locals = src.live,
                onLocals = src.onChange,
                localAllowed = { gate },
                localEstablished = { src.touch(it) },
            )
            val l = runBlocking {
                LanService.startLocal(
                    s,
                    LanOptions(mdns = net, host = "127.0.0.1", allowLoopback = true, handshakeSeconds = 10.0, dialSeconds = 5.0),
                )
            }
            lan = l
            runBlocking { links.attach(l) }
            links.onLink { inbound += it }
        }
    }

    private fun typed(code: LocalCode) = code.code

    private fun pairUp(a: Dev, b: Dev, viaQr: Boolean = false): Pair<LocalPaired, LocalPaired> = runBlocking {
        val h = a.links.pair(a.pairOptions())
        until { a.codes.isNotEmpty() }
        val code = a.codes.last()
        val joined = b.links.join(if (viaQr) b.joinOptions(qr = code.qr) else b.joinOptions(code = typed(code)))
        until { a.linked.isNotEmpty() }
        h.stop()
        a.linked.first() to joined
    }

    @Test
    fun aTypedCodePairsTwoDevicesWithNoAccount() {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val (la, lb) = pairUp(a, b)
        val ra = runBlocking { a.store.rows() }.single()
        val rb = runBlocking { b.store.rows() }.single()
        assertEquals(ra.secret, rb.secret)
        assertEquals(ra.ownPublic, rb.peerKey)
        assertEquals(rb.ownPublic, ra.peerKey)
        assertEquals("Bo", la.label)
        assertEquals("Anna", lb.label)
        assertEquals(listOf("docs"), la.categories)
        assertEquals(listOf("docs"), lb.categories)
        assertTrue(ra.reachable && rb.reachable)
        val info = runBlocking { a.links.list() }.single()
        assertEquals(la.id, info.id)
        assertNull(info.lastSeen)
        assertTrue(a.failed.isEmpty() && b.failed.isEmpty())
    }

    @Test
    fun aQrPairsWithoutTypingAndAnotherAppsQrIsNamedAsSuch() {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val (la, _) = pairUp(a, b, viaQr = true)
        assertEquals(1, runBlocking { a.links.list() }.size)
        assertNotNull(la.id)
        val other = Dev(net)
        val e = assertThrows(PolarisException::class.java) {
            runBlocking { other.links.join(other.joinOptions(qr = "PKP1:OTHERAPP:EIVPNFXZF7KYKTLM:PEFKYJON45LZNN3MU6EKDFHRKE")) }
        }
        assertEquals(ErrorCode.pairingCodeFailed, e.code)
        assertEquals("This code is for another app.", e.message)
    }

    @Test
    fun aWrongCodeIsOneFailedGuessTheCodeRotatesAndTheNewCodePairs() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val h = a.links.pair(a.pairOptions())
        until { a.codes.isNotEmpty() }
        val first = a.codes.last()
        val wrong = first.code.replaceRange(8, 9, if (first.code[8] == '1') "2" else "1")
        val e = assertThrows(PolarisException::class.java) { runBlocking { b.links.join(b.joinOptions(code = wrong, browse = 1.0)) } }
        assertEquals(ErrorCode.pairingCodeFailed, e.code)
        // The password rotated (the nameplate stays), and the new code pairs.
        until { a.codes.size >= 2 }
        val second = a.codes.last()
        assertEquals(first.nameplate, second.nameplate)
        assertNotEquals(first.code, second.code)
        resetLocalBudgets()
        b.links.join(b.joinOptions(code = second.code))
        until { a.linked.isNotEmpty() }
        assertTrue(runBlocking { a.store.rows() }.size == 1 && runBlocking { b.store.rows() }.size == 1)
        h.stop()
    }

    @Test
    fun aRetypedCodeMeetsTheSameDialBudgetAndNeverBrowses() = runBlocking {
        val net = Network()
        val b = Dev(net)
        // No shower anywhere: two joins browse and find nothing (one dial each is not spent: no advert). Spend the budget by hand.
        val budget = im.plrs.key.core.peer.DialBudget()
        assertTrue(budget.takeIfAllowed("48", 0.0).allowed)
        assertTrue(budget.takeIfAllowed("48", 1.0).allowed)
        assertFalse(budget.takeIfAllowed("48", 2.0).allowed)
        val e = assertThrows(PolarisException::class.java) { runBlocking { b.links.join(b.joinOptions(code = "4812 3456", browse = 0.2)) } }
        assertEquals(ErrorCode.pairingNotFound, e.code)
    }

    @Test
    fun aDeclineStoresNothingOnEitherDeviceAndTheCodeRotates() = runBlocking {
        val net = Network()
        val a = Dev(net, confirm = true)
        val b = Dev(net, confirm = false)
        val h = a.links.pair(a.pairOptions())
        until { a.codes.isNotEmpty() }
        val e = assertThrows(PolarisException::class.java) { runBlocking { b.links.join(b.joinOptions(code = a.codes.last().code)) } }
        assertEquals(ErrorCode.peerClosed, e.code)
        until { a.failed.isNotEmpty() }
        assertTrue(a.store.rows().isEmpty() && b.store.rows().isEmpty())
        h.stop()
    }

    @Test
    fun theGateOffRefusesPairAndJoinAsTheTypedNA() = runBlocking {
        val a = Dev(Network())
        a.gate = false
        assertFalse(a.links.localPairing())
        val e = assertThrows(LocalPairingOffException::class.java) { runBlocking { a.links.pair(a.pairOptions()) } }
        assertEquals(ErrorCode.localPairingOff, e.code)
        assertEquals(im.plrs.key.core.Feature.connectLocal, e.unsupported?.feature)
        assertThrows(LocalPairingOffException::class.java) { runBlocking { a.links.join(a.joinOptions(code = "48123456")) } }
        // Managing links is never gated.
        assertTrue(a.links.list().isEmpty())
    }

    @Test
    fun aClearedGateClosesTheWindowBeforeAnyoneSeesACode() = runBlocking {
        val a = Dev(Network())
        val h = a.links.pair(a.pairOptions())
        assertTrue(h.open)
        a.gate = false
        a.links.closeAll()
        assertFalse(h.open)
        assertNull(h.code())
    }

    @Test
    fun twoPairCallsThatRaceOpenOneWindow() = runBlocking {
        val a = Dev(Network())
        val both = (0 until 2).map { scope.async { runCatching { a.links.pair(a.pairOptions()) } } }.map { it.await() }
        assertEquals(1, both.count { it.isSuccess })
        val e = both.first { it.isFailure }.exceptionOrNull() as LanException
        assertEquals(LanErrorReason.bad_type, e.reason)
        both.first { it.isSuccess }.getOrThrow().stop()
    }

    @Test
    fun aDeviceAtTheCapAnswersLinksFullBeforeAnythingIsAdvertised() = runBlocking {
        val net = Network()
        val a = Dev(net)
        for (i in 0 until MAX_LOCAL_LINKS) a.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "L$i", emptyList()), 1L)
        assertEquals(MAX_LOCAL_LINKS, a.store.count())
        val paired = assertThrows(LocalPairingException::class.java) { runBlocking { a.links.pair(a.pairOptions()) } }
        assertEquals(ErrorCode.localLinksFull, paired.code)
        assertEquals("stored", paired.cap)
        val joined = assertThrows(PolarisException::class.java) { runBlocking { a.links.join(a.joinOptions(code = "48123456")) } }
        assertEquals(ErrorCode.localLinksFull, joined.code)
        assertTrue(net.names().isEmpty())
        // Only the first eight are reachable by default; a ninth cannot be turned on.
        val rows = a.store.rows()
        assertEquals(MAX_LIVE_LOCAL_ADVERTS, rows.count { it.reachable })
        val off = rows.first { !it.reachable }
        assertEquals(ErrorCode.localLinksFull, assertThrows(PolarisException::class.java) { runBlocking { a.links.setReachable(off.id, true) } }.code)
    }

    @Test
    fun theStoreRejectsAnUnusableRecordAndNeverReplacesIt() = runBlocking {
        val a = Dev(Network())
        a.storage.put("{\"schema\":\"pkey.connect.local.v1\",\"product\":\"djdl\",\"links\":[{\"id\":\"x\"}]}".toByteArray())
        assertEquals(ErrorCode.storeFailed, assertThrows(PolarisException::class.java) { runBlocking { a.links.list() } }.code)
        val added =
            assertThrows(PolarisException::class.java) {
                runBlocking { a.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), null, emptyList()), 1L) }
            }
        assertEquals(ErrorCode.storeFailed, added.code)
        // Nothing replaced the record, and the live links are none while it cannot be read.
        assertTrue(String(a.storage.get()!!).contains("\"id\":\"x\""))
        // A record that names one link twice is as unusable.
        val b = Dev(Network())
        b.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), null, emptyList()), 1L)
        val one = String(b.storage.get()!!)
        val row = one.substringAfter("\"links\":[").substringBeforeLast("]}")
        b.storage.put(one.replace(row, "$row,$row").toByteArray())
        assertEquals(ErrorCode.storeFailed, assertThrows(PolarisException::class.java) { runBlocking { b.links.list() } }.code)
    }

    @Test
    fun aRecordHoldsTheCapAndTwoWritersCannotPassIt() = runBlocking {
        val a = Dev(Network())
        val results = (0 until 40).map { i -> scope.launch { a.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "L$i", emptyList()), 1L) } }
        results.forEach { it.join() }
        assertEquals(MAX_LOCAL_LINKS, a.store.count())
    }

    // -- mode l under the link ---------------------------------------------------------------------

    private fun pairedWithLan(): Triple<Dev, Dev, String> {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val (la, lb) = pairUp(a, b)
        a.startLan()
        b.startLan()
        until { b.lan!!.localPeerIds().contains(lb.id) && a.lan!!.localPeerIds().contains(la.id) }
        return Triple(a, b, lb.id)
    }

    @Test
    fun aLocalLinkOpensASessionBothWaysWithTheStoredLabelAndCategories() {
        val (a, b, bLinkId) = pairedWithLan()
        val s = runBlocking { b.links.open(bLinkId) }
        until { a.inbound.isNotEmpty() }
        val inbound = a.inbound.first()
        val local = checkNotNull(s.local)
        assertEquals("Anna", local.label)
        assertEquals(listOf("docs"), local.categories)
        assertEquals("Bo", checkNotNull(inbound.local).label)
        assertTrue(s.origin is TransferOrigin.Local)
        assertEquals(local.id, (s.origin as TransferOrigin.Local).linkId)
        assertEquals("", s.peerDeviceId)
        runBlocking { s.send("hello".toByteArray()) }
        assertEquals("hello", String(runBlocking { inbound.receive(5000) }.body))
        until { a.touched.isNotEmpty() && b.touched.isNotEmpty() }
        runBlocking { s.close() }
    }

    /** What NsdManager does: a name the browse does not accept when it appears is dropped, and a new browse hears every service again. */
    private class NsdLike(private val inner: Network) : MdnsAdapter {
        override suspend fun advertise(advert: MdnsAdvert): MdnsHandle = inner.advertise(advert)

        override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle =
            inner.browse({ f -> if (accept(f.instance)) onUp(f) }, onDown, accept)
    }

    @Test
    fun aPeerThatAdvertisedBeforeThisDeviceTookTheLinkInIsStillFound() {
        val net = Network()
        val nsd = NsdLike(net)
        val a = Dev(net)
        val b = Dev(net)
        val takenIn = CompletableDeferred<Unit>()
        val hold = AtomicBoolean(false)
        fun start(d: Dev, slow: Boolean) {
            val s = LanSource(
                load = { throw LanException(LanErrorReason.no_identity, "no account") },
                now = { System.currentTimeMillis() / 1000 },
                slug = "djdl",
                // A's list is read late once the hold is on: B has advertised by then.
                locals = {
                    if (slow && hold.get()) takenIn.await()
                    d.src.live()
                },
                onLocals = d.src.onChange,
                localAllowed = { d.gate },
            )
            val l = runBlocking { LanService.startLocal(s, LanOptions(mdns = nsd, host = "127.0.0.1", allowLoopback = true)) }
            d.lan = l
            runBlocking { d.links.attach(l) }
        }
        start(a, slow = true)
        start(b, slow = false)
        hold.set(true)
        val (la, lb) = pairUp(a, b)
        // B advertises under the link while A's list is still unread.
        until { synchronized(net.adverts) { net.adverts.values.any { "m=l" in it.txt } } }
        assertTrue(a.lan!!.localPeerIds().isEmpty())
        takenIn.complete(Unit)
        until { a.lan!!.localPeerIds().contains(la.id) && b.lan!!.localPeerIds().contains(lb.id) }
    }

    @Test
    fun aSessionNobodyTakesIsClosedPeerBye() {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val (la, lb) = pairUp(a, b)
        // `a` starts its listener but registers no onLink listener.
        val lanSrc = LanSource(
            load = { throw LanException(LanErrorReason.no_identity, "no account") },
            now = { System.currentTimeMillis() / 1000 },
            slug = "djdl",
            locals = a.src.live,
            onLocals = a.src.onChange,
            localAllowed = { true },
        )
        val la2 = runBlocking { LanService.startLocal(lanSrc, LanOptions(mdns = net, host = "127.0.0.1", allowLoopback = true)) }
        a.lan = la2
        runBlocking { a.links.attach(la2) }
        b.startLan()
        until { b.lan!!.localPeerIds().contains(lb.id) }
        val s = runBlocking { b.links.open(lb.id) }
        var closed: SessionClosed? = null
        s.onClose { closed = it }
        until { closed != null }
        assertNotNull(la)
    }

    @Test
    fun removeEndsOpenSessionsPeerRevokedAndTheLinkLeavesTheRecordBeforeItReturns() {
        val (a, b, bLinkId) = pairedWithLan()
        val s = runBlocking { b.links.open(bLinkId) }
        until { a.inbound.isNotEmpty() }
        var closed: SessionClosed? = null
        s.onClose { closed = it }
        assertTrue(runBlocking { b.links.remove(bLinkId) })
        assertTrue(runBlocking { b.store.rows() }.isEmpty())
        until { closed != null }
        assertEquals("peer_revoked", closed!!.code)
        // A dial right after the remove finds no link.
        val e = assertThrows(LanException::class.java) { runBlocking { b.links.open(bLinkId) } }
        assertEquals(LanErrorReason.unknown_peer, e.reason)
        assertFalse(runBlocking { b.links.remove(bLinkId) })
    }

    @Test
    fun aGateThatGoesOffEndsTheSessionsAndWithdrawsTheAdverts() {
        val (a, b, bLinkId) = pairedWithLan()
        val s = runBlocking { b.links.open(bLinkId) }
        until { a.inbound.isNotEmpty() }
        var closed: SessionClosed? = null
        s.onClose { closed = it }
        assertTrue(a.net.names().isNotEmpty())
        a.gate = false
        b.gate = false
        runBlocking {
            a.links.closeAll()
            b.links.closeAll()
        }
        a.src.notify()
        b.src.notify()
        until { closed != null }
        assertEquals("peer_bye", closed!!.code)
        until { a.net.names().isEmpty() }
        val e = assertThrows(LocalPairingOffException::class.java) { runBlocking { b.links.open(bLinkId) } }
        assertEquals(ErrorCode.localPairingOff, e.code)
        // The links stay on disk, inert.
        assertEquals(1, runBlocking { b.links.list() }.size)
    }

    @Test
    fun renameIsLocalAndSetReachableMovesTheAdvert() {
        val (a, b, _) = pairedWithLan()
        val id = runBlocking { a.links.list() }.single().id
        assertTrue(runBlocking { a.links.rename(id, "  Studio\u200b laptop ") })
        assertEquals("Studio laptop", runBlocking { a.links.list() }.single().label)
        // The other device's label for this peer is its own.
        assertEquals("Anna", runBlocking { b.links.list() }.single().label)
        assertThrows(LanException::class.java) { runBlocking { a.links.rename(id, "\u200b") } }
        until { a.net.names().size == 2 }
        assertTrue(runBlocking { a.links.setReachable(id, false) })
        until { a.net.names().size == 1 }
        assertTrue(runBlocking { a.links.setReachable(id, true) })
        until { a.net.names().size == 2 }
        assertFalse(runBlocking { a.links.setReachable("nope", true) })
    }

    @Test
    fun openBeforeStartAndOpenOfNoLinkAreTyped() = runBlocking {
        val a = Dev(Network())
        assertEquals(LanErrorReason.not_started, assertThrows(LanException::class.java) { runBlocking { a.links.open("x") } }.reason)
    }

    @Test
    fun anOpenAfterAFastFailureDialsAgain() = runBlocking {
        val a = Dev(Network())
        val id = a.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "Bo", emptyList()), 1L)!!
        // Not started: the dial fails at once.
        val first = assertThrows(LanException::class.java) { runBlocking { a.links.open(id) } }
        assertEquals(LanErrorReason.not_started, first.reason)
        a.startLan()
        // The failed dial was not kept: this open dials again, and now meets the service (the peer is not on the network).
        val second = assertThrows(LanException::class.java) { runBlocking { a.links.open(id) } }
        assertEquals(LanErrorReason.unknown_peer, second.reason)
    }

    @Test
    fun aLinkWipedWhileItWasBeingCopiedIsNotServed() {
        val live = LiveLocal("x", rnd(), rnd(), rnd(), rnd(), null, emptyList(), true)
        val copy = copyLiveLocal(live)!!
        assertArrayEquals(live.secret, copy.secret)
        assertNotSame(live.secret, copy.secret)
        // A reload wipes the held keys: a copy taken after is all zeros, so the link is left out.
        live.secret.fill(0)
        live.ownKey.fill(0)
        assertNull(copyLiveLocal(live))
    }

    @Test
    fun aGateThatWentOffBeforeTheStoreLeavesNoLink() = runBlocking {
        val a = Dev(Network())
        a.gate = false
        val attempt = LocalAttempt()
        attempt.linkKey = rnd()
        val event = SessionEvent.LocalLinked(rnd(), rnd(), rnd(), "Bo", listOf("docs"))
        assertNull(storeLocalLink(a.src, attempt, event))
        assertFalse(attempt.linked)
        assertEquals(0, a.store.count())
        // With the gate on, the same event stores a link.
        a.gate = true
        val again = LocalAttempt()
        again.linkKey = rnd()
        assertNotNull(storeLocalLink(a.src, again, SessionEvent.LocalLinked(rnd(), rnd(), rnd(), "Bo", listOf("docs"))))
        assertEquals(1, a.store.count())
    }
}
