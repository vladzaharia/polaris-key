/// <reference types="@cloudflare/workers-types" />
// UK-42.22F: the red-team fix round for the device-code app mode (THREAT-MODEL R1-07, app mode).
//
//   - the approval page says the device is signed in to the person's account and names the app;
//   - every app-mode device-code bind sends the new-device security notice to every verified
//     address (the direct bind at the poll, and `choice/complete` over a device grant);
//   - a device grant cannot Replace (409, grant kept), and key and keep bind over one;
//   - a disabled or erased account at the poll binds nothing;
//   - the callback's decision travels in the flow record (the poll never derives it again);
//   - the `choice.complete` audit row says "(device code)".

import { describe, expect, it } from "vitest";
import {
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../src/core/singleUse.js";
import {
  deviceFlowKey,
  flowKey,
} from "../../../src/services/identity/productOidc/config.js";
import { noteErased } from "../../../src/core/accounts/erasureFence.js";
import type { Env } from "../../../src/platform/env.js";
import { LedgerBucket } from "../../eraseRestore.js";
import { asR2 } from "../../r2Mock.js";
import { type World } from "../../transcripts/recorder.js";
import { DEVICE, T0 } from "../../transcripts/client.js";
import {
  activated,
  pinned,
  PRODUCT,
  seedLicense,
} from "../../transcripts/world.js";
import {
  CHOICE,
  noGrantWorld,
  pollDevice,
  signedIn as shared,
  VERIFIED,
} from "../../transcripts/appMode.js";
import {
  identityWorld,
  platformIdentityWorld,
  PLAYER,
  postJson,
  type Started,
} from "../../transcripts/scenarios/identity.js";

type Mail = { to: string; subject: string; text: string };

/** Capture every mail the Worker sends. */
function mailbox(w: World): Mail[] {
  const sent: Mail[] = [];
  w.env.EMAIL = {
    send: async (m: Mail) => {
      sent.push(m);
    },
  } as unknown as Env["EMAIL"];
  return sent;
}

const call = postJson;

const asDevice = { "x-pkey-device": DEVICE };

const signedIn = (w: World, extra?: Record<string, unknown>) =>
  shared(w, extra, "Living room TV");

const poll = pollDevice;

async function choose(
  w: World,
  s: Started,
  now = T0 + 5,
): Promise<{ grant: string }> {
  const body = (await (await poll(w, s, now)).json()) as {
    status: string;
    grant: string;
  };
  expect(body.status).toBe("choose");
  return body;
}

const complete = (w: World, grant: string, choice: unknown, headers = {}) =>
  call(
    w,
    T0 + 8,
    `${CHOICE}/complete`,
    { grant, choice },
    { ...asDevice, ...headers },
  );

const notices = (sent: Mail[]): Mail[] =>
  sent.filter((m) => / signed in on /.test(m.subject));

describe("the approval page in app mode (R1-07)", () => {
  it("says the device is signed in to the person's account and names the app", () =>
    pinned("uk-42-22f-page", async () => {
      const w = await platformIdentityWorld();
      const { page } = await signedIn(w);
      expect(page).toContain(
        "will be signed in to your Polaris Locker account for",
      );
      expect(page).toContain("djdl");
    }));

  it("keeps the licence-only wording in card mode", () =>
    pinned("uk-42-22f-page", async () => {
      const w = await platformIdentityWorld();
      const { page } = await signedIn(w, { licenseChoice: "card" });
      expect(page).not.toContain("will be signed in to your Polaris Locker");
    }));
});

describe("the new-device security notice on an app-mode device-code bind (R1-07)", () => {
  it("is sent when the poll binds the device itself, to every verified address", () =>
    pinned("uk-42-22f-notice", async () => {
      const w = await platformIdentityWorld();
      const sent = mailbox(w);
      const { started } = await signedIn(w);
      expect(notices(sent)).toHaveLength(0);
      const res = await poll(w, started, T0 + 5);
      expect(((await res.json()) as { status: string }).status).toBe("ready");
      const got = notices(sent);
      expect(got.length).toBeGreaterThan(0);
      expect(got.map((m) => m.to)).toContain(VERIFIED.email);
      for (const m of got) {
        expect(m.subject).toBe("djdl signed in on Living room TV");
        expect(m.text).toContain("Sign out everywhere");
        expect(m.text).toContain("account/sessions");
      }
    }));

  it("is sent when choice/complete binds over a device grant", () =>
    pinned("uk-42-22f-notice", async () => {
      const w = await noGrantWorld();
      const sent = mailbox(w);
      const { key } = await seedLicense(w);
      const { started } = await signedIn(w);
      const { grant } = await choose(w, started);
      expect(notices(sent)).toHaveLength(0);
      const res = await complete(w, grant, { kind: "key", key });
      expect(res.status).toBe(200);
      const got = notices(sent);
      expect(got.map((m) => m.to)).toContain(VERIFIED.email);
      expect(got[0]!.text).toContain("Sign out everywhere");
      // The audit row tells a device-code completion from a redirect one.
      const audit = await w.db.first<{ summary: string }>(
        "SELECT summary FROM audit WHERE product = ? AND action = 'signin.choice.complete'",
        PRODUCT,
      );
      expect(audit?.summary).toBe(
        "Chose a license in the app (key) (device code)",
      );
    }));

  it("is not sent in card mode, which binds the identity's own licence as before", () =>
    pinned("uk-42-22f-notice", async () => {
      const w = await platformIdentityWorld();
      const sent = mailbox(w);
      const { started } = await signedIn(w, { licenseChoice: "card" });
      const res = await poll(w, started, T0 + 5);
      expect(((await res.json()) as { status: string }).status).toBe("ready");
      expect(notices(sent)).toHaveLength(0);
    }));
});

describe("a device grant (§12.5.1 rule 5)", () => {
  it("refuses replaceDeviceId with 409, burns nothing, and the view withholds Replace", () =>
    pinned("uk-42-22f-grant", async () => {
      const w = await noGrantWorld();
      const { started } = await signedIn(w);
      const { grant } = await choose(w, started);
      const res = await complete(w, grant, {
        kind: "license",
        licenseId: "lic_any",
        replaceDeviceId: "some-device",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; view?: { choices: { replace: unknown }[] } };
      };
      expect(body.error.code).toBe("license_choice_required");
      for (const c of body.error.view?.choices ?? [])
        expect(c.replace).toBeNull();
      // Nothing was bound, and the grant is still good.
      const bound = await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND device_id = ?",
        PRODUCT,
        DEVICE,
      );
      expect(bound?.n).toBe(0);
      const view = await call(
        w,
        T0 + 9,
        `${CHOICE}/licenses`,
        { grant },
        asDevice,
      );
      expect(view.status).toBe(200);
    }));

  it("binds a licence key the person enters, as the account's subject", () =>
    pinned("uk-42-22f-grant", async () => {
      const w = await noGrantWorld();
      const { key, licenseId } = await seedLicense(w);
      const { started } = await signedIn(w);
      const { grant } = await choose(w, started);
      const res = await complete(w, grant, { kind: "key", key });
      expect(res.status).toBe(200);
      const out = (await res.json()) as {
        subject: string;
        license: { id: string };
      };
      expect(out.license.id).toBe(licenseId);
      const seat = await w.db.first<{ license_id: string; subject: string }>(
        "SELECT license_id, subject FROM devices WHERE product = ? AND device_id = ?",
        PRODUCT,
        DEVICE,
      );
      expect(seat).toEqual({ license_id: licenseId, subject: out.subject });
    }));

  it("keeps the licence the device already holds, with its own token", () =>
    pinned("uk-42-22f-grant", async () => {
      const w = await noGrantWorld();
      const { key, licenseId } = await seedLicense(w);
      const token = await activated(w, key);
      const { started } = await signedIn(w);
      const { grant } = await choose(w, started);
      // Without the device's token there is nothing to keep.
      const bare = await complete(w, grant, { kind: "keep" });
      expect(bare.status).not.toBe(200);
      const res = await complete(
        w,
        grant,
        { kind: "keep" },
        { authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(200);
      const out = (await res.json()) as { license: { id: string } };
      expect(out.license.id).toBe(licenseId);
    }));
});

describe("an account that cannot sign in at the poll binds nothing", () => {
  const nothingBound = async (w: World, sent: Mail[]) => {
    const seat = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND device_id = ?",
      PRODUCT,
      DEVICE,
    );
    expect(seat?.n).toBe(0);
    expect(notices(sent)).toHaveLength(0);
  };

  it("a disabled account", () =>
    pinned("uk-42-22f-disabled", async () => {
      const w = await platformIdentityWorld();
      const sent = mailbox(w);
      const { started } = await signedIn(w);
      await w.db.run("UPDATE accounts SET status = 'disabled'");
      const res = await poll(w, started, T0 + 5);
      expect(await res.json()).toEqual({ status: "error" });
      await nothingBound(w, sent);
    }));

  it("an erased account", () =>
    pinned("uk-42-22f-erased", async () => {
      const w = await platformIdentityWorld();
      w.env.BLOBS = asR2(new LedgerBucket());
      const sent = mailbox(w);
      const { started } = await signedIn(w);
      const acct = await w.db.first<{ id: string }>(
        "SELECT id FROM accounts LIMIT 1",
      );
      noteErased(w.env, acct!.id);
      const res = await poll(w, started, T0 + 5);
      expect(await res.json()).toEqual({ status: "error" });
      await nothingBound(w, sent);
    }));
});

describe("the callback's decision travels in the flow record", () => {
  it("a flow the callback did not settle for an account is card mode at the poll", () =>
    pinned("uk-42-22f-record", async () => {
      // A custom IdP names no account: the callback stores none, and the poll does not derive one.
      const w = await identityWorld();
      const { started } = await signedIn(w);
      const res = await poll(w, started, T0 + 5);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ready");
    }));

  it("stores the account the callback settled for, and the poll settles for that one", () =>
    pinned("uk-42-22f-record", async () => {
      const w = await platformIdentityWorld();
      const { started } = await signedIn(w);
      const { stateKey, flow } = await flowOf(w, started);
      const account = await w.db.first<{ id: string }>(
        "SELECT id FROM accounts LIMIT 1",
      );
      expect(flow.appAccount).toBe(account!.id);
      // Take it away: the poll does not derive the account again, so the flow is card mode now
      // (the identity's own licence, not the account's).
      delete flow.appAccount;
      await putArtefact(w.env, stateKey, JSON.stringify(flow), 600);
      const body = (await (await poll(w, started, T0 + 5)).json()) as {
        status: string;
      };
      expect(body.status).toBe("ready");
      const lic = await w.db.all<{ sub: string | null }>(
        "SELECT sub FROM licenses WHERE product = ?",
        PRODUCT,
      );
      expect(lic).toEqual([{ sub: PLAYER.sub }]);
    }));
});

/** The flow record behind a started device flow. */
async function flowOf(
  w: World,
  started: Started,
): Promise<{ stateKey: ArtefactRef; flow: Record<string, unknown> }> {
  const dev = JSON.parse(
    (await getArtefact(
      w.env,
      await deviceFlowKey(w.env, PRODUCT, started.deviceCode),
    ))!,
  ) as { state: string };
  const stateKey = await flowKey(w.env, PRODUCT, dev.state);
  return {
    stateKey,
    flow: JSON.parse((await getArtefact(w.env, stateKey))!) as Record<
      string,
      unknown
    >,
  };
}
