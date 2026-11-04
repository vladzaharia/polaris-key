// @pkey-feature connect.links connect.transfer
// The models behind LinkPairing and TransferOffer (CC-19.10; the reference is packages/ui-core/src/
// linkPairingModel.ts). Each runs over a narrow driver, so a host binds `client.cloudConnect.links.pair`
// and the transfer offer handler (`LinkPairingDriver.links`, `TransferOfferCoordinator`) and a preview
// binds nothing.
//
//   LinkPairingModel   open -> code -> confirm -> linked | failed        (unavailable: links are off)
//     - `start()` opens the window; a device that reached the code shows its code, label and the
//       categories; one offer at a time: a second device that reaches the code meanwhile is declined;
//     - `confirm()` waits for the other person; `decline()` closes that session and the window stays
//       open for the next device; `cancel()` closes the window;
//     - a failure of a session this person never saw (no code shown) changes nothing on screen;
//     - an epoch is bumped when a window ends, so a late answer from an old one is dropped.
//
//   TransferOfferModel   ask -> receiving -> done | failed
//     - consent per transfer (D-8): `accept()` and `decline()` each answer the host's offer once; a
//       second answer is ignored.

import Foundation
import Observation
import PolarisKey

// MARK: - LinkPairing

/// A nearby device at the code stage, as the model holds it.
public struct LinkPairingOffer: Sendable {
    public let label: String?
    public let code: String
    public let categories: [String]
    public let confirm: @Sendable () async throws -> Void
    public let decline: @Sendable () async -> Void

    public init(
        label: String?, code: String, categories: [String],
        confirm: @escaping @Sendable () async throws -> Void,
        decline: @escaping @Sendable () async -> Void
    ) {
        self.label = label
        self.code = code
        self.categories = categories
        self.confirm = confirm
        self.decline = decline
    }
}

/// What the pairing window tells the model.
public struct LinkPairingEvents: Sendable {
    public var onCode: @Sendable (LinkPairingOffer) -> Void
    public var onLinked: @Sendable (_ label: String?, _ categories: [String]) -> Void
    public var onFailed: @Sendable (KitLinkPairing.Reason) -> Void
}

/// Opens the pairing window; the returned closure closes it.
public struct LinkPairingDriver: Sendable {
    public var pair:
        @Sendable (
            _ categories: [String], _ label: String?, _ seconds: TimeInterval?,
            _ events: LinkPairingEvents
        ) async throws -> @Sendable () async -> Void
    /// True for the error that means links are off for this product (`connect_links_disabled`).
    public var isUnavailable: @Sendable (Error) -> Bool

    public init(
        pair:
            @escaping @Sendable (
                _ categories: [String], _ label: String?, _ seconds: TimeInterval?,
                _ events: LinkPairingEvents
            ) async throws -> @Sendable () async -> Void,
        isUnavailable: @escaping @Sendable (Error) -> Bool = { _ in false }
    ) {
        self.pair = pair
        self.isUnavailable = isUnavailable
    }
}

#if canImport(Network)
    extension LinkPairingDriver {
        /// The driver over `client.cloudConnect.links`.
        public static func links(_ links: CloudLinks) -> LinkPairingDriver {
            LinkPairingDriver(
                pair: { categories, label, seconds, events in
                    var options = LinkPairOptions(
                        categories: categories, label: label,
                        onCode: { offer in
                            events.onCode(
                                LinkPairingOffer(
                                    label: offer.label, code: offer.code,
                                    categories: offer.categories,
                                    confirm: { await offer.confirm() },
                                    decline: { await offer.decline() }))
                        },
                        onLinked: { events.onLinked($0.label, $0.categories) },
                        onFailed: { events.onFailed(KitLinkPairing.Reason(rawValue: $0.reason.rawValue) ?? .closed) })
                    if let seconds { options.seconds = seconds }
                    let handle = try await links.pair(options)
                    return { await handle.stop() }
                },
                isUnavailable: { $0 is CloudLinksDisabled })
        }
    }
#endif

@MainActor
@Observable
public final class LinkPairingModel {
    /// The inputs the screen is drawn from, with the pairing's step on top.
    public var inputs: KitInputs { base.with(linkPairing: link) }
    /// Everything else the views read (identity, platform, services).
    public private(set) var base: KitInputs
    public private(set) var link: KitLinkPairing?
    /// Told once when a link was made.
    public var onLinked: (@MainActor () -> Void)?
    /// Told when Done or Cancel ends the screen: the host closes it.
    public var onClose: (@MainActor () -> Void)?

    @ObservationIgnored private let driver: LinkPairingDriver?
    @ObservationIgnored private let categories: [String]
    @ObservationIgnored private let label: String?
    @ObservationIgnored private let seconds: TimeInterval?
    @ObservationIgnored private var offer: LinkPairingOffer?
    @ObservationIgnored private var stop: (@Sendable () async -> Void)?
    /// Bumped when a window ends, so a late callback from an old one is dropped.
    @ObservationIgnored private var epoch = 0

    /// A model that runs the window on `driver`. Idle until `start()`.
    public init(
        driver: LinkPairingDriver, categories: [String], label: String? = nil,
        seconds: TimeInterval? = nil, inputs: KitInputs = KitInputs()
    ) {
        self.driver = driver
        self.categories = categories
        self.label = label
        self.seconds = seconds
        self.base = inputs
        self.link = nil
    }

    /// A model without a driver (previews, a host with its own protocol): it shows `inputs.linkPairing`
    /// and a press moves the step; nothing is paired.
    public init(inputs: KitInputs) {
        self.driver = nil
        self.categories = inputs.linkPairing?.categories ?? []
        self.label = nil
        self.seconds = nil
        self.base = inputs
        self.link = inputs.linkPairing
    }

    public var screen: KitScreen<LinkPairingState> { KitStates.linkPairing(inputs) }
    public var step: KitLinkPairing.Step? { link?.step }

    /// Replaces the look and product the copy is drawn from, keeping the step.
    public func update(inputs next: KitInputs) {
        var merged = next
        merged.linkPairing = nil
        base = merged
    }

    /// Open the pairing window (also Try again).
    public func start() async {
        await close()
        epoch += 1
        let mine = epoch
        link = KitLinkPairing(step: .open, categories: categories)
        guard let driver else { return }
        let events = LinkPairingEvents(
            onCode: { [weak self] offer in
                Task { @MainActor in self?.heard(offer, mine) }
            },
            onLinked: { [weak self] label, categories in
                Task { @MainActor in self?.linked(label, categories, mine) }
            },
            onFailed: { [weak self] reason in
                Task { @MainActor in self?.failed(reason, mine) }
            })
        do {
            let stop = try await driver.pair(categories, label, seconds, events)
            if mine != epoch {
                await stop()
                return
            }
            self.stop = stop
        } catch {
            guard mine == epoch else { return }
            let off = driver.isUnavailable(error)
            link = KitLinkPairing(
                step: off ? .unavailable : .failed, categories: categories,
                reason: off ? nil : .closed)
        }
    }

    /// Codes match: confirm on this device. The link is made when the other person does too.
    public func confirm() async {
        guard link?.step == .code else { return }
        link?.step = .confirm
        guard let offer else { return }
        do {
            try await offer.confirm()
        } catch {
            if self.offer?.code == offer.code {
                self.offer = nil
                link = KitLinkPairing(step: .failed, categories: categories, reason: .closed)
            }
        }
    }

    /// Not a match: close that session; the window stays open for the next device.
    public func decline() async {
        guard link?.step == .code else { return }
        let declined = offer
        offer = nil
        link = KitLinkPairing(step: .open, categories: categories)
        await declined?.decline()
    }

    /// Close the window and let go of any session.
    public func cancel() async {
        await close()
        link = nil
    }

    /// Done or Cancel: the window closes, then the host is told.
    public func finish() async {
        await cancel()
        onClose?()
    }

    private func heard(_ next: LinkPairingOffer, _ mine: Int) {
        guard mine == epoch else { return }
        if offer != nil {
            // One device at a time: the next one is declined, not left waiting.
            Task { await next.decline() }
            return
        }
        offer = next
        link = KitLinkPairing(
            step: .code, device: next.label, code: next.code, categories: categories)
    }

    private func linked(_ label: String?, _ approved: [String], _ mine: Int) {
        guard mine == epoch else { return }
        offer = nil
        link = KitLinkPairing(step: .linked, device: label, categories: approved)
        onLinked?()
    }

    private func failed(_ reason: KitLinkPairing.Reason, _ mine: Int) {
        // A session nobody saw (no code shown) fails silently.
        guard mine == epoch, offer != nil else { return }
        offer = nil
        link = KitLinkPairing(step: .failed, categories: categories, reason: reason)
    }

    private func close() async {
        epoch += 1
        let offer = self.offer
        let stop = self.stop
        self.offer = nil
        self.stop = nil
        await offer?.decline()
        await stop?()
    }
}

extension KitInputs {
    fileprivate func with(linkPairing: KitLinkPairing?) -> KitInputs {
        var copy = self
        copy.linkPairing = linkPairing
        return copy
    }

    fileprivate func with(transferOffer: KitTransferOffer?) -> KitInputs {
        var copy = self
        copy.transferOffer = transferOffer
        return copy
    }
}

// MARK: - TransferOffer

/// Answers one offer.
public struct TransferOfferDriver: Sendable {
    /// Accept: returns when everything arrived and was saved; throws when it did not.
    public var accept: @Sendable () async throws -> Void
    /// Decline: nothing is received.
    public var decline: @Sendable () async -> Void
    /// Stop a transfer in flight.
    public var cancel: @Sendable () async -> Void

    public init(
        accept: @escaping @Sendable () async throws -> Void,
        decline: @escaping @Sendable () async -> Void,
        cancel: @escaping @Sendable () async -> Void = {}
    ) {
        self.accept = accept
        self.decline = decline
        self.cancel = cancel
    }
}

@MainActor
@Observable
public final class TransferOfferModel {
    public var inputs: KitInputs { base.with(transferOffer: closed ? nil : offer) }
    public private(set) var base: KitInputs
    public private(set) var offer: KitTransferOffer
    /// The prompt was answered or finished: the view draws nothing.
    public private(set) var closed = false
    /// Told when Decline, Done or a withdrawn offer ends the prompt: the host closes it.
    public var onClose: (@MainActor () -> Void)?

    @ObservationIgnored private let driver: TransferOfferDriver?
    @ObservationIgnored private var answered = false

    public init(offer: KitTransferOffer, driver: TransferOfferDriver? = nil, inputs: KitInputs = KitInputs()) {
        self.offer = offer
        self.driver = driver
        self.base = inputs
    }

    /// A model without a driver (previews): it shows `inputs.transferOffer`.
    public convenience init(inputs: KitInputs) {
        self.init(
            offer: inputs.transferOffer ?? KitTransferOffer(step: .ask, name: ""), inputs: inputs)
    }

    public var screen: KitScreen<TransferOfferState> { KitStates.transferOffer(inputs) }

    public func update(inputs next: KitInputs) {
        var merged = next
        merged.transferOffer = nil
        base = merged
    }

    /// Accept the offer. Answered once: a second press does nothing.
    public func accept() async {
        guard !answered, offer.step == .ask else { return }
        answered = true
        offer.step = .receiving
        do {
            try await driver?.accept()
            finish(.done)
        } catch {
            finish(.failed)
        }
    }

    /// Decline the offer, and close.
    public func decline() async {
        guard !answered, offer.step == .ask else { return }
        answered = true
        closed = true
        await driver?.decline()
        onClose?()
    }

    /// Stop the transfer in flight: it ends as failed, nothing kept.
    public func cancel() async {
        guard offer.step == .receiving else { return }
        finish(.failed)
        await driver?.cancel()
    }

    /// Done: close the prompt.
    public func close() {
        closed = true
        onClose?()
    }

    /// The contact withdrew the offer, or the session ended before an answer: close without answering.
    public func withdraw() {
        guard !answered else { return }
        answered = true
        closed = true
        onClose?()
    }

    private func finish(_ step: KitTransferOffer.Step) {
        if offer.step == .receiving { offer.step = step }
    }
}

#if canImport(Network)
    /// Binds the SDK's offer handler (`client.cloudConnect.transfer.onOffer`) to one `TransferOfferModel`
    /// at a time: the host draws `current` with `TransferOfferView`. Every offer is asked (D-8); offers that
    /// arrive while one is on screen wait their turn. Without `start()` the SDK declines every offer.
    @MainActor
    @Observable
    public final class TransferOfferCoordinator {
        /// The offer on screen, if any.
        public private(set) var current: TransferOfferModel?

        @ObservationIgnored private let transfer: CloudTransfer
        @ObservationIgnored private let destination: @Sendable (TransferOffer) -> URL
        @ObservationIgnored private let inputs: KitInputs
        @ObservationIgnored private var removeHandler: (@Sendable () -> Void)?
        @ObservationIgnored private var removeResult: (@Sendable () -> Void)?
        @ObservationIgnored private var waiting: [CheckedContinuation<Void, Never>] = []
        @ObservationIgnored private var active: [String: Pending] = [:]
        @ObservationIgnored private var currentId: String?

        private final class Pending {
            var decision: CheckedContinuation<TransferDecision, Never>?
            var receipt: CheckedContinuation<Void, Error>?
            var result: Result<Void, Error>?
            var model: TransferOfferModel?
        }

        /// `destination` names where an accepted file is saved (a file that does not exist yet, in a
        /// directory that does); the person never sees the path.
        public init(
            transfer: CloudTransfer, destination: @escaping @Sendable (TransferOffer) -> URL,
            inputs: KitInputs = KitInputs()
        ) {
            self.transfer = transfer
            self.destination = destination
            self.inputs = inputs
        }

        /// Start answering offers.
        public func start() {
            guard removeHandler == nil else { return }
            removeHandler = transfer.onOffer { [weak self] offer in
                guard let self else { return .decline }
                return await withTaskCancellationHandler {
                    await self.ask(offer)
                } onCancel: {
                    Task { @MainActor [weak self] in self?.withdrawn(offer.id) }
                }
            }
            removeResult = transfer.onResult { [weak self] receipt in
                Task { @MainActor [weak self] in self?.received(receipt) }
            }
        }

        /// Stop: offers are declined again, and the offer on screen is withdrawn.
        public func stop() {
            removeHandler?()
            removeResult?()
            removeHandler = nil
            removeResult = nil
            for pending in active.values { pending.model?.withdraw() }
        }

        private func ask(_ offer: TransferOffer) async -> TransferDecision {
            if current != nil { await withCheckedContinuation { waiting.append($0) } }
            if Task.isCancelled {
                release()
                return .decline
            }
            let id = offer.id
            let dest = destination(offer)
            let pending = Pending()
            active[id] = pending
            let model = TransferOfferModel(
                offer: KitTransferOffer(
                    step: .ask, name: offer.name ?? "", device: offer.peer.label,
                    size: offer.size, type: offer.type),
                driver: TransferOfferDriver(
                    accept: { [weak self] in try await self?.accepted(id, dest) },
                    decline: { [weak self] in await self?.declined(id) },
                    cancel: { [weak self] in await self?.cancelled(id) }),
                inputs: inputs)
            model.onClose = { [weak self] in self?.closed(id) }
            pending.model = model
            current = model
            currentId = id
            return await withCheckedContinuation { pending.decision = $0 }
        }

        private func accepted(_ id: String, _ dest: URL) async throws {
            guard let pending = active[id] else { throw CancellationError() }
            pending.decision?.resume(returning: .accept(to: dest))
            pending.decision = nil
            if let result = pending.result { return try result.get() }
            try await withCheckedThrowingContinuation { pending.receipt = $0 }
        }

        private func declined(_ id: String) {
            guard let pending = active[id] else { return }
            pending.decision?.resume(returning: .decline)
            pending.decision = nil
        }

        private func cancelled(_ id: String) async { await transfer.cancel(id) }

        private func received(_ receipt: TransferReceipt) {
            let id: String
            let result: Result<Void, Error>
            switch receipt {
            case .delivered(let rid, _): (id, result) = (rid, .success(()))
            case .failed(let rid, let error): (id, result) = (rid, .failure(error))
            }
            guard let pending = active[id] else { return }
            if let cont = pending.receipt {
                pending.receipt = nil
                cont.resume(with: result)
            } else {
                pending.result = result
            }
        }

        private func withdrawn(_ id: String) {
            guard let pending = active[id], pending.decision != nil else { return }
            pending.decision?.resume(returning: .decline)
            pending.decision = nil
            pending.model?.withdraw()
        }

        private func closed(_ id: String) {
            active[id] = nil
            guard currentId == id else { return }
            current = nil
            currentId = nil
            release()
        }

        /// The next waiting offer's turn.
        private func release() {
            if current == nil, !waiting.isEmpty { waiting.removeFirst().resume() }
        }
    }
#endif
