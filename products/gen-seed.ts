// Emit local fixture SQL from product.json + catalog.json.
//
// This does NOT mint sealed product_keys or store product secret values, so it is not a
// live onboarding path. Register real products through the admin/GitHub-link flow.
//
//   pnpm --filter @plrs/products gen-seed djdl > products/djdl/seed.sql

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Catalog, type ProductCatalog } from "@plrs/catalog";

interface Tier {
  id: string;
  label: string;
  profileId: string | null;
  policyExpiryDays: number | null;
  policyDeviceLimit: number | null;
  channels?: string[];
  minVersion?: string | null;
  maxVersion?: string | null;
}
interface Hook {
  claim: string;
  entitlementKey?: string;
  entitlementValue?: unknown;
  secretKey?: string;
  secretUrlTemplate?: string;
  allowedHosts?: string[];
}
interface Mint {
  id: string;
  alg: string;
  signingKeySecret: string;
  kid?: string;
  claimsTemplate: Record<string, unknown>;
  ttlSeconds: number;
  audience?: string | null;
}
interface ProductDef {
  slug: string;
  name: string;
  signingKid: string;
  signingPub: string;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultDeviceLimit: number;
  adminGroup: string;
  oidc: {
    provider?: "platform" | "custom";
    issuer?: string;
    clientId?: string;
    clientSecretSecret?: string;
    redirectUris?: string[];
    groupRoleMap: Record<string, unknown>;
  };
  tiers: Tier[];
  provisioning: Hook[];
  edgeMint: Mint[];
  release: {
    ghOwner: string;
    ghRepo: string;
    ghInstallationId: number;
    channelWorkflow: string;
    betaBranch: string;
    binaryName: string;
    summaryMarker: string;
    sparkleEd25519Pub: string;
  };
}

function q(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + v.replace(/'/g, "''") + "'";
}
const j = (v: unknown): string => q(JSON.stringify(v));

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: gen-seed <product-dir>");
    process.exit(2);
  }
  const product = JSON.parse(
    readFileSync(join(dir, "product.json"), "utf8"),
  ) as ProductDef;
  const catalogRaw = readFileSync(join(dir, "catalog.json"), "utf8");
  // Sanity-check the catalog (throws on a malformed schema fragment).
  new Catalog(JSON.parse(catalogRaw) as ProductCatalog).compileAll();
  const now = Math.floor(Date.now() / 1000);
  const p = product.slug;
  const out: string[] = [
    `-- Polaris Key seed for product '${p}' (generated).`,
    "PRAGMA foreign_keys = OFF;",
  ];

  out.push(
    `INSERT INTO products (slug,name,signing_kid,signing_pub,compat_min,compat_max,default_max_offline_days,default_device_limit,admin_group,branding_json,created_at,modified_at) VALUES (${q(p)},${q(product.name)},${q(product.signingKid)},${q(product.signingPub)},${q(product.compatMin)},${q(product.compatMax)},${product.defaultMaxOfflineDays},${product.defaultDeviceLimit},${q(product.adminGroup)},NULL,${now},${now});`,
  );
  out.push(
    `INSERT INTO product_schema (product,catalog_version,catalog_json,active,created_at) VALUES (${q(p)},1,${q(catalogRaw)},1,${now});`,
  );
  const o = product.oidc;
  const oidcProvider = o.provider ?? "platform";
  out.push(
    `INSERT INTO oidc_config (product,provider,issuer,client_id,client_secret_secret,redirect_uris_json,group_role_map_json) VALUES (${q(p)},${q(oidcProvider)},${q(oidcProvider === "custom" ? (o.issuer ?? "") : "")},${q(oidcProvider === "custom" ? (o.clientId ?? "") : "")},${q(oidcProvider === "custom" ? (o.clientSecretSecret ?? "") : "")},${j(o.redirectUris ?? [])},${j(o.groupRoleMap)});`,
  );
  for (const t of product.tiers) {
    out.push(
      `INSERT INTO tiers (product,id,label,profile_id,policy_expiry_days,policy_device_limit,channels_json,min_version,max_version,modified_by,modified_at) VALUES (${q(p)},${q(t.id)},${q(t.label)},${t.profileId ? q(t.profileId) : "NULL"},${t.policyExpiryDays ?? "NULL"},${t.policyDeviceLimit ?? "NULL"},${t.channels ? j(t.channels) : "NULL"},${t.minVersion ? q(t.minVersion) : "NULL"},${t.maxVersion ? q(t.maxVersion) : "NULL"},NULL,${now});`,
    );
  }
  for (const h of product.provisioning) {
    out.push(
      `INSERT INTO provisioning_config (product,claim,entitlement_key,entitlement_value_json,secret_key,secret_url_template,allowed_hosts_json) VALUES (${q(p)},${q(h.claim)},${h.entitlementKey ? q(h.entitlementKey) : "NULL"},${h.entitlementValue !== undefined ? j(h.entitlementValue) : "NULL"},${h.secretKey ? q(h.secretKey) : "NULL"},${h.secretUrlTemplate ? q(h.secretUrlTemplate) : "NULL"},${h.allowedHosts ? j(h.allowedHosts) : "NULL"});`,
    );
  }
  for (const e of product.edgeMint) {
    out.push(
      `INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (${q(p)},${q(e.id)},${q(e.alg)},${q(e.signingKeySecret)},${e.kid ? q(e.kid) : "NULL"},${j(e.claimsTemplate)},${e.ttlSeconds},${e.audience ? q(e.audience) : "NULL"},NULL);`,
    );
  }
  const r = product.release;
  out.push(
    `INSERT INTO release_config (product,gh_owner,gh_repo,gh_installation_id,channel_workflow,beta_branch,manual_channels_json,binary_name,install_template,sparkle_ed25519_pub,summary_marker) VALUES (${q(p)},${q(r.ghOwner)},${q(r.ghRepo)},${r.ghInstallationId},${q(r.channelWorkflow)},${q(r.betaBranch)},NULL,${q(r.binaryName)},NULL,${q(r.sparkleEd25519Pub)},${q(r.summaryMarker)});`,
  );
  out.push("PRAGMA foreign_keys = ON;");
  console.log(out.join("\n"));
}

main();
