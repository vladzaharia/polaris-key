/// <reference types="@cloudflare/workers-types" />

import { activateFromIdentity } from "./activate.js";
import { hashKey, randomId } from "../../../platform/crypto.js";
import { type Env } from "../../../platform/env.js";
import { customerOrigin } from "../../../core/hosts.js";
import { brandedHtmlSecurityHeaders } from "../../../core/securityHeaders.js";
import { randomToken } from "../../../platform/random.js";
import { parseFlowRecord } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import {
  note,
  renderBrandPage,
  type AppFacts,
} from "../../../core/brandHtml.js";
import { errorResponse, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import { appendAudit } from "../../../core/audit.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import {
  binderClearCookie,
  chooserBody,
  choiceAccountStillLinked,
  legacyChoiceAccount,
  legacyLicenseChoices,
  readBinder,
  replaceConfirmBody,
  type ChoiceNotice,
  type LegacyChoiceRow,
  type LegacyChoiceView,
} from "../licenseChoice.js";
import { freeAccountDevice } from "../portal/freeDevice.js";
import { noticeOrigin } from "../accounts/libraryNotice.js";
import { attachClaimedLicenses } from "../accounts/platformMigration.js";
import {
  artefactRef,
  deleteArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { readBodyText } from "../../../core/cappedBody.js";
import { completeBrowserFlow } from "./callback.js";
import {
  approvalFacts,
  deniedPage,
  lostDenyPage,
  deviceDonePage,
  denyChosenDeviceFlow,
} from "./deviceApproval.js";
import {
  CHOICE_FIELDS,
  FLOW_TTL_SECONDS,
  type FlowRecord,
  type ResolvedOidcConfig,
  flowKey,
  isDeviceCodeFlow,
  rateLimited,
} from "./config.js";
import {
  type OidcIdentity,
  identityTier,
} from "../../../core/licensing/issue.js";
import { sameOriginDecisionPost } from "./deviceFlow.js";
import { hostOrigin } from "../../../core/hosts.js";
import { redirectToApprove } from "./deviceApproval.js";
import { decodeReplacePick, isReplaceGroup } from "../licenseChoice.js";
import { flowView, listingDeveloper } from "./pages.js";
import { appForPage, pageApp } from "../../../core/brandPage.js";

export { CHOICE_FIELDS };

/** Single-use store address of the chooser index: the binder's (peppered) hash → `state`. */
export function choiceKey(product: string, binderHash: string): ArtefactRef {
  return artefactRef("oidc-choice", `${product}:${binderHash}`);
}

export function choosePath(req: Request, product: Product): string {
  return `${new URL(req.url).origin}/${product.slug}/identity/auth/choose`;
}

/** A branded chooser-family page: no caching, no Referer, optional cookies. */
export function choicePage(
  status: number,
  opts: {
    title: string;
    heading: string;
    body: string;
    passport?: AppFacts;
    variant?: "tv";
  },
  cookies: string[] = [],
  imgOrigin: string | null = null,
): Response {
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    }),
    { imgOrigin },
  );
  for (const c of cookies) headers.append("set-cookie", c);
  // No surface label or eyebrow on sign-in pages (SIGN-IN.md §3.13, D-32).
  return new Response(renderBrandPage(opts), {
    status,
    headers,
  });
}

/** The one answer for a browser the chooser does not belong to, whatever the reason: no binder,
 *  a different binder, an expired or finished flow. Generic, and nothing is minted. */
export function startAgainPage(): Response {
  return choicePage(403, {
    title: "This page has expired",
    heading: "This page has expired",
    body: `<p class="muted">This page is no longer active. If your device still asks, start again there.</p>`,
  });
}

export function redirectToChooser(req: Request, product: Product): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: choosePath(req, product),
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/**
 * The callback's hand-off to the chooser, or `null` when the trigger does not hold (the sign-in
 * then continues exactly as before). With the trigger, nothing is minted: the browser must carry
 * the binder this flow stored, or the flow is dropped and the answer is "Start again"; with it,
 * the flow is marked open (the poll waits) and the browser is sent to the chooser.
 */
export async function beginLicenseChoice(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  oidc: ResolvedOidcConfig,
  state: string,
  stateKey: ArtefactRef,
  flow: FlowRecord,
  identity: OidcIdentity,
  now: number,
): Promise<Response | null> {
  const accountId = await legacyChoiceAccount(
    db,
    product.slug,
    oidc.row.provider,
    oidc.issuer,
    identity.sub,
    now,
  );
  if (!accountId) return null;
  const binder = readBinder(req);
  const binderHash = binder ? await hashKey(binder, env.KEY_HASH_PEPPER) : null;
  // Delegated decision 13: never fall back to minting. A forwarded authorize URL (R1-07) lands
  // in a browser without the binder, and must not bind the victim's licence to anybody's device.
  if (!flow.binder || !binderHash || binderHash !== flow.binder) {
    await deleteArtefact(env, stateKey);
    return startAgainPage();
  }
  await putArtefact(
    env,
    choiceKey(product.slug, binderHash),
    state,
    FLOW_TTL_SECONDS,
  );
  const opened = await updateArtefact(env, stateKey, {
    set: {
      choiceOpen: true,
      choiceAccount: accountId,
      ...(isDeviceCodeFlow(flow) ? { identity } : { choiceIdentity: identity }),
    },
  });
  if (!opened.ok) return startAgainPage();
  // A device flow with a customer host: the chooser is the explicit step, so it opens only for
  // the browser that holds C. The person goes through the customer host first, which checks C
  // and then sends them here (R2-B1).
  if (isDeviceCodeFlow(flow) && hostOrigin("customer", env) !== null)
    return redirectToApprove(req, env, product);
  return redirectToChooser(req, product);
}

export interface ChooserContext {
  stateKey: ArtefactRef;
  indexKey: ArtefactRef;
  flow: FlowRecord;
  accountId: string;
  identity: OidcIdentity;
  deviceLabel: string;
}

/** Drop the flow and its index, and answer "Start again": nothing is minted. */
export async function endChooser(
  env: Env,
  c: ChooserContext,
): Promise<Response> {
  await deleteArtefact(env, c.stateKey);
  await deleteArtefact(env, c.indexKey);
  return startAgainPage();
}

export async function chooserView(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  c: ChooserContext,
  now: number,
  hooks: ServiceHooks | undefined,
): Promise<LegacyChoiceView | null> {
  // The account may have been disabled, deleted or unlinked since the callback: the chooser then
  // ends rather than offering that account's licences or its Replace.
  if (!(await choiceAccountStillLinked(db, c.accountId, c.identity.sub)))
    return null;
  const grant = await identityTier(db, product, c.identity, now);
  return legacyLicenseChoices(db, product, {
    accountId: c.accountId,
    sub: c.identity.sub,
    deviceId: c.flow.deviceId ?? null,
    grantTierId: "error" in grant ? undefined : grant.tierId,
    hooks,
    origin: customerOrigin(env, req) ?? new URL(req.url).origin,
    deviceLabel: c.deviceLabel,
    now,
  });
}

/**
 * `GET`/`POST /<product>/identity/auth/choose`: the licence chooser of a legacy sign-in (I-26).
 *
 *   - `GET` renders the chooser (or the Replace confirmation) with a fresh single-use token.
 *   - `POST` (same origin, the token, the binder) records one step and redirects back, or, on
 *     **Use this licence** / **Replace and continue**, records the choice and completes the
 *     flow: the device-code poll then mints on the chosen licence; a `returnTo` flow gets its
 *     browser session; the identity's own licence, or **Create a new free licence**, runs
 *     `activateFromIdentity` exactly as the sign-in did before.
 */
export async function handleAuthChoose(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  hooks?: ServiceHooks,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const limited = await rateLimited(env, product, now, {
    bucket: "authChoose",
    id: clientNetwork(req),
    limit: 60,
    windowSec: 60,
  });
  if (limited) return limited;
  if (req.method === "POST" && !sameOriginDecisionPost(req))
    return startAgainPage();

  const binder = readBinder(req);
  if (!binder) return startAgainPage();
  const binderHash = await hashKey(binder, env.KEY_HASH_PEPPER);
  const indexKey = choiceKey(product.slug, binderHash);
  const state = await getArtefact(env, indexKey);
  if (!state) return startAgainPage();
  const stateKey = await flowKey(env, product.slug, state);
  const raw = await getArtefact(env, stateKey);
  const flow = raw ? parseFlowRecord<FlowRecord>(raw) : null;
  const identity =
    flow && isDeviceCodeFlow(flow) ? flow.identity : flow?.choiceIdentity;
  if (
    !flow ||
    !flow.choiceOpen ||
    !flow.choiceAccount ||
    flow.binder !== binderHash ||
    !identity
  ) {
    await deleteArtefact(env, indexKey);
    return startAgainPage();
  }
  // With a customer host a device flow's chooser opens only after C was shown there. Nothing is
  // dropped: the person's own path (the customer page) still finds the flow.
  if (
    isDeviceCodeFlow(flow) &&
    hostOrigin("customer", env) !== null &&
    flow.customerOk !== true
  )
    return startAgainPage();
  const c: ChooserContext = {
    stateKey,
    indexKey,
    flow,
    accountId: flow.choiceAccount,
    identity,
    deviceLabel: isDeviceCodeFlow(flow)
      ? flow.deviceName || "Unnamed device"
      : "This browser",
  };

  if (req.method === "GET")
    return renderChooser(req, env, db, product, c, now, hooks);

  const form = new URLSearchParams(await readBodyText(req).catch(() => ""));
  const token = form.get("choice") ?? "";
  // Spend the page's token (single-use): a second submit of the same page, or a page rendered
  // before another tab's, goes back to a fresh render and changes nothing.
  const spent = token
    ? await updateArtefact(env, stateKey, {
        expect: {
          choiceOpen: true,
          choiceToken: await hashKey(token, env.KEY_HASH_PEPPER),
        },
        unset: ["choiceToken"],
      })
    : { ok: false };
  if (!spent.ok) return redirectToChooser(req, product);

  const action = form.get("action") ?? "";
  const notice = async (n: ChoiceNotice): Promise<Response> => {
    await updateArtefact(env, stateKey, {
      set: { choiceNotice: n },
      unset: ["choiceReplace"],
    });
    return redirectToChooser(req, product);
  };

  if (action === "cancel") {
    // For a device-code flow Cancel is Deny (I-37): the device's poll answers `error`, and the
    // ending is the one "denied" page. A browser flow is simply dropped.
    if (isDeviceCodeFlow(flow)) {
      const denied = await denyChosenDeviceFlow(
        env,
        db,
        product,
        stateKey,
        flow,
        now,
      );
      await deleteArtefact(env, indexKey);
      const cancelView = await flowView(env, db, product, flow);
      if (!denied)
        return lostDenyPage(env, stateKey, flow, cancelView, [
          binderClearCookie(),
        ]);
      return deniedPage(flow, cancelView, [binderClearCookie()]);
    }
    await deleteArtefact(env, stateKey);
    await deleteArtefact(env, indexKey);
    return choicePage(
      200,
      {
        ...(flow.tv ? { variant: "tv" as const } : {}),
        title: "Sign-in canceled",
        heading: "Sign-in canceled",
        body: `<p class="muted">Nothing was changed. You can close this tab.</p>`,
      },
      [binderClearCookie()],
    );
  }
  if (action === "back") {
    await updateArtefact(env, stateKey, { unset: ["choiceReplace"] });
    return redirectToChooser(req, product);
  }

  const view = await chooserView(req, env, db, product, c, now, hooks);
  if (!view) return endChooser(env, c);

  if (action.startsWith("replace:")) {
    const licenseId = action.slice("replace:".length);
    const deviceId = form.get(`device:${licenseId}`) ?? "";
    const row = view.rows.find((r) => r.id === licenseId);
    if (!row?.replace?.some((d) => d.id === deviceId))
      return notice({ kind: "unavailable" });
    await updateArtefact(env, stateKey, {
      set: { choiceReplace: { licenseId, deviceId } },
    });
    return redirectToChooser(req, product);
  }

  if (action === "replace" || action === "replace-pick") {
    let pending = flow.choiceReplace;
    if (action === "replace-pick") {
      // The all-full group: one press picks the device and replaces it (no second step).
      const raw = form.get("replaceDevice") ?? "";
      if (!raw) return notice({ kind: "pick_device" });
      const ids = decodeReplacePick(raw);
      if (!ids) return notice({ kind: "unavailable" });
      const { licenseId, deviceId } = ids;
      const picked = view.rows.find((r) => r.id === licenseId);
      if (!picked?.replace?.some((d) => d.id === deviceId))
        return notice({ kind: "unavailable" });
      pending = { licenseId, deviceId };
    }
    if (!pending) return redirectToChooser(req, product);
    const row = view.rows.find((r) => r.id === pending.licenseId);
    if (!row) return notice({ kind: "unavailable" });
    if (row.state !== "free") {
      if (!row.replace?.some((d) => d.id === pending.deviceId))
        return notice({ kind: "unavailable" });
      // The portal's Remove, exactly (`freeAccountDevice`): ownership, the shared rate-limit
      // budget, the audit row and the security email.
      const freed = await freeAccountDevice(
        req,
        env,
        db,
        { accountId: c.accountId, email: identity.email ?? null },
        product.slug,
        pending.licenseId,
        pending.deviceId,
        now,
        { forLabel: c.deviceLabel },
      );
      if (!freed.ok) {
        return notice(
          freed.reason === "rate_limited"
            ? { kind: "rate_limited", retryAfter: freed.retryAfter }
            : { kind: "unavailable" },
        );
      }
      // Re-read: someone may have taken the freed seat in between (a race). The freed device
      // stays freed (audited and emailed), and the person chooses again.
      const after = await chooserView(req, env, db, product, c, now, hooks);
      if (!after) return endChooser(env, c);
      const fresh = after.rows.find((r) => r.id === pending.licenseId);
      if (fresh?.state !== "free") return notice({ kind: "unavailable" });
      return completeChoice(
        req,
        env,
        db,
        product,
        c,
        fresh,
        now,
        row.replace?.find((d) => d.id === pending.deviceId)?.label,
      );
    }
    return completeChoice(req, env, db, product, c, row, now);
  }

  if (action === "use") {
    const picked = form.get("license") ?? "";
    if (picked === "create" && view.create)
      return completeChoice(req, env, db, product, c, "create", now);
    const row = view.rows.find((r) => r.id === picked);
    if (row?.state !== "free") return notice({ kind: "unavailable" });
    return completeChoice(req, env, db, product, c, row, now);
  }
  return redirectToChooser(req, product);
}

export async function renderChooser(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  c: ChooserContext,
  now: number,
  hooks: ServiceHooks | undefined,
): Promise<Response> {
  const view = await chooserView(req, env, db, product, c, now, hooks);
  if (!view) return endChooser(env, c);
  const token = randomToken(24);
  const minted = await updateArtefact(env, c.stateKey, {
    expect: { choiceOpen: true },
    set: { choiceToken: await hashKey(token, env.KEY_HASH_PEPPER) },
    unset: ["choiceNotice"],
  });
  if (!minted.ok) return startAgainPage();
  const action = choosePath(req, product);
  // The app's strip on every step of the chooser (identity.refusals): who is asking, and where.
  const developer = await listingDeveloper(hooks);
  const shown = pageApp(
    await appForPage({ product, env, db, hooks }).catch(() => ({
      name: product.name,
    })),
  );
  const passport = {
    name: product.name,
    iconUrl: shown.app.iconUrl,
    artUrl: shown.app.artUrl ?? null,
    action: "wants you to sign in",
    developer: developer ?? null,
    device: isDeviceCodeFlow(c.flow) ? c.deviceLabel : "this browser",
  };
  const tvOpt = c.flow.tv ? { variant: "tv" as const } : {};
  const pending = c.flow.choiceReplace;
  if (pending) {
    const row = view.rows.find((r) => r.id === pending.licenseId);
    const device = row?.replace?.find((d) => d.id === pending.deviceId);
    if (row && device) {
      return choicePage(
        200,
        {
          passport,
          title: `Replace ${device.label}?`,
          heading: `Replace ${device.label}?`, // signin.replace.title
          body: replaceConfirmBody({
            action,
            token,
            device: device.label,
            productName: product.name,
            thisDevice: isDeviceCodeFlow(c.flow)
              ? c.deviceLabel
              : "this browser",
            activeNow: device.activeNow,
          }),
        },
        [],
        shown.imgOrigin,
      );
    }
    await updateArtefact(env, c.stateKey, { unset: ["choiceReplace"] });
  }
  // I-37: a device-code chooser says how to stop a sign-in the person did not start.
  const cancelNote = isDeviceCodeFlow(c.flow)
    ? note("info", "Didn't start this yourself? Cancel it.") // signin.device.cancel
    : "";
  // No eyebrow (SIGN-IN.md §3.13, D-32): the lede names the product.
  return choicePage(
    200,
    {
      passport,
      ...tvOpt,
      title: isReplaceGroup(view)
        ? "Replace a device"
        : "Choose a license for this device",
      // signin.replace.open when the page is the replace group, else signin.choice.title
      heading: isReplaceGroup(view)
        ? "Replace a device"
        : "Choose a license for this device",
      // I-37: a choice on a device-code flow IS the approval, so it shows the same facts first.
      body:
        (isDeviceCodeFlow(c.flow) ? approvalFacts(req, c.flow, now) : "") +
        chooserBody({
          productName: product.name,
          deviceLabel: c.deviceLabel,
          action,
          token,
          view,
          notice: c.flow.choiceNotice ?? null,
          now,
          namedByDevice: Boolean(isDeviceCodeFlow(c.flow)),
          developerName: developer,
          ...(isDeviceCodeFlow(c.flow)
            ? {
                primaryLabel:
                  view.preselected === "create"
                    ? `Create a license on ${c.deviceLabel}`
                    : `Use this license on ${c.deviceLabel}`,
              }
            : {}),
        }) +
        cancelNote,
    },
    [],
    shown.imgOrigin,
  );
}

export { listingDeveloper } from "./pages.js";

/** Record the person's choice and complete the flow (see `handleAuthChoose`). */
export async function completeChoice(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  c: ChooserContext,
  choice: LegacyChoiceRow | "create",
  now: number,
  /** After a Replace: the device that was signed out (the done page names both). */
  replaced?: string,
): Promise<Response> {
  const { flow, identity } = c;
  const view = await flowView(env, db, product, flow);
  // Through the identity's own activation: a new licence, or the identity's own `sub`-keyed one
  // (the deferred P1-07 activation, attach opt-in included, stays as it is today).
  const activate = choice === "create" || choice.own;
  // The audit row is written only once the choice is actually recorded on the flow.
  const audit = () =>
    appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: identity.sub,
      actor_name: identity.name ?? null,
      actor_email: identity.email ?? null,
      action: "identity.signin.license_chosen",
      target_kind: "license",
      target_id: choice === "create" ? null : choice.id,
      parent_id: null,
      summary:
        choice === "create"
          ? `Chose a new free license to sign in ${c.deviceLabel}`
          : `Chose this license to sign in ${c.deviceLabel}`,
    });
  await deleteArtefact(env, c.indexKey);
  const cookies = [binderClearCookie()];

  if (isDeviceCodeFlow(flow)) {
    // The device-code poll completes it: on the chosen licence (`authorizeAndMint`, seat-checked),
    // or through the deferred activation when `licenseId` stays unset.
    // I-37: the licence choice IS the explicit step, so it sets `approvedAt` in the same
    // compare-and-set that records it. A denied or already approved flow takes no choice.
    const done = await updateArtefact(env, c.stateKey, {
      expect: { approvedAt: null, error: null },
      set: {
        approvedAt: now,
        ...(activate ? {} : { licenseId: (choice as LegacyChoiceRow).id }),
      },
      unset: CHOICE_FIELDS,
    });
    if (!done.ok) return startAgainPage();
    await audit();
    return deviceDonePage(
      c.deviceLabel,
      view,
      cookies,
      replaced,
      flow.identity,
    );
  }

  let licenseId: string;
  if (activate) {
    const result = await activateFromIdentity(db, product, identity, now, {
      env,
    });
    if ("error" in result) {
      await deleteArtefact(env, c.stateKey);
      return errorResponse(403, "forbidden", "not entitled");
    }
    licenseId = result.licenseId;
    // I-17: a licence this choice minted joins the account the callback's claim signed in to.
    if (flow.claimAccount)
      await attachClaimedLicenses(
        env,
        db,
        flow.claimAccount,
        now,
        noticeOrigin(env, req),
      );
  } else {
    licenseId = (choice as LegacyChoiceRow).id;
  }
  const done = await updateArtefact(env, c.stateKey, { unset: CHOICE_FIELDS });
  if (!done.ok) return startAgainPage();
  await audit();
  return completeBrowserFlow(
    req,
    env,
    db,
    product,
    c.stateKey,
    flow,
    licenseId,
    identity.sub,
    now,
    cookies,
  );
}
