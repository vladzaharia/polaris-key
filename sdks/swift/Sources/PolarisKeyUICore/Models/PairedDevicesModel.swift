// @pkey-feature connect.local
// `PairedDevicesModel` (CC-29K): the list of devices this one paired with by a code, over the same
// `LocalLinksDriver` as `LocalPairingModel`. The reference is packages/ui-core/src/pairedDevicesModel.ts.
//
//   - it re-reads `list()` on `onChange`, so a pairing, a rename in another window, a forget or a
//     gate flip shows without a refresh;
//   - rows: the switch column's rule is `kitShowSwitchColumn` (more than 8, or one off);
//   - Rename and Forget work in the row: a refused name keeps its text and says why; after a Forget
//     focus moves to the next row, or the title when none is left;
//   - a switch the SDK refuses with `cap: reachable` says "Up to 8 can connect"; an unreadable
//     record is `load-failed` with Try again;
//   - with the gate off only Rename and Forget remain, and the host's entry shows while a link is held.

import Foundation
import Observation

/// Where focus goes after an edit or a Forget.
public enum PairedFocus: Sendable, Equatable {
    case row(String)
    case title
}

@MainActor
@Observable
public final class PairedDevicesModel {
    public var inputs: KitInputs {
        var copy = base
        var shown = state
        if shown.notice == nil { shown.notice = hostNotice ?? base.pairedDevices?.notice }
        copy.pairedDevices = shown
        return copy
    }
    public private(set) var base: KitInputs
    public private(set) var state = KitPairedDevices(step: .loading, devices: [])
    /// The text in the rename field.
    public private(set) var draft = ""
    /// Set after an edit; the renderer moves focus and the model clears it on the next change.
    public private(set) var focus: PairedFocus?
    /// True once the first read finished.
    public private(set) var loaded = false
    /// The host's "Paired devices" entry shows: pairing is on, or at least one link is held.
    public private(set) var entryVisible = false
    public private(set) var left = false
    /// The person asked to pair another (the host opens Pair with a Code).
    public private(set) var pairAnother = false
    /// An answer the host gave about a device (its own connection's), shown with the list.
    public private(set) var hostNotice: KitPairedDevices.Notice?
    /// The app was asked to try the notice's device again: the notice shows busy until the host reports the next answer.
    public private(set) var noticeBusy = false
    @ObservationIgnored public var onRetry: (@MainActor (String) -> Void)?
    @ObservationIgnored public var onClose: (@MainActor () -> Void)?
    @ObservationIgnored public var onPairAnother: (@MainActor () -> Void)?

    @ObservationIgnored private let driver: LocalLinksDriver
    @ObservationIgnored private var unsubscribe: (@Sendable () -> Void)?
    @ObservationIgnored private var reads = 0
    /// A still (previews, snapshots): it shows what it was given and never reads.
    @ObservationIgnored private var still = false

    public init(driver: LocalLinksDriver, inputs: KitInputs = KitInputs()) {
        self.driver = driver
        self.base = inputs
    }

    /// A model that shows `inputs.pairedDevices` as it is (previews, snapshots).
    public convenience init(inputs: KitInputs) {
        let never = LocalLinksDriver(
            localPairing: { true }, list: { [] }, rename: { _, _ in }, remove: { _ in },
            setReachable: { _, _ in }, onChange: { _ in {} }, dialsLeft: { _ in nil },
            pair: { _, _, _ in throw KitLocalError(code: "unknown") },
            join: { _, _, _, _ in throw KitLocalError(code: "unknown") })
        self.init(driver: never, inputs: inputs)
        still = true
        if let shown = inputs.pairedDevices {
            state = shown
            loaded = true
            draft = shown.devices?.first { $0.id == shown.target }?.label ?? ""
        }
    }

    public var screen: KitScreen<PairedDevicesState> { KitStates.pairedDevices(inputs) }

    public func update(inputs next: KitInputs) {
        var merged = next
        merged.pairedDevices = nil
        base = merged
    }

    /// Read the list and follow the SDK's changes until `stop()`.
    public func start() async {
        if unsubscribe == nil {
            unsubscribe = driver.onChange { [weak self] in
                Task { @MainActor in await self?.refresh() }
            }
        }
        await refresh()
    }

    public func stop() {
        unsubscribe?()
        unsubscribe = nil
    }

    /// Read `list()` and the gate again (also Try again).
    public func refresh() async {
        if still { return }
        reads += 1
        let read = reads
        // Try again from a failed read shows the loading treatment, not the stale failure.
        if state.step == .loadFailed { state.step = .loading }
        let on = driver.localPairing()
        let rows: [KitPairedDevice]
        do { rows = try await driver.list() } catch {
            if read != reads { return }
            state.step = .loadFailed
            state.devices = []
            loaded = true
            entryVisible = false
            return
        }
        if read != reads { return }
        let editing = state.step == .renaming || state.step == .forgetting
        let stillThere = editing && rows.contains { $0.id == state.target }
        state.devices = rows.map {
            KitPairedDevice(
                id: $0.id, label: $0.label, lastSeen: $0.lastSeen, reachable: $0.reachable,
                platform: $0.platform)
        }
        loaded = true
        entryVisible = on || !rows.isEmpty
        state.step = !on ? .off : stillThere ? state.step : .list
        if !on || !stillThere {
            state.target = nil
            state.renameError = nil
        }
    }

    // MARK: Rows

    /// Rename, from the row's menu. The field starts with the name now held.
    public func startRename(_ id: String) {
        guard let d = state.devices?.first(where: { $0.id == id }) else { return }
        state.step = .renaming
        state.target = id
        state.renameError = nil
        draft = d.label ?? ""
        focus = nil
    }

    public func setDraft(_ text: String) {
        guard state.step == .renaming else { return }
        draft = text
        state.renameError = nil
    }

    /// Save: a refused name keeps its text and focus and says why. Nothing is sent to the other device.
    public func saveRename() async {
        guard state.step == .renaming, let target = state.target else { return }
        let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            state.renameError = .empty
            return
        }
        if name.unicodeScalars.count > kitMaxDeviceName {
            state.renameError = .long
            return
        }
        do { try await driver.rename(target, name) } catch {
            // `bad_input` is a name the SDK cleans to nothing; any other rejection is the store's.
            state.renameError = (error as? KitLocalError)?.reason == "bad_input" ? .empty : .failed
            return
        }
        endEdit(target)
        await refresh()
    }

    /// Forget, from the row's menu: asks inside the row.
    public func askForget(_ id: String) {
        guard state.devices?.contains(where: { $0.id == id }) == true else { return }
        state.step = .forgetting
        state.target = id
        state.renameError = nil
        state.forgetError = nil
        focus = nil
    }

    /// Forget: deletes it here only; the other device is not told. Focus moves on.
    public func confirmForget() async {
        guard state.step == .forgetting, let target = state.target else { return }
        let rows = state.devices ?? []
        let at = rows.firstIndex { $0.id == target } ?? 0
        let next = at + 1 < rows.count ? rows[at + 1] : (at > 0 ? rows[at - 1] : nil)
        do { try await driver.remove(target) } catch {
            // Not forgotten: the question stays, with the reason, so Forget can be pressed again.
            state.forgetError = true
            return
        }
        endEdit(nil)
        await refresh()
        let remaining = state.devices ?? []
        if let next, remaining.contains(where: { $0.id == next.id }) {
            focus = .row(next.id)
        } else {
            focus = .title
        }
    }

    /// Cancel an edit: the row is as it was.
    public func cancelEdit() { endEdit(state.target) }

    private func endEdit(_ row: String?) {
        state.step = driver.localPairing() ? .list : .off
        state.target = nil
        state.renameError = nil
        state.forgetError = nil
        draft = ""
        focus = row.map { .row($0) }
    }

    /// A Can connect switch. A ninth is refused by the SDK (`cap: reachable`); the list says "Up to 8
    /// can connect" itself, so the refusal changes nothing but the re-read that puts the switch back.
    public func setReachable(_ id: String, _ on: Bool) async {
        try? await driver.setReachable(id, on)
        await refresh()
    }

    /// The answer of the app's own connection to a device, shown with the list.
    public func report(_ id: String, _ kind: KitPairedDevices.Notice.Kind?) {
        if let kind, let d = state.devices?.first(where: { $0.id == id }) {
            hostNotice = KitPairedDevices.Notice(device: d.label ?? "", kind: kind, id: id)
        } else {
            hostNotice = nil
        }
        state.notice = nil
        noticeBusy = false
    }

    /// Try again on the app's answer for `id`: the notice shows busy, the host's `onRetry` runs, and its next `report` replaces it.
    public func retryNotice(_ id: String) {
        guard inputs.pairedDevices?.notice?.id == id else { return }
        noticeBusy = true
        onRetry?(id)
    }

    /// Pair with a Code, the one primary.
    public func requestPair() {
        pairAnother = true
        onPairAnother?()
    }

    /// Done.
    public func done() {
        stop()
        left = true
        onClose?()
    }
}
