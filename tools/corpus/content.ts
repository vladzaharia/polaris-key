// `cases.json#/feedContentCases` (plans/P4-13.md §4.2), the content members appended to
// `feedCases`, and the content corpus (`content/cases.json`, `plan-matrix.json`), rebuilt
// through tools/gen-content-corpus.ts.

import { buildContentCorpus } from "../gen-content-corpus.js";
import {
  AUD_V3,
  FEED_NOW,
  headerText,
  PIN_KID,
  pub,
  raw,
  rawJson,
  sha256Hex,
  signRawSegments,
  utf8Bytes,
} from "./common.js";
import {
  P13_COUNTS,
  P13_SALT,
  p13FeedMembers,
  p13Hash,
  p13PackSets,
} from "./content-fixture.js";
import { placeNonWire } from "./nonwire.js";
import { appTwin, contentSet, packRecords } from "./pack-records.js";
import { feedPayload, leafDiff } from "./release-records.js";
import { ctxOf, isObj } from "./reference/claims.js";
import {
  REF_JSON,
  refFeedContent,
  refFeedDeltas,
  refPackSetId,
} from "./reference/content.js";
import { refFeedClaims } from "./reference/feed.js";
import { refVerifyJws } from "./reference/jws.js";
import { refNonWire } from "./reference/tokens.js";

// ── `feedContentCases` (plans/P4-13.md §4.2) ─────────────────────────────────────────────────

interface FeedContentCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  expectedAud: string;
  channel: string;
  platform: string;
  now: number;
  checkFreshness: boolean;
  nonWireIntegers?: string[];
  expect: {
    verify: "ok";
    content: { packSets: unknown; packFloors: unknown; revocations: unknown };
    /** plans/P4-29.md §4.1: the delta menu, on the appended cases only (absent means null). */
    deltas?: unknown;
  };
}

export async function buildFeedContentCases(): Promise<FeedContentCase[]> {
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const base = { ...feedPayload(), ...p13FeedMembers() };
  const cases: FeedContentCase[] = [];
  const baseContent = refFeedContent(base, null);
  type Patch = (d: Record<string, any>) => void;
  const mk = async (
    id: string,
    description: string,
    o: {
      patch?: Patch;
      raw?: boolean;
      /** The members (pointer prefixes) the mutation may touch. */
      props: string[];
      /** Which parsed members must differ from the base's (the rest must equal it). */
      changes: ("packSets" | "packFloors" | "revocations")[];
      /** plans/P4-29.md §4.2: an appended case, and whether its menu is usable. */
      deltas?: "usable" | "unusable";
    },
  ): Promise<void> => {
    const doc = structuredClone(base) as Record<string, any>;
    o.patch?.(doc);
    const text = o.raw ? rawJson(doc) : JSON.stringify(doc);
    const jws = await signRawSegments(
      headerText("pkey-feed+jws", PIN_KID),
      text,
      PIN_KID,
    );
    // Every case is a valid feed: the claims never see the content members.
    const v = refVerifyJws(jws, TRUST, "pkey-feed+jws");
    if (!v) throw new Error(`feedContentCases ${id}: does not verify`);
    if (
      refFeedClaims(v.payload, ctxOf(v.text), {
        aud: AUD_V3,
        channel: "stable",
        platform: "macos",
      }) !== null
    )
      throw new Error(`feedContentCases ${id}: fails the feed claims`);
    const content = refFeedContent(v.payload, ctxOf(v.text));
    // The mutation changes only its members.
    const parsedBack = JSON.parse(text) as unknown;
    const diff = leafDiff(base, parsedBack);
    if (
      o.patch &&
      (diff.length === 0 && !o.raw
        ? true
        : !diff.every((p) =>
            o.props.some((q) => p === q || p.startsWith(`${q}/`)),
          ))
    )
      throw new Error(
        `feedContentCases ${id}: differs outside ${o.props.join(", ")}: ${diff.join(", ")}`,
      );
    for (const m of ["packSets", "packFloors", "revocations"] as const) {
      const same =
        JSON.stringify(content[m]) === JSON.stringify(baseContent[m]);
      if (o.changes.includes(m) === same)
        throw new Error(
          `feedContentCases ${id}: ${m} ${same ? "unchanged" : "changed"}`,
        );
    }
    // plans/P4-29.md §4.1: an older case carries no menu; an appended one pins its own.
    const deltas = refFeedDeltas(v.payload, ctxOf(v.text));
    if (
      o.deltas === undefined
        ? deltas !== null
        : (deltas === null) !== (o.deltas === "unusable")
    )
      throw new Error(
        `feedContentCases ${id}: deltas ${deltas === null ? "null" : "usable"}`,
      );
    const nonWire = refNonWire(v.text);
    const c: FeedContentCase = {
      id,
      description,
      jws,
      trust: TRUST,
      expectedAud: AUD_V3,
      channel: "stable",
      platform: "macos",
      now: FEED_NOW,
      checkFreshness: true,
      expect: {
        verify: "ok",
        content,
        ...(o.deltas !== undefined ? { deltas } : {}),
      },
    };
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const ps = (d: Record<string, any>): Record<string, any> => d.packSets;
  const h = p13Hash;
  const gateBp = `/packSets/outlets/direct/gates/${h("foes@2.0.1")}/rollout/bp`;

  // Valid.
  await mk(
    "feed-content-valid",
    'The base: FC with all three content members (two platforms, an axis-less group and a texture group, an `engine: ""` row, a narrowed outlet, two gates, three floors and one revocation).',
    { props: [], changes: [] },
  );
  await mk("feed-content-valid-pack-sets-alone", "Only `packSets`.", {
    patch: (d) => {
      delete d.packFloors;
      delete d.revocations;
    },
    props: ["/packFloors", "/revocations"],
    changes: ["packFloors", "revocations"],
  });
  await mk("feed-content-valid-pack-floors-alone", "Only `packFloors`.", {
    patch: (d) => {
      delete d.packSets;
      delete d.revocations;
    },
    props: ["/packSets", "/revocations"],
    changes: ["packSets", "revocations"],
  });
  await mk("feed-content-valid-revocations-alone", "Only `revocations`.", {
    patch: (d) => {
      delete d.packSets;
      delete d.packFloors;
    },
    props: ["/packSets", "/packFloors"],
    changes: ["packSets", "packFloors"],
  });
  await mk(
    "feed-content-valid-absent",
    "No content member: all three parse as null (a feed from a Worker before P4-13).",
    {
      patch: (d) => {
        delete d.packSets;
        delete d.packFloors;
        delete d.revocations;
      },
      props: ["/packSets", "/packFloors", "/revocations"],
      changes: ["packSets", "packFloors", "revocations"],
    },
  );
  await mk(
    "feed-content-valid-unknown-members-ignored",
    "An unknown member at every level of every content member is ignored, and the parsed members carry the known ones only.",
    {
      patch: (d) => {
        ps(d).later = 1;
        ps(d).releases[h("foes@2.0.1")].later = 1;
        ps(d).rows[0].later = "x";
        ps(d).outlets.steam.later = true;
        ps(d).outlets.direct.gates[h("tex@1.1.0")].later = {};
        d.packFloors[0].later = 1;
        d.revocations[0].later = 1;
      },
      props: ["/packSets", "/packFloors", "/revocations"],
      changes: [],
    },
  );
  await mk(
    "feed-content-valid-floor-unknown-scheme",
    "A floor with a forward `versionScheme` (`calver`) is dropped alone; the others stay in force.",
    {
      patch: (d) => void (d.packFloors[2].versionScheme = "calver"),
      props: ["/packFloors/2/versionScheme"],
      changes: ["packFloors"],
    },
  );
  await mk(
    "feed-content-valid-empty-set",
    "A row whose set is empty (every pack of that group unsatisfied).",
    {
      patch: (d) => {
        const empty = refPackSetId([]);
        ps(d).sets[empty] = [];
        ps(d).rows[2].set = empty;
      },
      props: ["/packSets/sets", "/packSets/rows/2/set"],
      changes: ["packSets"],
    },
  );
  await mk(
    "feed-content-valid-engine-empty-rows",
    'Every row with `engine: ""` (builds that declared no engine).',
    {
      patch: (d) => {
        for (const r of ps(d).rows) r.engine = "";
      },
      props: ["/packSets/rows"],
      changes: ["packSets"],
    },
  );

  // Unusable `packSets`.
  const bad = async (
    id: string,
    description: string,
    patch: Patch,
    props: string[],
    member: "packSets" | "packFloors" | "revocations" = "packSets",
    raw = false,
  ): Promise<void> =>
    mk(id, description, { patch, props, changes: [member], raw });
  await bad(
    "feed-content-pack-sets-not-object",
    "`packSets` is a string.",
    (d) => void (d.packSets = "sets"),
    ["/packSets"],
  );
  await bad(
    "feed-content-pack-sets-array",
    "`packSets: []`, the shape `feed-valid-unknown-fields-ignored` carries: unusable, never a refusal.",
    (d) => void (d.packSets = []),
    ["/packSets"],
  );
  for (const k of ["releases", "sets", "rows"])
    await bad(
      `feed-content-pack-sets-${k}-missing`,
      `\`packSets\` without \`${k}\`.`,
      (d) => void delete ps(d)[k],
      [`/packSets/${k}`],
    );
  await bad(
    "feed-content-release-key-uppercase",
    "A `releases` key in uppercase hex.",
    (d) => {
      const r = ps(d).releases;
      const k = h("skins@1.0.0").toUpperCase();
      r[k] = { pack: "diceroll.skins", version: "1.0.0", seq: 1 };
    },
    ["/packSets/releases"],
  );
  await bad(
    "feed-content-release-pack-app",
    "A release whose `pack` is `app` (not a pack id).",
    (d) => void (ps(d).releases[h("l10n@1.1.0")].pack = "app"),
    [`/packSets/releases/${h("l10n@1.1.0")}/pack`],
  );
  await bad(
    "feed-content-release-version-bad",
    "A release `version` with a space.",
    (d) => void (ps(d).releases[h("l10n@1.1.0")].version = "1.1 .0"),
    [`/packSets/releases/${h("l10n@1.1.0")}/version`],
  );
  await bad(
    "feed-content-release-seq-string",
    'A release `seq` of `"2"`.',
    (d) => void (ps(d).releases[h("l10n@1.1.0")].seq = "2"),
    [`/packSets/releases/${h("l10n@1.1.0")}/seq`],
  );
  await bad(
    "feed-content-set-unknown-release",
    "A set names a hash that is not in `releases`.",
    (d) => {
      const id = ps(d).rows[2].set;
      ps(d).sets[id] = [...ps(d).sets[id], h("skins@1.0.0")];
    },
    ["/packSets/sets"],
  );
  await bad(
    "feed-content-set-pack-twice",
    "A set names two releases of one pack.",
    (d) => {
      const id = ps(d).rows[2].set;
      ps(d).sets[id] = [h("tex@1.1.0"), h("tex@1.0.0")];
    },
    ["/packSets/sets"],
  );
  await bad(
    "feed-content-row-content-api-string",
    'A row `contentApi` of `"4"`.',
    (d) => void (ps(d).rows[1].contentApi = "4"),
    ["/packSets/rows/1/contentApi"],
  );
  await bad(
    "feed-content-row-platform-bad",
    "A row platform with an uppercase letter.",
    (d) => void (ps(d).rows[1].platform = "macOS"),
    ["/packSets/rows/1/platform"],
  );
  await bad(
    "feed-content-row-engine-bad",
    "A row engine that is neither empty nor `godot-<major>.<minor>`.",
    (d) => void (ps(d).rows[1].engine = "godot-4"),
    ["/packSets/rows/1/engine"],
  );
  await bad(
    "feed-content-row-variant-five-axes",
    "A row variant with five members.",
    (d) =>
      void (ps(d).rows[2].variant = {
        texture: "astc",
        locale: "fr",
        quality: "hd",
        size: "l",
        tier: "a",
      }),
    ["/packSets/rows/2/variant"],
  );
  await bad(
    "feed-content-row-set-unknown",
    "A row names a set that is not in `sets`.",
    (d) => void (ps(d).rows[1].set = h("skins@1.0.0")),
    ["/packSets/rows/1/set"],
  );
  await bad(
    "feed-content-row-duplicate-key",
    "Two rows with the same (contentApi, platform, engine, variant).",
    (d) => void (ps(d).rows[3].variant = { texture: "astc" }),
    ["/packSets/rows/3/variant"],
  );
  await bad(
    "feed-content-row-platform-not-selector",
    "A per-platform feed (`selector {platform: macos}`) whose `packSets` keeps a windows row.",
    (d) => {
      d.selector = { platform: "macos" };
      d.app.targets = [d.app.targets[0]];
    },
    ["/selector", "/app/targets"],
  );
  await bad(
    "feed-content-outlet-key-bad",
    "An `outlets` key with an underscore.",
    (d) => {
      ps(d).outlets.play_store = { pinned: [] };
    },
    ["/packSets/outlets"],
  );
  await bad(
    "feed-content-outlet-pinned-duplicate",
    "`pinned` names one pack twice.",
    (d) =>
      void (ps(d).outlets.steam.pinned = ["diceroll.foes", "diceroll.foes"]),
    ["/packSets/outlets/steam/pinned"],
  );
  await bad(
    "feed-content-gate-key-not-release",
    "A gate keyed by a hash that is not in `releases`.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("skins@1.0.0")] = {
        halted: true,
        fallback: null,
      }),
    ["/packSets/outlets/direct/gates"],
  );
  await bad(
    "feed-content-gate-halted-string",
    'A gate `halted` of `"false"`.',
    (d) => void (ps(d).outlets.direct.gates[h("tex@1.1.0")].halted = "false"),
    [`/packSets/outlets/direct/gates/${h("tex@1.1.0")}/halted`],
  );
  await bad(
    "feed-content-gate-bp-over",
    "A gate rollout `bp` of 10 001.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("foes@2.0.1")].rollout.bp = 10001),
    [gateBp],
  );
  await bad(
    "feed-content-gate-salt-bad",
    "A gate rollout salt of 31 hex digits.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("foes@2.0.1")].rollout.salt =
        P13_SALT.slice(1)),
    [`/packSets/outlets/direct/gates/${h("foes@2.0.1")}/rollout/salt`],
  );
  await bad(
    "feed-content-gate-fallback-dangling",
    "A gate `fallback` that is not in `releases`.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("tex@1.1.0")].fallback =
        h("skins@1.0.0")),
    [`/packSets/outlets/direct/gates/${h("tex@1.1.0")}/fallback`],
  );

  // Unusable `packFloors` and `revocations`.
  await bad(
    "feed-content-pack-floors-not-array",
    "`packFloors` is an object.",
    (d) => void (d.packFloors = {}),
    ["/packFloors"],
    "packFloors",
  );
  await bad(
    "feed-content-pack-floors-duplicate",
    "Two floors for one (pack, contentApi).",
    (d) => void (d.packFloors[1].contentApi = 3),
    ["/packFloors/1/contentApi"],
    "packFloors",
  );
  await bad(
    "feed-content-revocations-not-array",
    "`revocations` is an object.",
    (d) => void (d.revocations = {}),
    ["/revocations"],
    "revocations",
  );
  await bad(
    "feed-content-revocations-duplicate-record",
    "Two entries with one `record`.",
    (d) =>
      void d.revocations.push({
        ...d.revocations[0],
        target: h("foes@1.3.4"),
        version: "1.3.4",
        seq: 11,
      }),
    ["/revocations/1"],
    "revocations",
  );

  // The token rule and the minimum at each of the five integer pointers.
  const intCase = async (
    slug: string,
    pointer: string,
    member: "packSets" | "packFloors" | "revocations",
    set: (d: Record<string, any>, v: unknown) => void,
    token: string,
    min: number,
  ): Promise<void> => {
    await bad(
      `feed-content-${slug}-token`,
      `V4 §3.1: \`${pointer}\` written as the token \`${token}\`.`,
      (d) => set(d, raw(token)),
      [pointer],
      member,
      true,
    );
    await bad(
      `feed-content-${slug}-minimum`,
      `\`${pointer}\` ${min}, below its minimum.`,
      (d) => set(d, min),
      [pointer],
      member,
    );
  };
  await intCase(
    "release-seq",
    `/packSets/releases/${h("l10n@1.1.0")}/seq`,
    "packSets",
    (d, v) => void (ps(d).releases[h("l10n@1.1.0")].seq = v),
    "2.0",
    0,
  );
  await intCase(
    "row-content-api",
    "/packSets/rows/0/contentApi",
    "packSets",
    (d, v) => void (ps(d).rows[0].contentApi = v),
    "3.0",
    0,
  );
  await intCase(
    "gate-bp",
    gateBp,
    "packSets",
    (d, v) => void (ps(d).outlets.direct.gates[h("foes@2.0.1")].rollout.bp = v),
    "2500.0",
    -1,
  );
  await intCase(
    "floor-content-api",
    "/packFloors/0/contentApi",
    "packFloors",
    (d, v) => void (d.packFloors[0].contentApi = v),
    "3.0",
    0,
  );
  await intCase(
    "revocation-seq",
    "/revocations/0/seq",
    "revocations",
    (d, v) => void (d.revocations[0].seq = v),
    "10.0",
    0,
  );

  // ── plans/P4-29.md §4.2: 28 appended cases, each the base plus one `deltas` mutation ──────
  const T = (n: string): string => sha256Hex(`p4-29 payload ${n}`);
  const A = (n: string): string => sha256Hex(`p4-29 artifact ${n}`);
  const entry = (
    from: string,
    art: string,
    bytes: number,
    memBytes = 10515192,
  ): Record<string, unknown> => ({
    from: T(from),
    method: "zstd-patch-from",
    scope: "payload",
    memBytes,
    artifact: { sha256: A(art), bytes },
  });
  const menu = (): Record<string, any> => ({
    [T("foes@2.0.1")]: [
      entry("foes@1.3.4", "foes 1.3.4-2.0.1", 325258),
      entry("foes@2.0.0", "foes 2.0.0-2.0.1", 120000),
    ],
    [T("tex@1.1.0")]: [entry("tex@1.0.0", "tex 1.0.0-1.1.0", 4096, 2097152)],
  });
  const k0 = T("foes@2.0.1");
  const k1 = T("tex@1.1.0");
  /** 16 targets × 4 entries: `MAX_FEED_DELTAS` with 4 on every key. */
  const atCaps = (): Record<string, any> => {
    const m: Record<string, any> = {};
    for (let t = 0; t < 16; t++) {
      const list: unknown[] = [];
      for (let e = 0; e < 4; e++)
        list.push(
          entry(`cap ${t} base ${e}`, `cap ${t}-${e}`, 1000 + t * 4 + e),
        );
      m[T(`cap ${t}`)] = list;
    }
    return m;
  };
  const dm = async (
    id: string,
    description: string,
    patch: Patch,
    deltas: "usable" | "unusable",
    raw = false,
  ): Promise<void> =>
    mk(id, description, {
      patch: (d) => {
        d.deltas = menu();
        patch(d);
      },
      props: ["/deltas"],
      changes: [],
      deltas,
      raw,
    });

  // Valid (8).
  await dm(
    "feed-deltas-valid",
    "The delta menu (plans/P4-29.md §2.2): two target payloads, one with two `payload` entries; the three content members stay parsed.",
    () => {},
    "usable",
  );
  await mk(
    "feed-deltas-alone",
    "Only `deltas`: the three content members parse as null and the menu stands on its own.",
    {
      patch: (d) => {
        delete d.packSets;
        delete d.packFloors;
        delete d.revocations;
        d.deltas = menu();
      },
      props: ["/packSets", "/packFloors", "/revocations", "/deltas"],
      changes: ["packSets", "packFloors", "revocations"],
      deltas: "usable",
    },
  );
  await dm(
    "feed-deltas-empty-object",
    "`deltas: {}` is usable and offers nothing.",
    (d) => void (d.deltas = {}),
    "usable",
  );
  await dm(
    "feed-deltas-unknown-members-ignored",
    "Unknown members on an entry and on its `artifact` are ignored; the parsed entries carry the known members only.",
    (d) => {
      d.deltas[k0][0].size = 5256232;
      d.deltas[k0][0].windowLog = 23;
      d.deltas[k1][0].artifact.later = "x";
    },
    "usable",
  );
  await dm(
    "feed-deltas-unknown-method-kept",
    "An entry whose `method` is an unknown vocabulary token (`hdiffpatch`) is kept: the planner's `caps.patchMethods` decides.",
    (d) => void (d.deltas[k1][0].method = "hdiffpatch"),
    "usable",
  );
  await dm(
    "feed-deltas-files-scope-dropped",
    "An entry of a forward scope (`files`) is dropped alone; its sibling on the same key is kept.",
    (d) => void (d.deltas[k0][1].scope = "files"),
    "usable",
  );
  await dm(
    "feed-deltas-all-dropped-key-omitted",
    "A key whose only entry is of a forward scope is left out of the parsed menu; the other key stays.",
    (d) => void (d.deltas[k1][0].scope = "files"),
    "usable",
  );
  await dm(
    "feed-deltas-at-caps",
    "`MAX_FEED_DELTAS` (64) entries, `MAX_FEED_DELTAS_PER_TARGET` (4) on every key: usable.",
    (d) => void (d.deltas = atCaps()),
    "usable",
  );

  // Unusable (16): the three content members stay parsed in each.
  const ud = (id: string, description: string, patch: Patch, raw = false) =>
    dm(id, description, patch, "unusable", raw);
  await ud("feed-deltas-null", "A present `deltas: null` is unusable.", (d) => {
    d.deltas = null;
  });
  await ud("feed-deltas-array", "`deltas` is an array.", (d) => {
    d.deltas = [d.deltas[k0][0]];
  });
  await ud(
    "feed-deltas-bad-key",
    "A key that is not 64 lowercase hex (upper case).",
    (d) => {
      d.deltas[k1.toUpperCase()] = d.deltas[k1];
      delete d.deltas[k1];
    },
  );
  await ud("feed-deltas-empty-value", "A key whose list is empty.", (d) => {
    d.deltas[k1] = [];
  });
  await ud(
    "feed-deltas-over-per-target",
    "Five entries on one key, over `MAX_FEED_DELTAS_PER_TARGET`.",
    (d) => {
      for (let e = 2; e < 5; e++)
        d.deltas[k0].push(entry(`foes base ${e}`, `foes extra ${e}`, 2000 + e));
    },
  );
  await ud(
    "feed-deltas-over-total",
    "65 entries in all, over `MAX_FEED_DELTAS` (each key within its own cap).",
    (d) => {
      d.deltas = atCaps();
      d.deltas[k1] = [entry("tex@1.0.0", "tex 1.0.0-1.1.0", 4096, 2097152)];
    },
  );
  await ud(
    "feed-deltas-entry-not-object",
    "An entry that is a string.",
    (d) => {
      d.deltas[k1][0] = "delta";
    },
  );
  await ud("feed-deltas-from-missing", "An entry without `from`.", (d) => {
    delete d.deltas[k1][0].from;
  });
  await ud(
    "feed-deltas-from-malformed",
    "An entry whose `from` is 63 hex digits.",
    (d) => void (d.deltas[k1][0].from = T("tex@1.0.0").slice(1)),
  );
  await ud(
    "feed-deltas-from-is-target",
    "An entry whose `from` equals its own key.",
    (d) => void (d.deltas[k1][0].from = k1),
  );
  await ud(
    "feed-deltas-bad-method",
    '`method: "Zstd-patch-from"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => void (d.deltas[k1][0].method = "Zstd-patch-from"),
  );
  await ud(
    "feed-deltas-bad-scope",
    '`scope: "Payload"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => void (d.deltas[k1][0].scope = "Payload"),
  );
  await ud(
    "feed-deltas-bad-artifact",
    "An entry whose `artifact.sha256` is not 64 lowercase hex (upper case).",
    (d) =>
      void (d.deltas[k1][0].artifact.sha256 =
        A("tex 1.0.0-1.1.0").toUpperCase()),
  );
  await ud(
    "feed-deltas-duplicate-artifact",
    "One `artifact.sha256` listed under two keys.",
    (d) =>
      void (d.deltas[k1][0].artifact.sha256 = d.deltas[k0][0].artifact.sha256),
  );
  await ud(
    "feed-deltas-duplicate-pair",
    "Two entries with one (`from`, `method`) on a key.",
    (d) => void (d.deltas[k0][1].from = d.deltas[k0][0].from),
  );
  await ud(
    "feed-deltas-duplicate-with-dropped",
    "A (`from`, `method`) duplicate whose first entry is of a forward scope: dropped entries count toward uniqueness.",
    (d) => {
      d.deltas[k0][0].scope = "files";
      d.deltas[k0][1].from = d.deltas[k0][0].from;
    },
  );

  // The token rule and the minimum at the two integer pointers (4).
  const memAt = `/deltas/${k1}/0/memBytes`;
  const bytesAt = `/deltas/${k1}/0/artifact/bytes`;
  await ud(
    "feed-deltas-mem-bytes-token",
    `V4 §3.1: \`${memAt}\` written as the token \`3.0\`.`,
    (d) => void (d.deltas[k1][0].memBytes = raw("3.0")),
    true,
  );
  await ud(
    "feed-deltas-mem-bytes-minimum",
    `\`${memAt}\` 0, below its minimum.`,
    (d) => void (d.deltas[k1][0].memBytes = 0),
  );
  await ud(
    "feed-deltas-artifact-bytes-token",
    `V4 §3.1: \`${bytesAt}\` written as the token \`1.0\`.`,
    (d) => void (d.deltas[k1][0].artifact.bytes = raw("1.0")),
    true,
  );
  await ud(
    "feed-deltas-artifact-bytes-minimum",
    `\`${bytesAt}\` 0, below its minimum.`,
    (d) => void (d.deltas[k1][0].artifact.bytes = 0),
  );

  // Every set key is the `packSetId` of its members, in every case whose `packSets` parses.
  for (const c of cases) {
    const p = c.expect.content.packSets as Record<string, any> | null;
    if (p === null) continue;
    for (const [id, members] of Object.entries<string[]>(p.sets))
      if (
        id !==
        refPackSetId(members.map((m) => [p.releases[m].pack as string, m]))
      )
        throw new Error(
          `feedContentCases ${c.id}: set ${id} is not its packSetId`,
        );
  }
  if (cases.length !== P13_COUNTS.feedContentCases)
    throw new Error(
      `feedContentCases: ${cases.length} != ${P13_COUNTS.feedContentCases}`,
    );
  // plans/P4-29.md §4.2: the menu's cases are appended; the at-caps payload stays in the cap.
  const appended = cases.filter((c) => c.expect.deltas !== undefined);
  if (appended.length !== 28 || cases.indexOf(appended[0]!) !== 48)
    throw new Error("feedContentCases: the 28 P4-29 cases must follow the 48");
  const capCase = cases.find((c) => c.id === "feed-deltas-at-caps")!;
  if (Buffer.from(capCase.jws.split(".")[1]!, "base64url").byteLength > 65536)
    throw new Error(
      "feedContentCases: feed-deltas-at-caps is over 65,536 bytes",
    );
  return cases;
}

/** The three appended `feedCases` (plans/P4-13.md §4.2): every runner verifies them. */
export async function appendContentFeedCases(
  mk: (
    id: string,
    description: string,
    o: { doc?: Record<string, unknown>; expect: "ok" },
  ) => Promise<void>,
  base: Record<string, unknown>,
): Promise<void> {
  await mk(
    "feed-valid-content-members-populated",
    "P4-13: a channel-wide feed carrying all three content members (`packSets` with every row kind, `packFloors`, `revocations`). A v4 verifier ignores them: the verdict is FC's.",
    { doc: { ...structuredClone(base), ...p13FeedMembers() }, expect: "ok" },
  );
  const perPlatform = {
    ...structuredClone(base),
    ...p13FeedMembers(),
  } as Record<string, any>;
  perPlatform.selector = { platform: "macos" };
  perPlatform.app.targets = [perPlatform.app.targets[0]];
  perPlatform.packSets = p13PackSets(
    [
      [3, "macos", "godot-4.4", {}, ["foes@1.3.4", "l10n@1.1.0"]],
      [4, "macos", "godot-4.4", {}, ["foes@2.0.1", "l10n@1.1.0"]],
    ],
    { "app-store": { pinned: ["diceroll.foes"] } },
  );
  await mk(
    "feed-valid-content-members-per-platform",
    "P4-13: a per-platform feed (`selector: {platform: macos}`) with its own rows only, every floor and revocation.",
    { doc: perPlatform, expect: "ok" },
  );
  // At the cap: `packSets` rows padded until the payload is exactly 65 536 bytes.
  const atCap = {
    ...structuredClone(base),
    ...p13FeedMembers(),
  } as Record<string, any>;
  const size = (o: unknown): number => utf8Bytes(JSON.stringify(o)).length;
  const rows = atCap.packSets.rows as Record<string, unknown>[];
  const set0 = rows[0]!.set as string;
  for (let api = 100; ; api++) {
    const row = {
      contentApi: api,
      platform: "linux",
      engine: "godot-4.4",
      variant: {},
      set: set0,
    };
    rows.push(row);
    if (size(atCap) > 65536 - 200) break;
  }
  const last = rows[rows.length - 1]!;
  last.pad = "";
  const room = 65536 - size(atCap);
  if (room < 0) throw new Error("feed-valid-content-at-cap: overshoot");
  last.pad = "A".repeat(room);
  if (size(atCap) !== 65536)
    throw new Error(`feed-valid-content-at-cap: ${size(atCap)} bytes`);
  if (refFeedContent(atCap, null).packSets === null)
    throw new Error("feed-valid-content-at-cap: packSets must stay usable");
  await mk(
    "feed-valid-content-at-cap",
    "P4-13: the generator's at-cap test, a content-carrying payload of exactly 65 536 bytes (its `packSets` rows padded). An over-cap payload is `jwsCases`' oversize case.",
    { doc: atCap, expect: "ok" },
  );
}

/** The content corpus over the signed pack records (`tools/gen-content-corpus.ts`), with the join
 *  self-check: every `refs.json` entry is pinned by a valid record or a `plan-real-*` row. */
export async function buildContent(): Promise<{
  cases: Record<string, unknown>;
  planMatrix: Record<string, unknown>;
}> {
  const packs = await packRecords();
  const built = buildContentCorpus(REF_JSON, contentSet(), {
    get: (name) => {
      const r = packs.get(name);
      if (!r) throw new Error(`content corpus: no pack record ${name}`);
      return { doc: r.doc, sha256: r.sha256 };
    },
    appContent: appTwin(packs).content as Record<string, unknown>,
    docsPin: (() => {
      const r = packs.get("djdl.docs@1.0.0")!;
      return { sha256: r.sha256, seq: r.doc.seq, version: r.doc.version };
    })(),
  });
  const pinned = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (typeof v.sha256 === "string") pinned.add(v.sha256);
      Object.values(v).forEach(walk);
    }
  };
  for (const r of packs.values()) walk(r.doc.variants);
  for (const [name, r] of Object.entries(contentSet().refsJson))
    if (!pinned.has(r.sha256) && !built.planRealPins.has(name))
      throw new Error(
        `content corpus: refs.json ${name} is pinned by no record or plan row`,
      );
  return { cases: built.cases, planMatrix: built.planMatrix };
}
