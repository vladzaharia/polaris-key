// Bonjour browse for Cloud Connect's LAN service (CC-11.7; WIRE-CONTRACT-V5 §15.4, D-5, D-6).
// Standalone, like the rest of this target: it knows nothing of the protocol. The LAN service
// (CC-11.12) matches instances to the roster; this file only turns what the OS finds for
// `_pkeypeer._tcp` into (instance, TXT, endpoint) rows.
//
//   - The OS resolves addresses, so the A-record rule of G5 does not apply here. The dial rule
//     (G6, D-10) is checked on the connected path by the pipe (CC-11.11).
//   - The instance table is bounded as G5 asks: at most 256 instances, the least recently
//     refreshed one evicted when full, at most 8 TXT entries per instance, and an instance name
//     of any shape but the advert's (`p1-` and 16 of a-z2-7) is dropped. The OS owns expiry: it
//     removes a result when the service goes away, so no timer of ours runs.
//   - Peer-to-peer (AWDL) is off unless the host asks (D-5): adverts would otherwise reach
//     devices that are not on the network.
//   - A refused Local Network permission is `.permissionDenied`; a missing `NSBonjourServices`
//     entry or `NSLocalNetworkUsageDescription` on iOS, tvOS or visionOS is `.notConfigured`.
//     Both are reported when browsing starts (L-11), never at launch.
//
// The tests drive `BonjourBrowseDriver`, the seam; `NWBrowserDriver` is the one that touches the
// network and is exercised only by the opt-in live test (`PKEY_LIVE_BONJOUR=1`).

import Foundation

#if canImport(Network)
    import Network
#endif

/// The Bonjour service type of a Polaris Key peer.
public let bonjourPeerServiceType = "_pkeypeer._tcp"

/// What the OS gave for one instance: where to connect to, as the OS names it.
public struct BonjourEndpoint: Sendable, Hashable {
    public let name: String
    public let type: String
    public let domain: String
    #if canImport(Network)
        /// The endpoint to hand to `NWConnection`. Nil only in tests.
        public let network: NWEndpoint?

        public init(
            name: String, type: String = bonjourPeerServiceType, domain: String = "local.", network: NWEndpoint? = nil
        ) {
            self.name = name
            self.type = type
            self.domain = domain
            self.network = network
        }
    #else
        public init(name: String, type: String = bonjourPeerServiceType, domain: String = "local.") {
            self.name = name
            self.type = type
            self.domain = domain
        }
    #endif
}

/// A browse hit: the instance name, its TXT entries (`key=value`, at most 8) and its endpoint.
public struct BonjourFound: Sendable, Hashable {
    public let instance: String
    public let txt: [String]
    public let endpoint: BonjourEndpoint

    public init(instance: String, txt: [String], endpoint: BonjourEndpoint) {
        self.instance = instance
        self.txt = txt
        self.endpoint = endpoint
    }
}

public struct BonjourBrowseOptions: Sendable, Equatable {
    /// Browse over AWDL too (`includePeerToPeer`). Off by default (D-5).
    public var peerToPeer: Bool

    public init(peerToPeer: Bool = false) { self.peerToPeer = peerToPeer }
}

public enum BonjourBrowseError: Error, Sendable, Equatable {
    /// The person (or a profile) refused Local Network access.
    case permissionDenied
    /// The app's Info.plist lacks what the OS needs before it will browse.
    case notConfigured
    /// Anything else the browser reported. The text is the OS's, never a peer's.
    case unavailable(String)
}

/// What a driver reports.
public enum BonjourDriverEvent: Sendable, Equatable {
    /// Results that appeared or changed.
    case upserted([BonjourFound])
    /// Results that went away, by instance name.
    case removed([String])
    case failed(BonjourBrowseError)
}

/// The seam. `start` begins browsing and returns the function that stops it.
public protocol BonjourBrowseDriver: Sendable {
    func start(includePeerToPeer: Bool, emit: @escaping @Sendable (BonjourDriverEvent) -> Void) -> @Sendable () -> Void
    /// Everything the browser holds right now (`NWBrowser.browseResults`); empty when it is not running.
    func snapshot() -> [BonjourFound]
}

extension BonjourBrowseDriver {
    public func snapshot() -> [BonjourFound] { [] }
}

// MARK: - Classification

public enum BonjourErrors {
    /// `DNSServiceErrorType` values from `dns_sd.h`, as plain numbers (the header is not imported
    /// here so this file type-checks off Apple).
    public static let dnsPolicyDenied: Int32 = -65570
    public static let dnsNoAuth: Int32 = -65555

    /// A DNS-SD error number as a browse error: PolicyDenied is the refused permission, NoAuth is
    /// a missing entitlement or plist key.
    public static func classify(dnsError code: Int32) -> BonjourBrowseError {
        switch code {
        case dnsPolicyDenied: return .permissionDenied
        case dnsNoAuth: return .notConfigured
        default: return .unavailable("dns-sd error \(code)")
        }
    }

    /// Whether this app's Info.plist lets the OS browse `_pkeypeer._tcp`. `requiresPlist` is true on
    /// iOS, tvOS and visionOS; macOS needs neither key, so it always passes.
    public static func configurationError(infoDictionary: [String: Any]?, requiresPlist: Bool) -> BonjourBrowseError? {
        guard requiresPlist else { return nil }
        let services = infoDictionary?["NSBonjourServices"] as? [String] ?? []
        let usage = infoDictionary?["NSLocalNetworkUsageDescription"] as? String ?? ""
        let hasService = services.contains { s in
            let t = s.lowercased()
            return t == bonjourPeerServiceType || t == bonjourPeerServiceType + "."
        }
        if hasService && !usage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        return .notConfigured
    }
}

// MARK: - The table

/// The bounded set of instances currently up.
struct BonjourTable {
    static let maxInstances = 256
    static let maxTxt = 8

    enum Change: Equatable {
        case up(BonjourFound)
        case down(String)
    }

    /// Least recently refreshed first.
    private var order: [String] = []
    private var rows: [String: BonjourFound] = [:]

    var count: Int { rows.count }

    /// `p1-` and 16 characters of `a-z2-7`.
    static func isInstanceName(_ name: String) -> Bool {
        let s = Array(name.unicodeScalars)
        return s.count == 19 && s[0] == "p" && s[1] == "1" && s[2] == "-"
            && s[3...].allSatisfy { ($0.value >= 0x61 && $0.value <= 0x7A) || ($0.value >= 0x32 && $0.value <= 0x37) }
    }

    mutating func upsert(_ found: BonjourFound) -> [Change] {
        guard Self.isInstanceName(found.instance) else { return [] }
        let row = BonjourFound(
            instance: found.instance, txt: Array(found.txt.prefix(Self.maxTxt)), endpoint: found.endpoint)
        var out: [Change] = []
        let existing = rows[row.instance]
        if existing != nil {
            order.removeAll { $0 == row.instance }
        } else {
            while rows.count >= Self.maxInstances, let oldest = order.first {
                order.removeFirst()
                rows[oldest] = nil
                out.append(.down(oldest))
            }
        }
        order.append(row.instance)
        rows[row.instance] = row
        if existing != row { out.append(.up(row)) }
        return out
    }

    mutating func remove(_ instance: String) -> [Change] {
        guard rows.removeValue(forKey: instance) != nil else { return [] }
        order.removeAll { $0 == instance }
        return [.down(instance)]
    }

    mutating func clear() {
        order = []
        rows = [:]
    }
}

// MARK: - The browser

/// One browse. `start` reports a plist or permission problem by throwing or through `onError`;
/// nothing is called after `stop()`.
public final class BonjourBrowse: Sendable {
    private struct State: Sendable {
        var table = BonjourTable()
        var stop: (@Sendable () -> Void)?
        var running = false
        var onUp: (@Sendable (BonjourFound) -> Void)?
        var onDown: (@Sendable (String) -> Void)?
    }

    private let options: BonjourBrowseOptions
    private let driver: any BonjourBrowseDriver
    private let configurationCheck: @Sendable () -> BonjourBrowseError?
    private let accept: (@Sendable (String) -> Bool)?
    private let state = PlatformLock(State())

    /// `configurationCheck` defaults to this process's Info.plist; a test passes its own.
    public init(
        options: BonjourBrowseOptions = BonjourBrowseOptions(),
        driver: (any BonjourBrowseDriver)? = nil,
        configurationCheck: (@Sendable () -> BonjourBrowseError?)? = nil,
        accept: (@Sendable (String) -> Bool)? = nil
    ) {
        self.accept = accept
        self.options = options
        #if canImport(Network)
            self.driver = driver ?? NWBrowserDriver()
        #else
            self.driver = driver ?? UnavailableDriver()
        #endif
        self.configurationCheck = configurationCheck ?? Self.processConfigurationCheck
    }

    @Sendable private static func processConfigurationCheck() -> BonjourBrowseError? {
        #if os(iOS) || os(tvOS) || os(visionOS)
            return BonjourErrors.configurationError(infoDictionary: Bundle.main.infoDictionary, requiresPlist: true)
        #else
            return nil
        #endif
    }

    /// Begin browsing. Throws `.notConfigured` before any network use when the plist is wrong.
    public func start(
        onUp: @escaping @Sendable (BonjourFound) -> Void,
        onDown: @escaping @Sendable (String) -> Void = { _ in },
        onError: @escaping @Sendable (BonjourBrowseError) -> Void = { _ in }
    ) throws {
        if let e = configurationCheck() { throw e }
        let first = state.withLock { s -> Bool in
            if s.running { return false }
            s.running = true
            s.onUp = onUp
            s.onDown = onDown
            return true
        }
        guard first else { return }
        let stop = driver.start(includePeerToPeer: options.peerToPeer) { [self] event in
            handle(event, onUp: onUp, onDown: onDown, onError: onError)
        }
        let stopNow = state.withLock { s -> Bool in
            if s.running {
                s.stop = stop
                return false
            }
            return true  // stop() ran while the driver was starting
        }
        if stopNow { stop() }
    }

    /// The accept filter's answer changed (a roster or key arrived): offer the browser's current results
    /// to it again, so a peer seen before it was known enters the table now, with no new browse event.
    public func rescan() {
        guard let accept else { return }
        let results = driver.snapshot()
        let (changes, up, down) = state.withLock {
            s -> ([BonjourTable.Change], (@Sendable (BonjourFound) -> Void)?, (@Sendable (String) -> Void)?) in
            guard s.running else { return ([], nil, nil) }
            return (results.filter { accept($0.instance) }.flatMap { s.table.upsert($0) }, s.onUp, s.onDown)
        }
        guard let up, let down else { return }
        deliver(changes, onUp: up, onDown: down)
    }

    public func stop() {
        let stop = state.withLock { s -> (@Sendable () -> Void)? in
            s.running = false
            s.onUp = nil
            s.onDown = nil
            s.table.clear()
            defer { s.stop = nil }
            return s.stop
        }
        stop?()
    }

    private func handle(
        _ event: BonjourDriverEvent,
        onUp: @Sendable (BonjourFound) -> Void,
        onDown: @Sendable (String) -> Void,
        onError: @Sendable (BonjourBrowseError) -> Void
    ) {
        switch event {
        case .upserted(let found):
            let changes = state.withLock { s -> [BonjourTable.Change] in
                guard s.running else { return [] }
                // Match first, then store: a name the caller does not know never takes a table slot,
                // so forged names cannot evict real peers.
                return found.filter { accept?($0.instance) ?? true }.flatMap { s.table.upsert($0) }
            }
            deliver(changes, onUp: onUp, onDown: onDown)
        case .removed(let names):
            let changes = state.withLock { s -> [BonjourTable.Change] in
                guard s.running else { return [] }
                return names.flatMap { s.table.remove($0) }
            }
            deliver(changes, onUp: onUp, onDown: onDown)
        case .failed(let e):
            let live = state.withLock { s in s.running }
            if live { onError(e) }
        }
    }

    private func deliver(
        _ changes: [BonjourTable.Change], onUp: @Sendable (BonjourFound) -> Void, onDown: @Sendable (String) -> Void
    ) {
        for c in changes {
            switch c {
            case .up(let f): onUp(f)
            case .down(let n): onDown(n)
            }
        }
    }
}

#if !canImport(Network)
    private struct UnavailableDriver: BonjourBrowseDriver {
        func start(includePeerToPeer: Bool, emit: @escaping @Sendable (BonjourDriverEvent) -> Void)
            -> @Sendable () -> Void
        {
            emit(.failed(.unavailable("Network.framework is not available")))
            return {}
        }
    }
#endif

// MARK: - NWBrowser

#if canImport(Network)
    /// The system driver: `NWBrowser(for: .bonjourWithTXTRecord(type: "_pkeypeer._tcp", domain: nil))`.
    public struct NWBrowserDriver: BonjourBrowseDriver {
        private let current = PlatformLock<NWBrowser?>(nil)

        public init() {}

        public func snapshot() -> [BonjourFound] {
            guard let b = current.withLock({ $0 }) else { return [] }
            return b.browseResults.compactMap { Self.found($0) }
        }

        public func start(
            includePeerToPeer: Bool, emit: @escaping @Sendable (BonjourDriverEvent) -> Void
        ) -> @Sendable () -> Void {
            let params = NWParameters()
            params.includePeerToPeer = includePeerToPeer
            let browser = NWBrowser(
                for: .bonjourWithTXTRecord(type: bonjourPeerServiceType, domain: nil), using: params)
            let queue = DispatchQueue(label: "im.plrs.key.bonjour-browse")
            browser.stateUpdateHandler = { state in
                switch state {
                case .failed(let e):
                    emit(.failed(Self.classify(e)))
                case .waiting(let e):
                    // Offline is the OS's to retry; a refused permission is not going to fix itself.
                    let c = Self.classify(e)
                    if c == .permissionDenied || c == .notConfigured { emit(.failed(c)) }
                default:
                    break
                }
            }
            browser.browseResultsChangedHandler = { _, changes in
                var up: [BonjourFound] = []
                var gone: [String] = []
                for change in changes {
                    switch change {
                    case .added(let r), .changed(old: _, new: let r, flags: _):
                        if let f = Self.found(r) { up.append(f) }
                    case .removed(let r):
                        if case .service(let name, _, _, _) = r.endpoint { gone.append(name) }
                    case .identical:
                        break
                    @unknown default:
                        break
                    }
                }
                if !up.isEmpty { emit(.upserted(up)) }
                if !gone.isEmpty { emit(.removed(gone)) }
            }
            current.withLock { $0 = browser }
            browser.start(queue: queue)
            return { [current] in
                current.withLock { $0 = nil }
                browser.cancel()
            }
        }

        static func classify(_ e: NWError) -> BonjourBrowseError {
            if case .dns(let code) = e { return BonjourErrors.classify(dnsError: code) }
            return .unavailable("\(e)")
        }

        static func found(_ r: NWBrowser.Result) -> BonjourFound? {
            guard case .service(let name, let type, let domain, _) = r.endpoint else { return nil }
            var txt: [String] = []
            if case .bonjour(let record) = r.metadata {
                for (key, value) in record {
                    switch value {
                    case .string(let v): txt.append("\(key)=\(v)")
                    case .data(let d): if let v = String(data: d, encoding: .utf8) { txt.append("\(key)=\(v)") }
                    case .empty: txt.append("\(key)=")
                    case .none: txt.append(key)
                    @unknown default: break
                    }
                }
            }
            return BonjourFound(
                instance: name, txt: txt,
                endpoint: BonjourEndpoint(name: name, type: type, domain: domain, network: r.endpoint))
        }
    }
#endif
