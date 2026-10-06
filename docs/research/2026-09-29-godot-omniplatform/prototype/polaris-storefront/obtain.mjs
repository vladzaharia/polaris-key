#!/usr/bin/env node
// Reference eligibility engine for the Polaris Key storefront (notes/S-21 §6.3).
//
// It is a pure model of "can this signed-in person obtain and use this product?". PS-03 ports
// it to the Worker (services/identity/portal/store/obtain.ts). The table in selfTest() is the
// acceptance table for PS-03's unit test; the two must not drift apart.
// Recorded deviation (see the PS-03 brief): the port returns ONE identity path per product,
// because `identityTier` returns one grant, so this model's `[group, auto_issue]` for product
// `x` is `[group]` there.
//
//   node obtain.mjs --self-test
//
// No dependencies, Node 22, writes nothing.

/**
 * @typedef {{ kind: "auto_issue"|"group"|"open"|"store_owned"|"product_idp"|"email_domain",
 *             detail?: string, tier?: string|null, action: "add"|"link" }} ObtainPath
 */

/** Path kinds in display order: the first evaluated path supplies the tile's main reason. */
export const PATH_ORDER = [
  "store_owned",
  "group",
  "product_idp",
  "email_domain",
  "auto_issue",
  "open",
];

/**
 * Evaluate one product for one account. Dry run: returns paths, never mutates.
 * @param {object} product the product's storefront-relevant config
 * @param {object} account the signed-in account's facts
 * @returns {ObtainPath[]}
 */
export function obtainPaths(product, account) {
  const paths = [];
  const offered = new Set(product.offerPaths ?? PATH_ORDER);
  const ai = product.autoIssue ?? {};
  const signInIssue =
    ai.enabled && (ai.mode === "oidcDefault" || ai.mode === "both");
  const platform = account.platformLink; // null when the account never signed in with the platform IdP

  // Store ownership (Steam) needs a linked store identity that owns the mapped app.
  if (
    offered.has("store_owned") &&
    product.steamAppId &&
    account.steamOwns?.includes(product.steamAppId)
  ) {
    paths.push({
      kind: "store_owned",
      detail: "steam",
      tier: product.storeTier ?? null,
      action: "add",
    });
  }
  // Platform-IdP group map: only on platform-provider products, only from the asserted groups.
  if (
    offered.has("group") &&
    product.provider === "platform" &&
    product.autoLink &&
    platform
  ) {
    const hit = Object.keys(product.groupRoleMap ?? {}).find((g) =>
      platform.groups?.includes(g),
    );
    if (hit)
      paths.push({
        kind: "group",
        detail: hit,
        tier: product.groupRoleMap[hit].tier ?? ai.tierId ?? null,
        action: "add",
      });
  }
  // Product's own IdP: only with a verified product-scoped link (I-22). Never by guess.
  if (
    offered.has("product_idp") &&
    product.provider === "custom" &&
    account.productLinks?.includes(product.slug)
  ) {
    paths.push({
      kind: "product_idp",
      detail: product.idpLabel ?? "custom",
      tier: ai.tierId ?? null,
      action: "add",
    });
  }
  // Verified email domain (PS-09): verified addresses only.
  if (offered.has("email_domain") && product.emailDomains?.length) {
    const d = (account.verifiedEmails ?? [])
      .map((e) => e.split("@")[1])
      .find((x) => product.emailDomains.includes(x));
    if (d)
      paths.push({
        kind: "email_domain",
        detail: d,
        tier: ai.tierId ?? null,
        action: "add",
      });
  }
  // Auto-issue on sign-in: today's `free_with_account`, platform-provider products only.
  if (
    offered.has("auto_issue") &&
    signInIssue &&
    product.provider === "platform" &&
    product.autoLink &&
    platform
  ) {
    paths.push({ kind: "auto_issue", tier: ai.tierId, action: "add" });
  }
  // Open: nothing to licence. Adding records a library entry, no licence.
  if (offered.has("open") && !product.licenseRequired) {
    paths.push({ kind: "open", tier: null, action: "add" });
  }
  return paths.sort(
    (a, b) => PATH_ORDER.indexOf(a.kind) - PATH_ORDER.indexOf(b.kind),
  );
}

/**
 * The storefront listing for one account: listed, not held, at least one path (or audience
 * "everyone" with a store link). Unknown, unlisted and ineligible products are indistinguishable.
 */
export function storefront(products, account) {
  const out = [];
  for (const p of products) {
    const v = verdict(p, account);
    if (v.visible) out.push({ slug: p.slug, paths: v.paths, cta: v.cta });
  }
  return out;
}

export function verdict(p, account) {
  const hidden = { visible: false, paths: [], cta: null };
  if (!p || p.listed === "unlisted" || !p.active || !p.portalEnabled)
    return hidden;
  if (account.held?.includes(p.slug)) return hidden; // Library, not the storefront
  const paths = obtainPaths(p, account);
  // `auto` lists only what today's Discover lists: sign-in auto-issue or a mapped group.
  if (
    p.listed === "auto" &&
    !paths.some((x) => x.kind === "auto_issue" || x.kind === "group")
  )
    return hidden;
  if (paths.length) return { visible: true, paths, cta: "add" };
  if (p.audience === "everyone" && p.storeLinks?.length)
    return { visible: true, paths: [], cta: "link" };
  return hidden;
}

/** Claim: the same answer for unknown, unlisted, withdrawn and ineligible. */
export function claim(products, account, slug) {
  const p = products.find((x) => x.slug === slug);
  const v = verdict(p, account);
  if (!v.visible || v.cta !== "add")
    return { status: 409, code: "not_eligible" };
  return {
    status: 200,
    path: v.paths[0].kind,
    creates: v.paths[0].kind === "open" ? "library_entry" : "licence",
  };
}

function selfTest() {
  const base = {
    active: true,
    portalEnabled: true,
    listed: "listed",
    audience: "eligible",
    provider: "platform",
    autoLink: true,
    licenseRequired: true,
  };
  const P = [
    {
      ...base,
      slug: "freebie",
      autoIssue: { enabled: true, mode: "oidcDefault", tierId: "free" },
    },
    {
      ...base,
      slug: "djdl",
      groupRoleMap: { members: { tier: "standard" }, admins: {} },
    },
    { ...base, slug: "private-tool" },
    { ...base, slug: "open-util", licenseRequired: false },
    { ...base, slug: "steam-game", steamAppId: "480", storeTier: "full" },
    {
      ...base,
      slug: "team-app",
      provider: "custom",
      idpLabel: "Aperture",
      autoIssue: { enabled: true, mode: "oidcDefault", tierId: "team" },
    },
    {
      ...base,
      slug: "domain-app",
      emailDomains: ["fennick.studio"],
      autoIssue: { enabled: true, mode: "oidcDefault", tierId: "pro" },
    },
    { ...base, slug: "teaser", audience: "everyone", storeLinks: ["steam"] },
    {
      ...base,
      slug: "hidden-free",
      listed: "unlisted",
      autoIssue: { enabled: true, mode: "both", tierId: "free" },
    },
    { ...base, slug: "auto-open", listed: "auto", licenseRequired: false },
    {
      ...base,
      slug: "auto-free",
      listed: "auto",
      autoIssue: { enabled: true, mode: "oidcDefault", tierId: "free" },
    },
  ];
  const anon = { platformLink: null, verifiedEmails: ["a@example.com"] }; // magic-link only
  const member = {
    platformLink: { groups: ["members"] },
    verifiedEmails: ["m@fennick.studio"],
    steamOwns: ["480"],
    productLinks: ["team-app"],
  };
  const holder = { ...member, held: ["freebie", "djdl"] };
  const rows = [
    // [account, expected visible slugs (sorted)]
    ["anon", anon, ["domain-app?no", "open-util", "teaser"]],
    [
      "member",
      member,
      [
        "auto-free",
        "djdl",
        "domain-app",
        "freebie",
        "open-util",
        "steam-game",
        "team-app",
        "teaser",
      ],
    ],
    [
      "holder",
      holder,
      [
        "auto-free",
        "domain-app",
        "open-util",
        "steam-game",
        "team-app",
        "teaser",
      ],
    ],
  ];
  let fail = 0;
  for (const [name, acct, want] of rows) {
    const expect = want.filter((s) => !s.endsWith("?no")).sort();
    const got = storefront(P, acct)
      .map((x) => x.slug)
      .sort();
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(7)} ${got.join(",")}`);
  }
  // No enumeration: unknown, unlisted, ineligible and private answer identically.
  const answers = ["does-not-exist", "hidden-free", "private-tool"].map((s) =>
    JSON.stringify(claim(P, member, s)),
  );
  const same = new Set(answers).size === 1;
  if (!same) fail++;
  console.log(
    `${same ? "ok  " : "FAIL"} claim answers identical for unknown/unlisted/ineligible: ${answers[0]}`,
  );
  // Reason order: a group member of a product that also auto-issues sees the group first.
  const both = {
    ...base,
    slug: "x",
    groupRoleMap: { members: { tier: "beta" } },
    autoIssue: { enabled: true, mode: "both", tierId: "free" },
  };
  const first = obtainPaths(both, member)[0];
  const okOrder = first.kind === "group" && first.tier === "beta";
  if (!okOrder) fail++;
  console.log(
    `${okOrder ? "ok  " : "FAIL"} group path precedes auto_issue (tier ${first.tier})`,
  );
  // Open product creates a library entry, not a licence.
  const c = claim(P, anon, "open-util");
  const okOpen = c.creates === "library_entry";
  if (!okOpen) fail++;
  console.log(
    `${okOpen ? "ok  " : "FAIL"} open product claim creates ${c.creates}`,
  );
  // Audience "everyone" without a free path offers a link, never an Add.
  const t = claim(P, anon, "teaser");
  const okTeaser = t.status === 409;
  if (!okTeaser) fail++;
  console.log(
    `${okTeaser ? "ok  " : "FAIL"} audience=everyone with no path cannot be claimed (${t.code})`,
  );
  console.log(fail ? `${fail} failed` : "all passed");
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes("--self-test")) selfTest();
