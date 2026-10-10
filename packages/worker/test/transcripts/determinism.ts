// The determinism harness for transcript recording (P1b-03).
//
// A recorded conversation must be byte-stable: two runs of `pnpm gen transcripts` produce
// identical files, and a file only changes when the Worker's behaviour does. Three sources of
// variation have to be pinned while a scenario runs:
//
//   * THE REQUEST CLOCK. `dispatchWith` takes `now` explicitly, but some handlers still read
//     `Date.now()` themselves (`handleDeauthorize`, `handleAuthDeviceStart`, …). Vitest's fake
//     timers freeze `Date` — and ONLY `Date`: the timer functions stay real, so nothing a
//     handler awaits can hang on a clock that never advances.
//   * RANDOMNESS. Tokens, licence keys, bundle ids and key-vault IVs all come from
//     `crypto.getRandomValues`; `crypto.randomUUID` is pinned as well so a future handler that
//     reaches for it cannot silently break reproducibility. Both draw from one seeded stream,
//     so the n-th random byte of a scenario is the same on every run.
//   * SIGNATURES need nothing: Ed25519 is deterministic, and the Worker's test signing key is
//     the corpus key (`pkey-test-prod-2026`), so every recorded document verifies against the
//     same pins the conformance corpus uses. Signed bodies are never rewritten after recording
//     — that would break them.

import { createHash } from "node:crypto";
import { vi } from "vitest";

/** A SHA-256 counter-mode byte stream: stable across Node versions and platforms, unlike any
 *  engine PRNG, and trivially re-derivable by anyone reading a transcript's provenance. */
class SeededStream {
  private counter = 0;
  private buffer = new Uint8Array(0);
  private offset = 0;

  constructor(private readonly seed: string) {}

  next(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      if (this.offset >= this.buffer.length) {
        this.buffer = new Uint8Array(
          createHash("sha256").update(`${this.seed}:${this.counter}`).digest(),
        );
        this.counter += 1;
        this.offset = 0;
      }
      out[i] = this.buffer[this.offset]!;
      this.offset += 1;
    }
    return out;
  }
}

export interface Pinned {
  /** Move the frozen clock (epoch SECONDS). */
  setNow(now: number): void;
  /** Restore the real clock and the real random source. */
  restore(): void;
}

/**
 * Freeze `Date` at `now` and route `crypto.getRandomValues` / `crypto.randomUUID` through a
 * stream seeded by `seed` (the scenario id, so scenarios cannot perturb one another).
 */
export function pinEnvironment(seed: string, now: number): Pinned {
  const stream = new SeededStream(`pkey-transcripts:${seed}`);
  vi.useFakeTimers({ toFake: ["Date"], now: now * 1000 });

  const fill = (array: unknown): unknown => {
    if (!ArrayBuffer.isView(array)) return array;
    const view = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    );
    view.set(stream.next(view.length));
    return array;
  };
  const random = vi
    .spyOn(crypto, "getRandomValues")
    .mockImplementation(fill as typeof crypto.getRandomValues);
  const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    const b = stream.next(16);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const hex = Buffer.from(b).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
  });

  return {
    setNow(next: number) {
      vi.setSystemTime(next * 1000);
    },
    restore() {
      random.mockRestore();
      uuid.mockRestore();
      vi.useRealTimers();
    },
  };
}
