// WIRE-CONTRACT-V5 §15.4: discovery adverts (CC-11.6). Swift mirror of client-core's
// `peer/advert.ts`. Pure functions: the account instance name, the product tag, TXT parsing and
// the browse match. Nothing here does I/O.

import Foundation

public let peerAdvertEpochSeconds = 900

/// The 15-minute epoch of a time in seconds since 1970.
public func peerAdvertEpoch(_ nowSeconds: Int) -> Int {
    let q = nowSeconds / peerAdvertEpochSeconds
    return nowSeconds % peerAdvertEpochSeconds < 0 ? q - 1 : q
}

public enum PeerAdvertError: Error, Sendable, Equatable {
    case deviceId
    case epoch
}

public enum PeerAdvert {
    private static let base32 = Array("abcdefghijklmnopqrstuvwxyz234567")

    private static func isLowerDigit(_ c: Unicode.Scalar) -> Bool {
        (c.value >= 0x61 && c.value <= 0x7a) || (c.value >= 0x32 && c.value <= 0x37)
    }

    private static func u64be(_ n: Int) throws -> Data {
        guard let u = UInt64(exactly: n) else { throw PeerAdvertError.epoch }
        return Data((0..<8).map { UInt8((u >> UInt64(56 - 8 * $0)) & 0xff) })
    }

    /// RFC 4648 base32, lower-case alphabet, no padding.
    public static func base32Lower(_ b: Data) -> String {
        var bits = 0
        var acc = 0
        var out = ""
        for x in b {
            acc = (acc << 8) | Int(x)
            bits += 8
            while bits >= 5 {
                out.append(base32[(acc >> (bits - 5)) & 31])
                bits -= 5
            }
            acc &= (1 << bits) - 1
        }
        if bits > 0 { out.append(base32[(acc << (5 - bits)) & 31]) }
        return out
    }

    /// A device id is 32 base64url characters: the 24 bytes the advert and the relay use.
    public static func deviceIdBytes(_ id: String) throws -> Data {
        let scalars = Array(id.unicodeScalars)
        guard scalars.count == 32,
            scalars.allSatisfy({
                ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5a)
                    || ($0.value >= 0x61 && $0.value <= 0x7a) || $0 == "-" || $0 == "_"
            }),
            let d = Base64URL.decode(id), d.count == 24
        else { throw PeerAdvertError.deviceId }
        return d
    }

    /// The mode-a instance name of a device in one epoch under one discovery key.
    public static func accountInstance(discoveryKey: Data, epoch: Int, deviceId: String) throws -> String {
        let msg = Data("pkey-peer/1 disc".utf8) + [0] + (try u64be(epoch)) + (try deviceIdBytes(deviceId))
        return "p1-" + String(base32Lower(PeerNoiseHash.hmacSHA256(key: discoveryKey, msg)).prefix(16))
    }

    /// The `h` TXT value of the approver and pair adverts.
    public static func productTag(slug: String, epoch: Int) throws -> String {
        let salt = PeerNoiseHash.sha256(Data("pkey-peer/1 salt".utf8), Data([0]), Data(slug.utf8))
        let mac = PeerNoiseHash.hmacSHA256(
            key: salt, Data("pkey-peer/1 pair".utf8) + [0] + (try u64be(epoch)))
        return String(mac.map { String(format: "%02x", $0) }.joined().prefix(16))
    }

    /// `p1-` and 16 characters of `a-z2-7`.
    public static func isInstanceName(_ name: String) -> Bool {
        let s = Array(name.unicodeScalars)
        return s.count == 19 && s[0] == "p" && s[1] == "1" && s[2] == "-" && s[3...].allSatisfy(isLowerDigit)
    }

    public enum TxtRefusal: String, Sendable, Equatable {
        case duplicate, version, mode, tag
    }

    public enum TxtResult: Sendable, Equatable {
        case ok(mode: PeerNoiseMode, h: String?)
        case refused(TxtRefusal)
    }

    /// An entry splits at its first `=`; one without `=` or with an empty key is ignored; a
    /// repeated key refuses.
    public static func parseTxt(_ entries: [String]) -> TxtResult {
        var kv: [String: String] = [:]
        for e in entries {
            guard let at = e.firstIndex(of: "="), at != e.startIndex else { continue }
            let k = String(e[e.startIndex..<at])
            if kv[k] != nil { return .refused(.duplicate) }
            kv[k] = String(e[e.index(after: at)...])
        }
        guard kv["v"] == "1" else { return .refused(.version) }
        guard let m = kv["m"], let mode = PeerNoiseMode(rawValue: m) else { return .refused(.mode) }
        if mode == .a { return .ok(mode: mode, h: nil) }
        guard let h = kv["h"], h.unicodeScalars.count == 16,
            h.unicodeScalars.allSatisfy({
                ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x61 && $0.value <= 0x66)
            })
        else { return .refused(.tag) }
        return .ok(mode: mode, h: h)
    }

    public struct BrowseHit: Sendable, Equatable {
        public let deviceId: String
        /// 0 the current epoch, 1 the previous one.
        public let epochBack: Int
        /// 0 the newest discovery key, 1 the previous one.
        public let keyIndex: Int
    }

    /// Which roster device an account instance belongs to: the current and the previous epoch, the
    /// (at most two) delivered keys, newest first. At most 512 HMACs for a 128-device roster.
    public static func browseAccountInstance(
        _ instance: String, discoveryKeys: [Data], now: Int, roster: [String]
    ) throws -> BrowseHit? {
        guard isInstanceName(instance) else { return nil }
        let epoch = peerAdvertEpoch(now)
        for epochBack in 0...1 {
            for (i, key) in discoveryKeys.prefix(2).enumerated() {
                for deviceId in roster.prefix(128)
                where try accountInstance(discoveryKey: key, epoch: epoch - epochBack, deviceId: deviceId)
                    == instance
                {
                    return BrowseHit(deviceId: deviceId, epochBack: epochBack, keyIndex: i)
                }
            }
        }
        return nil
    }
}
