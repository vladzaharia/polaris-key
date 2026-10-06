// The browser's `BootDriver` over the bearer engine (`ui.boot`, SDK-PARITY-PASS §3.4): what each
// stage of `runBoot` (core/boot.ts) does in a bearer-mode page. A factory, so the adapter and
// the transcript replayer (boot-cold-register.json) drive the same code.

import type { BootDecision, BootSyncResult } from "@polaris-key/client-core";
import type { LicenseStatus } from "@polaris-key/protocol/license";
import type { UpdateCheck } from "@polaris-key/protocol/update";
import type { BootDriver } from "../core/boot.js";
import type { BearerSession, SyncResult } from "./bearer/session.js";

/** Node's rule for a sync pass: every fetched document failed ⇒ `offline`, otherwise `ok`. */
export function bootSyncResult(r: SyncResult): BootSyncResult {
  const outcomes = Object.values(r.documents).filter(
    (d) => d && d.kind !== "skipped",
  );
  if (outcomes.length > 0 && outcomes.every((d) => d!.kind === "error"))
    return "offline";
  return "ok";
}

export interface BearerBootDriverOptions {
  session: BearerSession;
  /** Load discovery when it has not answered (never throws). */
  discover: () => Promise<void>;
  /** Discovery's `core.registration`, or null. */
  registrationPolicy: () => string | null;
  /** Whether the product runs License (discovery, or the host's expectation). */
  licenseEnabled: () => boolean;
  /** The gate's status, projected from the session's verified state. */
  status: () => LicenseStatus;
  /** The update decision, when the page configured one. */
  decide?: () => Promise<{ decision: BootDecision; check: UpdateCheck | null }>;
  /** Called after each step that changed the session, so the adapter re-projects. */
  changed?: () => void;
}

export function bearerBootDriver(o: BearerBootDriverOptions): BootDriver {
  const s = o.session;
  return {
    discover: async () => {
      await s.init();
      await o.discover();
    },
    hasToken: () => s.hasToken,
    registrationPolicy: o.registrationPolicy,
    licenseEnabled: o.licenseEnabled,
    register: async () => {
      const r = await s.register();
      o.changed?.();
      return r.kind === "ok";
    },
    enroll: async () => {
      const r = await s.enroll();
      if (r.kind !== "ok") return false;
      await s.sync({ force: true }).catch(() => undefined);
      o.changed?.();
      return true;
    },
    sync: async (force) => {
      const r = await s.sync(force ? { force: true } : {});
      o.changed?.();
      return bootSyncResult(r);
    },
    status: o.status,
    ...(o.decide ? { decide: o.decide } : {}),
  };
}
