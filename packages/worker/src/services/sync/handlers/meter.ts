/**
 * The per-operation meter of a Cloud Sync answer (U-05.18; plans/U-05-slices.md L15).
 *
 * A push or a pull that reached the person's object carries one standard `Server-Timing` header:
 *
 *     sync;desc="push";dur=12.4, mut;desc="100", rr;desc="340", rw;desc="212"
 *
 * `sync` names the operation (`push` or `pull`) and `dur` is the Worker's wall time in
 * milliseconds; `mut` is the number of mutations the request carried, `rr` the rows the object's
 * SQL read and `rw` the rows it wrote, summed over every object call the operation made (a push
 * also pulls). It holds counts and timings only: never a subject, a device id, a product, an
 * email or a key, and the caller can only learn about its own store. It is not CORS-exposed and
 * sends no `Timing-Allow-Origin`, so no page script reads it; the load script
 * (`scripts/load/cloud-sync-one-do.mjs`) is Node and reads it directly. The Worker has no log
 * sink (R12), so this header is the whole meter.
 */

import type { OpMeter } from "../do/protocol.js";

export type SyncOpName = "push" | "pull";

/** Accumulates one operation's meter across its object calls. */
export class OpTally {
  private readonly started = performance.now();
  mutations = 0;
  rowsRead = 0;
  rowsWritten = 0;
  /** True once an object call has answered (even a refusal that reached it). */
  reached = false;

  add(meter: OpMeter | undefined): void {
    this.reached = true;
    if (!meter) return;
    this.rowsRead += meter.rowsRead;
    this.rowsWritten += meter.rowsWritten;
  }

  /** The header value, in the fixed form above. */
  header(op: SyncOpName): string {
    const dur = (performance.now() - this.started).toFixed(1);
    return (
      `sync;desc="${op}";dur=${dur}, mut;desc="${this.mutations}", ` +
      `rr;desc="${this.rowsRead}", rw;desc="${this.rowsWritten}"`
    );
  }

  /** Sets the header on `res` when the operation reached the object; returns `res`. */
  stamp(res: Response, op: SyncOpName): Response {
    if (this.reached) res.headers.set("server-timing", this.header(op));
    return res;
  }
}
