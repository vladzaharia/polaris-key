// The Cloud Connect error taxonomy (CC-11.4; WIRE-CONTRACT-V5 §15.7, §15.9). Mirrors sdk-node's
// `LanError` and `RelayError` (`connect/session.ts`, `relay.ts`): a typed `reason` for the host
// to branch on and a registered `code` from `conformance/parity/errors.json` (never a new one
// here). `LAN_CODE` and `RELAY_CODE` of the other SDKs are `code` below.

import Foundation
import PolarisKeyCore

/// The WebSocket subprotocol this client speaks (§15.7).
public let connectRelayProtocol = "pkey-relay.1"

/// Why a LAN-side call refused.
public enum ConnectLanReason: String, Sendable, CaseIterable {
    case noIdentity = "no_identity"
    case noKeys = "no_keys"
    case notStarted = "not_started"
    case unknownPeer = "unknown_peer"
    case notListening = "not_listening"
    case connectFailed = "connect_failed"
    case handshakeFailed = "handshake_failed"
    case wrongPeer = "wrong_peer"
    case closed
    case tooLarge = "too_large"
    case badType = "bad_type"
    /// Local Network access was refused (D-8): hosts hide the nearby-device surface.
    case permissionDenied = "permission_denied"
    /// The app's Info.plist lacks `NSBonjourServices` or `NSLocalNetworkUsageDescription`.
    case notConfigured = "not_configured"
    /// The OS registered the advert under another name, so it was withdrawn; the next rotation retries.
    case registrationRenamed = "registration_renamed"

    /// The registered client code.
    public var code: String {
        switch self {
        case .noIdentity, .noKeys, .notStarted, .notConfigured: return ErrorCode.notConfigured
        case .permissionDenied: return ErrorCode.nearbyPermissionDenied
        case .unknownPeer, .tooLarge, .badType: return ErrorCode.invalidArgument
        case .notListening, .registrationRenamed: return ErrorCode.connectUnavailable
        case .connectFailed, .closed: return ErrorCode.networkError
        case .handshakeFailed, .wrongPeer: return ErrorCode.peerCertInvalid
        }
    }
}

/// Why a relay-side call refused.
public enum ConnectRelayReason: String, Sendable, CaseIterable {
    case disabled
    case paused
    case quota
    case ticketInvalid = "ticket_invalid"
    case rateLimited = "rate_limited"
    case busy
    case unavailable
    case notConnected = "not_connected"
    case notMember = "not_member"
    case handshakeFailed = "handshake_failed"
    case wrongPeer = "wrong_peer"
    case unknownPeer = "unknown_peer"
    case modeNotAllowed = "mode_not_allowed"
    case replaced
    case stopped

    /// The registered code: the Worker's own for the four it answers with.
    public var code: String {
        switch self {
        case .disabled: return ErrorCode.relayDisabled
        case .paused: return ErrorCode.relayPaused
        case .quota: return ErrorCode.relayQuotaExceeded
        case .ticketInvalid: return ErrorCode.relayTicketInvalid
        case .rateLimited, .busy: return ErrorCode.rateLimited
        case .unavailable: return ErrorCode.networkError
        case .notConnected: return ErrorCode.connectUnavailable
        case .notMember, .handshakeFailed, .wrongPeer: return ErrorCode.peerCertInvalid
        case .unknownPeer, .modeNotAllowed: return ErrorCode.invalidArgument
        case .replaced, .stopped: return ErrorCode.cancelled
        }
    }
}

/// A LAN-side refusal. `closeCode` is why a session ended, when it did.
public struct ConnectLanError: Error, Sendable, Equatable, CustomStringConvertible {
    public let reason: ConnectLanReason
    public let message: String
    public let closeCode: String?
    public var code: String { reason.code }

    public init(_ reason: ConnectLanReason, _ message: String, closeCode: String? = nil) {
        self.reason = reason
        self.message = message
        self.closeCode = closeCode
    }

    public var description: String { "ConnectLanError(\(reason.rawValue))" }
}

/// A relay-side refusal. `retryAfterSeconds` and `status` come from the ticket route's answer;
/// `scope` (`person` or `product`) says which quota is spent.
public struct ConnectRelayError: Error, Sendable, Equatable, CustomStringConvertible {
    public let reason: ConnectRelayReason
    public let message: String
    public let retryAfterSeconds: Int?
    public let scope: String?
    public let closeCode: Int?
    public let status: Int?
    public var code: String { reason.code }

    public init(
        _ reason: ConnectRelayReason, _ message: String, retryAfterSeconds: Int? = nil, scope: String? = nil,
        closeCode: Int? = nil, status: Int? = nil
    ) {
        self.reason = reason
        self.message = message
        self.retryAfterSeconds = retryAfterSeconds
        self.scope = scope
        self.closeCode = closeCode
        self.status = status
    }

    public var description: String { "ConnectRelayError(\(reason.rawValue))" }
}
