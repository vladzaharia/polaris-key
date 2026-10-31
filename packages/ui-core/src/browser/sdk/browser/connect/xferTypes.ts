// The host-facing types of Direct Transfer in the browser (CC-20.4; WIRE-CONTRACT-V5 §15.11),
// kept apart from the engine so the lean facade can name them without loading it.

import { ErrorCode } from "../../constants.generated.js";
import { PolarisError } from "../../core/types.js";
import type { XferReason } from "@polaris-key/client-core/peer";
import type { ConnectSession } from "./session.js";

export type { XferReason } from "@polaris-key/client-core/peer";

/** A device of the person's, or an open session. A browser has no links (it cannot pair). */
export type TransferPeer = string | ConnectSession;

/** What to send: a Blob (a File is one), a stream (spooled and hashed first) or bytes in memory. */
export type TransferSource =
  | Blob
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Uint8Array;

export interface SendOptions {
  /** Display data for the receiver, at most 255 UTF-8 bytes. Defaults to a File's name. */
  name?: string;
  /** A media type, display data only. Defaults to a Blob's type. */
  type?: string;
  /** Bytes per record, at most what the peer accepts (default 61,440). */
  chunk?: number;
  /** Aborting cancels the transfer (the reason the receiver sees is `cancelled`). */
  signal?: AbortSignal;
  /**
   * The id to offer under (22 base64url characters). Offer the same id and content again after an
   * interrupted send and the receiver resumes from the bytes it kept (§15.11, "Resume").
   */
  id?: string;
  /** Called with the id once the source is ready and just before the offer goes out. */
  onStart?: (t: { id: string; size: number; sha256: string }) => void;
}

export interface SentTransfer {
  id: string;
  size: number;
  /** Lowercase hex SHA-256 of the content. */
  sha256: string;
}

/** What the offer handler is shown. All text is the peer's: display data, never a path. */
export interface IncomingOffer {
  id: string;
  /** Cleaned display name, at most 255 bytes. */
  name?: string;
  type?: string;
  size: number;
  from: { kind: "device"; deviceId: string; label: string | null };
  path: "relay";
}

/** The slice of a File System Access `FileSystemFileHandle` the sink uses. */
export interface FileSinkHandle {
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

/**
 * The handler's answer. Delivery happens only after the hash matched and only where the host says:
 * `blob` receives the whole content as a Blob (the app decides what to do with it), `stream`
 * receives it as chunks, `file` is a File System Access handle the content is written to (the
 * browser swaps it in on close, so a half-written file is never seen). Nothing downloads on its
 * own. Anything else declines.
 */
export type OfferDecision =
  | false
  | null
  | undefined
  | "decline"
  | { blob: (blob: Blob) => void | Promise<void> }
  | { stream: (data: AsyncIterable<Uint8Array>) => Promise<void> }
  | { file: FileSinkHandle };

export type OfferHandler = (
  offer: IncomingOffer,
) => OfferDecision | Promise<OfferDecision>;

export interface TransferEvent {
  id: string;
  direction: "in" | "out";
  outcome: "delivered" | "cancelled" | "closed" | "failed";
  reason?: XferReason;
}

/** A transfer ended without its content delivered (`transfer-cancelled`). */
export class TransferError extends PolarisError {
  constructor(
    readonly reason: XferReason,
    message?: string,
  ) {
    super(
      ErrorCode.transferCancelled,
      message ?? `The transfer ended: ${reason}.`,
    );
    this.name = "TransferError";
  }
}

/** `adapter.cloudConnect.transfer`: Direct Transfer over the relay (mode `a`). */
export interface TransferClient {
  /**
   * Offer `source` to one of the person's devices and resolve when the peer has verified and
   * delivered it. Rejects with `transfer-cancelled` (carries `reason`), `peer-closed`, or a
   * `LanError` (`not_started` before `start()`, `elsewhere` in a tab that does not hold the relay).
   */
  send(
    peer: TransferPeer,
    source: TransferSource,
    opts?: SendOptions,
  ): Promise<SentTransfer>;
  /** Decide each offer. One handler at a time; `null` removes it; with none every offer is declined. */
  onOffer(handler: OfferHandler | null): () => void;
  /** Called when a transfer, either way, ends. Returns the unsubscribe. */
  onResult(fn: (e: TransferEvent) => void): () => void;
  /** Cancel a live transfer by id; false when none has that id. */
  cancel(id: string): boolean;
  /** The largest transfer this page accepts; null (default) for the protocol's own limit. */
  maxSize: number | null;
  /** Remove every partial transfer this page keeps (sign-out does this). */
  purge(): Promise<void>;
}
