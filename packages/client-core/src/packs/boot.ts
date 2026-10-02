// The stage machine's host side for packs (plans/P4-01.md §2.10, §5 order 1; P4-06): the boot's
// FETCH stage driven by the pack engine. `bootPackOptions` turns the content stamp's `expects`
// into `requiredPacks` and `essentialPacks`; `runBootFetch` sends the v3 events the machine
// accepts in `fetch` — `fetch.consent {bytes, metered}` when the host asks before downloading,
// `fetch.progress {done, total}` from the first byte, and `fetch.done {result, installed}`.
// `stage-matrix.json` pins what the machine does with them.

import type { AppContent } from "@polaris-key/protocol/packs";
import type { PackTarget } from "@polaris-key/protocol/update";
import type { BootEvent, BootFetchResult, BootOptions } from "../stages.js";
import type { PackEngine } from "./engine.js";
import { PackError } from "./engine.js";

/**
 * The boot's pack options from the stamp (plans/P4-01.md §2.10): `requiredPacks` are the
 * `required: true` expects; `essentialPacks` the `delivery: "essential"` ones that are not
 * required. Any other delivery (an unknown one reads as `on-demand`, §2.2) waits for `ensure`.
 */
export function bootPackOptions(
  stamp: AppContent | null,
): Required<Pick<BootOptions, "requiredPacks" | "essentialPacks">> {
  const expects = stamp?.expects ?? [];
  return {
    requiredPacks: expects.filter((e) => e.required).map((e) => e.pack),
    essentialPacks: expects
      .filter((e) => !e.required && e.delivery === "essential")
      .map((e) => e.pack),
  };
}

export interface RunBootFetchOptions {
  /** The running build's content stamp. */
  stamp: AppContent | null;
  /** Delivers each event to the host's stage machine (`bootTransition`). */
  send: (event: BootEvent) => void;
  /**
   * When to ask before downloading: `always`, `metered` (the default: only on a metered
   * network) or `never`. Asking sends `fetch.consent` and waits for `answer`.
   */
  consent?: "always" | "metered" | "never";
  /** Whether the network is metered (cellular), as the host knows it. Default false. */
  metered?: boolean;
  /** The player's answer to `consent_needed`: true to download, false to decline. */
  answer?: (bytes: number, metered: boolean) => Promise<boolean>;
  /**
   * A `packs` decision's `install` list (plans/P4-13.md §2.5 "Applying a packs answer"): its
   * `required` and `essential` entries are installed here, before mount, at exactly the named
   * release; the others come back in `background` for the host to install after the boot
   * (`engine.ensureReleases`). Omitted: the stamp's pins, as before.
   */
  install?: readonly PackTarget[];
}

/**
 * Run the FETCH stage: estimate the required and essential packs that are not current, ask when
 * the policy says so, download them with progress, and report what is installed. The result is
 * `ok` when every wanted pack installed, `declined` when the player said no, `offline` when a
 * download failed for want of a network (`network-error`), else `failed`. `installed` is every
 * wanted pack whose pinned release is now running.
 */
export async function runBootFetch(
  engine: PackEngine,
  opts: RunBootFetchOptions,
): Promise<{
  result: BootFetchResult;
  installed: string[];
  /** With `install`: its entries that are neither required nor essential (install after
   *  boot). */
  background?: PackTarget[];
}> {
  const { requiredPacks, essentialPacks } = bootPackOptions(opts.stamp);
  const wanted = [...new Set([...requiredPacks, ...essentialPacks])];
  const blocking = new Set(wanted);
  const targets = new Map<string, PackTarget>();
  const background: PackTarget[] = [];
  for (const t of opts.install ?? []) {
    if (blocking.has(t.pack)) targets.set(t.pack, t);
    else background.push(t);
  }
  const metered = opts.metered === true;
  const installedNow = (): string[] => {
    const running = engine.state().running;
    const pins = new Map(
      (opts.stamp?.pins ?? []).map((p) => [p.pack, p.release.sha256]),
    );
    for (const [id, t] of targets) pins.set(id, t.release.sha256);
    return wanted.filter(
      (id) =>
        running[id] !== undefined && running[id]!.recordSha256 === pins.get(id),
    );
  };
  const done = (result: BootFetchResult) => {
    const installed = installedNow();
    opts.send({ type: "fetch.done", result, installed });
    return opts.install
      ? { result, installed, background }
      : { result, installed };
  };

  // The decision's targets install at exactly their release; the other wanted packs at the pin.
  const pinned = wanted.filter((id) => !targets.has(id));
  const est = await engine.estimate(pinned);
  if (targets.size > 0) {
    const t = await engine.estimateReleases([...targets.values()]);
    est.bytes += t.bytes;
    est.packs.push(...t.packs);
    est.refused.push(...t.refused);
  }
  const policy = opts.consent ?? "metered";
  const ask =
    est.bytes > 0 && (policy === "always" || (policy === "metered" && metered));
  if (ask) {
    opts.send({ type: "fetch.consent", bytes: est.bytes, metered });
    const yes = opts.answer ? await opts.answer(est.bytes, metered) : false;
    if (!yes) return done("declined");
  }
  const total = est.bytes;
  opts.send({ type: "fetch.progress", done: 0, total });
  let base = 0;
  let last = 0;
  const off = engine.on((p) => {
    if (p.phase !== "download") return;
    const now = Math.min(total, base + p.done);
    if (now > last) {
      last = now;
      opts.send({ type: "fetch.progress", done: now, total });
    }
  });
  let result: BootFetchResult = "ok";
  try {
    for (const id of est.packs) {
      try {
        const t = targets.get(id);
        if (t) await engine.ensureReleases([t]);
        else await engine.ensure([id]);
      } catch (e) {
        result =
          e instanceof PackError && e.code === "network-error"
            ? "offline"
            : "failed";
      }
      base = last;
    }
    if (est.refused.length > 0 && result === "ok")
      result = est.refused.some((r) => r.code === "network-error")
        ? "offline"
        : "failed";
  } finally {
    off();
  }
  if (result === "ok" && last < total)
    opts.send({ type: "fetch.progress", done: total, total });
  return done(result);
}
