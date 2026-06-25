// Emit the D1 seed SQL that registers a product on Polaris Key from its data files
// (product.json + catalog.json). Apply it with:
//   pnpm --filter @polaris-key/products gen-seed products/djdl > products/djdl/seed.sql
//   wrangler d1 execute polaris_key_prod --remote --file products/djdl/seed.sql
// (Alternatively register the product via the admin API once deployed.)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Catalog, type ProductCatalog } from "@polaris-key/catalog";

interface Tier {
  id: string;
  label: string;
  profileId: string | null;
  policyExpiryDays: number | null;
  policyMachineLimit: number | null;
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
}
interface ProductDef {
  slug: string;
  name: string;
  signingKid: string;
  signingKeySecret: string;
  signingPub: string;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultMachineLimit: number;
  adminGroup: string;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecretSecret: string;
    redirectUris: string[];
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
    `INSERT INTO products (slug,name,signing_kid,signing_key_secret,signing_pub,compat_min,compat_max,default_max_offline_days,default_machine_limit,admin_group,branding_json,created_at,modified_at) VALUES (${q(p)},${q(product.name)},${q(product.signingKid)},${q(product.signingKeySecret)},${q(product.signingPub)},${q(product.compatMin)},${q(product.compatMax)},${product.defaultMaxOfflineDays},${product.defaultMachineLimit},${q(product.adminGroup)},NULL,${now},${now});`,
  );
  out.push(
    `INSERT INTO product_schema (product,catalog_version,catalog_json,active,created_at) VALUES (${q(p)},1,${q(catalogRaw)},1,${now});`,
  );
  const o = product.oidc;
  out.push(
    `INSERT INTO oidc_config (product,issuer,client_id,client_secret_secret,redirect_uris_json,group_role_map_json) VALUES (${q(p)},${q(o.issuer)},${q(o.clientId)},${q(o.clientSecretSecret)},${j(o.redirectUris)},${j(o.groupRoleMap)});`,
  );
  for (const t of product.tiers) {
    out.push(
      `INSERT INTO tiers (product,id,label,profile_id,policy_expiry_days,policy_machine_limit,modified_by,modified_at) VALUES (${q(p)},${q(t.id)},${q(t.label)},${t.profileId ? q(t.profileId) : "NULL"},${t.policyExpiryDays ?? "NULL"},${t.policyMachineLimit ?? "NULL"},NULL,${now});`,
    );
  }
  for (const h of product.provisioning) {
    out.push(
      `INSERT INTO provisioning_config (product,claim,entitlement_key,entitlement_value_json,secret_key,secret_url_template,allowed_hosts_json) VALUES (${q(p)},${q(h.claim)},${h.entitlementKey ? q(h.entitlementKey) : "NULL"},${h.entitlementValue !== undefined ? j(h.entitlementValue) : "NULL"},${h.secretKey ? q(h.secretKey) : "NULL"},${h.secretUrlTemplate ? q(h.secretUrlTemplate) : "NULL"},${h.allowedHosts ? j(h.allowedHosts) : "NULL"});`,
    );
  }
  for (const e of product.edgeMint) {
    out.push(
      `INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,auth_page_template) VALUES (${q(p)},${q(e.id)},${q(e.alg)},${q(e.signingKeySecret)},${e.kid ? q(e.kid) : "NULL"},${j(e.claimsTemplate)},${e.ttlSeconds},NULL);`,
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
