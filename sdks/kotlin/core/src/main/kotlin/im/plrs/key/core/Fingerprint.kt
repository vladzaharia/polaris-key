// Hardware fingerprint derivation from SUPPLIED inputs — WIRE-CONTRACT-V3 §6.1, pinned by
// `conformance/corpus/v2/fingerprint.json`. Each component is hashed on the device as
// `pkey-hw:<product>:<component>:<raw>` → SHA-256 → base64url, first 22 characters, so a raw
// serial never crosses the wire; the composite `hwid` is a second digest over the present
// components in CANONICAL order, first 32 characters.
//
// The three source rules are pure functions of what a reader produced: `parseWindowsCim` (rule 1,
// what `WINDOWS_CIM_COMMAND` printed), `linuxAnchorSource` (rule 2) and `ramBucket` (rule 3).
// READING this host's hardware is per platform: Android's inputs (the app-scoped id and the
// Keystore anchor) are the :android module's (P6-12).

package im.plrs.key.core

import java.math.BigInteger
import java.security.MessageDigest

/** One hashed hardware signal, in canonical order; `machineUuid` is the anchor. */
public enum class FingerprintComponent(public val wire: String) {
    machineUuid("machineUuid"),
    boardSerial("boardSerial"),
    cpuModel("cpuModel"),
    primaryMac("primaryMac"),
    bootVolumeUuid("bootVolumeUuid"),
    ramBucket("ramBucket"),
    machineModel("machineModel"),
}

/** A device's hardware identity: per-component digests and their composite. */
public data class HardwareFingerprint(val components: Map<String, String>, val hwid: String)

/** Rule 1's pinned command. */
public data class WindowsCimCommand(val program: String, val args: List<String>, val stdin: String, val timeoutMs: Long)

/** A Linux anchor: which file, and its trimmed content. */
public data class AnchorSource(val source: String, val value: String)

/** Rule 2's sources, in order. No DMI file is ever read (root-only). */
public val LINUX_ANCHOR_PATHS: List<String> = listOf("/etc/machine-id", "/var/lib/dbus/machine-id")

public object Fingerprint {
    /** Canonical component order: the hwid digest walks this list. */
    public val COMPONENT_ORDER: List<FingerprintComponent> = FingerprintComponent.entries

    private const val HASH_PREFIX = "pkey-hw"
    private const val COMPONENT_LENGTH = 22
    private const val HWID_LENGTH = 32

    /** The exact command a Windows reader runs (`fingerprint.json#/windowsCimCommand`). */
    public val WINDOWS_CIM_COMMAND: WindowsCimCommand = WindowsCimCommand(
        program = "powershell.exe",
        args = listOf(
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "\$ErrorActionPreference='Stop';\$b=\$null;\$m=\$null;" +
                "try{\$b=@(Get-CimInstance -ClassName Win32_BaseBoard -Property SerialNumber)[-1].SerialNumber}catch{};" +
                "try{\$m=@(Get-CimInstance -ClassName Win32_ComputerSystem -Property Model)[-1].Model}catch{};" +
                "\$j=ConvertTo-Json -Compress -InputObject @{boardSerial=\$b;machineModel=\$m};" +
                "\$o='';foreach(\$c in \$j.ToCharArray()){\$n=[int]\$c;if(\$n -gt 126){\$o+='\\u'+\$n.ToString('x4')}else{\$o+=\$c}};\$o",
        ),
        stdin = "null",
        timeoutMs = 10_000,
    )

    private fun sha256B64url(value: String, length: Int): String =
        Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))).take(length)

    /** Hash raw component values into the wire form. A component absent from [raw] is omitted. */
    public fun hashComponents(productSlug: String, raw: Map<String, String>): HardwareFingerprint {
        val components = LinkedHashMap<String, String>()
        val parts = ArrayList<String>()
        for (component in COMPONENT_ORDER) {
            val value = raw[component.wire] ?: continue
            val digest = sha256B64url("$HASH_PREFIX:$productSlug:${component.wire}:$value", COMPONENT_LENGTH)
            components[component.wire] = digest
            parts += "${component.wire}=$digest"
        }
        return HardwareFingerprint(components, sha256B64url(parts.joinToString("\n"), HWID_LENGTH))
    }

    /** Rules 1 and 2 trim exactly U+0009–U+000D and U+0020. */
    public fun trimAsciiWhitespace(value: String): String {
        fun space(c: Char) = c in '\u0009'..'\u000D' || c == ' '
        var start = 0
        var end = value.length
        while (start < end && space(value[start])) start++
        while (end > start && space(value[end - 1])) end--
        return value.substring(start, end)
    }

    /**
     * Rule 1: parse what [WINDOWS_CIM_COMMAND] printed. One leading U+FEFF is stripped; the text
     * must be a JSON object; `boardSerial` and `machineModel` are kept when each is a string
     * that is non-empty after trimming. Anything else yields an empty map.
     */
    public fun parseWindowsCim(stdout: String?): Map<String, String> {
        if (stdout.isNullOrEmpty()) return emptyMap()
        val text = if (stdout[0] == '\uFEFF') stdout.substring(1) else stdout
        val o = JsonText.parseOrNull(text).objectValue ?: return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (key in listOf("boardSerial", "machineModel")) {
            val value = o[key].stringValue ?: continue
            val trimmed = trimAsciiWhitespace(value)
            if (trimmed.isNotEmpty()) out[key] = trimmed
        }
        return out
    }

    /**
     * Rule 2: the first of [LINUX_ANCHOR_PATHS] whose content, trimmed, is non-empty and not
     * systemd's `uninitialized`. [files] maps each READABLE path to its content.
     */
    public fun linuxAnchorSource(files: Map<String, String?>): AnchorSource? {
        for (source in LINUX_ANCHOR_PATHS) {
            val content = files[source] ?: continue
            val value = trimAsciiWhitespace(content)
            if (value.isNotEmpty() && value != "uninitialized") return AnchorSource(source, value)
        }
        return null
    }

    /**
     * Rule 3: `g = floor(bytes / 2^30)`; null when `g == 0`, otherwise the largest power of two
     * not above `g`, in decimal. Integer arithmetic only.
     */
    public fun ramBucket(bytes: BigInteger): String? {
        if (bytes.signum() <= 0) return null
        val g = bytes.shiftRight(30)
        if (g.signum() == 0) return null
        return BigInteger.ONE.shiftLeft(g.bitLength() - 1).toString()
    }

    /** [ramBucket] over a Long byte count. */
    public fun ramBucket(bytes: Long): String? = ramBucket(BigInteger.valueOf(bytes))
}
