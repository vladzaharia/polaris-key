/// <reference types="@cloudflare/workers-types" />
// PX-W14: the parts of "Sign in with another device" the runtime could change. The country name
// comes from `Intl.DisplayNames` (workerd's ICU), the QR code is base64'd with `btoa`, and the
// single use of a code is a `consume` on the REAL single-use object.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  artefactRef,
  consumeArtefact,
  putArtefact,
} from "../src/core/singleUse.js";
import { qrSvg } from "../src/core/qr.js";
import { requestLocation } from "../src/services/identity/portal/deviceLogin.js";
import type { Env as WorkerEnv } from "../src/env.js";

const workerEnv = env as unknown as WorkerEnv;

describe("device login on workerd", () => {
  it("names the country from Cloudflare's code", () => {
    const req = new Request("https://key.plrs.im/", {
      headers: { "cf-ipcountry": "PT" },
    });
    expect(requestLocation(req)).toMatchObject({
      country: "PT",
      label: "Portugal",
    });
  });

  it("encodes the approve link as a QR data URI", () => {
    const svg = qrSvg(
      "https://key.plrs.im/#/account/approve?code=WDJB-MJHT",
      "QR code",
    );
    expect(svg).not.toBeNull();
    expect(atob(btoa(svg!))).toBe(svg);
  });

  it("two concurrent decisions on one code: exactly one takes it", async () => {
    const ref = artefactRef("device-login-code", `race-${crypto.randomUUID()}`);
    await putArtefact(workerEnv, ref, "request", 300, { ifAbsent: true });
    const results = await Promise.all([
      consumeArtefact(workerEnv, ref),
      consumeArtefact(workerEnv, ref),
    ]);
    expect(results.filter((v) => v === "request")).toHaveLength(1);
  });
});
