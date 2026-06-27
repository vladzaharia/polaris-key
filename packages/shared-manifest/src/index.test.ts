import { describe, expect, it } from "vitest";
import { parseManifest, validateManifestDocuments } from "./index.js";

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
