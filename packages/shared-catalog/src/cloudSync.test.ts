import { describe, expect, it } from "vitest";
import {
  CLOUD_SYNC_CEILINGS,
  CLOUD_SYNC_COLLECTION_PATTERN,
  CLOUD_SYNC_DEFAULTS,
  CLOUD_SYNC_KEY_PATTERN,
  CLOUD_SYNC_MAX_MERGE_MEMBERS,
  CLOUD_SYNC_MAX_UNION_ELEMENT_BYTES,
  CLOUD_SYNC_SAVE_SLOTS,
  CLOUD_SYNC_TEMPLATES,
  CLOUD_SYNC_THUMBNAIL_MAX_CHARS,
  SYNC_CONFLICTS,
  USER_SETTING_CONFLICTS,
  USER_SETTING_SYNC_SCOPES,
  cloudSyncEncryption,
  matchCollection,
  resolveCollection,
  userSettingIssues,
} from "./cloudSync.js";
import { syncedSettings } from "./syncRoutes.js";
import type { ConfigEntry } from "./types.js";
import { prepareSchema, validatePrepared } from "./validate.js";

const entry = (over: Partial<ConfigEntry> & { key: string }): ConfigEntry => ({
  kind: "config",
  category: "general",
  label: over.key,
  description: "",
  schema: { type: "string" },
  ...over,
});

describe("the one conflict vocabulary", () => {
  it("is six values; settings take four of them", () => {
    expect(SYNC_CONFLICTS).toEqual([
      "lastWrite",
      "max",
      "min",
      "merge",
      "union",
      "revision",
    ]);
    expect(USER_SETTING_CONFLICTS).toEqual([
      "lastWrite",
      "max",
      "min",
      "merge",
    ]);
    for (const c of USER_SETTING_CONFLICTS) expect(SYNC_CONFLICTS).toContain(c);
  });

  it("has no device scope", () => {
    expect(USER_SETTING_SYNC_SCOPES).toEqual(["user", "platform", "local"]);
  });
});

describe("limits", () => {
  it("are @polaris-key/protocol/sync's numbers, every value unchanged (U-05.1)", () => {
    const KiB = 1024;
    const MiB = 1024 * KiB;
    // The literals this module held before the protocol subpath owned them.
    expect(CLOUD_SYNC_DEFAULTS).toEqual({
      quotaBytes: 256 * MiB,
      unlicensedQuotaBytes: 1 * MiB,
      settings: { maxKeys: 256, maxValueBytes: 8 * KiB, maxBytes: 64 * KiB },
      records: {
        maxRecordBytes: 64 * KiB,
        maxRecords: 10_000,
        maxCollections: 32,
      },
      files: { maxBytes: 32 * MiB, keepRevisions: 5 },
      push: { maxMutations: 100, maxBytes: 256 * KiB, perMinutePerDevice: 60 },
      fileTransfersPerHour: 30,
    });
    expect(CLOUD_SYNC_SAVE_SLOTS).toBe(16);
    expect(CLOUD_SYNC_MAX_MERGE_MEMBERS).toBe(256);
    expect(CLOUD_SYNC_MAX_UNION_ELEMENT_BYTES).toBe(1024);
    expect(CLOUD_SYNC_KEY_PATTERN).toBe("^[A-Za-z0-9._:-]{1,128}$");
    expect(CLOUD_SYNC_COLLECTION_PATTERN).toBe(
      "^[A-Za-z0-9._:-]{1,126}(?:\\.\\*)?$",
    );
    expect(CLOUD_SYNC_CEILINGS).toEqual({
      perPerson: {
        bytes: 256 * KiB + 64 * MiB + 1024 * MiB,
        fileBytes: 1024 * MiB,
      },
      perProduct: {
        bytes: 50 * 1024 * MiB,
        users: 100_000,
        pushesPerSecond: 2_000,
      },
    });
  });

  it("are the owner's numbers: 256 keys and 64 KiB per player, 256 MiB, 1 MiB without a licence", () => {
    expect(CLOUD_SYNC_DEFAULTS.settings).toEqual({
      maxKeys: 256,
      maxValueBytes: 8192,
      maxBytes: 65536,
    });
    expect(CLOUD_SYNC_DEFAULTS.quotaBytes).toBe(268_435_456);
    expect(CLOUD_SYNC_DEFAULTS.unlicensedQuotaBytes).toBe(1_048_576);
    expect(CLOUD_SYNC_SAVE_SLOTS).toBe(16);
  });

  it("hold the defaults under the per-person ceiling", () => {
    expect(CLOUD_SYNC_CEILINGS.perPerson.bytes).toBe(
      256 * 1024 + 64 * 1024 ** 2 + 1024 ** 3,
    );
    expect(CLOUD_SYNC_DEFAULTS.quotaBytes).toBeLessThan(
      CLOUD_SYNC_CEILINGS.perPerson.bytes,
    );
    expect(CLOUD_SYNC_DEFAULTS.files.maxBytes).toBeLessThanOrEqual(
      CLOUD_SYNC_CEILINGS.perPerson.fileBytes,
    );
  });
});

describe("templates", () => {
  it("pin the saves slots, even against a declaration", () => {
    expect(
      resolveCollection({ name: "saves", template: "saves", maxRecords: 99 })
        .maxRecords,
    ).toBe(CLOUD_SYNC_SAVE_SLOTS);
  });

  it("let a declaration override every other member", () => {
    const r = resolveCollection({
      name: "slots",
      template: "saves",
      label: "Slots",
      conflict: "max",
      conflictField: "playtime",
      files: { maxBytes: 1024 },
    });
    expect(r).toMatchObject({
      label: "Slots",
      conflict: "max",
      conflictField: "playtime",
      files: { maxBytes: 1024, keepRevisions: 5 },
    });
  });

  it("default a plain collection to revision, owner and the platform record count", () => {
    expect(resolveCollection({ name: "notes" })).toEqual({
      name: "notes",
      label: "notes",
      template: null,
      access: "owner",
      conflict: "revision",
      conflictField: null,
      schema: null,
      maxRecords: 10_000,
      files: { maxBytes: 32 * 1024 ** 2, keepRevisions: 5, delta: false },
      requires: null,
    });
    expect(resolveCollection({ name: "s", template: "session" })).toMatchObject(
      {
        label: "Session",
        conflict: "lastWrite",
        maxRecords: 16,
        files: { maxBytes: 8 * 1024 ** 2, keepRevisions: 1, delta: false },
      },
    );
  });

  it("give saves a thumbnail field inside the 64 KiB record bound", () => {
    const schema = CLOUD_SYNC_TEMPLATES.saves.schema!;
    const prepared = prepareSchema(schema);
    const thumb = "A".repeat(CLOUD_SYNC_THUMBNAIL_MAX_CHARS);
    expect(CLOUD_SYNC_THUMBNAIL_MAX_CHARS).toBe(43_692);
    expect(
      validatePrepared(prepared, {
        playtime: 3600,
        progress: 0.5,
        chapter: "Act II",
        formatVersion: 3,
        thumbnail: thumb,
      }),
    ).toEqual([]);
    // Negative control: one character over the cap is refused.
    expect(
      validatePrepared(prepared, { thumbnail: `${thumb}A` }).length,
    ).toBeGreaterThan(0);
    expect(
      validatePrepared(prepared, { progress: 1.5 }).length,
    ).toBeGreaterThan(0);
    // The largest metadata a save can carry still fits one record.
    const largest = JSON.stringify({
      playtime: Number.MAX_SAFE_INTEGER,
      progress: 1,
      chapter: "x".repeat(128),
      formatVersion: Number.MAX_SAFE_INTEGER,
      thumbnail: thumb,
    });
    expect(largest.length).toBeLessThan(
      CLOUD_SYNC_DEFAULTS.records.maxRecordBytes,
    );
  });
});

describe("syncedSettings", () => {
  it("routes every declared key, in catalog order", () => {
    const routes = syncedSettings({
      entries: [
        entry({ key: "audio.volume", schema: { type: "number" } }),
        entry({
          key: "stats.best",
          schema: { type: "integer" },
          user: { sync: "platform", conflict: "max" },
        }),
        entry({ key: "ui.window", user: { sync: "local" } }),
        entry({
          key: "ui.theme",
          managementDefault: "enforced",
          user: { sync: "user" },
        }),
        entry({ key: "ops.flags", managementDefault: "hidden" }),
        entry({ key: "api.token", kind: "secret" }),
        entry({ key: "beta", kind: "flag", schema: { type: "boolean" } }),
        entry({ key: "ui.hint", user: { listed: false } }),
      ],
    });
    expect(routes).toEqual([
      {
        key: "audio.volume",
        route: "synced",
        scope: "user",
        policy: "lastWrite",
        listed: true,
        schema: { type: "number" },
      },
      {
        key: "stats.best",
        route: "synced",
        scope: "platform",
        policy: "max",
        listed: true,
        schema: { type: "integer" },
      },
      { key: "ui.window", route: "local" },
      { key: "ui.theme", route: "locked" },
      { key: "ops.flags", route: "locked" },
      { key: "api.token", route: "refused" },
      { key: "beta", route: "refused" },
      {
        key: "ui.hint",
        route: "synced",
        scope: "user",
        policy: "lastWrite",
        listed: false,
        schema: { type: "string" },
      },
    ]);
  });
});

describe("userSettingIssues", () => {
  const codes = (e: Record<string, unknown>) =>
    userSettingIssues(e).map((i) => [i.code, i.severity, i.at]);

  it("accepts an empty block: sync is optional", () => {
    expect(codes({ kind: "config", schema: {}, user: {} })).toEqual([]);
  });

  it("refuses the retired device scope, naming local", () => {
    const issues = userSettingIssues({
      kind: "config",
      schema: {},
      user: { sync: "device" },
    });
    expect(issues.map((i) => [i.code, i.severity, i.at])).toEqual([
      ["invalid_user_setting", "error", "user.sync"],
    ]);
    expect(issues[0]!.message).toMatch(/local/);
  });

  it("makes a block on a locked key a warning, not an error", () => {
    expect(
      codes({
        kind: "config",
        schema: {},
        managementDefault: "enforced",
        user: { sync: "user" },
      }),
    ).toEqual([["user_setting_locked_default", "warning", "user"]]);
  });

  it("keeps merge object-only: a list setting cannot combine", () => {
    expect(
      codes({
        kind: "config",
        schema: { type: "array", uniqueItems: true },
        user: { conflict: "merge" },
      }),
    ).toEqual([["user_conflict_type_mismatch", "error", "user.conflict"]]);
    expect(
      codes({
        kind: "config",
        schema: { type: "object" },
        user: { conflict: "merge" },
      }),
    ).toEqual([]);
  });

  it("refuses union and revision on a setting", () => {
    expect(
      codes({ kind: "config", schema: {}, user: { conflict: "union" } }),
    ).toEqual([["user_conflict_union", "error", "user.conflict"]]);
    expect(
      codes({ kind: "config", schema: {}, user: { conflict: "revision" } }),
    ).toEqual([["invalid_user_setting", "error", "user.conflict"]]);
  });
});

describe("encryption and delta", () => {
  it("defaults delta on for saves, off otherwise, and lets a declaration override", () => {
    expect(
      resolveCollection({ name: "s", template: "saves" }).files.delta,
    ).toBe(true);
    expect(resolveCollection({ name: "n" }).files.delta).toBe(false);
    expect(
      resolveCollection({
        name: "s",
        template: "saves",
        files: { delta: false },
      }).files.delta,
    ).toBe(false);
  });

  it("reads the mode as e2e unless the catalog opts out", () => {
    expect(cloudSyncEncryption({})).toBe("e2e");
    expect(cloudSyncEncryption({ cloudSync: {} })).toBe("e2e");
    expect(cloudSyncEncryption({ cloudSync: { encryption: "server" } })).toBe(
      "server",
    );
  });

  it("carries the mode on every route when the catalog hands over its cloudSync block", () => {
    const entries = [entry({ key: "a" }), entry({ key: "b", kind: "secret" })];
    expect(syncedSettings({ entries })[0]).not.toHaveProperty("encryption");
    expect(
      syncedSettings({ entries, cloudSync: {} }).map((r) => r.encryption),
    ).toEqual(["e2e", "e2e"]);
    expect(
      syncedSettings({ entries, cloudSync: { encryption: "server" } }).map(
        (r) => r.encryption,
      ),
    ).toEqual(["server", "server"]);
  });

  describe("matchCollection (V5 13.7, Matching)", () => {
    const catalog = {
      cloudSync: {
        collections: [
          { name: "saves.*", template: "saves" as const },
          { name: "saves.cloud.*", maxRecords: 5 },
          { name: "saves.cloud.pinned", maxRecords: 2 },
          { name: "notes", conflict: "merge" as const },
        ],
      },
    };

    it("an exact name beats a pattern", () => {
      expect(matchCollection(catalog, "saves.cloud.pinned")?.maxRecords).toBe(
        2,
      );
      expect(matchCollection(catalog, "notes")?.conflict).toBe("merge");
    });

    it("among patterns the longest prefix wins, whatever the declaration order", () => {
      expect(matchCollection(catalog, "saves.cloud.x")?.name).toBe(
        "saves.cloud.*",
      );
      expect(matchCollection(catalog, "saves.local")?.name).toBe("saves.*");
      const reversed = {
        cloudSync: {
          collections: [...catalog.cloudSync.collections].reverse(),
        },
      };
      expect(matchCollection(reversed, "saves.cloud.x")?.name).toBe(
        "saves.cloud.*",
      );
    });

    it("a pattern needs its dot and a suffix; a plain name is never a prefix", () => {
      expect(matchCollection(catalog, "saves")).toBeNull();
      expect(matchCollection(catalog, "saves.")).toBeNull();
      expect(matchCollection(catalog, "savesx")).toBeNull();
      expect(matchCollection(catalog, "notes.more")).toBeNull();
      expect(matchCollection(catalog, "other")).toBeNull();
    });

    it("a name that spells a pattern is not an exact match for it", () => {
      expect(matchCollection(catalog, "saves.*")?.name).toBe("saves.*");
    });

    it("answers null for no catalog, no block or no collections", () => {
      expect(matchCollection(null, "a")).toBeNull();
      expect(matchCollection(undefined, "a")).toBeNull();
      expect(matchCollection({}, "a")).toBeNull();
      expect(matchCollection({ cloudSync: {} }, "a")).toBeNull();
    });
  });
});
