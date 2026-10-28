// The typed errors of Cloud Connect's relay and sessions in the browser (CC-09.2). Each is a
// `PolarisError` with a registered code; none carries a secret, a ticket or a key.

import type { ClosedReason } from "@polaris-key/client-core/peer";
import { ErrorCode } from "../../constants.generated.js";
import { PolarisError, type PolarisErrorCode } from "../../core/types.js";

export const RELAY_PROTOCOL = "pkey-relay.1";
/** The only PeerChannel mode that may cross the relay. */
export const RELAY_MODES = ["a"] as const;

/** Why a session ended: a client-core code, or the socket going away. */
export type SessionCloseCode = ClosedReason | "connection_lost";

/** The ticket answer (§15.7), already checked by the client. */
export interface RelayGrant {
  ticket: string;
  url: string;
  protocol: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export type RelayErrorReason =
  /** The product turned its relay off (403 `relay_disabled`). */
  | "disabled"
  /** The deployment paused the relay (503 `relay_paused`). */
  | "paused"
  /** A relay byte quota is spent (429 `relay_quota_exceeded`, or a LIMIT 2 or 3). */
  | "quota"
  | "rate_limited"
  | "ticket_invalid"
  | "unavailable"
  | "not_member"
  | "replaced"
  | "not_connected"
  | "unknown_peer"
  | "handshake_failed"
  | "wrong_peer"
  | "busy"
  | "mode_not_allowed"
  | "stopped";

/** The registered code of each reason: the Worker's own for the four it answers with. */
const RELAY_CODE: Record<RelayErrorReason, PolarisErrorCode> = {
  disabled: ErrorCode.relayDisabled,
  paused: ErrorCode.relayPaused,
  quota: ErrorCode.relayQuotaExceeded,
  ticket_invalid: ErrorCode.relayTicketInvalid,
  rate_limited: ErrorCode.rateLimited,
  busy: ErrorCode.rateLimited,
  unavailable: ErrorCode.networkError,
  not_connected: ErrorCode.connectUnavailable,
  not_member: ErrorCode.peerCertInvalid,
  handshake_failed: ErrorCode.peerCertInvalid,
  wrong_peer: ErrorCode.peerCertInvalid,
  unknown_peer: ErrorCode.invalidArgument,
  mode_not_allowed: ErrorCode.invalidArgument,
  replaced: ErrorCode.cancelled,
  stopped: ErrorCode.cancelled,
};

export class RelayError extends PolarisError {
  readonly reason: RelayErrorReason;
  readonly scope: "person" | "product" | undefined;
  readonly closeCode: SessionCloseCode | number | undefined;
  constructor(
    reason: RelayErrorReason,
    message: string,
    options?: {
      retryAfterSeconds?: number;
      scope?: "person" | "product";
      closeCode?: SessionCloseCode | number;
      /** For a refusal at the ticket route: the HTTP status. */
      status?: number;
    },
  ) {
    super(RELAY_CODE[reason], message, undefined, undefined, {
      ...(options?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: options.retryAfterSeconds }
        : {}),
      ...(options?.status !== undefined ? { status: options.status } : {}),
    });
    this.name = "RelayError";
    this.reason = reason;
    this.scope = options?.scope;
    this.closeCode = options?.closeCode;
  }
}

/** Throws for a mode the relay must never carry (`v`, `p`, anything else). */
export function assertRelayMode(mode: string): "a" {
  if (mode !== "a")
    throw new RelayError(
      "mode_not_allowed",
      `Mode ${mode} never crosses the relay; it is LAN only.`,
    );
  return "a";
}

export type LanErrorReason =
  | "no_identity"
  | "no_keys"
  | "unknown_peer"
  | "handshake_failed"
  | "wrong_peer"
  | "closed"
  | "too_large"
  | "bad_type"
  | "not_started";

const LAN_CODE: Record<LanErrorReason, PolarisErrorCode> = {
  no_identity: ErrorCode.notConfigured,
  no_keys: ErrorCode.notConfigured,
  not_started: ErrorCode.notConfigured,
  unknown_peer: ErrorCode.invalidArgument,
  handshake_failed: ErrorCode.peerCertInvalid,
  wrong_peer: ErrorCode.peerCertInvalid,
  closed: ErrorCode.networkError,
  too_large: ErrorCode.invalidArgument,
  bad_type: ErrorCode.invalidArgument,
};

/** A session error. The name matches the Node SDK's: the browser has no LAN, but a session's
 *  failures are the same typed ones on both. */
export class LanError extends PolarisError {
  readonly reason: LanErrorReason;
  readonly closeCode: SessionCloseCode | undefined;
  constructor(
    reason: LanErrorReason,
    message: string,
    options?: { closeCode?: SessionCloseCode },
  ) {
    super(LAN_CODE[reason], message);
    this.name = "LanError";
    this.reason = reason;
    this.closeCode = options?.closeCode;
  }
}
