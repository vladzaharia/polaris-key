// Shared by the exchange tests (I-46.3, I-46.4): a scripted Worker's pieces.
import {
  createWebDeviceKeyStore,
  memoryDeviceKeyStorage,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import { BearerSession } from "../src/browser/bearer/session.js";

export const SUBJECT_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnb29nbGUifQ.c2ln";
export const ACCESS = "pkeyt_prsGUTwB_L_ya9ehl-yBxntG6B7_xgjP270SLtXiRdU";
export const GRANT = "sg_vXaXXVFx-nbsln4n2t-RP-vjQSv6dpGbNfDR9V7Kn7M";
export const HANDLE = "lh_Cgk9GjrOM5ZTa16Q4RNw3rl3FE1zW0g_zIXFPBEenRU";
export const nonceOf = (n: number) => `${String(n).padStart(43, "N")}`;

export const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const durableKeys = (): DeviceKeyPort =>
  createWebDeviceKeyStore({ storage: memoryDeviceKeyStorage() });

export const TOKEN_BODY = {
  access_token: ACCESS,
  token_type: "Bearer",
  scope: "profile email",
  subject: "ps_abc",
  schemaVersion: 1,
  device: { id: "EXCHANGEDEVICE0000000000000001", licenseId: null },
  license: { id: "lic-1" },
  issued_token_type: "urn:polaris-key:token-type:device",
};

/** A bearer session over a scripted Worker, with the pins and the identity service on. */
export function exchangeSession(
  o: Pick<
    ConstructorParameters<typeof BearerSession>[0],
    "fetchImpl" | "store" | "exchangeEndpoints"
  > &
    Partial<ConstructorParameters<typeof BearerSession>[0]>,
): BearerSession {
  return new BearerSession({
    baseUrl: "https://key.plrs.im",
    product: "acme",
    version: "1.0.0",
    now: () => 1_700_000_000,
    pinned: { k: "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
    enabled: (slug) => slug === "identity",
    random: () => 0,
    ...o,
  });
}
