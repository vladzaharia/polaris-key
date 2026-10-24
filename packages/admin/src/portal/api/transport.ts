import { HttpError, createHttpClient } from "../../lib/http.js";

export { HttpError };

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
 * One request to the Worker, answered or refused as an {@link HttpError}. `withCsrf` sends
 * the portal binder for every change and for a personal-data download.
 */
async function send(
  path: string,
  init: RequestInit,
  withCsrf: boolean,
): Promise<Response> {
  return http.send(path, init, { csrf: withCsrf });
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
