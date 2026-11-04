// @pkey-feature connect.links connect.transfer
// The inter-account screens (ui-matrix `connect`, CC-19.9/19.10): LinkPairing, the window where two
// people pair their devices once, nearby, and TransferOffer, the prompt for something a contact
// offers (D-8: consent per transfer). The reference is packages/ui-core/src/models/connect.ts.
// Rules the rows pin:
//   - the code is what both people compare: the categories come before "Codes match", and the code,
//     the reported line and the categories stay through `confirm`;
//   - the other device's label is unauthenticated: it is worded as reported by the device, and an
//     absent label says so instead of inventing one;
//   - no state confirms by default: focus stays on the heading, so a stray Return never links;
//   - a failed session says why in its own line and stored nothing; links turned off by the product
//     are their own neutral state;
//   - an offer shows the contact's label and the name it chose, both isolated text.

import Foundation

// MARK: - LinkPairing

public enum LinkPairingState: String, KitStateID {
    case open, code, confirm, linked, failed, unavailable
    public static let component = KitComponent.linkPairing
}

// MARK: - TransferOffer

public enum TransferOfferState: String, KitStateID {
    case ask, receiving, done, failed
    public static let component = KitComponent.transferOffer
}

/// A name for a heading: at most `limit` characters, the middle elided so the extension stays
/// (`shortName` in ui-core).
public func kitShortName(_ name: String, limit: Int = 40) -> String {
    let chars = Array(name)
    if chars.count <= limit { return name }
    let keep = limit - 1
    let tail = (keep + 1) / 2
    return String(chars[0..<(keep - tail)]) + "…" + String(chars[(chars.count - tail)...])
}

/// A category id as words when the app gave it no label: "photos" is "Photos", "tax-forms" and
/// "voice_memos" are "Tax forms" and "Voice memos" (`categoryFallback` in ui-core).
public func kitCategoryFallback(_ id: String) -> String {
    let words = id.replacingOccurrences(of: "[-_]+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    guard let first = words.first else { return id }
    return first.uppercased() + words.dropFirst()
}

extension KitStates {
    /// The pairing window and its outcomes.
    public static func linkPairing(_ i: KitInputs) -> KitScreen<LinkPairingState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.connect), let p = i.linkPairing else { return .hidden }
        let device = p.device.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let deviceArg: [String: CopyArgument] = device.map { ["device": .text($0)] } ?? [:]
        let codeArg: [String: CopyArgument] = p.code.map { ["code": .text($0)] } ?? [:]
        let shares = c.line(p.categories.isEmpty ? "linkPairing.sharesNone" : "linkPairing.shares")
        let reported =
            device != nil
            ? c.line("linkPairing.reported", deviceArg) : c.line("linkPairing.reportedUnnamed")
        switch p.step {
        case .code:
            var lines = [c.line("linkPairing.codeTitle"), c.line("linkPairing.codeBody")]
            if p.code != nil { lines.append(c.line("a11y.linkCode", codeArg)) }
            lines += [
                reported, shares, c.line("linkPairing.confirm"), c.line("linkPairing.decline"),
            ]
            return KitScreen(.code, lines)
        case .confirm:
            var lines = [c.line("linkPairing.waiting")]
            if p.code != nil { lines.append(c.line("a11y.linkCode", codeArg)) }
            lines += [reported, shares, c.line("common.cancel")]
            return KitScreen(.confirm, lines)
        case .linked:
            return KitScreen(
                .linked,
                [
                    c.line("linkPairing.linkedTitle"),
                    device != nil
                        ? c.line("linkPairing.linkedWith", deviceArg) : c.line("linkPairing.linkedBody"),
                    shares, c.line("common.done"),
                ])
        case .failed:
            let body: String
            switch p.reason ?? .closed {
            case .declined: body = "linkPairing.failedDeclined"
            case .timeout: body = "linkPairing.failedTimeout"
            case .full: body = "linkPairing.failedFull"
            case .closed: body = "linkPairing.failedClosed"
            }
            return KitScreen(
                .failed,
                [
                    c.line("linkPairing.failedTitle"), c.line(body), c.line("common.tryAgain"),
                    c.line("common.done"),
                ])
        case .unavailable:
            return KitScreen(
                .unavailable,
                [
                    c.line("core.codes.connect_links_disabled.title"),
                    c.line("core.codes.connect_links_disabled.message"), c.line("common.done"),
                ])
        case .open:
            return KitScreen(
                .open,
                [
                    c.line("linkPairing.title"), c.line("linkPairing.openBody"),
                    c.line("linkPairing.searching"), c.line("common.cancel"),
                ])
        }
    }

    /// The prompt for something a contact offers, and what follows Accept.
    public static func transferOffer(_ i: KitInputs) -> KitScreen<TransferOfferState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.connect), let t = i.transferOffer else { return .hidden }
        let device = t.device.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        var args: [String: CopyArgument] = ["name": .text(kitShortName(t.name))]
        if let device { args["device"] = .text(device) }
        switch t.step {
        case .receiving:
            return KitScreen(
                .receiving, [c.line("transferOffer.receiving", args), c.line("common.cancel")])
        case .done:
            return KitScreen(
                .done, [c.line("transferOffer.done", args), c.line("common.done")])
        case .failed:
            return KitScreen(
                .failed,
                [
                    c.line("transferOffer.failed", args), c.line("transferOffer.failedBody"),
                    c.line("common.done"),
                ])
        case .ask:
            // No default on Accept: consent is a deliberate press, never a stray Return.
            return KitScreen(
                .ask,
                [
                    c.line(device != nil ? "transferOffer.ask" : "transferOffer.askUnnamed", args),
                    c.line("transferOffer.askBody"), c.line("transferOffer.accept"),
                    c.line("transferOffer.decline"),
                ])
        }
    }
}
