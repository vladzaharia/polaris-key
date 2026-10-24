import { HttpError, createHttpClient } from "../../lib/http.js";

/** A sign-in connection the card can offer (I-30): its id names `/login/sso/<id>`. */
export interface PortalConnection {
  id: string;
  label: string;
}

/**
 * I-30: where an address's domain routes (identifier-first routing). The email start answers it
 * for a DNS-verified domain of an active connection, and an enforced domain's refusals carry it.
 */
export interface PortalSsoNext {
  kind: "sso";
  connection: PortalConnection;
  /** The domain gets no email code or sign-in link: the connection is the only way in. */
  enforced: boolean;
}

const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `x` as a `next: {kind: "sso"}` member, or `undefined` when it is anything else. */
export function readSsoNext(x: unknown): PortalSsoNext | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as { kind?: unknown; connection?: unknown; enforced?: unknown };
  if (o.kind !== "sso" || typeof o.connection !== "object" || !o.connection)
    return undefined;
  const c = o.connection as { id?: unknown; label?: unknown };
  if (typeof c.id !== "string" || !CONNECTION_ID_RE.test(c.id))
    return undefined;
  if (typeof c.label !== "string" || !c.label.trim()) return undefined;
  return {
    kind: "sso",
    connection: { id: c.id, label: c.label.trim() },
    enforced: o.enforced === true,
  };
}

export class PortalApiError extends HttpError {
  /** I-30: an enforced domain's refusal names the connection to use instead. */
  next?: PortalSsoNext;
  /** I-16: a passkey sign-in refused because no account here holds that credential. */
  unknownCredential?: boolean;
  constructor(status: number, code?: string) {
    super(status, { code });
    this.name = "PortalApiError";
    this.message = `portal api ${status}`;
  }

  /** A transport refusal as the portal's error: the core's fields plus what only the portal reads. */
  static from(e: HttpError): HttpError {
    const out = new HttpError(e.status, { code: e.code });
    const serverMessage =
      e.message !== `http ${e.status}` &&
      !(e.status === 0 && e.code === "network");
    if (serverMessage) out.message = e.message;
    Object.assign(out, {
      fields: e.fields,
      errors: e.errors,
      reason: e.reason,
      area: e.area,
      retryAfter: e.retryAfter,
      triesLeft: e.triesLeft,
      stale: e.stale,
      body: e.body,
    });
    const body = e.body as {
      next?: unknown;
      unknownCredential?: unknown;
    } | null;
    if (body && typeof body === "object") {
      const next = readSsoNext(body.next);
      if (next) out.next = next;
      if (body.unknownCredential === true) out.unknownCredential = true;
    }
    return out;
  }
}

const CSRF_HEADER = "X-PKey-Portal-CSRF";

let csrf = "";

export function setPortalCsrf(token: string): void {
  csrf = token;
}

export const http = createHttpClient({
  csrfHeader: CSRF_HEADER,
  csrf: () => csrf,
});

/**
 * One request to the Worker, answered or refused as a {@link PortalApiError}. `withCsrf` sends
 * the portal binder for every change and for a personal-data download.
 */
async function send(
  path: string,
  init: RequestInit,
  withCsrf: boolean,
): Promise<Response> {
  try {
    return await http.send(path, init, { csrf: withCsrf });
  } catch (e) {
    throw e instanceof HttpError && !(e instanceof HttpError)
      ? HttpError.from(e)
      : e;
  }
}

export async function call<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await send(
    path,
    init,
    init.method != null && init.method !== "GET",
  );
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function saveDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function download(path: string, filename: string): Promise<void> {
  const res = await send(path, {}, true);
  saveDownload(await res.blob(), filename);
}

export const enc = encodeURIComponent;
