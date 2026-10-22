// Pieces of the kit that load on demand, so the gate's entry stays inside its size budget (SP-47):
// the QR encoder (qr.ts) and the rows of the screens the gate rarely shows first (rows.tsx). Until a
// piece arrives it draws nothing; every kit component redraws when it does (`onLazyLoaded`), the
// way it does for a copy pack.

type Qr = typeof import("./qr.js");
type Rows = typeof import("./rows.js");

let qr: Qr | null = null;
let rows: Rows | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Called when a piece has loaded. */
export function onLazyLoaded(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Load the QR encoder and the rows now (once). Resolves when both are ready; a host that wants
 *  the first QR or settings list on screen at once awaits this before it renders. */
export function preloadParts(): Promise<void> {
  pending ??= Promise.all([
    import("./qr.js").then((m) => {
      qr = m;
    }),
    import("./rows.js").then((m) => {
      rows = m;
    }),
  ])
    .then(() => {
      for (const l of [...listeners]) l();
    })
    .catch(() => {
      // Nothing to draw them with: the screen keeps its text (the address beside a QR, DL14).
    });
  return pending;
}

/** The rows module, or `null` while it loads. */
export function rowsOf(): Rows | null {
  if (rows === null) void preloadParts();
  return rows;
}

/** The QR modules for `data`, or `null` while the encoder loads (and when it cannot encode it). */
export function encodeQr(data: string): ReturnType<Qr["encodeQr"]> | null {
  if (qr === null) {
    void preloadParts();
    return null;
  }
  return qr.encodeQr(data);
}
