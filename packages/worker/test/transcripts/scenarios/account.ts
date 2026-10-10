/// <reference types="@cloudflare/workers-types" />
// The account on the device wire (I-09; WIRE-CONTRACT-V4 §12.3, §12.6, plans/I-09.md §4): what an
// SDK sees when the product's Identity service is on.
//
//   discovery-identity         the identity fragment's account members: `account`,
//                              `keyEntryLimit` (the enforced value) and the attach, subject,
//                              signout and accountPortal endpoints.
//   identity-attach            a key-activated device whose person signed in: preview, attach
//                              (the token rotates), and the idempotent repeat.
//   identity-attach-errors     401, account_required, license_owned, license_email_bound, and
//                              404 once Identity is off.
//   identity-subject-signout   a sign-in-bound device signs out and is released (its token
//                              stops); the key is entered again, and a key-bound device signs out
//                              keeping its licence.
//
// The sign-in itself is SEEDED (the account, its verified email and the device binding are rows
// written before the step, as a completed sign-in leaves them): I-08 re-records these with its
// real device-code sign-in. Nothing here changes a signed document.

import { expect } from "vitest";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, discovery, T0, VERSION } from "../client.js";
import { activateAndSync } from "./keyEntry.js";
import {
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  servicesOn,
  type Scenario,
} from "../world.js";
import { setServices } from "../../../src/core/repo.js";
import { serializeServices } from "../../../src/core/services.js";
import { loadProduct } from "../../../src/core/products.js";
import {
  setDeviceSubject,
  subjectFor,
} from "../../../src/core/accounts/accountSubjects.js";
import { bindSignedInDevice } from "../../../src/core/licensing/anchor.js";
import { getOrCreateAccountByEmail } from "../../../src/services/identity/portal/repo.js";

/** The product's services: License, Config and Identity. */
export const IDENTITY_ON = servicesOn("license", "config", "identity");

const ATTACH = ["identity.attach"];
const ACCOUNT = ["identity.account"];

/** An active account with `email` verified, and its pairwise subject for the product. */
export async function seedAccount(
  w: World,
  email: string,
): Promise<{ id: string; subject: string }> {
  const acct = await getOrCreateAccountByEmail(w.db, email, T0);
  await w.db.run(
    "UPDATE accounts SET primary_email = ?, primary_email_verified_at = ? WHERE id = ?",
    email,
    T0,
    acct.id,
  );
  return { id: acct.id, subject: await subjectFor(w.db, acct.id, PRODUCT, T0) };
}

/** Setup: the account signs in on DEVICE (the binding a completed sign-in writes). */
async function signedIn(w: World, subject: string): Promise<void> {
  expect(await setDeviceSubject(w.env, w.db, PRODUCT, DEVICE, subject)).toBe(
    true,
  );
}

/** Setup: put the licence in `accountId` (or take it out with `null`). */
export async function holdLicense(
  w: World,
  licenseId: string,
  accountId: string | null,
): Promise<void> {
  await w.db.run(
    "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
    accountId,
    PRODUCT,
    licenseId,
  );
}

/** `POST /<p>/identity/attach {confirm}` with the device's token. */
function attach(
  s: StepRecorder,
  confirm: boolean,
  capture = false,
): Promise<Response> {
  return s.send({
    method: "POST",
    path: `/${PRODUCT}/identity/attach`,
    bearer: "token",
    body: { confirm },
    expectBody: { json: { confirm }, match: "exact" },
    ...(capture ? { capture: { token: "$.token" } } : {}),
  });
}

function subjectRead(s: StepRecorder): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${PRODUCT}/identity/subject`,
    bearer: "token",
  });
}

function signOut(s: StepRecorder): Promise<Response> {
  return s.send({
    method: "POST",
    path: `/${PRODUCT}/identity/signout`,
    bearer: "token",
  });
}

async function nestedCode(res: Response): Promise<string> {
  return ((await res.clone().json()) as { error: { code: string } }).error.code;
}

export const discoveryIdentity: Scenario = {
  id: "discovery-identity",
  record: () =>
    pinned("discovery-identity", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      await world.db.run(
        `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
         VALUES (?, 'identity.keyEntry.limit', '5', 'manifest', ?, 'resync')`,
        PRODUCT,
        T0,
      );
      const r = new TranscriptRecorder({
        id: "discovery-identity",
        description:
          "Discovery of a product whose Identity service is on (I-09, WIRE-CONTRACT-V4 §12.6). The identity fragment carries account: true, keyEntryLimit (the product's identity.keyEntry.limit as key entry enforces it, here 5) and the attach, subject, signout and accountPortal endpoints beside the sign-in ones. A client uses each account feature only when its endpoint is present and never builds one; a client that predates them ignores them. A product with Identity off keeps its bare {enabled:false} fragment (discovery-capabilities.json).",
        features: ["core.discover", "identity.account"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      await r.step(
        { action: "discover" },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(200);
          const doc = (await res.json()) as {
            services: { identity: Record<string, unknown> };
          };
          expect(doc.services.identity).toMatchObject({
            enabled: true,
            account: true,
            keyEntryLimit: 5,
          });
        },
        {
          result: "ok",
          services: {
            license: true,
            config: true,
            release: false,
            distribution: false,
            update: false,
            identity: true,
            sync: false,
          },
        },
      );
      return r.transcript();
    }),
};

export const identityAttach: Scenario = {
  id: "identity-attach",
  record: () =>
    pinned("identity-attach", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      const { key, licenseId } = await seedLicense(world);
      // The licence's buyer email, verified on the account that signs in: it may join it.
      const ada = await seedAccount(world, "ada@example.com");

      const r = new TranscriptRecorder({
        id: "identity-attach",
        description:
          "Attach (I-09, WIRE-CONTRACT-V4 §12.3). The device activates by key, then the person signs in on it (seeded here: the account, its verified email and the device's sign-in binding; I-08 re-records this with its device-code sign-in). attach({confirm:false}) previews the device's own licence and writes nothing; attach({confirm:true}) adds it to the signed-in account, rotates the device token and answers the activation result with subject and attached: claimed; the licence and its document are unchanged. Repeating it is idempotent: the same answer without attached.",
        features: ATTACH,
        requires: ["license.activate"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });

      await r.step(
        {
          action: "activate",
          args: { key },
          note: "Key activation: a new device on an Identity product (one counted entry).",
        },
        (s) => activateAndSync(s, { used: 1, limit: 10 }),
        {
          result: "ok",
          keyEntries: { used: 1, limit: 10 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await signedIn(world, ada.subject);
      await r.step(
        {
          action: "attach",
          args: { confirm: false },
          now: T0 + 60,
          note: "The person has signed in on the device: the preview names the licence, writes nothing.",
        },
        async (s) => {
          const res = await attach(s, false);
          expect(res.status).toBe(200);
          expect(await res.clone().json()).toEqual({
            status: "confirm",
            license: { id: licenseId, tierId: null, name: "Ada Lovelace" },
          });
        },
        {
          result: "confirm",
          license: { id: licenseId, tierId: null, name: "Ada Lovelace" },
          tokenHeld: true,
        },
      );

      await r.step(
        {
          action: "attach",
          args: { confirm: true },
          now: T0 + 120,
          note: "Confirmed: the licence joins the signed-in account and the token rotates.",
        },
        async (s) => {
          const res = await attach(s, true, true);
          expect(res.status).toBe(200);
          expect(await res.clone().json()).toMatchObject({
            subject: ada.subject,
            attached: "claimed",
            license: { id: licenseId },
          });
        },
        {
          result: "ok",
          attached: "claimed",
          subject: ada.subject,
          tokenHeld: true,
        },
      );

      await r.step(
        {
          action: "attach",
          args: { confirm: true },
          now: T0 + 180,
          note: "Again: already in this account, so the same answer with no attached.",
        },
        async (s) => {
          const res = await attach(s, true, true);
          expect(res.status).toBe(200);
          expect(await res.clone().json()).not.toHaveProperty("attached");
        },
        {
          result: "ok",
          attached: null,
          subject: ada.subject,
          tokenHeld: true,
        },
      );
      const owner = await world.db.first<{ account_id: string }>(
        "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
        PRODUCT,
        licenseId,
      );
      expect(owner?.account_id).toBe(ada.id);
      return r.transcript();
    }),
};

export const identityAttachErrors: Scenario = {
  id: "identity-attach-errors",
  record: () =>
    pinned("identity-attach-errors", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      const { key, licenseId } = await seedLicense(world);
      const other = await seedAccount(world, "other@example.com");
      const someone = await seedAccount(world, "someone@example.com");

      const r = new TranscriptRecorder({
        id: "identity-attach-errors",
        description:
          "Attach refusals (I-09, WIRE-CONTRACT-V4 §12.3), each a nested error the client reports without wiping state. A token that is not the device's answers 401. After a key activation, no account is signed in on the device: account_required. Once one is (seeded), a licence that is in another account answers license_owned, with no link and nothing about that account; a licence with a buyer email the signed-in account has not verified answers license_email_bound. With the product's Identity service off the route does not exist: not_found.",
        features: ATTACH,
        requires: ["license.activate"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          token: `pkeyt_${"x".repeat(43)}`,
        },
      });

      await r.step(
        {
          action: "attach",
          args: { confirm: true },
          note: "A token that is not this device's: 401.",
        },
        async (s) => {
          const res = await attach(s, true);
          expect(res.status).toBe(401);
          expect(await nestedCode(res)).toBe("unauthorized");
        },
        { result: "refused", code: "unauthorized" },
      );

      await r.step(
        { action: "activate", args: { key }, now: T0 + 60 },
        (s) => activateAndSync(s, { used: 1, limit: 10 }),
        {
          result: "ok",
          keyEntries: { used: 1, limit: 10 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await r.step(
        {
          action: "attach",
          args: { confirm: true },
          now: T0 + 120,
          note: "No account is signed in on the device.",
        },
        async (s) => {
          const res = await attach(s, true);
          expect(res.status).toBe(403);
          expect(await nestedCode(res)).toBe("account_required");
        },
        { result: "refused", code: "account_required", tokenHeld: true },
      );

      await signedIn(world, someone.subject);
      await holdLicense(world, licenseId, other.id);
      await r.step(
        {
          action: "attach",
          args: { confirm: true },
          now: T0 + 180,
          note: "Signed in, but the licence is in another account: it never moves.",
        },
        async (s) => {
          const res = await attach(s, true);
          expect(res.status).toBe(403);
          expect(await res.clone().json()).toEqual({
            error: { code: "license_owned" },
          });
        },
        { result: "refused", code: "license_owned", tokenHeld: true },
      );

      await holdLicense(world, licenseId, null);
      await r.step(
        {
          action: "attach",
          args: { confirm: true },
          now: T0 + 240,
          note: "The licence is in no account, but its buyer email is not one this account verified.",
        },
        async (s) => {
          const res = await attach(s, true);
          expect(res.status).toBe(403);
          expect(await nestedCode(res)).toBe("license_email_bound");
        },
        { result: "refused", code: "license_email_bound", tokenHeld: true },
      );

      await setServices(
        world.db,
        PRODUCT,
        serializeServices({ services: servicesOn("license", "config") }),
        "manifest",
        T0,
      );
      await r.step(
        {
          action: "attach",
          args: { confirm: true },
          now: T0 + 300,
          note: "The product's Identity service is off: the route does not exist.",
        },
        async (s) => {
          const res = await attach(s, true);
          expect(res.status).toBe(404);
          expect(await nestedCode(res)).toBe("not_found");
        },
        { result: "refused", code: "not_found", tokenHeld: true },
      );
      return r.transcript();
    }),
};

export const identitySubjectSignout: Scenario = {
  id: "identity-subject-signout",
  record: () =>
    pinned("identity-subject-signout", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      const { key, licenseId } = await seedLicense(world);
      const ada = await seedAccount(world, "ada@example.com");
      await holdLicense(world, licenseId, ada.id);
      // The device signed in and chose Ada's licence: a seat bound by the sign-in.
      const product = (await loadProduct(world.env, world.db, PRODUCT))!;
      const bound = await bindSignedInDevice(world.env, world.db, product, {
        accountId: ada.id,
        subject: ada.subject,
        deviceId: DEVICE,
        choice: { kind: "license", licenseId },
        now: T0,
      });
      if (!bound.ok || !bound.token) throw new Error("setup: sign-in bind");

      const r = new TranscriptRecorder({
        id: "identity-subject-signout",
        description:
          "Subject and sign-out (I-09, WIRE-CONTRACT-V4 §12.3). The device starts signed in, on a seat its sign-in took on the account's licence: subject() is the product's pairwise subject, and signOut() releases that seat (released: true), so the token stops working. The key is then entered on the device (refusals are off, so a licence in an account is still admitted and counted) and the person signs in again on the key-activated device: signOut() now keeps the licence and the token (released: false) and subject() is null.",
        features: ACCOUNT,
        requires: ["license.activate"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION, token: bound.token },
      });

      await r.step(
        {
          action: "subject",
          note: "Signed in: the product's pairwise subject.",
        },
        async (s) => {
          const res = await subjectRead(s);
          expect(res.status).toBe(200);
          expect(await res.clone().json()).toEqual({ subject: ada.subject });
        },
        { subject: ada.subject, tokenHeld: true },
      );

      await r.step(
        {
          action: "signOut",
          now: T0 + 60,
          note: "The sign-in bound the seat: signing out releases it.",
        },
        async (s) => {
          const res = await signOut(s);
          expect(res.status).toBe(200);
          expect(await res.clone().json()).toEqual({ released: true });
        },
        { released: true, licenseStatus: "needs-activation", tokenHeld: false },
      );

      await r.step(
        {
          action: "activate",
          args: { key },
          now: T0 + 120,
          note: "The key on the same device: admitted (refusals off) and counted.",
        },
        (s) => activateAndSync(s, { used: 1, limit: 10 }),
        {
          result: "ok",
          keyEntries: { used: 1, limit: 10 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await signedIn(world, ada.subject);
      await r.step(
        {
          action: "subject",
          now: T0 + 180,
          note: "Signed in again, on the key-activated device.",
        },
        async (s) => {
          const res = await subjectRead(s);
          expect(await res.clone().json()).toEqual({ subject: ada.subject });
        },
        { subject: ada.subject, tokenHeld: true },
      );

      await r.step(
        {
          action: "signOut",
          now: T0 + 240,
          note: "Key-bound: the device keeps its licence and its token.",
        },
        async (s) => {
          const res = await signOut(s);
          expect(await res.clone().json()).toEqual({ released: false });
        },
        { released: false, tokenHeld: true },
      );

      await r.step(
        { action: "subject", now: T0 + 300, note: "Signed out." },
        async (s) => {
          const res = await subjectRead(s);
          expect(await res.clone().json()).toEqual({ subject: null });
        },
        { subject: null, tokenHeld: true },
      );
      return r.transcript();
    }),
};
