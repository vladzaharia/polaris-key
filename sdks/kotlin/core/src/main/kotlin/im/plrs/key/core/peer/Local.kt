// WIRE-CONTRACT-V5 section 15.12: local links, account-free pairing (CC-29.13). Pure functions and small machines,
// no I/O: the code and its nameplate, the QR, the adverts, the `LOCAL_LINK` body, the link secret, the handshake
// capabilities, the joiner, the pairing window, the exchange guard, the pin, the trial order and the gate. The
// vectors are `peer-matrix.json` `local`; the session (`PeerChannel`) runs modes `q` and `l` over them, and CPace
// itself is `CPace.kt`. Mirrors client-core's `peer/local.ts`.
//
// A password, a QR secret and a link secret are key material: nothing here logs one or returns one inside an
// error. Time comes in as arguments (a monotonic clock, in seconds, for the window), so a machine never reads a
// clock of its own.

@file:Suppress(
    "CyclomaticComplexMethod",
    "MagicNumber",
    "ReturnCount",
    "TooManyFunctions",
)

package im.plrs.key.core.peer

import im.plrs.key.core.PairingCodeFailedReason
import im.plrs.key.core.StrictJson
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// -- Constants (section 15.12) --------------------------------------------------------------------

/** A pairing window stays open at most this long. */
public const val LOCAL_PAIR_SECONDS: Int = 300

/** A code is 8 digits: a 2-digit nameplate and a 6-digit password. */
public const val LOCAL_CODE_DIGITS: Int = 8

/** The fifth failed guess closes the window. */
public const val LOCAL_PAIR_FAILURES: Int = 5
public const val LOCAL_QR_SECRET_BYTES: Int = 16
public const val LOCAL_JOIN_CANDIDATES: Int = 2
public const val LOCAL_JOIN_BROWSE_SECONDS: Int = 15

/** Local links one device holds for one product. */
public const val MAX_LOCAL_LINKS: Int = 32
public const val MAX_LIVE_LOCAL_ADVERTS: Int = 8

/** [MAX_CONTACT_SECRETS] plus [MAX_LOCAL_LINKS]. */
public const val MAX_LINK_SECRETS: Int = 104

/** The pairing window admits at most this many C1s in any [LOCAL_C1_WINDOW_SECONDS]. */
public const val LOCAL_C1_PER_WINDOW: Int = 5
public const val LOCAL_C1_WINDOW_SECONDS: Int = 60

/** From the first byte (C1 included) to the transport. */
public const val LOCAL_ATTEMPT_SECONDS: Int = 30

/** The joiner keeps at most this many matching `m=q` names while it joins. */
public const val LOCAL_JOIN_KEPT: Int = 8
public const val LOCAL_LINK_BODY_MAX: Int = 4096

/** The mandatory capability of mode `q`. */
public const val LOCAL_CAP: String = "local/1"

/** At most this many dials per nameplate in any [LOCAL_DIAL_BUDGET_SECONDS], across joins. */
public const val LOCAL_DIAL_BUDGET: Int = 2
public const val LOCAL_DIAL_BUDGET_SECONDS: Int = 300

private const val LOW_BYTE = 0xff
private const val NAMEPLATE_LIMIT = 200
private const val NAMEPLATE_MOD = 100
private const val PASSWORD_LIMIT = 4_294_000_000L
private const val PASSWORD_MOD = 1_000_000L
private const val KEY_BYTES = 32
private const val SID_BYTES = 10
private const val INSTANCE_CHARS = 16
private const val SECRET_CHARS = 26
private const val BITS_PER_CHAR = 5
private const val BITS_PER_BYTE = 8
private const val BYTE_MASK = 0xff
private const val CAT_MAX = 8
private const val BASE32 = "abcdefghijklmnopqrstuvwxyz234567"
private val SLUG_RE = Regex("[a-z0-9][a-z0-9-]{0,63}")
private val CAT_RE = Regex("[a-z0-9-]{1,32}")
private val CODE_RE = Regex("[0-9]{$LOCAL_CODE_DIGITS}")
private val INSTANCE_BODY_RE = Regex("[a-z2-7]{$INSTANCE_CHARS}")
private val SECRET_RE = Regex("[a-z2-7]{$SECRET_CHARS}")

private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

private fun cat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var off = 0
    for (p in parts) {
        p.copyInto(out, off)
        off += p.size
    }
    return out
}

private fun u64be(n: Long): ByteArray = ByteArray(BITS_PER_BYTE) { i -> (n ushr (BITS_PER_BYTE * (BITS_PER_BYTE - 1 - i))).toByte() }

/** Unsigned byte order of two equal-length byte strings: negative when [a] sorts first. */
private fun byteCompare(a: ByteArray, b: ByteArray): Int {
    for (i in a.indices) {
        val d = (a[i].toInt() and BYTE_MASK) - (b[i].toInt() and BYTE_MASK)
        if (d != 0) return d
    }
    return 0
}

private fun sameKey(a: ByteArray, b: ByteArray): Boolean = a.size == b.size && byteCompare(a, b) == 0

private fun catsOk(cats: List<String>): Boolean = cats.size <= CAT_MAX && cats.all { CAT_RE.matches(it) } && cats.toSet().size == cats.size

/** A person's label as a `HELLO` label is cleaned (NFC, controls and bidi stripped, 64 code points); null when nothing is left. */
public fun cleanLocalLabel(raw: String): String? = cleanLabel(raw)

// -- The code (section 15.12, "The code") ---------------------------------------------------------

/** A source of random bytes that answers null when it cannot supply `n` of them (a stream of fixed bytes in a vector). */
public fun interface DrawSource {
    public fun draw(n: Int): ByteArray?
}

private fun two(n: Int): String = n.toString().padStart(2, '0')

/**
 * The nameplate: one byte at a time, 200 or more drawn again, then mod 100, and a nameplate in [inUse] drawn again
 * unless all 100 are in use (then any is taken). Rejection sampling, so every nameplate is equally likely. Null
 * when the source runs out.
 */
public fun drawNameplate(source: DrawSource, inUse: Collection<String> = emptyList()): String? {
    val used = inUse.toSet()
    val all = (0 until NAMEPLATE_MOD).all { two(it) in used }
    while (true) {
        val b = source.draw(1) ?: return null
        val v = b[0].toInt() and LOW_BYTE
        val n = two(v % NAMEPLATE_MOD)
        // 200 or more is drawn again, and so is a nameplate in use while one is free.
        if (v < NAMEPLATE_LIMIT && (all || n !in used)) return n
    }
}

/**
 * The nameplates this device showed for one product in windows that closed less than [LOCAL_DIAL_BUDGET_SECONDS] ago
 * (section 15.12, "The code"), in memory. The shower's draw skips them, so a renewed window never reuses the nameplate
 * of the window just closed, whose dials a joiner may have spent. Hold one per product for the life of the process,
 * like [DialBudget]. Thread-safe.
 */
public class NameplateMemory {
    private val lock = Any()
    private val closed = HashMap<String, Double>()

    /** The window that showed [nameplate] closed at the monotonic time [t] (seconds). */
    public fun shown(nameplate: String, t: Double) {
        synchronized(lock) { closed[nameplate] = maxOf(t, closed[nameplate] ?: t) }
    }

    private fun recentLocked(t: Double): List<String> {
        closed.entries.removeAll { t - it.value >= LOCAL_DIAL_BUDGET_SECONDS }
        return closed.keys.toList()
    }

    /** The nameplates of windows that closed less than 300 s before [t]. */
    public fun recent(t: Double): List<String> = synchronized(lock) { recentLocked(t) }

    /**
     * The shower's draw, in two tiers. First among the nameplates this memory does not hold: the adverts of other
     * windows are not authenticated, so they never steer it. Only when it holds all 100, the one that closed longest
     * ago (the lowest on a tie), with no byte read. Null when the source runs out.
     */
    public fun draw(source: DrawSource, t: Double): String? = synchronized(lock) {
        val held = recentLocked(t)
        if (held.size < NAMEPLATE_MOD) {
            drawNameplate(source, held)
        } else {
            closed.entries.sortedBy { it.key }.minByOrNull { it.value }?.key
        }
    }

    override fun toString(): String = "NameplateMemory"
}

/** The SDK's renewal floor (section 15.12, "The code"): refuse a new window for this long after a hard end. */
public const val LOCAL_RENEW_COOLDOWN_SECONDS: Int = 30

/** Two windows that ended after a wrong guess within this many seconds start the cooldown. */
public const val LOCAL_RENEW_WRONG_SECONDS: Int = 600

/** How many such windows start the cooldown. */
public const val LOCAL_RENEW_WRONG_LIMIT: Int = 2

/**
 * How a window ended, for [RenewFloor]: [TooManyTries] (the fifth failed guess) or [WrongCode] (any other end of a
 * window that had counted a failed guess, a `renew()` replacement included).
 */
public enum class RenewEnd { TooManyTries, WrongCode }

/** What [RenewFloor.check] answers: whether a window may open, and else the whole seconds until it may. */
public data class RenewVerdict(val allowed: Boolean, val retryIn: Int)

/**
 * The renewal floor, one per product for the life of the process, beside [DialBudget]. After a [RenewEnd.TooManyTries]
 * end, or the second [RenewEnd.WrongCode] end within 600 s, no window opens for 30 s, so a host that renews from
 * `onEnd` with no person cannot give a guesser windows at machine speed. Times are monotonic seconds. In memory only.
 * Thread-safe.
 */
public class RenewFloor {
    private val lock = Any()
    private var until = Double.NEGATIVE_INFINITY
    private var wrong = ArrayList<Double>()

    /** A window ended at [t]. */
    public fun ended(end: RenewEnd, t: Double) {
        synchronized(lock) {
            if (end == RenewEnd.WrongCode) {
                wrong = ArrayList(wrong.filter { t - it < LOCAL_RENEW_WRONG_SECONDS })
                wrong += t
            }
            if (end == RenewEnd.TooManyTries || wrong.size >= LOCAL_RENEW_WRONG_LIMIT) {
                until = maxOf(until, t + LOCAL_RENEW_COOLDOWN_SECONDS)
            }
        }
    }

    /** Whether a window may open at [t], and else the whole seconds until it may. */
    public fun check(t: Double): RenewVerdict = synchronized(lock) {
        if (t >= until) RenewVerdict(true, 0) else RenewVerdict(false, Math.ceil(until - t).toInt())
    }

    override fun toString(): String = "RenewFloor"
}

/**
 * The password: a u32be of 4 bytes, drawn again at 4 294 000 000 or more, then mod 10^6, written with leading
 * zeros. Null when the source runs out.
 */
public fun drawPassword(source: DrawSource): String? {
    while (true) {
        val b = source.draw(4) ?: return null
        var n = 0L
        for (x in b) n = (n shl BITS_PER_BYTE) or (x.toLong() and BYTE_MASK.toLong())
        if (n >= PASSWORD_LIMIT) continue
        return (n % PASSWORD_MOD).toString().padStart(LOCAL_CODE_DIGITS - 2, '0')
    }
}

/** `4812 3456`: two groups of four, one space. */
public fun displayCode(nameplate: String, password: String): String {
    val digits = nameplate + password
    require(CODE_RE.matches(digits)) { "code" }
    return "${digits.substring(0, 4)} ${digits.substring(4)}"
}

/** The verdict on a typed code. */
public sealed class CodeVerdict {
    public class Ok(public val nameplate: String, public val password: String) : CodeVerdict() {
        override fun toString(): String = "Ok(nameplate=$nameplate)"
    }

    public object Invalid : CodeVerdict()
}

/** A typed code: ASCII spaces and hyphens removed, then exactly 8 ASCII digits. */
public fun parseCode(text: String): CodeVerdict {
    val digits = text.filter { it != ' ' && it != '-' }
    return if (CODE_RE.matches(digits)) CodeVerdict.Ok(digits.substring(0, 2), digits.substring(2)) else CodeVerdict.Invalid
}

// -- The QR (section 15.12, "The QR") -------------------------------------------------------------

private fun asciiFold(s: String): String = buildString(s.length) {
    for (c in s) append(if (c in 'A'..'Z') c + ('a' - 'A') else c)
}

/** `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case. */
public fun makeQr(slug: String, instance: String, secret: ByteArray): String {
    require(SLUG_RE.matches(slug)) { "slug" }
    require(isInstanceName(instance)) { "instance" }
    require(secret.size == LOCAL_QR_SECRET_BYTES) { "secret" }
    return "PKP1:$slug:${instance.substring(3)}:${base32Lower(secret)}".uppercase()
}

/** The verdict on a scanned QR. */
public sealed class QrVerdict {
    public class Ok(public val slug: String, public val instance: String, public val secret: ByteArray) : QrVerdict() {
        override fun toString(): String = "Ok($slug)"
    }

    public object OtherApp : QrVerdict()

    public object Invalid : QrVerdict()
}

/** The 16 bytes of 26 canonical base32 characters; null when the two unused low bits are set. */
private fun decodeSecret(chars: String): ByteArray? {
    val out = ByteArray(LOCAL_QR_SECRET_BYTES)
    var acc = 0
    var bits = 0
    var at = 0
    for (c in chars) {
        acc = (acc shl BITS_PER_CHAR) or BASE32.indexOf(c)
        bits += BITS_PER_CHAR
        if (bits >= BITS_PER_BYTE) {
            out[at++] = ((acc shr (bits - BITS_PER_BYTE)) and BYTE_MASK).toByte()
            bits -= BITS_PER_BYTE
            acc = acc and ((1 shl bits) - 1)
        }
    }
    return if (acc == 0) out else null
}

/**
 * Read a scanned QR. ASCII case is folded and the text needs four fields split at `:`: `PKP1`, a slug, 16 base32
 * characters and 26 canonical ones. A well-formed slug that is not [own] answers [QrVerdict.OtherApp]; everything
 * else wrong is [QrVerdict.Invalid], and the slug is judged last.
 */
public fun parseQr(text: String, own: String): QrVerdict {
    val f = asciiFold(text).split(":")
    if (f.size != 4 || f[0] != "pkp1") return QrVerdict.Invalid
    val slug = f[1]
    val instance = f[2]
    val secret = f[3]
    if (!SLUG_RE.matches(slug) || !INSTANCE_BODY_RE.matches(instance)) return QrVerdict.Invalid
    if (!SECRET_RE.matches(secret)) return QrVerdict.Invalid
    val bytes = decodeSecret(secret) ?: return QrVerdict.Invalid
    if (slug != own) {
        bytes.fill(0)
        return QrVerdict.OtherApp
    }
    return QrVerdict.Ok(slug, "p1-$instance", bytes)
}

// -- The adverts (section 15.12, "The pairing window" and "Mode l") -------------------------------

/** The `m=q` instance: `p1-` and the 16 base32 characters of the window's 10 random bytes. */
public fun pairingInstance(sid: ByteArray): String {
    require(sid.size == SID_BYTES) { "sid" }
    return "p1-${base32Lower(sid)}"
}

/**
 * The 10 bytes behind a `p1-` instance name, which are the window's CPace `sid`; null for a name that is not 16
 * base32 characters.
 */
public fun pairingSid(instance: String): ByteArray? {
    if (!isInstanceName(instance)) return null
    var acc = java.math.BigInteger.ZERO
    for (c in instance.substring(3)) acc = acc.shiftLeft(BITS_PER_CHAR).or(java.math.BigInteger.valueOf(BASE32.indexOf(c).toLong()))
    return ByteArray(SID_BYTES) { i -> acc.shiftRight(BITS_PER_BYTE * (SID_BYTES - 1 - i)).toInt().toByte() }
}

/**
 * The `m=l` instance of an advertiser in one epoch: `p1-` and the first 16 characters of the lower-case base32 of
 * `HMAC-SHA256(secret, "pkey-peer/1 ldisc" 0x00 u64be(epoch) key)`, with the advertiser's own link key so the two
 * devices of a link differ.
 */
public fun localInstance(secret: ByteArray, advertiserLinkKey: ByteArray, epoch: Long): String {
    val mac = hmacSha256(secret, cat(utf8("pkey-peer/1 ldisc"), byteArrayOf(0), u64be(epoch), advertiserLinkKey))
    return "p1-" + base32Lower(mac).substring(0, INSTANCE_CHARS)
}

/** A link the device holds, as a browser tests it: its secret and the peer's link key. */
public class LocalLinkKey(public val secret: ByteArray, public val peerKey: ByteArray) {
    override fun toString(): String = "LocalLinkKey(redacted)"
}

/** Which held link an instance belongs to: [link] indexes the links as held; [epochBack] is 0 (current) or 1 (previous). */
public data class LocalHit(val link: Int, val epochBack: Int)

/**
 * Which held link an instance belongs to: the first of the first [MAX_LOCAL_LINKS], in held order, that matches in
 * the current or the previous epoch. At most 64 HMACs.
 */
public fun browseLocalInstance(instance: String, links: List<LocalLinkKey>, nowSeconds: Long): LocalHit? {
    if (!isInstanceName(instance)) return null
    val epoch = advertEpoch(nowSeconds)
    for ((i, l) in links.take(MAX_LOCAL_LINKS).withIndex()) {
        for (back in 0..1) {
            if (epoch - back < 0) continue
            if (localInstance(l.secret, l.peerKey, epoch - back) == instance) return LocalHit(i, back)
        }
    }
    return null
}

/** The outcome of [parseLocalTxt]. */
public sealed class LocalTxtResult {
    public object Ok : LocalTxtResult()

    /** [reason]: duplicate, version or mode. */
    public class Refused(public val reason: String) : LocalTxtResult() {
        override fun toString(): String = "Refused($reason)"
    }
}

/** `v=1` and `m=l`. Entries split as [parseTxt] splits them; `h` and `n` are not read. */
public fun parseLocalTxt(entries: List<String>): LocalTxtResult {
    val kv = txtEntries(entries) ?: return LocalTxtResult.Refused("duplicate")
    if (kv["v"] != "1") return LocalTxtResult.Refused("version")
    if (kv["m"] != "l") return LocalTxtResult.Refused("mode")
    return LocalTxtResult.Ok
}

// -- The LOCAL_LINK body (section 15.12, "The LOCAL_LINK body") -----------------------------------

/** A `LOCAL_LINK` body, read. */
public class LocalLinkBody(public val label: String?, public val cats: List<String>) {
    override fun toString(): String = "LocalLinkBody(cats=${cats.size})"
}

/** The bytes of a `LOCAL_LINK` body. Throws [IllegalArgumentException] for a body the peer would refuse. */
public fun buildLocalLink(label: String?, cats: List<String>): ByteArray {
    require(catsOk(cats)) { "cats" }
    val clean = label?.let(::cleanLabel)
    val sb = StringBuilder("{\"v\":1")
    if (clean != null) sb.append(",\"label\":").append(JsonPrimitive(clean).toString())
    sb.append(",\"cats\":[").append(cats.joinToString(",") { "\"$it\"" }).append("]}")
    val bytes = utf8(sb.toString())
    require(bytes.size <= LOCAL_LINK_BODY_MAX) { "size" }
    return bytes
}

/**
 * Judge one `LOCAL_LINK` body: strict JSON of at most 4 KiB, `v` the integer 1, an optional label cleaned as a
 * `HELLO` label (dropped when nothing is left), `cats` required. Unknown members are ignored; a key, id or
 * certificate in the body is never read. Null when the body is refused.
 */
public fun parseLocalLink(body: ByteArray): LocalLinkBody? {
    if (body.size > LOCAL_LINK_BODY_MAX) return null
    val parsed = StrictJson.validate(body) ?: return null
    val o: JsonObject = parsed.value
    if (o["v"].longValue != 1L || "/v" in parsed.nonWireIntegers) return null
    val rawLabel = o["label"]
    if (rawLabel != null && rawLabel.stringValue == null) return null
    val arr = o["cats"].arrayValue ?: return null
    val cats = arr.map { it.stringValue ?: return null }
    if (!catsOk(cats)) return null
    return LocalLinkBody(rawLabel.stringValue?.let(::cleanLabel), cats)
}

// -- The link secret (section 15.12, "The link secret") -------------------------------------------

/**
 * `HKDF-SHA256(salt = h, ikm = ISK, info = "pkey-peer/1 local" 0x00 lo hi)`, 32 bytes: [h] is the mode-`q` handshake
 * hash, [isk] the CPace ISK (64 bytes) and [keyA], [keyB] the two link public keys by unsigned byte order.
 */
public fun localLinkSecret(h: ByteArray, isk: ByteArray, keyA: ByteArray, keyB: ByteArray): ByteArray {
    require(keyA.size == KEY_BYTES && keyB.size == KEY_BYTES) { "key" }
    val ordered = byteCompare(keyA, keyB) <= 0
    val lo = if (ordered) keyA else keyB
    val hi = if (ordered) keyB else keyA
    return hkdfSha256(h, isk, cat(utf8("pkey-peer/1 local"), byteArrayOf(0), lo, hi), KEY_BYTES)
}

/** A link's categories: the entries both sides listed, once each, in byte order. */
public fun localCategories(a: List<String>, b: List<String>): List<String> = capsIntersection(a, b)

// -- Handshake capabilities (section 15.12 step 4) ------------------------------------------------

/** The session's capabilities of a mode-`q` or mode-`l` handshake; [close] is set when the session must close first. */
public class LocalCaps(public val caps: List<String>, public val close: PeerCloseCode? = null)

/** Mode `q` without `local/1` in the session's capabilities closes `peer_not_allowed`, before any consent. */
public fun negotiateLocalCaps(mode: PeerMode, local: List<String>, remote: List<String>): LocalCaps {
    val caps = capsIntersection(local, remote)
    return if (mode == PeerMode.q && LOCAL_CAP !in caps) LocalCaps(caps, PeerCloseCode.peer_not_allowed) else LocalCaps(caps)
}

// -- The joiner (section 15.12, "The joiner") -----------------------------------------------------

/** What a join was given. */
public sealed class JoinInput {
    public class Code(public val nameplate: String) : JoinInput()

    public class Qr(public val instance: String) : JoinInput()

    public object Invalid : JoinInput()

    /** A QR for another app. */
    public object OtherApp : JoinInput()
}

/** How one dial ended. [Budget] is a dial the joiner's budget stopped in the middle of a join (nothing was dialled). */
public enum class DialOutcome { Transport, BeforeC2, AfterC2, Budget }

/** What a join answers once no dial is left. */
public enum class JoinResult(public val wire: String) {
    Transport("transport"),
    PairingCodeFailed("pairing-code-failed"),
    PairingNotFound("pairing-not-found"),
}

/**
 * The joiner's choices over one browse. A code or QR that did not parse browses nothing and answers
 * `pairing-code-failed`. Matching `m=q` adverts are kept once each in first-seen order, at most [LOCAL_JOIN_KEPT],
 * and the first [LOCAL_JOIN_CANDIDATES] are dialled, never redialled. The first session that reaches the transport
 * ends the dial. Not thread-safe: one caller at a time.
 */
public class JoinPlan(private val input: JoinInput) {
    private val keptNames = ArrayList<String>()
    private var dials = 0
    private var transport = false
    private var afterC2 = false
    private var budgetStopped = false
    private var spentAtStart = false

    /** Whether anything is browsed at all. */
    public val browses: Boolean get() = input !is JoinInput.Invalid && input !is JoinInput.OtherApp && !spentAtStart

    /** The nameplate's dials were spent before the join began: nothing is browsed or dialled. */
    public fun startSpent() {
        spentAtStart = true
    }

    public val kept: List<String> get() = keptNames.toList()

    /**
     * One `m=q` advert seen. [tagMatches] is whether its `h` is this product's tag of the current or previous epoch;
     * [n] its nameplate. Returns whether it was kept.
     */
    public fun see(instance: String, tagMatches: Boolean, n: String): Boolean {
        if (!browses || !tagMatches) return false
        val match = when (input) {
            is JoinInput.Code -> n == input.nameplate
            is JoinInput.Qr -> instance == input.instance
            JoinInput.Invalid, JoinInput.OtherApp -> false
        }
        if (!match || instance in keptNames || keptNames.size >= LOCAL_JOIN_KEPT) return false
        keptNames += instance
        return true
    }

    /** The next advert to dial, or null when the dial has ended. */
    public fun next(): String? = if (transport || dials >= LOCAL_JOIN_CANDIDATES) null else keptNames.getOrNull(dials)

    /** The dial of [next] ended this way. */
    public fun ended(outcome: DialOutcome) {
        dials++
        when (outcome) {
            DialOutcome.Transport -> transport = true
            DialOutcome.AfterC2 -> afterC2 = true
            DialOutcome.Budget -> budgetStopped = true
            DialOutcome.BeforeC2 -> Unit
        }
    }

    /** The answer once no dial is left (or the browse ran out). */
    public fun result(): JoinResult = when {
        !browses -> JoinResult.PairingCodeFailed
        transport -> JoinResult.Transport
        afterC2 || budgetStopped -> JoinResult.PairingCodeFailed
        else -> JoinResult.PairingNotFound
    }

    /**
     * Of a [JoinResult.PairingCodeFailed] result, why, as a [PairingCodeFailedReason] value (section 15.12, "Errors"); null for
     * any other result. The first that applies wins: invalid or other-app (the parse), spent (refused at the start), wrong (a
     * dial ended after C2), spent (the budget stopped a dial in the middle of the join).
     */
    public fun reason(): String? = when {
        result() != JoinResult.PairingCodeFailed -> null
        input is JoinInput.Invalid -> PairingCodeFailedReason.invalid
        input is JoinInput.OtherApp -> PairingCodeFailedReason.otherApp
        spentAtStart -> PairingCodeFailedReason.spent
        afterC2 -> PairingCodeFailedReason.wrong
        else -> PairingCodeFailedReason.spent
    }
}

/** What [DialBudget.check] answers. */
public data class DialVerdict(val allowed: Boolean, val used: Int)

/**
 * The joiner's dials per typed nameplate across joins, in memory, per product (section 15.12). A person who retypes
 * a code meets the same budget as one join: a fake advert that answers a dial gets one guess, so retries must not
 * multiply the dials. A QR names its instance and is never limited. Thread-safe.
 */
public class DialBudget {
    private val lock = Any()
    private val dialled = HashMap<String, ArrayList<Double>>()

    private fun recent(nameplate: String, t: Double): ArrayList<Double> {
        val kept = ArrayList((dialled[nameplate] ?: emptyList()).filter { t - it < LOCAL_DIAL_BUDGET_SECONDS })
        dialled[nameplate] = kept
        return kept
    }

    /** Whether a join of this nameplate may browse and dial now, and the dials already spent. */
    public fun check(nameplate: String, t: Double): DialVerdict = synchronized(lock) {
        val used = recent(nameplate, t).size
        DialVerdict(used < LOCAL_DIAL_BUDGET, used)
    }

    /** The join made [dials] dials. */
    public fun spend(nameplate: String, t: Double, dials: Int) {
        synchronized(lock) { repeat(dials) { recent(nameplate, t) += t } }
    }

    /**
     * Check and spend in one step under one lock: one dial ([dials], default 1) is taken only when the budget allows it, so
     * dials that overlap across threads cannot multiply. Answers the verdict from before the spend.
     */
    public fun takeIfAllowed(nameplate: String, t: Double, dials: Int = 1): DialVerdict = synchronized(lock) {
        val list = recent(nameplate, t)
        val used = list.size
        val allowed = used < LOCAL_DIAL_BUDGET
        if (allowed) repeat(dials) { list += t }
        DialVerdict(allowed, used)
    }

    /** The dials a join of this nameplate may still make now: 2 less the dials spent. */
    public fun left(nameplate: String, t: Double): Int = synchronized(lock) { LOCAL_DIAL_BUDGET - recent(nameplate, t).size }

    override fun toString(): String = "DialBudget"
}

/**
 * The dials left for the nameplate a person has typed so far (`localLinks.dialsLeft`): null unless the text, with ASCII
 * spaces and hyphens removed, starts with two ASCII digits. It reads those two digits only, keeps nothing and spends
 * nothing.
 */
public fun dialsLeft(budget: DialBudget, text: String, t: Double): Int? {
    // Reads only the first two characters that are not spaces or hyphens: no copy of the rest of the text is made.
    val head = StringBuilder(2)
    var i = 0
    while (head.length < 2 && i < text.length) {
        val ch = text[i++]
        if (ch in '0'..'9') {
            head.append(ch)
        } else if (ch != ' ' && ch != '-') {
            return null
        }
    }
    return if (head.length == 2) budget.left(head.toString(), t) else null
}

// -- The pairing window (section 15.12, "The pairing window") -------------------------------------

/** What a window event answers. */
public enum class WindowResult(public val wire: String) {
    Opened("opened"),
    AlreadyOpen("already-open"),
    Closed("closed"),
    Busy("busy"),
    Limited("limited"),
    Refused("refused"),
    Attempt("attempt"),
    Transport("transport"),
    Failed("failed"),
    TooManyTries("too-many-tries"),
}

/** Why a window closed. */
public enum class WindowClosed(public val wire: String) { Expired("expired"), TooManyTries("too-many-tries"), Stored("stored"), Person("person") }

/** What holds the window: an attempt, the session it became, or the rotation after a failure. */
public enum class WindowHolder(public val wire: String) { Attempt("attempt"), Session("session"), Rotating("rotating") }

/** The outcome of one window event. */
public class WindowOutcome(
    public val result: WindowResult? = null,
    /** The id of the attempt a C1 admitted. */
    public val id: Int? = null,
    /** The error the host hears: the fifth failed guess (`pairing-code-failed`). */
    public val host: String? = null,
    /**
     * The password and the QR secret rotate now. The window is `rotating` (busy, uncounted) until the host has made
     * the new code and QR secret and computed both generators, and calls [PairingWindow.rotated].
     */
    public val rotate: Boolean = false,
) {
    override fun toString(): String = "WindowOutcome(${result?.wire})"
}

/** The window's state as the corpus reads it. */
public data class WindowState(
    val open: Boolean,
    val holder: WindowHolder?,
    /** Guesses counted: counted when permitted, refunded when one opens. */
    val failures: Int,
    val rotations: Int,
    val closed: WindowClosed?,
)

/**
 * The shower's window over events with a monotonic time in seconds. A C1 that is admitted hands out an attempt id;
 * one attempt holds the window from its C1 until its guess or [LOCAL_ATTEMPT_SECONDS].
 *
 * A guess is counted before its tag is tried. The session asks [beginGuess], a synchronous permit given once, to the
 * holder's own attempt only, while the window is open; it counts the failure now (the fifth closes the window once
 * its verdict is in), and an attempt that was not permitted, a stale, expired or closed one, answers false and its
 * tag is never tried. A guess that opens is refunded ([guessOpened]) and the attempt becomes the session; one that
 * does not, and a permitted attempt whose connection ends ([abandon]) or runs out its 30 s, is a failed guess
 * ([guessFailed]): the password and the QR secret rotate. The window is `rotating` until [rotated], which the host
 * calls once the new secrets and both generators are ready (section 15.12, step 6), so a C1 never meets the old
 * password or a generator that is still being made.
 *
 * A refused C1 and an attempt that never reached its guess count nothing; a session that ends without a link also
 * rotates and holds the window until [rotated]. At most 5 C1s a minute are admitted, counted when admitted; a busy
 * C1 is never counted. The window expires [LOCAL_PAIR_SECONDS] after it opened, which closes a connection that has
 * not reached the transport (the host closes it) and leaves a session running. Attempt ids never repeat, so a
 * connection of a closed window cannot touch the next one. Every call is serialised.
 */
public class PairingWindow {
    private class Attempt(val id: Int, val at: Double, var guessed: Boolean = false)

    private val lock = Any()
    private var isOpen = false
    private var openedAt = 0.0
    private var holder: WindowHolder? = null
    private var attempt: Attempt? = null
    private var nextId = 1
    private var failures = 0
    private var rotations = 0
    private var closedFor: WindowClosed? = null
    private var admits = ArrayList<Double>()

    public val state: WindowState
        get() = synchronized(lock) { WindowState(isOpen, holder, failures, rotations, closedFor) }

    /** Apply the clocks: the window's expiry and an attempt's deadline. */
    public fun tick(t: Double): WindowOutcome = synchronized(lock) { tickLocked(t) }

    private fun tickLocked(t: Double): WindowOutcome {
        var out = WindowOutcome()
        if (isOpen && t - openedAt >= LOCAL_PAIR_SECONDS) {
            isOpen = false
            closedFor = WindowClosed.Expired
            // A counted guess stays counted; there is no window left to rotate.
            if (holder == WindowHolder.Attempt) drop()
            if (holder == WindowHolder.Rotating) holder = null
        }
        val a = attempt
        if (holder == WindowHolder.Attempt && a != null && t - a.at >= LOCAL_ATTEMPT_SECONDS) {
            out = if (a.guessed) failed() else WindowOutcome().also { drop() }
        }
        return out
    }

    private fun drop() {
        attempt = null
        holder = null
    }

    private fun isHolder(id: Int): Boolean = isOpen && holder == WindowHolder.Attempt && attempt?.id == id

    /** One window per device per product: an open window, or a session still running, answers `already-open`. */
    public fun open(t: Double): WindowOutcome = synchronized(lock) {
        tickLocked(t)
        if (isOpen || holder == WindowHolder.Session) return@synchronized WindowOutcome(WindowResult.AlreadyOpen)
        isOpen = true
        openedAt = t
        holder = null
        attempt = null
        failures = 0
        rotations = 0
        closedFor = null
        admits = ArrayList()
        WindowOutcome(WindowResult.Opened)
    }

    /** A C1 arrived; [valid] is whether it passed the frame and share checks. */
    public fun c1(t: Double, valid: Boolean): WindowOutcome = synchronized(lock) {
        tickLocked(t)
        if (!isOpen) return@synchronized WindowOutcome(WindowResult.Closed)
        if (holder != null) return@synchronized WindowOutcome(WindowResult.Busy)
        admits = ArrayList(admits.filter { t - it < LOCAL_C1_WINDOW_SECONDS })
        if (admits.size >= LOCAL_C1_PER_WINDOW) return@synchronized WindowOutcome(WindowResult.Limited)
        admits += t
        if (!valid) return@synchronized WindowOutcome(WindowResult.Refused)
        val id = nextId++
        holder = WindowHolder.Attempt
        attempt = Attempt(id, t)
        WindowOutcome(WindowResult.Attempt, id = id)
    }

    /**
     * The permit to try message 1's tag. True once, for the holder's own attempt, while the window is open and the
     * attempt's 30 s have not run out; the guess is counted now. False otherwise: the session must not try the tag.
     */
    public fun beginGuess(id: Int, t: Double): Boolean = synchronized(lock) {
        tickLocked(t)
        if (!isHolder(id) || attempt!!.guessed) return@synchronized false
        attempt!!.guessed = true
        failures++
        true
    }

    /** The permitted guess opened: the count is refunded and the attempt is the session. */
    public fun guessOpened(id: Int, t: Double): WindowOutcome = synchronized(lock) {
        tickLocked(t)
        if (!isHolder(id) || !attempt!!.guessed) return@synchronized WindowOutcome()
        failures--
        attempt = null
        holder = WindowHolder.Session
        WindowOutcome(WindowResult.Transport)
    }

    /** The permitted guess did not open. */
    public fun guessFailed(id: Int, t: Double): WindowOutcome = synchronized(lock) {
        tickLocked(t)
        if (!isHolder(id) || !attempt!!.guessed) return@synchronized WindowOutcome()
        failed()
    }

    private fun failed(): WindowOutcome {
        attempt = null
        if (failures >= LOCAL_PAIR_FAILURES) {
            isOpen = false
            closedFor = WindowClosed.TooManyTries
            holder = null
            return WindowOutcome(WindowResult.TooManyTries, host = "pairing-code-failed")
        }
        rotations++
        holder = WindowHolder.Rotating
        return WindowOutcome(WindowResult.Failed, rotate = true)
    }

    /** Message 1 of [id]: the permit, then the verdict. Not permitted: nothing is tried, nothing changes (null). */
    public fun msg1(id: Int, t: Double, opens: Boolean): WindowOutcome? {
        if (!beginGuess(id, t)) return null
        return if (opens) guessOpened(id, t) else guessFailed(id, t)
    }

    /** The attempt's connection closed or timed out. A permitted guess with no verdict is failed. */
    public fun abandon(id: Int, t: Double): WindowOutcome = synchronized(lock) {
        tickLocked(t)
        if (!isHolder(id)) return@synchronized WindowOutcome()
        if (attempt!!.guessed) return@synchronized failed()
        drop()
        WindowOutcome()
    }

    /** The new code, QR secret and both generators are ready: the window takes the next C1. */
    public fun rotated(t: Double) {
        synchronized(lock) {
            tickLocked(t)
            if (holder == WindowHolder.Rotating) holder = null
        }
    }

    /** The held session ended. A stored link closes the window; any other end rotates and holds the window until [rotated]. */
    public fun sessionEnd(t: Double, stored: Boolean): WindowOutcome = synchronized(lock) {
        tickLocked(t)
        if (holder != WindowHolder.Session) return@synchronized WindowOutcome()
        holder = null
        if (stored) {
            isOpen = false
            closedFor = WindowClosed.Stored
            return@synchronized WindowOutcome()
        }
        if (!isOpen) return@synchronized WindowOutcome()
        rotations++
        holder = WindowHolder.Rotating
        WindowOutcome(rotate = true)
    }

    /** The person closed the window. */
    public fun close(t: Double): WindowOutcome = synchronized(lock) {
        tickLocked(t)
        if (isOpen) {
            isOpen = false
            closedFor = WindowClosed.Person
            if (holder == WindowHolder.Attempt || holder == WindowHolder.Rotating) drop()
        }
        WindowOutcome()
    }

    override fun toString(): String = "PairingWindow"
}

// -- The gate (section 15.12, "Gates") ------------------------------------------------------------

/** The cached discovery answer for local pairing. */
public enum class GateState(public val wire: String) { On("on"), Off("off"), None("none") }

/** What a read that left a cached `true` behind makes the host do. */
public enum class GateEffect(public val wire: String) {
    CloseWindows("close-windows"),
    WithdrawAdverts("withdraw-adverts"),
    EndSessions("end-sessions"),
}

/** The calls the gate holds back; managing links (`list`, `rename`, `remove`, `set-reachable`) is never gated. */
public val GATED_CALLS: List<String> = listOf("pair", "join", "advertise-q", "advertise-l", "browse-q", "browse-l", "dial-l", "answer-l")

/**
 * `services.connect.localPairing` of a discovery body: true only as the boolean `true` while
 * `services.connect.enabled` is the boolean `true`. A body of any other shape, a disabled service and an absent
 * member all read as false.
 */
public fun localPairingOf(body: JsonElement?): Boolean {
    val connect = body.objectValue?.get("services").objectValue?.get("connect").objectValue
    return connect?.get("enabled").boolValue == true && connect?.get("localPairing").boolValue == true
}

/**
 * The SDK's enforcement of the operator gate from the discovery document it cached. No cached document is off, and
 * offline a cached `true` keeps working. A successful read replaces the answer, a not-found clears it, an error
 * changes nothing; a read that leaves a cached `true` behind returns the effects the host must carry out. Thread-safe.
 */
public class LocalPairingGate(start: GateState = GateState.None) {
    private val lock = Any()
    private var cached: GateState = start

    public val state: GateState get() = synchronized(lock) { cached }

    public val allowed: Boolean get() = state == GateState.On

    /** A successful discovery read whose answer is [on] (see [localPairingOf]). */
    public fun readOk(on: Boolean): List<GateEffect> = set(if (on) GateState.On else GateState.Off)

    /** A successful discovery read of [body]. */
    public fun readOk(body: JsonElement?): List<GateEffect> = readOk(localPairingOf(body))

    /** A not-found discovery read: the cached answer is cleared. */
    public fun readNotFound(): List<GateEffect> = set(GateState.None)

    /** A failed read (offline, an error status): nothing changes. */
    public fun readError(): List<GateEffect> = emptyList()

    private fun set(next: GateState): List<GateEffect> = synchronized(lock) {
        val was = cached
        cached = next
        if (was == GateState.On && next != GateState.On) GateEffect.entries.toList() else emptyList()
    }

    /** `local-pairing-off` for a gated call while the gate is not on, else `ok`. */
    public fun check(): String = if (allowed) "ok" else "local-pairing-off"

    override fun toString(): String = "LocalPairingGate($state)"
}

// -- The pairing exchange (section 15.12, "Consent and LOCAL_LINK") -------------------------------

/** One event of a pairing, in the order a side sees it. */
public sealed class LocalExchangeEvent {
    public object OwnConfirm : LocalExchangeEvent()

    public object OwnDecline : LocalExchangeEvent()

    public object PeerConfirm : LocalExchangeEvent()

    public class PeerLink(public val body: ByteArray) : LocalExchangeEvent()

    /** 120 s from the first byte ran out. */
    public object TimeoutConfirm : LocalExchangeEvent()

    /** [CONTACT_EXCHANGE_SECONDS] after both `CONFIRM`s ran out. */
    public object TimeoutExchange : LocalExchangeEvent()
}

/** What one step makes a side do. */
public class LocalExchangeStep(
    /** The records this step makes the side send: `CONFIRM`, `LOCAL_LINK`. */
    public val sends: List<String> = emptyList(),
    public val close: PeerCloseCode? = null,
    /** The peer's `LOCAL_LINK`, valid, read in order: the host stores the link. */
    public val stored: LocalLinkBody? = null,
)

/**
 * One side's order guard over the records of the pairing (section 15.12, "Order of checks"). A `LOCAL_LINK` goes out
 * once this side has sent its `CONFIRM` and read the peer's; the peer's arrives only after both. The first valid
 * `LOCAL_LINK` is stored and the side closes `peer_bye`; after any close nothing happens, so a second `LOCAL_LINK`
 * is never answered. [held] is the number of local links the device holds; [cats] are this side's approved ones.
 */
public class LocalExchange(private val held: Int, private val cats: List<String>) {
    private var ownConfirmed = false
    private var peerConfirmed = false
    private var linkSent = false
    private var dead = false

    /** Both `CONFIRM`s are done (this side's sent, the peer's read), and no link has closed the session. */
    public val bothConfirmed: Boolean get() = !dead && ownConfirmed && peerConfirmed

    private fun end(close: PeerCloseCode, stored: LocalLinkBody? = null): LocalExchangeStep {
        dead = true
        return LocalExchangeStep(close = close, stored = stored)
    }

    private fun maybeLink(): List<String> {
        if (ownConfirmed && peerConfirmed && !linkSent) {
            linkSent = true
            return listOf("LOCAL_LINK")
        }
        return emptyList()
    }

    public fun step(e: LocalExchangeEvent): LocalExchangeStep {
        if (dead) return LocalExchangeStep()
        return when (e) {
            LocalExchangeEvent.OwnConfirm -> {
                if (ownConfirmed) return LocalExchangeStep()
                ownConfirmed = true
                LocalExchangeStep(sends = listOf("CONFIRM") + maybeLink())
            }

            // A decline after this side's CONFIRM is not an event: the person already agreed.
            LocalExchangeEvent.OwnDecline -> if (ownConfirmed) LocalExchangeStep() else end(PeerCloseCode.peer_bye)

            LocalExchangeEvent.PeerConfirm -> {
                if (peerConfirmed) return end(PeerCloseCode.peer_bad_frame)
                peerConfirmed = true
                LocalExchangeStep(sends = maybeLink())
            }

            is LocalExchangeEvent.PeerLink -> onLink(e.body)

            LocalExchangeEvent.TimeoutConfirm -> if (ownConfirmed && peerConfirmed) LocalExchangeStep() else end(PeerCloseCode.peer_timeout)

            LocalExchangeEvent.TimeoutExchange -> if (ownConfirmed && peerConfirmed) end(PeerCloseCode.peer_timeout) else LocalExchangeStep()
        }
    }

    private fun onLink(body: ByteArray): LocalExchangeStep {
        if (!ownConfirmed || !peerConfirmed) return end(PeerCloseCode.peer_bad_frame)
        val v = parseLocalLink(body) ?: return end(PeerCloseCode.peer_bad_frame)
        if (held >= MAX_LOCAL_LINKS) return end(PeerCloseCode.peer_not_allowed)
        return end(PeerCloseCode.peer_bye, LocalLinkBody(v.label, localCategories(cats, v.cats)))
    }
}

// -- The pin (section 15.12, "Mode l" and "Link keys") --------------------------------------------

/**
 * Mode l: the remote static key must be the peer link key of the link whose secret opened the session. The initiator
 * asks after message 2, the responder after message 3; a false ends the session as `peer_revoked` with nothing sent.
 */
public fun localPin(held: ByteArray, remoteStatic: ByteArray): Boolean = sameKey(held, remoteStatic)

/**
 * Mode q: a remote static key equal to this side's own link key ends the handshake silently, before the transport
 * (a reflected handshake). True means the key is another's.
 */
public fun pairingRemoteOk(own: ByteArray, remoteStatic: ByteArray): Boolean = !sameKey(own, remoteStatic)

// -- The listener's trial order (section 15.5 "One listener, one order") --------------------------

/** The trials a full miss costs: two account keys, 72 contact secrets and 32 local-link secrets. */
public const val TRIAL_TOTAL: Int = 2 + MAX_CONTACT_SECRETS + MAX_LOCAL_LINKS

/** Dummy trials after a miss behind the limiter, so a silent close costs [TRIAL_TOTAL] trials. */
public fun trialPadding(tried: Int): Int = maxOf(0, TRIAL_TOTAL - tried)

/** One trial: `a` an account discovery key, `c` a contact secret, `l` a local-link secret, and its index in the list as held. */
public data class TrialEntry(val kind: Char, val index: Int)

/**
 * The order a shared listener tries message 1 in: the account's keys (an absent one is skipped), then the contact
 * secrets (at most [MAX_CONTACT_SECRETS]), then the local-link secrets in held order (at most [MAX_LOCAL_LINKS]): at
 * most [MAX_LINK_SECRETS] secrets after the account keys. The contact and local-link trials sit behind the contact
 * limiter; the account keys do not. [account] is null for a listener with no account.
 */
public fun listenerTrialOrder(account: List<Any?>?, contacts: Int, locals: Int): List<TrialEntry> {
    val out = ArrayList<TrialEntry>()
    (account ?: emptyList()).take(2).forEachIndexed { index, k -> if (k != null) out += TrialEntry('a', index) }
    for (i in 0 until minOf(contacts, MAX_CONTACT_SECRETS)) out += TrialEntry('c', i)
    for (i in 0 until minOf(locals, MAX_LOCAL_LINKS)) out += TrialEntry('l', i)
    return out
}
