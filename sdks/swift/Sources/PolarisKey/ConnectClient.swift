// `client.connect` — Cloud Connect identity (CC-11.1; WIRE-CONTRACT-V5 §15; plans/CC-01-cloud-connect.md §2.3, §3).
//
//   identity()      registers the device keys on first need (`PUT /<p>/devices/keys`), fetches
//                   `GET /<p>/connect/identity`, verifies the roster and the certificate against
//                   the effective trust set, binds them to this device and its keys, and keeps
//                   them with K_disc in one Keychain item (`ConnectStateStore`).
//   held()          the stored identity, re-verified, without a request.
//   listDevices()   `GET /<p>/connect/devices`: the person's devices, display data only.
//   leave()         removes everything held, K_disc and its previous key included.
//
// This slice is the identity; the transport (Bonjour, TCP, relay) comes after. Where the service
// is off, the answer is the typed `product` N/A. A memory-only key store refuses, because keys
// that die with the process cannot be a roster entry. The Worker's refusals (`account_required`,
// `device_keys_required`, `ring_too_large`) come back verbatim. A roster that does not verify,
// is another account's, is not newer than the one held, or does not list this device with this
// device's keys is never stored, and the held identity stays as it was.

import Foundation
import PolarisKeyCore

/// The verified identity this device holds.
public struct ConnectIdentity: Sendable, Equatable {
    public let subject: String
    public let deviceId: String
    public let ring: DeviceRing
    public let certificate: PeerCert
    /// The compact JWS, verbatim, for the peer protocol to present.
    public let ringJws: String
    public let certificateJws: String
    /// Newest first. A device advertises under the first only; the second is the previous key,
    /// present for 24 hours after a bump and never after a leave.
    public let discKeys: [DiscoveryKey]
}

/// A refusal by the Worker, verbatim, or by this client before any request.
public struct ConnectRefusal: Sendable, Equatable {
    public let code: String
    /// The HTTP status; 0 for a refusal made on this device.
    public let status: Int
    public let message: String?
    /// For `account_required`: the link that starts sign-in.
    public let signInUrl: String?
}

public enum ConnectIdentityResult: Sendable, Equatable {
    case ready(ConnectIdentity)
    /// The typed N/A: `product` when the product does not run Cloud Connect.
    case unsupported(Unsupported)
    /// `account_required`, `device_keys_required`, `ring_too_large`, `unauthorized`, … .
    case refused(ConnectRefusal)
    /// No usable answer: `network`, `local-only`, `no-token`, `invalid-response`, `store-failed`.
    case error(code: String, message: String)

    public var identity: ConnectIdentity? {
        if case .ready(let i) = self { return i }
        return nil
    }
}

/// One of the person's devices, as `GET /<p>/connect/devices` lists it.
public struct ConnectDevice: Sendable, Equatable, Codable {
    public let deviceId: String
    public let label: String?
    public let platform: String?
    public let lastSeen: Int
    public let isSelf: Bool

    private enum CodingKeys: String, CodingKey {
        case deviceId, label, platform, lastSeen
        case isSelf = "self"
    }
}

public enum ConnectDevicesResult: Sendable, Equatable {
    case devices([ConnectDevice])
    case unsupported(Unsupported)
    case refused(ConnectRefusal)
    case error(code: String, message: String)

    public var list: [ConnectDevice]? {
        if case .devices(let d) = self { return d }
        return nil
    }
}

/// The seams a host or a test may replace.
public struct ConnectOptions: Sendable {
    /// The device key port. Nil: a `DeviceKeyStore` for the product, made on first use.
    public var keys: (any DeviceKeyPort)?
    /// Where the identity is kept. Nil: the Keychain.
    public var store: ConnectStateStore?
    /// Accept a key store whose keys die with the process (`DeviceKeyStore.inMemory()`). Off by
    /// default: without it a memory-only store is `invalid-options`, because keys that are gone
    /// at the next launch leave a dead entry in the person's roster.
    public var allowEphemeralKeys: Bool

    public init(
        keys: (any DeviceKeyPort)? = nil, store: ConnectStateStore? = nil, allowEphemeralKeys: Bool = false
    ) {
        self.keys = keys
        self.store = store
        self.allowEphemeralKeys = allowEphemeralKeys
    }
}

public actor ConnectClient {
    private let core: CoreContext
    private let options: ConnectOptions
    private let accessGroup: String?
    private var madeKeys: (any DeviceKeyPort)?
    private var madeStore: ConnectStateStore?

    public init(core: CoreContext, options: ConnectOptions = ConnectOptions(), accessGroup: String? = nil) {
        self.core = core
        self.options = options
        self.accessGroup = accessGroup
    }

    // ── Serialisation ────────────────────────────────────────────────────────────────────
    // An actor is reentrant at every `await`, so `identity()`, `listDevices()` and `leave()` run
    // one at a time through this lock: a `leave()` during a fetch waits for it and then clears,
    // and two `identity()` calls never save out of order.
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private func acquire() async {
        if locked {
            await withCheckedContinuation { waiters.append($0) }
        } else {
            locked = true
        }
    }

    private func release() {
        if waiters.isEmpty {
            locked = false
        } else {
            waiters.removeFirst().resume()
        }
    }

    private func serialised<T: Sendable>(_ body: () async -> T) async -> T {
        await acquire()
        let out = await body()
        release()
        return out
    }

    // ── Public ───────────────────────────────────────────────────────────────────────────

    /// The held identity, re-verified against the current trust set and clock; nil when none is
    /// held or it no longer verifies (a roster past `expiresAt + 300` counts as none).
    public func held() async -> ConnectIdentity? {
        guard let store = try? self.store(), let record = try? store.load() else { return nil }
        return await verified(record, deviceId: await core.deviceId, now: await core.now())
    }

    /// The previous K_disc is kept for 24 hours from when it was first seen (V5 §15.4); a record
    /// with a second key and no first-seen time keeps neither.
    private static let previousKeySeconds = 86_400
    /// A certificate with more than 3.5 days left is served from the held identity.
    private static let certFreshSeconds = 302_400

    private static func activeDiscKeys(_ r: ConnectRecord, now: Int) -> [String] {
        guard r.discKeys.count > 1 else { return r.discKeys }
        guard let seen = r.prevFirstSeen, now < seen + previousKeySeconds else { return [r.discKeys[0]] }
        return r.discKeys
    }

    /// Registers keys if needed, fetches and verifies the identity, stores it.
    ///
    /// With a held identity whose certificate has more than 3.5 days left the held one is served
    /// without a request, unless `refresh` is true. A transport that sees a peer certificate on a
    /// higher epoch, or a `RING` from a peer, asks for `refresh: true`.
    public func identity(refresh: Bool = false) async -> ConnectIdentityResult {
        await serialised { await identityLocked(refresh: refresh) }
    }

    private func identityLocked(refresh: Bool) async -> ConnectIdentityResult {
        if let early = await precheck() { return early }
        let keys: DevicePublicKeys
        let port: any DeviceKeyPort
        let store: ConnectStateStore
        let record: ConnectRecord?
        do {
            port = try keyPort()
            store = try self.store()
            // Keys that die with the process cannot be a roster entry: refuse before making any.
            if try await port.persistence() == .memory && !options.allowEphemeralKeys {
                return .error(
                    code: ErrorCode.invalidOptions,
                    message: "The device key store is memory-only; set allowEphemeralKeys to use it.")
            }
            keys = try await port.ensure()
            record = try store.load()
        } catch {
            return .error(code: "store-failed", message: "The device keys or the held identity could not be read.")
        }
        if !refresh, let record, let id = await verified(record, deviceId: await core.deviceId, now: await core.now()),
            id.certificate.signKey == keys.signKey, id.certificate.agreeKey == keys.agreeKey,
            id.certificate.expiresAt - (await core.now()) > Self.certFreshSeconds
        {
            return .ready(id)
        }
        guard let token = await core.token else {
            return .error(code: ErrorCode.noToken, message: "Activate or register before using Cloud Connect.")
        }
        var registered = record?.registered
        let known = registered.map { $0.signKey == keys.signKey && $0.agreeKey == keys.agreeKey } ?? false
        if !known {
            switch await register(port, token: token) {
            case .success(let r): registered = r
            case .failure(let failure): return failure.result
            }
        }
        var answer = await fetchIdentity(token: token)
        // The Worker lost the keys (or this device was released): register once more, once.
        if case .failure(let f) = answer, case .refused(let r) = f.result, r.code == ErrorCode.deviceKeysRequired,
            known
        {
            switch await register(port, token: token) {
            case .success(let r): registered = r
            case .failure(let failure): return failure.result
            }
            answer = await fetchIdentity(token: token)
        }
        switch answer {
        case .failure(let failure): return failure.result
        case .success(let body):
            return await accept(body, keys: keys, registered: registered, held: record, store: store)
        }
    }

    /// The person's devices (`GET /<p>/connect/devices`).
    public func listDevices() async -> ConnectDevicesResult {
        await serialised { await listDevicesLocked() }
    }

    private func listDevicesLocked() async -> ConnectDevicesResult {
        if let early = await precheck() {
            switch early {
            case .unsupported(let u): return .unsupported(u)
            case .refused(let r): return .refused(r)
            case .error(let c, let m): return .error(code: c, message: m)
            case .ready: break
            }
        }
        guard let token = await core.token else {
            return .error(code: ErrorCode.noToken, message: "Activate or register before using Cloud Connect.")
        }
        switch await get(core.endpoints.connectDevices, token: token) {
        case .failure(let f):
            switch f.result {
            case .unsupported(let u): return .unsupported(u)
            case .refused(let r): return .refused(r)
            case .error(let c, let m): return .error(code: c, message: m)
            case .ready: return .error(code: ErrorCode.invalidResponse, message: "Unexpected answer.")
            }
        case .success(let data):
            struct Body: Decodable { let devices: [ConnectDevice] }
            guard let body = StrictJSON.decode(Body.self, from: data), body.devices.count <= MAX_RING_DEVICES else {
                return .error(code: ErrorCode.invalidResponse, message: "The device list is malformed.")
            }
            return .devices(body.devices)
        }
    }

    /// Removes the held identity: the roster, the certificate and every discovery key, the
    /// previous one included. The device keys stay (they belong to the device, not the account).
    ///
    /// With nothing held it returns at once and touches nothing. If a record exists (even an
    /// unreadable one) and cannot be deleted, it throws, so a sign-out stops rather than leave
    /// K_disc behind.
    public func leave() async throws {
        await acquire()
        defer { release() }
        let store = try self.store()
        guard try store.exists() else { return }
        try store.clear()
    }

    // ── Seams ────────────────────────────────────────────────────────────────────────────

    private func keyPort() throws -> any DeviceKeyPort {
        if let k = options.keys { return k }
        if let k = madeKeys { return k }
        let k = try DeviceKeyStore(productSlug: core.product, accessGroup: accessGroup)
        madeKeys = k
        return k
    }

    private func store() throws -> ConnectStateStore {
        if let s = options.store { return s }
        if let s = madeStore { return s }
        let s = try ConnectStateStore(productSlug: core.product, accessGroup: accessGroup)
        madeStore = s
        return s
    }

    /// The service gate and the local-only gate; nil to go on.
    private func precheck() async -> ConnectIdentityResult? {
        do {
            try await core.requireService(.connect, feature: Feature.connectIdentity)
        } catch let e as PolarisError {
            if let u = e.unsupported { return .unsupported(u) }
            return .error(code: e.code, message: e.message)
        } catch {
            return .error(code: ErrorCode.network, message: "\(error)")
        }
        return nil
    }

    // ── Requests ─────────────────────────────────────────────────────────────────────────

    private struct Failure: Error {
        let result: ConnectIdentityResult
    }

    private func refusal(_ response: PolarisResponse) -> ConnectIdentityResult {
        struct Body: Decodable {
            struct Err: Decodable {
                let code: String?
                let message: String?
                let signInUrl: String?
            }
            let error: Err?
        }
        guard let err = (try? JSONDecoder().decode(Body.self, from: response.body))?.error, let code = err.code else {
            return .error(code: ErrorCode.invalidResponse, message: "The server answered \(response.status).")
        }
        return .refused(
            ConnectRefusal(code: code, status: response.status, message: err.message, signInUrl: err.signInUrl))
    }

    private func send(
        _ url: URL, method: String, token: String, body: Data? = nil
    ) async -> Result<PolarisResponse, Failure> {
        var headers = ["authorization": "Bearer \(token)"]
        if body != nil { headers["content-type"] = "application/json" }
        do {
            let response = try await core.request(url, method: method, headers: headers, body: body)
            guard response.isOK else { return .failure(Failure(result: refusal(response))) }
            return .success(response)
        } catch let e as PolarisError {
            return .failure(Failure(result: .error(code: e.code, message: e.message)))
        } catch {
            return .failure(Failure(result: .error(code: ErrorCode.network, message: "The request failed.")))
        }
    }

    private func get(_ url: URL, token: String) async -> Result<Data, Failure> {
        await send(url, method: "GET", token: token).map(\.body)
    }

    /// `PUT /<p>/devices/keys` with the `keys` proof; safe to repeat.
    private func register(_ port: any DeviceKeyPort, token: String) async -> Result<RegisteredDeviceKeys, Failure> {
        let request: (path: String, body: DeviceKeysRequest)
        do {
            let deviceId = await core.deviceId
            request = try await DeviceProofs.keysRequest(
                port, product: core.product, deviceId: deviceId, allowEphemeral: options.allowEphemeralKeys)
        } catch DeviceKeyError.unsupported {
            return .failure(
                Failure(
                    result: .refused(
                        ConnectRefusal(
                            code: ErrorCode.deviceKeysRequired, status: 0,
                            message: "The device key store cannot register keys.", signInUrl: nil))))
        } catch {
            return .failure(
                Failure(result: .error(code: "store-failed", message: "The device keys could not be used.")))
        }
        guard let body = try? JSONEncoder().encode(request.body) else {
            return .failure(Failure(result: .error(code: "store-failed", message: "The request could not be built.")))
        }
        let sent = await send(core.endpoints.deviceKeys, method: "PUT", token: token, body: body)
        switch sent {
        case .failure(let f): return .failure(f)
        case .success(let response):
            guard let ok = try? JSONDecoder().decode(DeviceKeysResponse.self, from: response.body) else {
                return .failure(
                    Failure(result: .error(code: ErrorCode.invalidResponse, message: "The key answer is malformed.")))
            }
            return .success(
                RegisteredDeviceKeys(signKey: request.body.signKey, agreeKey: request.body.agreeKey, keySeq: ok.keySeq))
        }
    }

    private struct IdentityBody: Decodable {
        let ring: String
        let certificate: String
        let discKeys: [String]
    }

    private func fetchIdentity(token: String) async -> Result<IdentityBody, Failure> {
        switch await get(core.endpoints.connectIdentity, token: token) {
        case .failure(let f): return .failure(f)
        case .success(let data):
            guard let body = StrictJSON.decode(IdentityBody.self, from: data) else {
                return .failure(
                    Failure(result: .error(code: ErrorCode.invalidResponse, message: "The identity is malformed.")))
            }
            return .success(body)
        }
    }

    // ── Verification ─────────────────────────────────────────────────────────────────────

    private func invalid(_ why: String) -> ConnectIdentityResult {
        .error(code: ErrorCode.invalidResponse, message: "The identity was refused: \(why).")
    }

    /// Verifies the answer and, only if every check holds, stores it.
    private func accept(
        _ body: IdentityBody, keys: DevicePublicKeys, registered: RegisteredDeviceKeys?, held: ConnectRecord?,
        store: ConnectStateStore
    ) async -> ConnectIdentityResult {
        let trust = await core.trust
        let now = await core.now()
        let deviceId = await core.deviceId
        // K_disc: one or two canonical 32-byte keys, nothing else.
        guard (1...2).contains(body.discKeys.count), body.discKeys.allSatisfy({ DiscoveryKey(base64url: $0) != nil }),
            body.discKeys.count == Set(body.discKeys).count
        else { return invalid("discovery keys") }
        guard
            case .ok(let ring) = PeerDocs.verifyRing(body.ring, trust: trust, expectedAud: core.product)
        else { return invalid("roster") }
        let opts = VerifyPeerCertOptions(trust: trust, expectedAud: core.product, now: now)
        guard case .ok(let cert) = PeerDocs.verifyPeerCert(body.certificate, options: opts) else {
            return invalid("certificate")
        }
        // The roster and the certificate belong together, to this person and this device.
        guard ring.sub == cert.sub else { return invalid("another account") }
        guard cert.deviceId == deviceId, cert.signKey == keys.signKey, cert.agreeKey == keys.agreeKey else {
            return invalid("certificate of another device")
        }
        guard cert.ringEpoch == ring.epoch else { return invalid("certificate on another epoch") }
        guard !PeerDocs.ringExpired(ring, now: now) else { return invalid("expired roster") }
        guard
            ring.devices.contains(where: {
                $0.deviceId == deviceId && $0.signKey == keys.signKey && $0.agreeKey == keys.agreeKey
            })
        else { return invalid("this device is not in the roster") }
        // Against the held roster (§15.3): another account's is foreign, an older one is stale.
        // The same epoch is a re-issue (new lifetime, same members) and is taken only if nothing
        // else moved.
        if let held, let heldRing = PeerDocs.liveRing(held.ring, trust: trust, expectedAud: core.product, now: now) {
            if heldRing.sub != ring.sub { return invalid("another account's roster") }
            if ring.epoch < heldRing.epoch { return invalid("stale roster") }
            if ring.epoch == heldRing.epoch && ring.devices != heldRing.devices {
                return invalid("stale roster")
            }
        }
        // K_disc: the current key, and the previous one only while it is under 24 hours old and
        // no device was lost or re-keyed since the held roster. Nothing carries over from the
        // held record except the time the previous key was first seen.
        var disc = [body.discKeys[0]]
        var prevSeen: Int?
        if body.discKeys.count > 1 {
            let prev = body.discKeys[1]
            let sameKey = (held?.discKeys.count ?? 0) > 1 && held?.discKeys[1] == prev
            let first = (sameKey ? held?.prevFirstSeen : nil) ?? now
            var lost = false
            if let held, case .ok(let was) = PeerDocs.verifyRing(held.ring, trust: trust, expectedAud: core.product) {
                lost = was.devices.contains { !ring.devices.contains($0) }
            }
            if !lost && now < first + Self.previousKeySeconds {
                disc.append(prev)
                prevSeen = first
            }
        }
        let record = ConnectRecord(
            ring: body.ring, certificate: body.certificate, discKeys: disc, registered: registered,
            storedAt: now, prevFirstSeen: prevSeen)
        do { try store.save(record) } catch {
            return .error(code: "store-failed", message: "The identity could not be stored.")
        }
        return .ready(
            ConnectIdentity(
                subject: ring.sub, deviceId: deviceId, ring: ring, certificate: cert, ringJws: body.ring,
                certificateJws: body.certificate, discKeys: disc.compactMap { DiscoveryKey(base64url: $0) }))
    }

    /// A stored record is trusted only as far as it verifies again.
    private func verified(_ r: ConnectRecord, deviceId: String, now: Int) async -> ConnectIdentity? {
        let trust = await core.trust
        guard case .ok(let ring) = PeerDocs.verifyRing(r.ring, trust: trust, expectedAud: core.product),
            !PeerDocs.ringExpired(ring, now: now),
            case .ok(let cert) = PeerDocs.verifyPeerCert(
                r.certificate, options: VerifyPeerCertOptions(trust: trust, expectedAud: core.product, now: now)),
            cert.sub == ring.sub, cert.deviceId == deviceId, (1...2).contains(r.discKeys.count)
        else { return nil }
        let active = Self.activeDiscKeys(r, now: now)
        let disc = active.compactMap { DiscoveryKey(base64url: $0) }
        guard disc.count == active.count else { return nil }
        return ConnectIdentity(
            subject: ring.sub, deviceId: deviceId, ring: ring, certificate: cert, ringJws: r.ring,
            certificateJws: r.certificate, discKeys: disc)
    }
}
