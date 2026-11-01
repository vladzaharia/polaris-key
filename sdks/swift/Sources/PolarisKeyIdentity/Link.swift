// `client.identity.link`: the link offer (identity.link; WIRE-CONTRACT-V5 §12.11.4). After a
// sign-in the person started on this device (a redirect, native or not), the SDK can offer to add
// the platform identity the exchange found no account for.
//
//   let link = client.identity.link
//   if link.pending, case .ok(let kinds) = try await link.offer() { ...show the choice... }
//   switch try await link.accept() {            // the held handle, else one provider prompt
//   case .linked(let kind, let reach): ...
//   case .refused(_, let code): ...             // step_up_required: sign in again, ask again
//   case .unavailable: ...
//   }
//   await link.decline()                        // not again for this account on this device
//
// Rules:
//   - `offer()` and `accept()` answer `.unavailable`, with no request, until a sign-in this
//     device started has completed (`SignInReady.sameDevice`), and after the account's decline.
//     A device-code, exchange, nearby or restore sign-in never opens the offer.
//   - The handle an exchange left (`NeedsSignIn.linkHandle`) is held in memory for its lifetime
//     and spent by the attempt that uses it, except by a stale step-up, which leaves it.
//   - The proof is `pkey-proof/1` with purpose `link`, signed through the device key port. The
//     handle, the provider token and the proof never reach a log, a description or an error.
//   - A decline is `sha256(issuer ‖ sub)`, kept in the Store beside the other local records:
//     the hash only, never the identity.

import Foundation
import PolarisKeyCore
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

/// One platform identity the account could add. `reach` is what the link would cover
/// (`global` or `developer`), nil until a link is made.
public struct LinkOfferEntry: Sendable, Equatable {
    public let kind: String
    public let reach: String?
}

/// `link.offer()`.
public enum LinkOfferResult: Sendable, Equatable {
    case ok([LinkOfferEntry])
    /// The product, the gate or the sign-in has no offer, or the person declined it here.
    case unavailable
}

/// `link.accept()`. `refused.code` is the Worker's: `step_up_required` (sign in again),
/// `link_conflict` (the identity belongs to another account), `invalid_grant` or `not_found`.
public enum LinkAcceptResult: Sendable, Equatable {
    case linked(kind: String, reach: String?)
    case refused(status: Int, code: String)
    case unavailable
}

/// The offer's memory for one client: whether a same-device sign-in is waiting for an answer,
/// whose, and the handle the exchange left.
struct LinkState: Sendable {
    /// The subject the offer belongs to; `""` when the sign-in did not say; nil when no offer is open.
    var pendingFor: String?
    var handle: String?
    var handleExpiresAt = 0
    /// Grants a same-device redirect left pending a licence choice; completing one opens the offer.
    var choiceGrants: Set<String> = []
}

/// `client.identity.link`.
public struct LinkNamespace: Sendable {
    let client: IdentityClient

    /// True after a sign-in this device started, until the person answers or signs out.
    public var pending: Bool { client.linkState.current.pendingFor != nil }

    /// `GET link`: the kinds the account could add.
    public func offer() async throws -> LinkOfferResult {
        guard let url = try await client.linkReady(declinedAllowed: false) else { return .unavailable }
        let response: PolarisResponse
        do {
            response = try await client.withBearer(url, method: "GET")
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "the link offer could not be read.")
        }
        if response.status == 404 { return .unavailable }
        guard response.status == 200 else { throw client.linkFailure(response) }
        guard case .array(let rows)? = client.exchangeBody(response)?.objectValue?["offer"] else {
            throw PolarisError(code: ErrorCode.badResponse, message: "the link offer answered without an offer.")
        }
        return .ok(
            rows.compactMap { row in
                guard let object = row.objectValue, let kind = object["kind"]?.stringValue,
                    LinkNamespace.kinds.contains(kind)
                else { return nil }
                let reach = object["reach"]?.stringValue
                return LinkOfferEntry(kind: kind, reach: reach == "global" || reach == "developer" ? reach : nil)
            })
    }

    /// `POST link`. With the handle the exchange left (or `linkHandle`), no second provider prompt;
    /// otherwise the installed platform provider is asked once, over a fresh nonce.
    public func accept(linkHandle: String? = nil) async throws -> LinkAcceptResult {
        try await accept(linkHandle: linkHandle, proofValue: nil)
    }

    /// Conformance only: `proofValue` replaces the value the proof covers.
    func accept(linkHandle: String?, proofValue: String?) async throws -> LinkAcceptResult {
        guard let url = try await client.linkReady(declinedAllowed: true) else { return .unavailable }
        guard let port = try await client.exchangePort() else { return .unavailable }
        let held = await client.linkHeldHandle()
        let explicit = linkHandle ?? held
        var result: LinkAcceptResult
        if let handle = explicit {
            result = try await post(url, port, handle: handle, proofValue: proofValue)
            // A handle that lapsed or was spent is no error for the person: the provider is asked
            // in the same press.
            if linkHandle == nil, case .refused(_, let code) = result,
                code == ErrorCode.invalidGrant || code == ErrorCode.notFound
            {
                client.linkDropHandle()
                result = try await viaProvider(url, port)
            }
        } else {
            result = try await viaProvider(url, port)
        }
        // Linking spends the handle and the step-up, so the next offer is empty (the Worker says
        // so); the app closes the offer with `dismiss()`. An identity another account holds spends
        // them too. Every other answer leaves it where it is: a stale step-up asks the person to
        // sign in again, and a handle nobody issued or a proof that failed spends nothing.
        switch result {
        case .linked:
            client.linkDropHandle()
        case .refused(_, let code) where code == ErrorCode.linkConflict:
            // An identity that belongs to another account is not offered again here (`offer()`
            // answers unavailable); the spent handle is forgotten.
            client.linkDropHandle()
            if let key = await client.linkDeclineKey() { await client.linkRemember(key) }
        default:
            break
        }
        return result
    }

    /// Not again for this account on this device: `sha256(issuer ‖ sub)` is kept. With no known
    /// subject the offer is only closed.
    public func decline() async {
        let key = await client.linkDeclineKey()
        client.linkClose()
        guard let key else { return }
        await client.linkRemember(key)
    }

    /// Close the offer for now without remembering a decline.
    public func dismiss() { client.linkClose() }

    static let kinds: Set<String> = ["google", "apple", "gamecenter", "pgs"]

    private func post(_ url: URL, _ port: any DeviceKeyPort, handle: String, proofValue: String?) async throws
        -> LinkAcceptResult
    {
        guard IdentityLinkHandle.ok(handle) else { return .refused(status: 404, code: ErrorCode.notFound) }
        let proof = try await client.linkProof(
            port, value: proofValue ?? handle, tokenHash: "-")
        return try await send(
            url, ["linkHandle": .string(handle), "proof": .string(proof)])
    }

    private func viaProvider(_ url: URL, _ port: any DeviceKeyPort) async throws -> LinkAcceptResult {
        guard let provider = client.platformProvider.current else { return .unavailable }
        guard case .nonce(let nonce)? = try await client.linkNonce(kind: provider.kind, port) else {
            return .unavailable
        }
        let subject: PlatformSubjectToken
        do { subject = try await provider.sheet(nonce: nonce.value) } catch { return .unavailable }
        guard !subject.token.isEmpty else {
            throw PolarisError(code: ErrorCode.signInFailed, message: "the platform provider returned no token.")
        }
        let keys = try await port.ensure()
        let proof = try await client.linkProof(
            port, value: "\(nonce.value).\(keys.signKey)",
            tokenHash: Base64URL.encode(Data(SHA256.hash(data: Data(subject.token.utf8)))))
        var body: [String: JSONValue] = [
            "subjectToken": .string(subject.token), "nonce": .string(nonce.value),
            "signKey": .string(keys.signKey), "agreeKey": .string(keys.agreeKey), "proof": .string(proof),
        ]
        if provider.kind == .gamecenter { body["subjectTokenType"] = .string(provider.kind.subjectTokenType) }
        return try await send(url, body)
    }

    private func send(_ url: URL, _ body: [String: JSONValue]) async throws -> LinkAcceptResult {
        let encoded = try JSONEncoder().encode(JSONValue.object(body))
        let response: PolarisResponse
        do {
            response = try await client.withBearer(
                url, method: "POST", headers: ["content-type": "application/json"], body: encoded)
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "the link request could not be sent.")
        }
        let object = client.exchangeBody(response)?.objectValue ?? [:]
        if response.status == 200 {
            guard let linked = object["linked"]?.objectValue, let kind = linked["kind"]?.stringValue,
                LinkNamespace.kinds.contains(kind)
            else {
                throw PolarisError(code: ErrorCode.badResponse, message: "the link answered without a link.")
            }
            return .linked(kind: kind, reach: linked["reach"]?.stringValue)
        }
        let code = object["error"]?.objectValue?["code"]?.stringValue ?? object["error"]?.stringValue
        if response.status < 500, let code,
            [ErrorCode.stepUpRequired, ErrorCode.linkConflict, ErrorCode.invalidGrant, ErrorCode.notFound]
                .contains(code)
        {
            return .refused(status: response.status, code: code)
        }
        throw client.linkFailure(response)
    }
}

enum IdentityLinkHandle {
    /// `lh_` and 43 base64url characters.
    static func ok(_ s: String) -> Bool {
        s.hasPrefix("lh_") && IdentityClient.urlSafe(String(s.dropFirst(3)), count: 43)
    }
}

extension IdentityClient {
    static let linkDeclinedRecord = "link-declined"
    static let linkDeclinedCap = 64

    /// `client.identity.link`.
    public var link: LinkNamespace { LinkNamespace(client: self) }

    /// The link route when an offer may be made now, else nil and no request: no open offer, the
    /// offer belongs to another account, the person declined it, the product serves none, or no
    /// device token is held.
    func linkReady(declinedAllowed: Bool) async throws -> URL? {
        guard let owner = linkState.current.pendingFor else { return nil }
        if owner != "", let now = subjectValue.current, now != owner {
            linkClose()
            return nil
        }
        guard await core.token != nil else { return nil }
        if !declinedAllowed, let key = await linkDeclineKey(), await linkDeclined(key) { return nil }
        if await core.discoveryDocument == nil { await core.discover() }
        guard let fragment = await core.discoveryDocument?.identity, let route = fragment.link, !route.isEmpty
        else { return nil }
        guard route.hasPrefix(core.endpoints.url("").absoluteString), let url = URL(string: route) else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "an identity endpoint points outside this product.")
        }
        return url
    }

    /// A sign-in this device started has completed: open the offer for its account.
    func linkOpen(subject: String?) {
        linkState.with { state in
            state.pendingFor = subject ?? ""
        }
    }

    /// Hold the handle an exchange left, for its lifetime.
    func linkHold(handle: String, expiresAt: Int) {
        linkState.with { state in
            state.handle = handle
            state.handleExpiresAt = expiresAt
        }
    }

    func linkHeldHandle() async -> String? {
        let now = await core.now()
        return linkState.with { state in
            guard let handle = state.handle, now < state.handleExpiresAt else {
                state.handle = nil
                return nil
            }
            return handle
        }
    }

    func linkDropHandle() { linkState.with { $0.handle = nil } }

    /// The offer is answered, dismissed or not this account's: nothing is held for it.
    func linkClose() { linkState.set(LinkState(choiceGrants: linkState.current.choiceGrants)) }

    /// Forget everything (sign-out).
    func linkReset() { linkState.set(LinkState()) }

    func linkChoicePending(grant: String) { _ = linkState.with { $0.choiceGrants.insert(grant) } }

    /// A licence choice completed: it opens the offer when its redirect started on this device.
    func linkChoiceCompleted(grant: String, subject: String?) {
        let own = linkState.with { $0.choiceGrants.remove(grant) != nil }
        if own { linkOpen(subject: subject) }
    }

    func linkNonce(kind: ExchangeKind, _ port: any DeviceKeyPort) async throws -> ExchangeNonceAnswer? {
        guard let routes = try await exchangeRoutes(kind) else { return nil }
        return try await fetchNonce(routes.nonce, port)
    }

    func linkProof(_ port: any DeviceKeyPort, value: String, tokenHash: String) async throws -> String {
        do {
            return try await DeviceProofs.sign(
                port, purpose: .link, product: core.product, deviceId: await core.deviceId, value: value,
                tokenHash: tokenHash
            ).sig
        } catch {
            throw PolarisError(code: ErrorCode.signInFailed, message: "the device proof could not be signed.")
        }
    }

    /// `sha256(issuer ‖ sub)`, base64url; nil while the subject is unknown.
    func linkDeclineKey() async -> String? {
        guard let sub = subjectValue.current, !sub.isEmpty else { return nil }
        let fromDiscovery = await core.discoveryDocument?.identity?.issuer
        let issuer = fromDiscovery ?? core.endpoints.url("identity").absoluteString
        return Base64URL.encode(Data(SHA256.hash(data: Data((issuer + sub).utf8))))
    }

    private func linkDeclinedSet() async -> [String] {
        guard let data = await core.store.readRecord(IdentityClient.linkDeclinedRecord),
            let text = String(data: data, encoding: .utf8)
        else { return [] }
        return text.split(separator: "\n").map(String.init)
    }

    func linkDeclined(_ key: String) async -> Bool { await linkDeclinedSet().contains(key) }

    func linkRemember(_ key: String) async {
        var all = await linkDeclinedSet()
        guard !all.contains(key) else { return }
        all.append(key)
        if all.count > IdentityClient.linkDeclinedCap { all.removeFirst(all.count - IdentityClient.linkDeclinedCap) }
        await core.store.writeRecord(IdentityClient.linkDeclinedRecord, Data(all.joined(separator: "\n").utf8))
    }

    /// A refusal that is not one of the link's own: the code and status only.
    func linkFailure(_ response: PolarisResponse) -> PolarisError {
        let refusal = exchangeRefusal(response)
        return PolarisError(code: refusal.code, message: "the link route refused the request (\(response.status)).")
    }
}
