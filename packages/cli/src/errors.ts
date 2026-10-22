/**
 * How `pkey` words a failure for a person: the exit code a message earns, and the sentence a
 * network error becomes. No stack trace ever reaches the terminal; `PKEY_DEBUG=1` adds one.
 *
 *   0  success
 *   1  a failure: an invalid manifest, a refusal, a network or server error
 *   2  a usage error: an unknown command or subcommand, a missing or misused argument
 */

/**
 * The user passed a bad argument or flag value: exit 2. Throw it where a command refuses its
 * input; a runtime failure (network, a server refusal, file IO) stays a plain `Error` (exit 1).
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * A message that carries its command's `Usage:` lines, or that opens by faulting a flag
 * (`--bp must be ...`, `--product is required.`), is a usage error (exit 2).
 */
export function isUsageError(message: string): boolean {
  return (
    /^Usage: /m.test(message) ||
    /^--[\w-]+(?: and --[\w-]+)? (?:must|is required|are required|goes with|go with|go together|needs)\b/.test(
      message,
    )
  );
}

interface Cause {
  code?: string;
  message?: string;
}

const NETWORK_CODES: Readonly<Record<string, string>> = {
  ECONNREFUSED: "the connection was refused",
  ENOTFOUND: "the host name did not resolve",
  EAI_AGAIN: "the host name did not resolve",
  ETIMEDOUT: "the connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  ECONNRESET: "the connection was reset",
  EHOSTUNREACH: "the host is unreachable",
  ENETUNREACH: "the network is unreachable",
};

/** Node's `fetch` rejects with `TypeError: fetch failed` and the real reason in `cause`. */
export function isFetchFailure(err: unknown): boolean {
  return err instanceof TypeError && err.message === "fetch failed";
}

const FS_CODES: Readonly<Record<string, string>> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Permission denied",
  EISDIR: "Is a directory, not a file",
  ENOTDIR: "Not a directory",
  EEXIST: "Already exists",
};

/** A file-system error as one sentence: `No such file or directory: <path>`. */
export function fsMessage(err: unknown): string | undefined {
  const e = err as { code?: unknown; path?: unknown } | null;
  if (typeof e?.code !== "string" || typeof e.path !== "string") return;
  const what = FS_CODES[e.code];
  return what === undefined ? undefined : `${what}: ${e.path}`;
}

/**
 * The sentence for a failed request: what failed, why where known, and what to check. Any other
 * error's message is returned as it is.
 */
export function networkMessage(err: unknown, url?: string): string {
  const fs = fsMessage(err);
  if (fs !== undefined) return fs;
  const listen = err as { code?: unknown; address?: unknown; port?: unknown };
  if (listen?.code === "EADDRINUSE")
    return `${String(listen.address)}:${String(listen.port)} is already in use. Stop what holds it, or pass --port <n>.`;
  if (!isFetchFailure(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  const cause = (err as Error & { cause?: Cause }).cause;
  const code = cause?.code;
  const why =
    (code !== undefined ? NETWORK_CODES[code] : undefined) ??
    (code?.startsWith("ERR_TLS") || code?.includes("CERT")
      ? "the TLS certificate was not accepted"
      : undefined) ??
    cause?.message;
  return (
    `Could not reach ${url ?? "the server"}${why ? `: ${why}` : ""}. ` +
    "Check your network, and --base-url (or $PKEY_BASE_URL) if you set one."
  );
}

/**
 * An exception the runtime throws on a bug rather than one pkey throws on purpose: a TypeError,
 * RangeError or ReferenceError with no `code` (Node's own input errors carry one).
 */
export function isInternalError(err: unknown): boolean {
  if (isFetchFailure(err)) return false;
  return (
    (err instanceof TypeError ||
      err instanceof RangeError ||
      err instanceof ReferenceError) &&
    (err as { code?: unknown }).code === undefined
  );
}

/** What an unexpected exception prints: one line, and how to get the detail. */
export function internalMessage(err: unknown): string {
  const text =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return (
    `pkey hit an unexpected error: ${text}\n` +
    "This is a bug in pkey. Re-run with PKEY_DEBUG=1 for the stack, and report it."
  );
}
