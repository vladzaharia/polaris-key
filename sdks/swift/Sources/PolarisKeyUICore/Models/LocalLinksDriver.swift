// @pkey-feature connect.local
// The narrow driver under Pair with a Code (CC-29K): what `LocalPairingModel` and `PairedDevicesModel`
// call, so a host binds `client.cloudConnect.localLinks` (`LocalLinksDriver.links`) and a test binds a
// fake. The reference is packages/ui-core/src/localPairingModel.ts (`LocalLinksLike`).

import Foundation
import PolarisKey
import PolarisKeyCore

/// A rejection, read by what a typed error carries: its registered code, the reason and the cap.
public struct KitLocalError: Error, Sendable, Equatable {
    public let code: String
    public let reason: String?
    public let cap: String?
    public init(code: String, reason: String? = nil, cap: String? = nil) {
        self.code = code
        self.reason = reason
        self.cap = cap
    }
}

/// The code a shower shows now.
public struct KitLocalCode: Sendable, Equatable {
    public let code: String
    public let qr: String
    /// `opened`, `wrong-code`, `declined`, `timeout` or `closed` (`LocalCodeReason`).
    public let reason: String
    public let expiresAt: Int
    public init(code: String, qr: String, reason: String, expiresAt: Int) {
        self.code = code
        self.qr = qr
        self.reason = reason
        self.expiresAt = expiresAt
    }
}

/// The other device at consent.
public struct KitLocalOffer: Sendable {
    public let label: String?
    public let categories: [String]
    public let confirm: @Sendable () async -> Void
    public let decline: @Sendable () async -> Void
    public init(
        label: String?, categories: [String], confirm: @escaping @Sendable () async -> Void,
        decline: @escaping @Sendable () async -> Void
    ) {
        self.label = label
        self.categories = categories
        self.confirm = confirm
        self.decline = decline
    }
}

/// A pairing that was stored.
public struct KitLocalPaired: Sendable, Equatable {
    public let id: String
    public let label: String?
    public init(id: String, label: String?) {
        self.id = id
        self.label = label
    }
}

/// The open pairing window.
public struct KitLocalWindow: Sendable {
    public let stop: @Sendable () async -> Void
    public let renew: @Sendable () async throws -> KitLocalCode
    public init(
        stop: @escaping @Sendable () async -> Void,
        renew: @escaping @Sendable () async throws -> KitLocalCode
    ) {
        self.stop = stop
        self.renew = renew
    }
}

/// What a pairing window tells the model.
public struct KitLocalEvents: Sendable {
    public var onCode: @Sendable (KitLocalCode) -> Void
    public var onConfirm: @Sendable (KitLocalOffer) -> Void
    public var onLinked: @Sendable (KitLocalPaired) -> Void
    public var onInterrupted: @Sendable (Int) -> Void
    /// `expired`, `too-many-tries`, `stored`, `person` or `off` (`LocalWindowEnd`).
    public var onEnd: @Sendable (String) -> Void
    public init(
        onCode: @escaping @Sendable (KitLocalCode) -> Void,
        onConfirm: @escaping @Sendable (KitLocalOffer) -> Void,
        onLinked: @escaping @Sendable (KitLocalPaired) -> Void,
        onInterrupted: @escaping @Sendable (Int) -> Void,
        onEnd: @escaping @Sendable (String) -> Void
    ) {
        self.onCode = onCode
        self.onConfirm = onConfirm
        self.onLinked = onLinked
        self.onInterrupted = onInterrupted
        self.onEnd = onEnd
    }
}

/// What a scanned text is, judged before the join: a pairing code of this app, another app's, or no
/// pairing code at all (`PeerLocal.parseQr`).
public enum KitQrRead: Sendable, Equatable {
    case ours, otherApp, invalid
}

/// `client.cloudConnect.localLinks` as far as the two models need it. Calls throw `KitLocalError`
/// (or `CancellationError` for a cancelled join).
public struct LocalLinksDriver: Sendable {
    /// The cached discovery answer: false while pairing is off for this app.
    public var localPairing: @Sendable () -> Bool
    public var list: @Sendable () async throws -> [KitPairedDevice]
    public var rename: @Sendable (_ id: String, _ label: String) async throws -> Void
    public var remove: @Sendable (_ id: String) async throws -> Void
    public var setReachable: @Sendable (_ id: String, _ reachable: Bool) async throws -> Void
    /// Fires after any change to the links or the gate. Returns the unsubscribe.
    public var onChange: @Sendable (@escaping @Sendable () -> Void) -> @Sendable () -> Void
    /// Dials left for the typed code's first two digits (0, 1 or 2); nil until two are typed.
    public var dialsLeft: @Sendable (String) -> Int?
    public var pair:
        @Sendable (_ categories: [String], _ label: String?, _ events: KitLocalEvents) async throws
            -> KitLocalWindow
    public var join:
        @Sendable (
            _ code: String, _ categories: [String], _ label: String?,
            _ onConfirm: @escaping @Sendable (KitLocalOffer) -> Void
        ) async throws -> KitLocalPaired
    /// Sorts a scanned text locally, so another app's QR is said in place and never reaches `join`.
    /// The default trusts the text (the join answers it).
    public var readQr: @Sendable (_ text: String) -> KitQrRead

    public init(
        localPairing: @escaping @Sendable () -> Bool,
        list: @escaping @Sendable () async throws -> [KitPairedDevice],
        rename: @escaping @Sendable (String, String) async throws -> Void,
        remove: @escaping @Sendable (String) async throws -> Void,
        setReachable: @escaping @Sendable (String, Bool) async throws -> Void,
        onChange: @escaping @Sendable (@escaping @Sendable () -> Void) -> @Sendable () -> Void,
        dialsLeft: @escaping @Sendable (String) -> Int?,
        pair: @escaping @Sendable ([String], String?, KitLocalEvents) async throws -> KitLocalWindow,
        join:
            @escaping @Sendable (
                String, [String], String?, @escaping @Sendable (KitLocalOffer) -> Void
            ) async throws -> KitLocalPaired,
        readQr: @escaping @Sendable (String) -> KitQrRead = { _ in .ours }
    ) {
        self.localPairing = localPairing
        self.list = list
        self.rename = rename
        self.remove = remove
        self.setReachable = setReachable
        self.onChange = onChange
        self.dialsLeft = dialsLeft
        self.pair = pair
        self.join = join
        self.readQr = readQr
    }
}

#if canImport(Network)
    extension LocalLinksDriver {
        /// The driver over `client.cloudConnect.localLinks`. `product` is this app's product slug: with
        /// it a scanned QR is sorted before the join (another app's code is said in place).
        public static func links(_ links: LocalLinks, product: String? = nil) -> LocalLinksDriver {
            LocalLinksDriver(
                localPairing: { links.localPairing() },
                list: {
                    do {
                        return try await links.list().map {
                            KitPairedDevice(
                                id: $0.id, label: $0.label, lastSeen: $0.lastSeen,
                                reachable: $0.reachable, platform: $0.platform)
                        }
                    } catch { throw mapLocalError(error) }
                },
                rename: { id, label in
                    do { _ = try await links.rename(id, label) } catch { throw mapLocalError(error) }
                },
                remove: { id in
                    do { _ = try await links.remove(id) } catch { throw mapLocalError(error) }
                },
                setReachable: { id, on in
                    do { _ = try await links.setReachable(id, on) } catch { throw mapLocalError(error) }
                },
                onChange: { fn in links.onChange(fn) },
                dialsLeft: { links.dialsLeft($0) },
                pair: { categories, label, events in
                    let options = LocalPairOptions(
                        categories: categories, label: label,
                        onCode: { events.onCode(mapLocalCode($0)) },
                        onConfirm: { events.onConfirm(mapLocalOffer($0)) },
                        onLinked: { events.onLinked(KitLocalPaired(id: $0.id, label: $0.label)) },
                        onInterrupted: { events.onInterrupted($0) },
                        onEnd: { events.onEnd($0.reason.rawValue) })
                    do {
                        let handle = try await links.pair(options)
                        return KitLocalWindow(
                            stop: { await handle.stop() },
                            renew: {
                                do { return mapLocalCode(try await handle.renew()) } catch {
                                    throw mapLocalError(error)
                                }
                            })
                    } catch { throw mapLocalError(error) }
                },
                join: { code, categories, label, onConfirm in
                    let options = LocalJoinOptions(
                        categories: categories, label: label, code: code,
                        onConfirm: { onConfirm(mapLocalOffer($0)) })
                    do {
                        let paired = try await links.join(options)
                        return KitLocalPaired(id: paired.id, label: paired.label)
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch { throw mapLocalError(error) }
                },
                readQr: { text in
                    guard let own = product?.lowercased(), !own.isEmpty else { return .ours }
                    switch PeerLocal.parseQr(text, own: own) {
                    case .ok: return .ours
                    case .otherApp: return .otherApp
                    case .invalid: return .invalid
                    }
                })
        }
    }

    private func mapLocalCode(_ c: LocalCode) -> KitLocalCode {
        KitLocalCode(code: c.code, qr: c.qr, reason: c.reason.rawValue, expiresAt: c.expiresAt)
    }

    private func mapLocalOffer(_ o: LocalOffer) -> KitLocalOffer {
        KitLocalOffer(
            label: o.label, categories: o.categories, confirm: { await o.confirm() },
            decline: { await o.decline() })
    }

    /// An SDK rejection as the fields the models read.
    func mapLocalError(_ error: Error) -> KitLocalError {
        if let e = error as? KitLocalError { return e }
        if let e = error as? LocalPairingError {
            return KitLocalError(code: e.code, reason: e.reason?.rawValue, cap: e.cap?.rawValue)
        }
        if let e = error as? LocalPairingOff { return KitLocalError(code: e.code) }
        if let e = error as? ConnectLanError {
            return KitLocalError(code: e.code, reason: e.reason == .badType ? "bad_input" : nil)
        }
        return KitLocalError(code: "unknown")
    }
#endif
