// @pkey-feature connect.local
//
// The kit-support API of local pairing in :sdk (WIRE-CONTRACT-V5 section 15.12; the reference is sdk-node's
// `localLinksKit.test.ts`): a code says why it is on show, `renew()`, `onInterrupted`, `onEnd`, the renewal floor and the
// nameplate memory, the joiner's reasons, `dialsLeft` and cancellation, the list's `onChange`, the platform and the caps. Two
// devices of one app over one fake LAN (real loopback TCP); the clock of a window is injected, and every wait is on a
// condition.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.PLATFORM_VALUES
import im.plrs.key.core.peer.MAX_LIVE_LOCAL_ADVERTS
import im.plrs.key.core.peer.MAX_LOCAL_LINKS
import im.plrs.key.core.peer.encodeFrame
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

class ConnectLocalLinksKitTest : ConnectLanBase() {
    private val devs = ArrayList<Dev>()

    @After
    fun closeDevices() {
        for (d in devs) {
            runBlocking { d.links.detach() }
            d.links.shutdown()
        }
        resetLocalBudgets()
    }

    /** An mDNS adapter that can hold the next advert back, so a test can act while a window is still opening. */
    private class GatedMdns(private val inner: MdnsAdapter) : MdnsAdapter {
        @Volatile var hold: CompletableDeferred<Unit>? = null
        val reached = CompletableDeferred<Unit>()

        override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
            val g = hold
            if (g != null) {
                reached.complete(Unit)
                g.await()
            }
            return inner.advertise(advert)
        }

        override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle =
            inner.browse(onUp, onDown, accept)
    }

    private inner class Dev(val net: Network, val confirm: Boolean = true) {
        val storage = InMemoryDeviceKeyStorage()
        val store = LocalLinkStore("djdl") { storage }

        @Volatile var gate = true

        /** The monotonic clock of this device's windows, in seconds. */
        @Volatile var t = 1000.0
        val subs = CopyOnWriteArrayList<() -> Unit>()
        val views = CopyOnWriteArrayList<() -> Unit>()
        val src = LocalSource(
            slug = "djdl",
            now = { System.currentTimeMillis() / 1000 },
            mono = { t },
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
            touch = {},
        )
        val links = CloudLocalLinks(src)
        val codes = CopyOnWriteArrayList<LocalCode>()
        val linked = CopyOnWriteArrayList<LocalPaired>()
        val failed = CopyOnWriteArrayList<LocalPairFailure>()
        val ends = CopyOnWriteArrayList<LocalWindowEnd>()
        val interrupts = CopyOnWriteArrayList<Int>()

        init {
            devs += this
        }

        fun onConfirm(offer: LocalOffer) {
            scope.launch { if (confirm) offer.confirm() else offer.decline() }
        }

        fun pairOptions(
            seconds: Double = 30.0,
            mdns: MdnsAdapter = net,
            random: ((Int) -> ByteArray)? = null,
            onEnd: (LocalWindowEnd) -> Unit = { ends += it },
        ) = LocalPairOptions(
            categories = listOf("docs"),
            onCode = { codes += it },
            onConfirm = ::onConfirm,
            label = "Anna",
            onLinked = { linked += it },
            onFailed = { failed += it },
            seconds = seconds,
            mdns = mdns,
            host = "127.0.0.1",
            allowLoopback = true,
            onInterrupted = { interrupts += it },
            onEnd = onEnd,
        ).also {
            it.mono = { t }
            if (random != null) it.random = random
        }

        fun joinOptions(
            code: String? = null,
            qr: String? = null,
            browse: Double = 5.0,
            onConfirm: (LocalOffer) -> Unit = ::onConfirm,
            random: ((Int) -> ByteArray)? = null,
        ) = LocalJoinOptions(
            categories = listOf("docs"),
            onConfirm = onConfirm,
            code = code,
            qr = qr,
            label = "Bo",
            browseSeconds = browse,
            mdns = net,
            allowLoopback = true,
        ).also { if (random != null) it.random = random }
    }

    private fun wrongOf(code: String): String = code.replaceRange(8, 9, if (code[8] == '1') "2" else "1")

    private fun tamperedQr(qr: String): String {
        val at = qr.lastIndexOf(':') + 6
        return qr.replaceRange(at, at + 1, if (qr[at] == 'A') "B" else "A")
    }

    private fun joinError(b: Dev, o: LocalJoinOptions): LocalPairingException =
        assertThrows(LocalPairingException::class.java) { runBlocking { b.links.join(o) } }

    // -- the shower: the code, the window and renew() ---------------------------------------------

    @Test
    fun aCodeSaysWhyItIsOnShowWhenTheWindowEndsAndHowManyGuessesWereCounted() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val before = System.currentTimeMillis() / 1000
        val h = a.links.pair(a.pairOptions(seconds = 30.0))
        val first = a.codes.single()
        assertEquals(LocalCodeReason.Opened, first.reason)
        assertEquals(0, first.failures)
        assertTrue(first.expiresAt in before + 30..System.currentTimeMillis() / 1000 + 30)
        joinError(b, b.joinOptions(code = wrongOf(first.code)))
        until { a.codes.size == 2 }
        val second = a.codes.last()
        assertEquals(LocalCodeReason.WrongCode, second.reason)
        assertEquals(1, second.failures)
        assertEquals(first.expiresAt, second.expiresAt)
        assertEquals(first.nameplate, second.nameplate)
        h.stop()
    }

    @Test
    fun renewOpensAWindowThatIsNewInEveryRespectAndNeverReusesARecentNameplate() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val rand = java.security.SecureRandom()
        // The nameplate draw reads one byte at a time: 48, then (the window just closed holds it) 48 again and 55.
        val bytes = ArrayDeque(listOf(48, 48, 55))
        val random: (Int) -> ByteArray = { n ->
            if (n == 1) byteArrayOf(bytes.removeFirst().toByte()) else ByteArray(n).also { rand.nextBytes(it) }
        }
        val h = a.links.pair(a.pairOptions(random = random))
        val first = a.codes.single()
        assertEquals("48", first.nameplate)
        val next = h.renew()
        assertEquals("55", next.nameplate)
        assertEquals(LocalCodeReason.Opened, next.reason)
        assertEquals(0, next.failures)
        assertNotEquals(first.code, next.code)
        assertNotEquals(first.qr, next.qr)
        assertTrue(h.open)
        assertEquals(next.code, h.code()?.code)
        // The advert of the old window is gone and exactly one is up, and a replaced window makes no onEnd.
        assertEquals(1, net.names().size)
        assertTrue(a.ends.isEmpty())
        h.stop()
        assertEquals(listOf(LocalWindowEnd.Person), a.ends.toList())
        assertTrue(net.names().isEmpty())
    }

    @Test
    fun aWindowThatComesToItsOwnEndSaysExpired() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val h = a.links.pair(a.pairOptions(seconds = 0.3))
        until { LocalWindowEnd.Expired in a.ends }
        assertEquals(listOf(LocalWindowEnd.Expired), a.ends.toList())
        assertFalse(h.open)
        assertNull(h.code())
        until { net.names().isEmpty() }
    }

    @Test
    fun renewWorksOnAClosedHandleAndRefusesWhatPairRefuses() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val h = a.links.pair(a.pairOptions())
        h.stop()
        assertFalse(h.open)
        val again = h.renew()
        assertEquals(LocalCodeReason.Opened, again.reason)
        assertTrue(h.open)
        // Another window is already open: pair refuses, and so does a second handle's renewal.
        val e = assertThrows(LanException::class.java) { runBlocking { a.links.pair(a.pairOptions()) } }
        assertEquals(LanErrorReason.bad_type, e.reason)
        // The cap: the old window is left alone.
        for (i in 0 until MAX_LOCAL_LINKS) a.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "L$i", emptyList()), 1L)
        val full = assertThrows(LocalPairingException::class.java) { runBlocking { h.renew() } }
        assertEquals(ErrorCode.localLinksFull, full.code)
        assertEquals("stored", full.cap)
        assertTrue(h.open)
        h.stop()
    }

    @Test
    fun renewIsRefusedWithTheTypedNAWhileTheGateIsOff() = runBlocking {
        val a = Dev(Network())
        val h = a.links.pair(a.pairOptions())
        a.gate = false
        val e = assertThrows(LocalPairingOffException::class.java) { runBlocking { h.renew() } }
        assertEquals(ErrorCode.localPairingOff, e.code)
        h.stop()
    }

    @Test
    fun stopWhileRenewIsOpeningAWindowLeavesNoWindowNoAdvertAndNoCode() = runBlocking {
        val net = Network()
        val gated = GatedMdns(net)
        val a = Dev(net)
        val h = a.links.pair(a.pairOptions(mdns = gated))
        val hold = CompletableDeferred<Unit>()
        gated.hold = hold
        val renewing = scope.async { runCatching { h.renew() } }
        withTimeout(8000) { gated.reached.await() }
        val stopping = scope.launch { h.stop() }
        hold.complete(Unit)
        stopping.join()
        val e = renewing.await().exceptionOrNull()
        assertEquals(LanErrorReason.closed, (e as LanException).reason)
        assertFalse(h.open)
        assertTrue(net.names().isEmpty())
        // The new window was never shown.
        assertEquals(1, a.codes.size)
        assertEquals(listOf(LocalWindowEnd.Person), a.ends.toList())
    }

    @Test
    fun noCodeIsShownForAWindowThatClosesOffWhileItOpens() = runBlocking {
        val net = Network()
        val gated = GatedMdns(net)
        val a = Dev(net)
        val hold = CompletableDeferred<Unit>()
        gated.hold = hold
        val opening = scope.async { runCatching { a.links.pair(a.pairOptions(mdns = gated)) } }
        withTimeout(8000) { gated.reached.await() }
        a.gate = false
        val closing = scope.launch { a.links.closeAll() }
        hold.complete(Unit)
        closing.join()
        assertTrue(opening.await().exceptionOrNull() is LocalPairingOffException)
        assertTrue(a.codes.isEmpty())
        assertEquals(listOf(LocalWindowEnd.Off), a.ends.toList())
        assertTrue(net.names().isEmpty())
    }

    @Test
    fun onEndSaysOnceWhyTheWindowEndedAfterItsAdvertIsWithdrawn() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val advertsAtEnd = CopyOnWriteArrayList<Int>()
        val h = a.links.pair(
            a.pairOptions(onEnd = {
                a.ends += it
                advertsAtEnd += net.names().size
            }),
        )
        h.stop()
        h.stop()
        assertEquals(listOf(LocalWindowEnd.Person), a.ends.toList())
        assertEquals(listOf(0), advertsAtEnd.toList())
        // A window that comes to its own end says so, and a link made says `stored`.
        val b = Dev(net)
        pairUpEnding(a, b)
        assertEquals(LocalWindowEnd.Stored, a.ends.last())
    }

    private fun pairUpEnding(a: Dev, b: Dev) = runBlocking {
        a.codes.clear()
        a.links.pair(a.pairOptions())
        until { a.codes.isNotEmpty() }
        b.links.join(b.joinOptions(code = a.codes.last().code))
        until { a.linked.isNotEmpty() && a.ends.size == 2 }
    }

    // -- the floor, the draw and the interruptions ------------------------------------------------

    @Test
    fun theSecondWindowThatEndsAfterAWrongGuessWithinTenMinutesStartsTheCooldownAndOneDoesNot() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val h = a.links.pair(a.pairOptions())
        joinError(b, b.joinOptions(code = wrongOf(a.codes.last().code)))
        until { a.codes.size == 2 }
        // One window that ended after a wrong guess: the renewal is allowed.
        val second = h.renew()
        assertEquals(LocalCodeReason.Opened, second.reason)
        joinError(b, b.joinOptions(code = wrongOf(second.code)))
        until { a.codes.size == 4 }
        // The second such window within 10 minutes: refused for 30 s, by renew and by pair.
        val e = assertThrows(LocalPairingException::class.java) { runBlocking { h.renew() } }
        assertEquals(ErrorCode.peerClosed, e.code)
        assertEquals("cooldown", e.reason)
        assertFalse(h.open)
        assertEquals("cooldown", assertThrows(LocalPairingException::class.java) { runBlocking { a.links.pair(a.pairOptions()) } }.reason)
        a.t += 30
        assertEquals(LocalCodeReason.Opened, h.renew().reason)
        h.stop()
    }

    @Test
    fun afterTooManyTriesPairAndRenewAreRefusedFor30sWithCooldown() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val h = a.links.pair(a.pairOptions())
        // A QR is never limited by the joiner's budget: five guesses with a wrong secret close the window.
        for (i in 1..5) {
            a.t += 20
            joinError(b, b.joinOptions(qr = tamperedQr(a.codes.last().qr)))
            if (i < 5) until { a.codes.size == i + 1 }
        }
        until { LocalWindowEnd.TooManyTries in a.ends }
        assertFalse(h.open)
        assertEquals(LocalPairFailureReason.TooManyTries, a.failed.last().reason)
        val e = assertThrows(LocalPairingException::class.java) { runBlocking { h.renew() } }
        assertEquals("cooldown", e.reason)
        a.t += 29
        assertEquals("cooldown", assertThrows(LocalPairingException::class.java) { runBlocking { a.links.pair(a.pairOptions()) } }.reason)
        a.t += 1
        assertTrue(h.renew().nameplate.isNotEmpty())
        h.stop()
    }

    @Test
    fun aWindowWithNoFailedGuessNeverStartsTheCooldown() = runBlocking {
        val a = Dev(Network())
        val h = a.links.pair(a.pairOptions())
        repeat(3) { assertEquals(0, h.renew().failures) }
        h.stop()
    }

    @Test
    fun onInterruptedCountsConnectionsClosedWithoutAGuessAndIsToldAtMostOnceASecond() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val h = a.links.pair(a.pairOptions())
        val port = net.adverts.values.single().port
        fun poke() {
            Socket("127.0.0.1", port).use { s ->
                s.soTimeout = 8000
                s.getOutputStream().write(encodeFrame(ByteArray(5) { 1 }))
                s.getOutputStream().flush()
                // The window closes it after counting the interruption (a reset is a close too).
                assertTrue(runCatching { s.getInputStream().read() == -1 }.getOrDefault(true))
            }
        }
        // A bare connection that sends nothing is no first message: nothing is counted.
        Socket("127.0.0.1", port).close()
        repeat(3) { poke() }
        assertEquals(listOf(1), a.interrupts.toList())
        a.t += 2
        poke()
        assertEquals(listOf(1, 4), a.interrupts.toList())
        h.stop()
    }

    // -- the joiner: reasons, dialsLeft and cancel -------------------------------------------------

    @Test
    fun pairingCodeFailedCarriesWhyInvalidOtherAppSpentWrong() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val invalid = joinError(b, b.joinOptions(code = "12"))
        assertEquals(ErrorCode.pairingCodeFailed, invalid.code)
        assertEquals("invalid", invalid.reason)
        val other = joinError(b, b.joinOptions(qr = "PKP1:OTHERAPP:EIVPNFXZF7KYKTLM:PEFKYJON45LZNN3MU6EKDFHRKE"))
        assertEquals("other-app", other.reason)
        val h = a.links.pair(a.pairOptions())
        val np = a.codes.single().nameplate
        assertEquals(2, b.links.dialsLeft(np))
        assertEquals("wrong", joinError(b, b.joinOptions(code = wrongOf(a.codes.last().code))).reason)
        assertEquals(1, b.links.dialsLeft(np))
        until { a.codes.size == 2 }
        assertEquals("wrong", joinError(b, b.joinOptions(code = wrongOf(a.codes.last().code))).reason)
        assertEquals(0, b.links.dialsLeft(np))
        until { a.codes.size == 3 }
        // The dials for this nameplate are spent: it answers at once and browses nothing.
        val spent = joinError(b, b.joinOptions(code = a.codes.last().code))
        assertEquals(ErrorCode.pairingCodeFailed, spent.code)
        assertEquals("spent", spent.reason)
        h.stop()
    }

    @Test
    fun noMatchingAdvertIsNotFoundWithNoReason() = runBlocking {
        val b = Dev(Network())
        val e = joinError(b, b.joinOptions(code = "4812 3456", browse = 0.2))
        assertEquals(ErrorCode.pairingNotFound, e.code)
        assertNull(e.reason)
    }

    @Test
    fun dialsLeftReadsTwoDigitsKeepsNothingAndSpendsNothing() {
        val b = Dev(Network())
        for (text in listOf("", "4", "ab12", "4 a", "٤٨")) assertNull(text, b.links.dialsLeft(text))
        repeat(5) { assertEquals(2, b.links.dialsLeft("48")) }
        assertEquals(2, b.links.dialsLeft(" 4-8 12-3"))
        assertEquals(2, b.links.dialsLeft("49"))
        assertEquals(2, b.links.dialsLeft("48"))
    }

    @Test
    fun aPeerClosedCarriesWhyDeclinedByTheOtherDeviceOrByThisOne() = runBlocking {
        val net = Network()
        // The showing device says no: the joiner hears it, and the next code says why.
        val a = Dev(net, confirm = false)
        val b = Dev(net)
        val h = a.links.pair(a.pairOptions())
        val e = joinError(b, b.joinOptions(code = a.codes.last().code))
        assertEquals(ErrorCode.peerClosed, e.code)
        assertEquals("declined", e.reason)
        until { a.failed.isNotEmpty() && a.codes.size == 2 }
        assertEquals(LocalPairFailureReason.Declined, a.failed.single().reason)
        assertEquals(LocalCodeReason.Declined, a.codes.last().reason)
        h.stop()
        // The joining device says no: it is declined too, and the shower's next code is "closed".
        val c = Dev(net)
        val d = Dev(net, confirm = false)
        val hc = c.links.pair(c.pairOptions())
        val declined = joinError(d, d.joinOptions(code = c.codes.last().code))
        assertEquals("declined", declined.reason)
        until { c.codes.size == 2 }
        assertEquals(LocalCodeReason.Closed, c.codes.last().reason)
        hc.stop()
    }

    @Test
    fun aCancelledJoinClosesItsDialWipesItsKeysAndRefundsNoDial() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val h = a.links.pair(a.pairOptions())
        val np = a.codes.single().nameplate
        val rand = java.security.SecureRandom()
        val keys = CopyOnWriteArrayList<ByteArray>()
        val random: (Int) -> ByteArray = { n ->
            ByteArray(n).also {
                rand.nextBytes(it)
                if (n == 32) keys += it
            }
        }
        val consent = AtomicBoolean(false)
        // The joiner reaches the consent and waits there: the dial is up, the keys are made.
        val job = scope.launch {
            b.links.join(b.joinOptions(code = a.codes.last().code, random = random, onConfirm = { consent.set(true) }))
        }
        until { consent.get() }
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        // The scalar and the link key it made are zeros, and the dial it spent is not given back.
        assertTrue(keys.size >= 2)
        assertTrue(keys.all { k -> k.all { it == 0.toByte() } })
        assertEquals(1, b.links.dialsLeft(np))
        // The showing device sees the connection end without a link.
        until { a.failed.isNotEmpty() }
        assertTrue(a.store.rows().isEmpty() && b.store.rows().isEmpty())
        h.stop()
    }

    // -- the list: onChange, the platform, the caps and the gate -----------------------------------

    @Test
    fun onChangeFiresAfterAPairingIsStoredRenameSetReachableAndRemoveAndNotAfterUnsubscribing() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        var n = 0
        val off = a.links.onChange { n++ }
        val h = a.links.pair(a.pairOptions())
        b.links.join(b.joinOptions(code = a.codes.last().code))
        until { a.linked.isNotEmpty() }
        val afterPairing = n
        assertTrue(afterPairing >= 1)
        val id = a.links.list().single().id
        assertTrue(a.links.rename(id, "Studio"))
        assertEquals(afterPairing + 1, n)
        assertTrue(a.links.setReachable(id, false))
        assertEquals(afterPairing + 2, n)
        assertFalse(a.links.rename("nope", "x"))
        assertEquals(afterPairing + 2, n)
        off()
        assertTrue(a.links.remove(id))
        assertEquals(afterPairing + 2, n)
        h.stop()
    }

    @Test
    fun aLinkKeepsTheOtherDevicesPlatformAndOnlyAKnownSpelling() = runBlocking {
        val net = Network()
        val a = Dev(net)
        val b = Dev(net)
        val h = a.links.pair(a.pairOptions())
        b.links.join(b.joinOptions(code = a.codes.last().code))
        until { a.linked.isNotEmpty() }
        // The pairing's HELLO reports a canonical platform, whatever the JVM calls the OS.
        assertTrue(pairingPlatform() in PLATFORM_VALUES)
        assertEquals(pairingPlatform(), a.links.list().single().platform)
        assertEquals(pairingPlatform(), b.links.list().single().platform)
        h.stop()
        // A raw spelling is not stored.
        val c = Dev(net)
        c.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "Raw", emptyList(), platform = "darwin"), 1L)
        c.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "Known", emptyList(), platform = "windows"), 1L)
        val byLabel = c.links.list().associate { it.label to it.platform }
        assertNull(byLabel["Raw"])
        assertEquals("windows", byLabel["Known"])
    }

    @Test
    fun localLinksFullNamesTheCapStoredAt32AndReachableAt8() = runBlocking {
        val a = Dev(Network())
        for (i in 0 until MAX_LOCAL_LINKS) a.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "L$i", emptyList()), 1L)
        val pair = assertThrows(LocalPairingException::class.java) { runBlocking { a.links.pair(a.pairOptions()) } }
        assertEquals("stored", pair.cap)
        assertNull(pair.reason)
        val join = joinError(a, a.joinOptions(code = "48123456"))
        assertEquals(ErrorCode.localLinksFull, join.code)
        assertEquals("stored", join.cap)
        val rows = a.store.rows()
        assertEquals(MAX_LIVE_LOCAL_ADVERTS, rows.count { it.reachable })
        val ninth = assertThrows(LocalPairingException::class.java) { runBlocking { a.links.setReachable(rows.first { !it.reachable }.id, true) } }
        assertEquals(ErrorCode.localLinksFull, ninth.code)
        assertEquals("reachable", ninth.cap)
    }

    @Test
    fun listRenameRemoveAndSetReachableAreNeverGatedWithTheGateOff() = runBlocking {
        val net = Network()
        val a = Dev(net)
        a.gate = false
        val id = a.store.add(NewLocalLink(rnd(), rnd(), rnd(), rnd(), "Bo", emptyList()), 1L)!!
        assertFalse(a.links.localPairing())
        assertEquals(1, a.links.list().size)
        assertTrue(a.links.rename(id, "Studio"))
        assertTrue(a.links.setReachable(id, false))
        assertTrue(a.links.setReachable(id, true))
        assertThrows(LocalPairingOffException::class.java) { runBlocking { a.links.pair(a.pairOptions()) } }
        // Nothing is advertised while the gate is off, and a held link can still be forgotten.
        assertTrue(net.names().isEmpty())
        assertTrue(a.links.remove(id))
        assertTrue(a.links.list().isEmpty())
    }
}
