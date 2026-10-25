import { call, enc } from "./transport.js";

/** `POST /api/device-login/start` (PX-W14): the code, its QR and the poll handle. */
export interface PortalDeviceLoginStart {
  id: string;
  /** `KRQP-BMXD`, shown as is. */
  code: string;
  /** An SVG `data:` URI of `approveUrl`. */
  qr: string;
  approveUrl: string;
  /** Seconds the code works. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
}

export type PortalDeviceLoginPoll =
  | { status: "pending"; expiresIn?: number; interval?: number }
  | { status: "approved" | "denied" };

/** `POST /api/device-login/lookup`: what asks to sign in, for the approver. */
export interface PortalDeviceLoginRequest {
  code: string;
  device: { label: string; browser: string | null; os: string | null };
  location: {
    city: string | null;
    region: string | null;
    country: string | null;
    label: string | null;
  };
  requestedAt: number;
  expiresIn: number;
  approverCountry: string | null;
  newLocation: boolean;
  stepUpRequired: boolean;
  /** Set on a command-line request for a packages token (F-37.1). */
  scope?: string;
  client?: { name: string; version: string; host: string };
}

export const deviceLoginApi = {
  /** PX-W14: ask to sign in on this browser by approving it from a signed-in device. */
  deviceLoginStart: () =>
    call<PortalDeviceLoginStart>("/api/device-login/start", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /** The asking browser's poll: `pending`, `denied` or `approved` (the session cookie is set). */
  deviceLoginPoll: (id: string) =>
    call<PortalDeviceLoginPoll>(`/api/device-login/${enc(id)}`),

  /** The approver reads what is asking, before deciding (reads only). */
  deviceLoginLookup: (code: string) =>
    call<{ request: PortalDeviceLoginRequest }>("/api/device-login/lookup", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  deviceLoginDecide: (code: string, decision: "approve" | "deny") =>
    call<{ ok: true; status: "approved" | "denied" }>(
      "/api/device-login/approve",
      { method: "POST", body: JSON.stringify({ code, decision }) },
    ),
};
