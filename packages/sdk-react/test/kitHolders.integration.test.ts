// @pkey-feature ui.kit.holders
//
// UK-42.11: ui-core's AddToAccountModel (the state machine behind <AddToAccount>) driven over the
// Worker's recording of the same conversation, `holders-add-to-account.json`: key activation, the
// sign-in with the hints and `license_choice=app`, `choice/complete {kind:"keep"}` with the device
// token, then the attach (preview and confirm). The driver is the one the gates build over the
// SDK: `signIn(hints)` starts the redirect on the browser engine and plays the recorded browser
// steps, `complete` is the engine's `choiceComplete`, `attach` is its `attach`. The replay server
// refuses any request the recording does not hold, so the model reaching `added` proves the wire.

import { describe, expect, it } from "vitest";
import {
  AddToAccountModel,
  type AddToAccountDriver,
  type SignInWait,
} from "@polaris-key/ui-core";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";

import { BearerSession } from "../src/browser/bearer/session.js";
import { servicesFromList } from "../src/core/services.js";
import {
  ReplayServer,
  loadTranscripts,
  type Step,
  type Transcript,
} from "../../../conformance/runners/node/transcriptReplay.js";

const ID = "holders-add-to-account";
const FINGERPRINT = {
  components: { machineUuid: "REPLAYmachineUuid00000" },
  hwid: "REPLAYhwid0000000000000000000000",
};
const ENTROPY = {
  state: "tidewater-state-0123456789",
  codeVerifier: "transcript-verifier-0123456789-abcdefghijklmnopqrst",
};

/** The store the replay starts from: the transcript's device id, no token, nothing cached. */
function memoryStore(deviceId: string): Store & { token: string | null } {
  const held: { token: string | null; cache: CacheRecordV3 | null } = {
    token: null,
    cache: null,
  };
  return {
    get token() {
      return held.token;
    },
    getToken: async () => held.token,
    setToken: async (t: string) => void (held.token = t),
    clearToken: async () => void (held.token = null),
    getDeviceId: async () => deviceId,
    readCache: async () => held.cache,
    writeCache: async (rec: CacheRecordV3) => void (held.cache = rec),
    clearCache: async () => void (held.cache = null),
  };
}

const str = (step: Step, name: string): string => String(step.args[name] ?? "");

/** The model over the recording: each driver call plays the recorded steps it stands for. */
function setup(t: Transcript) {
  const server = new ReplayServer(t);
  const store = memoryStore(t.initial.deviceId);
  const base = `${t.baseUrl}/${t.product}`;
  const session = new BearerSession({
    baseUrl: t.baseUrl,
    product: t.product,
    version: t.initial.version,
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
      server.fetch(input, init)) as typeof fetch,
    now: () => clock,
    pinned: t.trust,
    store,
    enabled: (slug) =>
      servicesFromList(["license", "config", "identity"])[slug].enabled,
    fingerprint: () => FINGERPRINT,
    deviceName: "",
    redirectEndpoints: () => ({
      authorizeEndpoint: `${base}/identity/authorize`,
      tokenEndpoint: `${base}/identity/token`,
      issuer: `${base}/identity`,
      choiceAvailable: true,
    }),
    redirectEntropy: () => ENTROPY,
    choiceEndpoints: () => ({
      choiceLicenses: `${base}/identity/choice/licenses`,
      choiceDevices: `${base}/identity/choice/devices`,
      choiceComplete: `${base}/identity/choice/complete`,
      choiceCancel: `${base}/identity/choice/cancel`,
    }),
    identityEndpoints: () => ({
      subject: `${base}/identity/subject`,
      signout: `${base}/identity/signout`,
      attach: `${base}/identity/attach`,
    }),
  });
  // The sign-in's acquisition sync is pinned by the sync transcripts, not by this recording.
  (
    session as unknown as { syncAfterSignIn: () => Promise<void> }
  ).syncAfterSignIn = async () => undefined;
  let clock = t.now;
  let next = 0;
  const log: string[] = [];

  /** Play the recorded step that must come next, and close it (every request it holds served). */
  const play = async <T>(
    action: string,
    run: (step: Step) => Promise<T>,
  ): Promise<T> => {
    const step = server.beginStep(next);
    expect(step.action).toBe(action);
    next += 1;
    clock = step.now ?? t.now;
    log.push(action);
    const out = await run(step);
    server.endStep();
    return out;
  };

  const driver: AddToAccountDriver = {
    signIn: async (hints) => {
      let callback = "";
      const pending = await session.startRedirect({
        redirectUri: "https://app.example/auth/callback",
        licenseChoice: "app",
        loginHint: hints.loginHint,
        nameHint: hints.nameHint,
        purpose: hints.purpose,
      });
      // The browser: authorize, then the card's Continue, exactly the recorded requests.
      await play("browser", async (step) => {
        const built = new URL(pending.authorizeUrl);
        let last: Response | null = null;
        for (const item of step.exchanges.items) {
          const isAuthorize = item.request.path.includes("/identity/authorize");
          const path = isAuthorize
            ? built.pathname + built.search
            : item.request.path;
          last = await server.fetch(`${t.baseUrl}${path}`, {
            method: item.request.method,
            redirect: "manual",
          });
        }
        callback = ((await last!.json()) as { redirect: string }).redirect;
      });
      return {
        wait: async (): Promise<SignInWait> =>
          play("redirectComplete", async () => {
            const done = await session.redeemRedirect(pending, callback);
            if (done.kind !== "choose")
              throw new Error(`expected a grant, got ${done.kind}`);
            return {
              outcome: "choose",
              grant: done.grant,
              choices: done.choices,
            } as unknown as SignInWait;
          }),
        reopen: () => false,
        cancel: () => {},
      };
    },
    complete: (grant, choice) =>
      play("choiceComplete", async () => {
        const r = await session.choiceComplete(grant, choice);
        if (r.kind !== "ok") throw new Error(`choice refused: ${r.code}`);
        return { outcome: "signedIn" as const, issuedNow: false };
      }),
    attach: (confirm = true) =>
      play("attach", async (step) => {
        expect(step.args.confirm).toBe(confirm);
        const r = await session.attach(confirm);
        return r.kind === "refused"
          ? { kind: "refused" as const, code: r.code }
          : { kind: "ok" as const };
      }),
  };

  const activate = (): Promise<void> =>
    play("activate", async (step) => {
      const r = await session.activate(str(step, "key"));
      expect(r.kind).toBe("ok");
      await session.sync();
    });

  return { driver, activate, session, store, log, done: () => next };
}

describe("AddToAccountModel over holders-add-to-account.json", () => {
  const t = loadTranscripts().find((x) => x.id === ID)!;

  it("the recording is tagged with the features it exercises", () => {
    expect(t.features).toEqual([
      "identity.attach",
      "identity.choice",
      "identity.signin.hints",
    ]);
    expect(t.requires).toEqual(["license.activate"]);
  });

  it("the model signs in with the hints, keeps the device's license and attaches it", async () => {
    const w = setup(t);
    await w.activate();
    const model = new AddToAccountModel({ driver: w.driver });
    model.setField("name", "Ada");
    model.setField("email", "ada@example.com");
    await model.submit();

    expect(model.snapshot.step).toBe("added");
    // Every recorded step was played, in order, with nothing left over.
    expect(w.done()).toBe(t.steps.length);
    expect(w.log).toEqual([
      "activate",
      "browser",
      "redirectComplete",
      "choiceComplete",
      "attach",
      "attach",
    ]);
    const kept = t.steps[3]!.expect;
    const claimed = t.steps[5]!.expect;
    expect(claimed.attached).toBe("claimed");
    expect(claimed.subject).toBe(kept.subject);
    expect(kept.licenseId).toBeTruthy();
    // The token the attach rotated is the one the device holds now.
    expect(w.store.token).not.toBeNull();
  });
});
