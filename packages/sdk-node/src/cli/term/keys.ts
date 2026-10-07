// Keypresses from a terminal in raw mode, for the prompts and the waiting steps' keys (Enter,
// Esc, c, the arrows). Raw mode is entered on the first read and always left on close, so a
// cancelled flow never leaves the user's shell without echo.

import { emitKeypressEvents } from "node:readline";
import type { TerminalInput } from "./caps.js";

export interface Key {
  /** `return`, `escape`, `backspace`, `up`, `down`, a letter… */
  name: string;
  /** The characters the key produced (a pasted run arrives as one sequence). */
  sequence: string;
  ctrl: boolean;
  meta: boolean;
}

/** Normalise readline's keypress pair. */
function toKey(str: string | undefined, key: Partial<Key> | undefined): Key {
  return {
    name: key?.name ?? str ?? "",
    sequence: key?.sequence ?? str ?? "",
    ctrl: key?.ctrl ?? false,
    meta: key?.meta ?? false,
  };
}

/** Ctrl-C, Esc or Ctrl-D: the user wants out. */
export function isCancel(k: Key): boolean {
  return (
    (k.ctrl && (k.name === "c" || k.name === "d")) ||
    k.name === "escape" ||
    k.sequence === "\x1b"
  );
}

export class KeyReader {
  private queue: Key[] = [];
  private waiting: ((k: Key | null) => void) | null = null;
  private started = false;
  private closed = false;
  private readonly onKey = (str: string | undefined, key: Partial<Key>) => {
    const k = toKey(str, key);
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(k);
    } else this.queue.push(k);
  };

  constructor(private readonly input: TerminalInput) {}

  private start(): void {
    if (this.started) return;
    this.started = true;
    emitKeypressEvents(input(this.input));
    this.input.setRawMode?.(true);
    this.input.on("keypress", this.onKey);
    this.input.resume?.();
  }

  /** The next key, or null when the reader closed or `signal` aborted. */
  next(signal?: AbortSignal): Promise<Key | null> {
    if (this.closed) return Promise.resolve(null);
    this.start();
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiting = null;
        resolve(null);
      };
      if (signal?.aborted) return resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting = (k) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(k);
      };
    });
  }

  /** Leave raw mode and stop listening. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.started) return;
    const off = this.input.off ?? this.input.removeListener;
    off?.call(this.input, "keypress", this.onKey);
    this.input.setRawMode?.(false);
    this.input.pause?.();
    this.waiting?.(null);
    this.waiting = null;
  }
}

function input(i: TerminalInput): NodeJS.ReadableStream {
  return i as unknown as NodeJS.ReadableStream;
}
