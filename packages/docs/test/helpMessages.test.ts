/**
 * The `help-messages.json` contract (docs plan section 7.1): the id format, the schema and the
 * seed data. DOC-05a adds the completeness test (every catalog key is in exactly one entry or the
 * developer-only list) when it fills the data.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CATALOG_ENTRIES,
  HELP_MESSAGES,
  MESSAGE_ID,
  catalogEntries,
  helpCodePath,
  validateHelpMessages,
  type HelpMessagesData,
} from "../src/lib/helpMessages";
import { fileFor } from "../scripts/site-map.mjs";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(join(docsRoot, "help-messages.schema.json"), "utf8"),
) as {
  properties: { messages: { propertyNames: { pattern: string } } };
  required: string[];
};

describe("message ids", () => {
  it.each([
    "device_limit",
    "license_owned",
    "gate.expired",
    "activation.device-limit",
    "fallback",
    "service-unavailable",
    "device-limit",
  ])("%s is an id", (id) => expect(MESSAGE_ID.test(id)).toBe(true));

  it.each([
    "Device_limit",
    "gate.",
    "gate.Expired",
    "activation.device_limit",
    "device__limit",
    "-limit",
    "codes.device_limit",
    "",
  ])("%j is not an id", (id) => expect(MESSAGE_ID.test(id)).toBe(false));

  it("the JSON schema uses the same pattern as the code", () => {
    expect(schema.properties.messages.propertyNames.pattern).toBe(
      MESSAGE_ID.source,
    );
  });

  it("every catalog key makes a valid id", () => {
    for (const id of CATALOG_ENTRIES.keys())
      expect(MESSAGE_ID.test(id), id).toBe(true);
  });

  it("a gate or activation key never collides with a codes key", () => {
    // activation.device-limit and device_limit are different ids on purpose.
    expect(CATALOG_ENTRIES.has("device_limit")).toBe(true);
    expect(CATALOG_ENTRIES.has("activation.device-limit")).toBe(true);
    expect(helpCodePath("activation.device-limit")).toBe(
      "/docs/help/code/activation.device-limit/",
    );
  });
});

describe("the seed data", () => {
  it("is well formed against the catalog", () => {
    expect(validateHelpMessages(HELP_MESSAGES, CATALOG_ENTRIES)).toEqual([]);
  });

  it("names a messages page for every page key, and only those", () => {
    const keys = Object.keys(HELP_MESSAGES.pages).filter((k) => k !== "index");
    for (const key of keys)
      expect(fileFor(`help/messages/${key}`), key).not.toBeNull();
    const pagesUsed = new Set(
      Object.values(HELP_MESSAGES.messages).map((m) => m.page),
    );
    for (const used of pagesUsed) expect(keys, used).toContain(used);
  });

  it("the file declares the keys the schema requires", () => {
    for (const key of schema.required)
      expect(HELP_MESSAGES).toHaveProperty(key);
  });
});

describe("validateHelpMessages", () => {
  const known = catalogEntries({
    fallback: { title: "Something went wrong", message: "m" },
    codes: {
      device_limit: { title: "Device limit reached", message: "m" },
      other: { title: "Other", message: "m" },
    },
    gate: {},
    activation: {
      "device-limit": { title: "Device limit reached", message: "m" },
    },
  });
  const base = (): HelpMessagesData => ({
    version: 1,
    pages: { index: { title: "All" }, devices: { title: "Devices" } },
    messages: { device_limit: { page: "devices" } },
    developerOnly: [],
  });

  it("accepts a good document", () => {
    expect(validateHelpMessages(base(), known)).toEqual([]);
  });

  it("refuses an id the catalog lacks", () => {
    const doc = base();
    doc.messages.nonesuch = { page: "devices" };
    expect(validateHelpMessages(doc, known)).toContain(
      "nonesuch: not in the copy catalog",
    );
  });

  it("refuses a malformed id and an unknown page", () => {
    const doc = base();
    doc.messages["Bad-Id"] = { page: "nowhere" };
    const problems = validateHelpMessages(doc, known);
    expect(problems).toContain("Bad-Id: not a message id");
    expect(problems.some((p) => p.includes('page "nowhere"'))).toBe(true);
  });

  it("lets ids with one title share an entry, and refuses a different title", () => {
    const doc = base();
    doc.messages.device_limit = { page: "devices", entry: "limit" };
    doc.messages["activation.device-limit"] = {
      page: "devices",
      entry: "limit",
    };
    expect(validateHelpMessages(doc, known)).toEqual([]);
    doc.messages.other = { page: "devices", entry: "limit" };
    expect(validateHelpMessages(doc, known).join()).toContain("shares entry");
  });

  it("refuses an id that is both a message and developer-only", () => {
    const doc = base();
    doc.developerOnly = ["device_limit"];
    expect(validateHelpMessages(doc, known).join()).toContain(
      "both a message and developer-only",
    );
  });
});
