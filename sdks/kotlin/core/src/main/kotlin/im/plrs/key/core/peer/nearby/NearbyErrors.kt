// Nearby approval's failures (CC-15.K2; plans CC-15 section 2): `NearbyException`, a `PolarisException`
// carrying a REGISTERED code only, in the table Node's `LAN_CODE` uses for the same reasons (sdk-node
// `connect/session.ts`). A reason is the finer, host-facing name; the code is what a log or a wire answer may
// show. Nothing here carries a key, a request handle, a signature or a payload: the message is a fixed sentence.

package im.plrs.key.core.peer.nearby

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException

/** Why a nearby call failed. */
public enum class NearbyErrorReason(public val code: String) {
    /** The host's input is not valid (a request handle, a label, an option). */
    bad_input(ErrorCode.invalidArgument),

    /** The session or the request is closed. */
    closed(ErrorCode.networkError),

    /** The person has not picked the matching code on this session, or there is no code to pick. */
    not_picked(ErrorCode.invalidArgument),

    /** A Sync record type outside `0x0030` to `0x003F`. */
    bad_type(ErrorCode.invalidArgument),

    /** The message is larger than the other device accepts. */
    too_large(ErrorCode.invalidArgument),

    /** That approver is no longer on the list. */
    unknown_peer(ErrorCode.invalidArgument),

    /** The request has not started, or nobody is chosen. */
    not_started(ErrorCode.notConfigured),
}

/** A nearby failure. [reason] says which; [code] is the registered client code. */
public class NearbyException(public val reason: NearbyErrorReason, message: String, cause: Throwable? = null) :
    PolarisException(reason.code, message, cause = cause) {
    override fun toString(): String = "NearbyException(${reason.name}, $code)"
}
