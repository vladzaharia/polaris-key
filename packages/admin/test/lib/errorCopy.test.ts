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
    { title: "The server refused this (418 teapot)", action: "copy-details" },
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
