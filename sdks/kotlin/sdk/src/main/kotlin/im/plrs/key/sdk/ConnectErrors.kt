// Cloud Connect's error taxonomy (CC-12.4; plans CC-01 G20): `LanException` and `RelayException`,
// each a `PolarisException` carrying a REGISTERED code only, in the tables Node's `LAN_CODE` and
// `RELAY_CODE` use (sdk-node `connect/session.ts` and `relay.ts`). A reason is the finer, host-facing
// name; the code is what a log, a wire answer or a transcript may show. Nothing here carries a key,
// ticket, certificate or payload: the message is a fixed sentence.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException

/** Why a LAN call failed. */
public enum class LanErrorReason(public val code: String) {
    no_identity(ErrorCode.notConfigured),
    no_keys(ErrorCode.notConfigured),
    not_started(ErrorCode.notConfigured),
    unknown_peer(ErrorCode.invalidArgument),
    not_listening(ErrorCode.connectUnavailable),
    connect_failed(ErrorCode.networkError),
    handshake_failed(ErrorCode.peerCertInvalid),
    wrong_peer(ErrorCode.peerCertInvalid),
    closed(ErrorCode.networkError),
    too_large(ErrorCode.invalidArgument),
    bad_type(ErrorCode.invalidArgument),

    /** The OS refused local network access (D-8); hosts show the permission hint. */
    permission_denied(ErrorCode.nearbyPermissionDenied),
}

/** A LAN failure. [closeCode] is the session's close code when a session ended. */
public class LanException(public val reason: LanErrorReason, message: String, cause: Throwable? = null, public val closeCode: String? = null) :
    PolarisException(reason.code, message, cause = cause) {
    override fun toString(): String = "LanException(${reason.name}, $code)"
}

/** Why a relay call failed. */
public enum class RelayErrorReason(public val code: String) {
    /** The product turned its relay off (403 `relay_disabled`). */
    disabled(ErrorCode.relayDisabled),

    /** The deployment paused the relay (503 `relay_paused`). */
    paused(ErrorCode.relayPaused),

    /** A relay byte quota is spent (429 `relay_quota_exceeded`, or a LIMIT 2 or 3). */
    quota(ErrorCode.relayQuotaExceeded),
    rate_limited(ErrorCode.rateLimited),
    ticket_invalid(ErrorCode.relayTicketInvalid),
    unavailable(ErrorCode.networkError),
    not_member(ErrorCode.peerCertInvalid),
    replaced(ErrorCode.cancelled),
    not_connected(ErrorCode.connectUnavailable),
    unknown_peer(ErrorCode.invalidArgument),
    handshake_failed(ErrorCode.peerCertInvalid),
    wrong_peer(ErrorCode.peerCertInvalid),
    busy(ErrorCode.rateLimited),
    mode_not_allowed(ErrorCode.invalidArgument),
    stopped(ErrorCode.cancelled),
}

/** The scope of a spent relay quota. */
public enum class RelayQuotaScope { person, product }

/** A relay failure. [scope] names a spent quota; [retryAfterSeconds] and [httpStatus] come from the ticket route. */
public class RelayException(
    public val reason: RelayErrorReason,
    message: String,
    cause: Throwable? = null,
    retryAfterSeconds: Int? = null,
    public val scope: RelayQuotaScope? = null,
    public val closeCode: String? = null,
    httpStatus: Int? = null,
) : PolarisException(reason.code, message, cause = cause, httpStatus = httpStatus, retryAfterSeconds = retryAfterSeconds) {
    override fun toString(): String = "RelayException(${reason.name}, $code)"
}
