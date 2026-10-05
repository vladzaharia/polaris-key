import { describe, expect, it } from "vitest";
import {
  ApiError,
  RELEASE_POLICY_ERROR_MESSAGES,
  SERVICE_ERROR_MESSAGES,
} from "../../src/api.js";
import {
  DISTRIBUTION_ERROR_MESSAGES,
  RELEASE_REASON_MESSAGES,
  errorCopy,
} from "../../src/lib/errorCopy.js";

const api = (
  status: number,
  o: {
    code?: string;
    reason?: string;
    fields?: string[];
    errors?: string[];
    message?: string;
  } = {},
) => {
  const e = new ApiError(status, o.fields, o.code, o.errors, o.reason);
  if (o.message) e.message = o.message;
  return e;
};

/** ADMIN.md §5.9, one row per line of its table. */
const TABLE: [
  string,
  unknown,
  Parameters<typeof errorCopy>[1],
  { title: RegExp | string; action: string },
][] = [
  [
    "401",
    api(401, { code: "unauthorized" }),
    {},
    { title: "Your session ended", action: "sign-in" },
  ],
  [
    "403 csrf",
    api(403, { code: "forbidden", message: "csrf token mismatch" }),
    {},
    { title: "Your session token is out of date", action: "reload" },
  ],
  [
    "403",
    api(403, { code: "forbidden", message: "nope" }),
    {},
    { title: "You can't do that", action: "none" },
  ],
  [
    "404",
    api(404, { code: "not_found" }),
    { thing: "License" },
    { title: "License not found", action: "none" },
  ],
  [
    "409 in use",
    Object.assign(api(409, { code: "bad_request" }), {
      references: ["lic_1", "lic_2", "lic_3"],
    }),
    { thing: "Tier" },
    { title: "Tier is still in use", action: "none" },
  ],
  [
    "409 catalog",
    api(409, { code: "conflict" }),
    { area: "catalog" },
    { title: "The catalog changed since you started", action: "review" },
  ],
  [
    "422 fields",
    api(422, { code: "bad_request", fields: ["name", "email"] }),
    {},
    { title: "Fix 2 fields", action: "fields" },
  ],
  [
    "422 errors[]",
    api(422, { code: "bad_request", errors: ["update_requires_distribution"] }),
    {},
    { title: "These services depend on each other", action: "fields" },
  ],
  [
    "429",
    api(429, { code: "rate_limited" }),
    {},
    { title: "Too many requests", action: "retry" },
  ],
  [
    "413",
    api(413),
    {},
    { title: "The request was too large", action: "copy-details" },
  ],
  [
    "400 invalid_json",
    api(400, { code: "invalid_json" }),
    {},
    { title: "The request was malformed", action: "copy-details" },
  ],
  [
    "503 KEK",
    api(503),
    {},
    { title: "The platform keyring is unavailable", action: "platform" },
  ],
  [
    "500 catalog_unavailable",
    api(500, { code: "catalog_unavailable" }),
    {},
    { title: "The catalog couldn't be read", action: "copy-details" },
  ],
  [
    "500 document_not_representable",
    api(500, { code: "document_not_representable" }),
    {},
    { title: "This document can't be represented", action: "copy-details" },
  ],
  [
    "network",
    new TypeError("Failed to fetch"),
    {},
    { title: "Can't reach Polaris Key", action: "retry" },
  ],
  [
    "unknown",
    api(418, { code: "teapot" }),
    {},
    { title: "The server refused this", action: "copy-details" },
  ],
];

describe("errorCopy: every row of ADMIN.md §5.9", () => {
  it.each(TABLE)("%s", (_name, error, context, want) => {
    const copy = errorCopy(error, context);
    expect(copy.title).toEqual(want.title);
    expect(copy.action).toBe(want.action);
    expect(copy.description).not.toMatch(/^api \d+$/);
    expect(copy.details).toBeTypeOf("object");
  });

  it("422 errors[] words every coherence code", () => {
    for (const code of Object.keys(SERVICE_ERROR_MESSAGES)) {
      const copy = errorCopy(api(422, { errors: [code] }));
      expect(copy.lines).toEqual([SERVICE_ERROR_MESSAGES[code]]);
    }
  });

  it("422 fields are handed to the form", () => {
    expect(errorCopy(api(422, { fields: ["name"] })).fieldErrors).toEqual([
      "name",
    ]);
    expect(errorCopy(api(422, { fields: ["name"] })).title).toBe("Fix 1 field");
  });

  it("422 fields name the field to focus: the first one refused", () => {
    expect(errorCopy(api(422, { fields: ["email", "name"] })).focus).toBe(
      "email",
    );
    expect(
      errorCopy(api(422, { reason: "bad_pinned", fields: ["pinned"] })).focus,
    ).toBe("pinned");
    expect(errorCopy(api(429)).focus).toBeUndefined();
  });

  it("409 lists its references", () => {
    const e = Object.assign(api(409), { references: ["a", "b"] });
    expect(errorCopy(e, { thing: "Profile" }).references).toEqual(["a", "b"]);
    expect(errorCopy(e, { thing: "Profile" }).description).toBe(
      "Used by 2 items.",
    );
  });

  it("the unknown fallback keeps the details for a support report", () => {
    const d = errorCopy(api(418, { code: "teapot", reason: "short" })).details;
    expect(d).toMatchObject({ status: 418, code: "teapot", reason: "short" });
    expect(typeof d.time).toBe("string");
  });
});

describe("errorCopy: release reasons", () => {
  // worker services/release/policy.ts refuses with these 18 reasons.
  const REASONS = [
    "bad_content_api",
    "bad_critical",
    "bad_deliverable",
    "bad_min_supported",
    "bad_pinned",
    "bad_reason",
    "bad_release",
    "content_api_floor_only",
    "empty_update",
    "no_policy",
    "not_yanked",
    "pin_without_pointer",
    "release_revoked",
    "release_yanked",
    "unknown_channel",
    "unknown_deliverable",
    "unknown_field",
    "unknown_release",
  ];

  it("covers all 18 and reuses the api.ts table", () => {
    expect(Object.keys(RELEASE_REASON_MESSAGES).sort()).toEqual(REASONS);
    for (const [k, v] of Object.entries(RELEASE_POLICY_ERROR_MESSAGES)) {
      expect(RELEASE_REASON_MESSAGES[k]).toBe(v);
    }
  });

  it.each(REASONS)("%s", (reason) => {
    const copy = errorCopy(api(422, { reason, code: "bad_request" }));
    expect(copy.description).toBe(RELEASE_REASON_MESSAGES[reason]);
  });
});

describe("errorCopy: distribution reasons", () => {
  const CODES = [
    "rollout_mirrored",
    "invalid_transition",
    "stale_release",
    "release_yanked",
    "no_rollout",
    "no_override",
    "candidate_closed",
    "credential_pin_missing",
    "credential_pin_mismatch",
    "not_configured",
    "store_refused",
    "unknown_version",
    "no_phased_release",
    "not_held",
    "unknown_beta_group",
    "no_webhook_secret",
    "unknown_track",
    // A-17a: the typed confirmation on an App Store release.
    "confirmation_required",
    "confirmation_mismatch",
    // A-17g: the App Store Distribute flow and App Store products.
    "idempotency_key_required",
    "idempotency_conflict",
    "unknown_build",
    "build_expired",
    "build_not_ready",
    "already_answered",
    "version_not_editable",
    "no_build",
    "unknown_submission",
    "not_cancelable",
    "unmapped_product",
    "iap_missing",
    "iap_type_mismatch",
    "unknown_price_point",
    "iap_not_ready",
    "first_iap_portal",
    "unknown_iap_version",
    "unknown_background_asset_version",
    "background_asset_not_ready",
    "write_denied",
    // A-9 (chunk 9): the distribution 404s keep their reason.
    "unknown_outlet",
    "unknown_channel",
    "unknown_release",
    "unknown_deliverable",
    "unknown_candidate",
  ];

  it("has copy for every code in ADMIN.md §5.9", () => {
    expect(Object.keys(DISTRIBUTION_ERROR_MESSAGES).sort()).toEqual(
      [...CODES].sort(),
    );
  });

  it.each(CODES)("%s", (reason) => {
    const copy = errorCopy(api(409, { reason }), { area: "distribution" });
    expect(copy.description).toBe(DISTRIBUTION_ERROR_MESSAGES[reason]);
  });

  it("stale_release offers a retry", () => {
    expect(
      errorCopy(api(409, { reason: "stale_release" }), { area: "distribution" })
        .action,
    ).toBe("retry");
  });

  it("release_yanked reads per area", () => {
    expect(errorCopy(api(409, { reason: "release_yanked" })).description).toBe(
      RELEASE_REASON_MESSAGES.release_yanked,
    );
    expect(
      errorCopy(api(409, { reason: "release_yanked" }), {
        area: "distribution",
      }).description,
    ).toBe(DISTRIBUTION_ERROR_MESSAGES.release_yanked);
  });
});

describe("errorCopy is total", () => {
  it.each([null, undefined, "boom", 42, new Error("x"), {}])("%s", (v) => {
    const copy = errorCopy(v);
    expect(copy.title).toBeTruthy();
    expect(copy.description).toBeTruthy();
  });
});

/** EXPERIENCE.md §0.3 (J-4), §0.4 S1 and §11.3 "Errors": the product-setup routes (UX-01). */
describe("errorCopy: manifest problems", () => {
  // The worker's link-repo refusal: `manifest validation failed` + shared-manifest's lines.
  const manifest = (errors: string[]) =>
    api(422, {
      code: "bad_request",
      message: "manifest validation failed",
      errors,
    });

  it("lists each problem with its file and path, not as service coherence", () => {
    const copy = errorCopy(
      manifest([
        "product/licensing/tiers/0: must be an object",
        "product/slug: must match ^[a-z0-9-]+$",
        "product: unknown key 'colour'",
      ]),
    );
    expect(copy.title).toBe("3 problems in .pkey/product");
    expect(copy.description).toBe("Fix them in one commit, then check again.");
    expect(copy.problems).toEqual([
      {
        file: ".pkey/product",
        path: "/licensing/tiers/0",
        message: "must be an object",
      },
      {
        file: ".pkey/product",
        path: "/slug",
        message: "must match ^[a-z0-9-]+$",
      },
      { file: ".pkey/product", path: "", message: "unknown key 'colour'" },
    ]);
    expect(copy.lines).toEqual([
      ".pkey/product/licensing/tiers/0: must be an object",
      ".pkey/product/slug: must match ^[a-z0-9-]+$",
      ".pkey/product: unknown key 'colour'",
    ]);
    expect(copy.fix).toEqual({ kind: "check-again", label: "Check again" });
    expect(copy.title).not.toMatch(/services/i);
  });

  it("counts across files, and words one problem in the singular", () => {
    expect(
      errorCopy(
        manifest([
          "schema/keys/0: missing type",
          "release/binaryName: must be a safe file name",
        ]),
      ).title,
    ).toBe("The manifest has 2 problems");
    const one = errorCopy(manifest(["schema: invalid YAML"]));
    expect(one.title).toBe("1 problem in .pkey/schema");
    expect(one.description).toBe("Fix it in a commit, then check again.");
  });

  it("is recognized without an area, and the manifest area takes free-form lines", () => {
    const plain = errorCopy(api(422, { errors: ["product: required"] }));
    expect(plain.problems).toHaveLength(1);
    const free = errorCopy(api(422, { errors: ["something odd"] }), {
      area: "manifest",
    });
    expect(free.title).toBe("The manifest has 1 problem");
    expect(free.lines).toEqual(["something odd"]);
  });

  it("leaves service coherence codes to the services copy", () => {
    const copy = errorCopy(
      api(422, { errors: ["update_requires_distribution"] }),
      { area: "services" },
    );
    expect(copy.title).toBe("These services depend on each other");
    expect(copy.problems).toBeUndefined();
    expect(copy.lines).toEqual([
      SERVICE_ERROR_MESSAGES.update_requires_distribution,
    ]);
  });
});

describe("errorCopy: product slug", () => {
  it("a taken slug says so and offers a free one, on the field", () => {
    const copy = errorCopy(
      api(409, {
        code: "bad_request",
        message: "product exists",
        fields: ["slug"],
      }),
      { area: "slug", slug: "tonebox" },
    );
    expect(copy).toMatchObject({
      title: "tonebox is taken",
      description: "Try tonebox-app.",
      action: "fields",
      focus: "slug",
      suggestion: "tonebox-app",
      fieldErrors: ["slug"],
    });
  });

  it("reads the slug from link-repo's message when the caller has none", () => {
    // §11.3: "The server refused this (422 bad_request) — product already exists: tonebox".
    const copy = errorCopy(
      api(422, {
        code: "bad_request",
        message: "product already exists: tonebox",
      }),
    );
    expect(copy.title).toBe("tonebox is taken");
    expect(copy.description).toBe("Try tonebox-app.");
    expect(copy.focus).toBe("slug");
  });

  it("words a reserved and a malformed slug", () => {
    expect(
      errorCopy(
        api(422, {
          message: "reserved slug",
          fields: ["slug"],
          reason: "reserved_slug",
        }),
        { slug: "manage" },
      ),
    ).toMatchObject({ title: "manage is reserved", suggestion: "manage-app" });
    expect(
      errorCopy(api(422, { message: "invalid slug", fields: ["slug"] })),
    ).toMatchObject({ title: "That slug can't be used", focus: "slug" });
  });

  it("a refusal that names other fields as well stays the form's", () => {
    expect(errorCopy(api(422, { fields: ["slug", "name"] })).title).toBe(
      "Fix 2 fields",
    );
  });
});

describe("errorCopy: GitHub access", () => {
  const linkRepo = (message: string) =>
    api(422, { code: "bad_request", message });

  it("an uninstalled app names the repo and offers the install", () => {
    const copy = errorCopy(
      linkRepo("github app is not installed on this repository"),
      { area: "github", repo: "acme/beatgrid" },
    );
    expect(copy).toMatchObject({
      title: "The GitHub App can't read acme/beatgrid",
      description:
        "The Polaris Key GitHub App isn't installed on acme/beatgrid, or the repo is private.",
      focus: "repoUrl",
      fix: {
        kind: "install-github-app",
        label: "Install the GitHub App",
        repo: "acme/beatgrid",
      },
    });
  });

  it.each([
    "installation discovery failed: 404",
    "installation token failed: 403",
    "repo file fetch failed: 404",
    // §11.3: "…github access failed: 404 Not Found".
    "github access failed: 404 Not Found",
  ])("%s reads as the app not reaching the repo", (message) => {
    const copy = errorCopy(linkRepo(message));
    expect(copy.fix?.kind).toBe("install-github-app");
    expect(copy.description).toContain("this repository");
  });

  it("an unconfigured app, a bad repo name and an outage each say so", () => {
    expect(errorCopy(linkRepo("github app not configured"))).toMatchObject({
      title: "The GitHub App isn't set up",
      action: "platform",
    });
    expect(
      errorCopy(linkRepo("could not parse a github owner/repo from the URL")),
    ).toMatchObject({ focus: "repoUrl", action: "fields" });
    const outage = errorCopy(linkRepo("installation discovery failed: 502"), {
      repo: "acme/tonebox",
    });
    expect(outage).toMatchObject({
      title: "Couldn't reach GitHub",
      action: "retry",
    });
    expect(outage.description).not.toMatch(/502/);
  });

  it("a message that only mentions GitHub is not an access failure", () => {
    expect(
      errorCopy(
        api(422, {
          message: "github environment is invalid",
          fields: ["environment"],
        }),
      ).title,
    ).toBe("Fix 1 field");
    expect(
      errorCopy(
        api(422, { message: "repoUrl is required", fields: ["repoUrl"] }),
        {
          area: "github",
        },
      ),
    ).toMatchObject({ title: "Fix 1 field", focus: "repoUrl" });
  });

  it("the area alone never claims an ended session or a missing permission", () => {
    expect(errorCopy(api(401), { area: "github" }).title).toBe(
      "Your session ended",
    );
    expect(
      errorCopy(api(403, { code: "csrf_invalid" }), { area: "github" }).title,
    ).toBe("Your session token is out of date");
    expect(
      errorCopy(api(502), { area: "github", repo: "acme/tonebox" }).title,
    ).toBe("Couldn't reach GitHub");
  });
});

describe("errorCopy never shows an HTTP status", () => {
  const STATUS = /\b[1-5]\d\d\b/;
  it.each([
    api(418, { code: "teapot" }),
    api(500, { code: "internal" }),
    api(502),
    api(404, { message: "github access failed: 404 Not Found" }),
    api(403, { message: "upstream said (403 forbidden)" }),
    api(409, { message: "api 409" }),
    new Error("request failed: HTTP 500"),
  ])("%s", (error) => {
    const copy = errorCopy(error, { thing: "License" });
    expect(copy.title).not.toMatch(STATUS);
    expect(copy.description).not.toMatch(STATUS);
  });

  it("keeps the status and code in the details", () => {
    const copy = errorCopy(api(500, { code: "internal" }));
    expect(copy.title).toBe("Something went wrong on the server");
    expect(copy.details).toMatchObject({ status: 500, code: "internal" });
  });

  it("keeps the words of a message it strips", () => {
    expect(
      errorCopy(api(404, { message: "not found: 404 Not Found" })).description,
    ).toBe("not found");
    expect(
      errorCopy(api(403, { message: "upstream said (403 forbidden)" }))
        .description,
    ).toBe("upstream said");
  });
});
