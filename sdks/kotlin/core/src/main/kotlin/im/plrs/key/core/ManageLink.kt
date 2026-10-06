// Refusal links (PX-W8, WIRE-CONTRACT-V4 §5.3): the `manageUrl` the Worker puts on the
// `device_limit` (and, with Identity, `key_entry_limit`) refusal, and the two things a client may
// add to it. A port of Swift's `PolarisKeyCore/ManageLink.swift`.
//
// Pure functions: no I/O, no signing, no change to any result type. The link is never an auth
// failure, so nothing here wipes state or asks for a retry; a host opens it only behind a user
// action ("Replace a device"). Every SDK pins the same table of cases (client-core
// `test/manage.test.ts`), so the links each one builds are byte-identical.

package im.plrs.key.core

public object ManageLink {
    /** The longest `manageUrl` a client keeps (characters); a longer one is ignored. */
    public const val MAX_LENGTH: Int = 2048

    private val loopback = setOf("localhost", "127.0.0.1", "[::1]", "::1")

    private class Parsed(val path: String)

    private fun parse(raw: String): Parsed? {
        if (raw.isEmpty() || raw.length > MAX_LENGTH) return null
        if (raw.any { it.isWhitespace() || it.code < 0x20 || it.code == 0x7F || it.isISOControl() }) return null
        val sep = raw.indexOf("://")
        if (sep <= 0) return null
        val scheme = raw.substring(0, sep).lowercase()
        val rest = raw.substring(sep + 3)
        val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }.let { if (it == -1) rest.length else it }
        val authority = rest.substring(0, end)
        if ('@' in authority || '\\' in authority) return null
        var host = authority
        if (host.startsWith("[")) {
            val close = host.indexOf(']')
            if (close == -1) return null
            host = host.substring(0, close + 1)
        } else if (':' in host) {
            host = host.substring(0, host.lastIndexOf(':'))
        }
        host = host.lowercase()
        if (host.isEmpty()) return null
        val tail = rest.substring(end)
        val pathEnd = tail.indexOfFirst { it == '?' || it == '#' }.let { if (it == -1) tail.length else it }
        val path = tail.substring(0, pathEnd)
        return when {
            scheme == "https" -> Parsed(path)
            scheme == "http" && host in loopback -> Parsed(path)
            else -> null
        }
    }

    /**
     * Is [raw] a link a client may show: an absolute `https` URL (or `http` to a loopback host),
     * with no userinfo, at most [MAX_LENGTH] characters?
     */
    public fun isValid(raw: String?): Boolean = raw != null && parse(raw) != null

    /** The first valid candidate (the top-level member, then the nested one), or null. */
    public fun read(vararg candidates: String?): String? = candidates.firstOrNull { isValid(it) }

    /**
     * The WHATWG `application/x-www-form-urlencoded` byte serializer: UTF-8, then
     * `A-Z a-z 0-9 * - . _` as themselves, space as `+`, every other byte as `%XX`.
     */
    public fun formEncode(value: String): String {
        val out = StringBuilder()
        for (b in value.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xFF
            when {
                c in 0x41..0x5A || c in 0x61..0x7A || c in 0x30..0x39 ||
                    c == '*'.code || c == '-'.code || c == '.'.code || c == '_'.code -> out.append(c.toChar())
                c == 0x20 -> out.append('+')
                else -> out.append('%').append(String.format("%02X", c))
            }
        }
        return out.toString()
    }

    private fun appendParam(target: String, name: String, encoded: String): String {
        val q = target.indexOf('?')
        val path = if (q == -1) target else target.substring(0, q)
        val kept = (if (q == -1) "" else target.substring(q + 1))
            .split('&')
            .filter { it.isNotEmpty() && it != name && !it.startsWith("$name=") }
            .toMutableList()
        kept.add("$name=$encoded")
        return "$path?${kept.joinToString("&")}"
    }

    /**
     * Add the app's return URL as `return=`: inside the fragment's query when the fragment holds a
     * portal route (`#/…`), else in the URL's query. An earlier `return` is replaced and every
     * other byte is kept. [url] comes back unchanged when it is not a valid link or [returnUrl] is
     * empty.
     */
    public fun withReturn(url: String, returnUrl: String): String {
        if (parse(url) == null || returnUrl.isEmpty()) return url
        val encoded = formEncode(returnUrl)
        val h = url.indexOf('#')
        if (h == -1) return appendParam(url, "return", encoded)
        val base = url.substring(0, h)
        val fragment = url.substring(h + 1)
        if (fragment.startsWith("/")) return "$base#${appendParam(fragment, "return", encoded)}"
        return "${appendParam(base, "return", encoded)}#$fragment"
    }

    /**
     * Add the licence key as the fragment `#key=<key>` on an `/activate` link. Any other link (the
     * free-device route) or an invalid one comes back unchanged: the key is never put anywhere
     * else, and a fragment never reaches a server.
     */
    public fun withKey(url: String, key: String): String {
        val parsed = parse(url) ?: return url
        if (key.isEmpty() || parsed.path.trimEnd('/') != "/activate") return url
        val h = url.indexOf('#')
        if (h != -1 && url.substring(h + 1).startsWith("/")) return url
        val base = if (h == -1) url else url.substring(0, h)
        return "$base#key=${formEncode(key)}"
    }
}
