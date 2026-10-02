// The stage machine's host side for packs (plans/P4-01.md §2.10, §5 order 1; client-core
// `packs/boot.ts`): the boot's FETCH stage driven by the pack engine. `bootPackOptions` turns the
// content stamp's `expects` into `requiredPacks` and `essentialPacks`; `runBootFetch` sends the v3
// events the machine accepts in `fetch` — `fetch.consent {bytes, metered}` when the host asks
// before downloading, `fetch.progress {done, total}` from the first byte, and `fetch.done
// {result, installed}`. `stage-matrix.json` pins what the machine does with them.

import Foundation
import PolarisKeyCore

/// The boot's pack options from the stamp: `requiredPacks` are the `required: true` expects;
/// `essentialPacks` the `delivery: "essential"` ones that are not required. Any other delivery
/// (an unknown one reads as `on-demand`) waits for `ensure`.
public func bootPackOptions(_ stamp: AppContent?) -> (requiredPacks: [String], essentialPacks: [String]) {
    let expects = stamp?.expects ?? []
    return (
        expects.filter(\.required).map(\.pack),
        expects.filter { !$0.required && $0.delivery == "essential" }.map(\.pack)
    )
}

/// When to ask before downloading.
public enum BootConsentPolicy: String, Sendable {
    case always, metered, never
}

/// `runBootFetch`'s options.
public struct RunBootFetchOptions: Sendable {
    /// The running build's content stamp.
    public var stamp: AppContent?
    /// Delivers each event to the host's stage machine (`bootTransition`).
    public var send: @Sendable (BootEvent) -> Void
    /// `metered` by default: ask only on a metered network.
    public var consent: BootConsentPolicy
    /// Whether the network is metered (cellular), as the host knows it.
    public var metered: Bool
    /// The player's answer to `consent_needed`: true to download, false to decline.
    public var answer: (@Sendable (_ bytes: Int, _ metered: Bool) async -> Bool)?

    public init(
        stamp: AppContent?, send: @escaping @Sendable (BootEvent) -> Void,
        consent: BootConsentPolicy = .metered, metered: Bool = false,
        answer: (@Sendable (Int, Bool) async -> Bool)? = nil
    ) {
        self.stamp = stamp
        self.send = send
        self.consent = consent
        self.metered = metered
        self.answer = answer
    }
}

/// Run the FETCH stage: estimate the required and essential packs that are not current, ask when
/// the policy says so, download them with progress, and report what is installed. The result is
/// `ok` when every wanted pack installed, `declined` when the player said no, `offline` when a
/// download failed for want of a network (`network-error`), else `failed`. `installed` is every
/// wanted pack whose pinned release is now running.
public func runBootFetch(_ engine: PackEngine, _ opts: RunBootFetchOptions) async throws -> (
    result: BootEvent.FetchResult, installed: [String]
) {
    let (requiredPacks, essentialPacks) = bootPackOptions(opts.stamp)
    var wanted: [String] = []
    for id in requiredPacks + essentialPacks where !wanted.contains(id) { wanted.append(id) }
    let metered = opts.metered
    let pins = Dictionary((opts.stamp?.pins ?? []).map { ($0.pack, $0.sha256) }, uniquingKeysWith: { a, _ in a })
    func installedNow() async -> [String] {
        let running = (try? await engine.state().running) ?? [:]
        return wanted.filter { id in running[id] != nil && running[id]!.recordSha256 == pins[id] }
    }
    func done(_ result: BootEvent.FetchResult) async -> (result: BootEvent.FetchResult, installed: [String]) {
        let installed = await installedNow()
        opts.send(.fetchDone(result, installed: installed))
        return (result, installed)
    }

    let est = try await engine.estimate(wanted)
    let ask = est.bytes > 0 && (opts.consent == .always || (opts.consent == .metered && metered))
    if ask {
        opts.send(.fetchConsent(bytes: est.bytes, metered: metered))
        let yes = await opts.answer?(est.bytes, metered) ?? false
        if !yes { return await done(.declined) }
    }
    let total = est.bytes
    opts.send(.fetchProgress(done: 0, total: total))
    let counters = Locked((base: 0, last: 0))
    let send = opts.send
    let off = engine.on { p in
        guard p.phase == "download" else { return }
        let event: BootEvent? = counters.with { c in
            let now = Swift.min(total, c.base + p.done)
            guard now > c.last else { return nil }
            c.last = now
            return .fetchProgress(done: now, total: total)
        }
        if let event { send(event) }
    }
    defer { off() }
    var result: BootEvent.FetchResult = .ok
    for id in est.packs {
        do {
            _ = try await engine.ensure([id])
        } catch let e as PackError {
            result = e.code == ErrorCode.networkError ? .offline : .failed
        } catch {
            result = .failed
        }
        counters.with { $0.base = $0.last }
    }
    if !est.refused.isEmpty && result == .ok {
        result = est.refused.contains { $0.code == ErrorCode.networkError } ? .offline : .failed
    }
    let last = counters.with { $0.last }
    if result == .ok && last < total { opts.send(.fetchProgress(done: total, total: total)) }
    return await done(result)
}
