/**
 * `pkey channel add <id>` (A-25.2, UX-56): append a channel's outlet to `.pkey/distribution`.
 *
 * The block comes from `outletBlockEntry` (one declaration, shared with the console). YAML is
 * edited through the `yaml` Document API so the file's comments and layout survive; JSON is
 * rewritten with two-space indent (D-A8). The whole `.pkey/` is validated before anything is
 * written, and a refusal writes nothing. The answer shows only the entry it added.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  OUTLET_ID_PATTERN,
  channelIdentityFields,
  findChannel,
  outletBlockEntry,
  outletFieldLabel,
  renderOutletBlock,
  type OutletBlockEntry,
} from "@polaris-key/manifest";
import { envelope } from "./account.js";
import type { ChannelArgs, ChannelIo } from "./channel.js";
import {
  ADD_USAGE,
  errorLine,
  manifestFailure,
  messageEntry,
  termOf,
  unknownOption,
} from "./channel.js";
import { UsageError } from "./errors.js";
import { ADDABLE_CHANNELS } from "./help.js";
import {
  loadManifest,
  validateLoadedManifest,
  type LoadedManifest,
} from "./manifest.js";
import { nearest } from "./suggest.js";
import { untrustedLines } from "./untrusted.js";

/** `product` and `base-url` are what the help row's context fills in; add reads neither. */
const KNOWN_FLAGS = ["field", "outlet-id", "json", "product", "base-url"];

/** `name=value`: a value that starts `[` or `{` is JSON, anything else stays a string. */
function parseFields(values: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of values) {
    const at = raw.indexOf("=");
    if (at < 1)
      throw new UsageError(`--field must be name=value, not "${raw}".`);
    const name = raw.slice(0, at);
    const text = raw.slice(at + 1);
    if (name in out) throw new UsageError(`--field ${name} is given twice.`);
    if (/^\s*[[{]/.test(text)) {
      try {
        out[name] = JSON.parse(text) as unknown;
      } catch {
        throw new UsageError(`--field ${name} is not valid JSON.`);
      }
    } else out[name] = text;
  }
  return out;
}

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Refusal extends Error {}

/** The YAML text with the entry appended under `outlets`, comments kept. */
function appendYaml(raw: string, b: OutletBlockEntry): string {
  const doc = YAML.parseDocument(raw) as unknown as YAML.Document;
  if (doc.errors.length > 0)
    throw new Refusal(
      `distribution is not valid YAML: ${doc.errors[0]!.message}`,
    );
  if (doc.contents === null) doc.contents = doc.createNode({}) as YAML.YAMLMap;
  if (!YAML.isMap(doc.contents))
    throw new Refusal("distribution must be a mapping.");
  let outlets: unknown = doc.contents.get("outlets", true);
  if (outlets === undefined || outlets === null) {
    outlets = doc.createNode({}) as YAML.YAMLMap;
    doc.contents.set("outlets", outlets);
  }
  if (!YAML.isMap(outlets))
    throw new Refusal("outlets in distribution must be a mapping.");
  const node = doc.createNode(b.entry) as YAML.YAMLMap;
  for (const p of node.items as YAML.Pair<YAML.Scalar>[]) {
    const comment = b.comments[String(p.key.value)];
    if (comment) p.key.commentBefore = ` ${comment}`;
  }
  const key = new YAML.Scalar(b.id);
  key.commentBefore = ` ${b.label}`;
  outlets.items.push(new YAML.Pair(key, node));
  return doc.toString({ lineWidth: 0 });
}

/** What a direct package manager needs before its entry is more than `kind: direct`. */
const MARKERS: Readonly<Record<string, string>> = {
  homebrew:
    "homebrew needs --field homebrewTap=owner/homebrew-name and --field homebrewCask=token (or homebrewFormula=name).",
  scoop:
    'scoop needs --field scoopBucket=owner/repo (or --field scoop=\'{"bin":"app.exe"}\').',
};

interface Problem {
  code: string;
  message: string;
  at: string;
  file: string | null;
}

/** The `Fields not set` line: each field with its label, or null when every field is set. */
function unsetFields(
  channelId: string,
  kind: string,
  given: Record<string, unknown>,
): string | null {
  const rest = channelIdentityFields(channelId).filter(
    (f) => given[f] === undefined,
  );
  if (!rest.length) return null;
  const items = rest.map(
    (f) =>
      `${f} (${outletFieldLabel(kind as never, f).replace(/(?: \([^)]*\))?\.$/, "")})`,
  );
  return `Fields not set: ${items.join(", ")}. Set one with --field name=value.`;
}

export async function channelAdd(
  a: ChannelArgs,
  io: ChannelIo,
): Promise<number> {
  const bad = unknownOption(a, io, KNOWN_FLAGS);
  if (bad !== null) return bad;
  const [, id, ...extra] = a.positional;
  if (!id || extra.length > 0) throw new UsageError(ADD_USAGE);
  const json = a.flags.json === true || a.flags.json === "true";
  const outletId = a.flags["outlet-id"];
  if (outletId !== undefined && typeof outletId !== "string")
    throw new UsageError("--outlet-id needs a value.");
  if (a.flags.field === true) throw new UsageError("--field needs a value.");
  const identity = parseFields(a.multi.field ?? []);
  if (outletId !== undefined && !OUTLET_ID_PATTERN.test(outletId))
    throw new UsageError(
      `--outlet-id "${outletId}": use lowercase letters, digits and hyphens, starting with a letter, like itch-beta.`,
    );

  const channel = findChannel(id);
  if (!channel || !ADDABLE_CHANNELS.includes(channel.id)) {
    const near = nearest(id, ADDABLE_CHANNELS);
    throw new UsageError(
      `Unknown channel "${id}". ${near ? `Did you mean ${near}?` : "Run pkey help channel for the list."}`,
    );
  }
  const fields = channelIdentityFields(channel.id);
  const wrong = Object.keys(identity).find((k) => !fields.includes(k as never));
  if (wrong !== undefined)
    throw new UsageError(
      `Unknown field ${wrong} for ${channel.id}. ${fields.length ? `Its fields: ${fields.join(", ")}.` : "It takes no fields."}`,
    );
  const block: OutletBlockEntry = outletBlockEntry(channel.id, identity, {
    outletId,
  });

  let loaded: LoadedManifest;
  try {
    loaded = await loadManifest(io.cwd);
  } catch (e) {
    return manifestFailure("channel add", e, io, json);
  }
  const term = termOf(io, io.stderr);
  const file =
    loaded.distributionPath ?? path.join(loaded.rootDir, "distribution.yaml");
  const asJson = file.endsWith(".json");
  const existing = loaded.distributionPath !== undefined;
  const rel = path.relative(io.cwd, file);

  const refuse = (text: string, problems: Problem[]): number => {
    if (json)
      io.stdout.write(
        envelope("channel add", 1, {
          channel: channel.id,
          outlet: block.id,
          errors: problems,
        }),
      );
    else io.stderr.write(`${untrustedLines(text, io.env)}\n`);
    return 1;
  };
  const simple = (code: string, message: string): Problem => ({
    code,
    message,
    at: rel,
    file: rel,
  });
  const nothing = (code: string, message: string): number =>
    refuse(`Nothing written. ${message}`, [simple(code, message)]);

  const marker = MARKERS[channel.id];
  if (marker && !fields.some((f) => identity[f] !== undefined))
    return nothing("missing-field", marker);

  const before = validateLoadedManifest(loaded);
  if (!before.ok)
    return refuse(
      `Nothing written: .pkey/ already has ${before.errors.length} error${before.errors.length === 1 ? "" : "s"}. Fix it first (pkey validate):\n${before.errors.map((e) => errorLine(loaded, e, io.cwd, term)).join("\n")}`,
      before.errors.map((e) => messageEntry(loaded, e, io.cwd)),
    );

  if (existing && !isMap(loaded.distribution) && loaded.distribution != null)
    return nothing("invalid-file", `${rel} must be a mapping.`);
  const outlets = isMap(loaded.distribution)
    ? loaded.distribution.outlets
    : undefined;
  if (outlets != null && !isMap(outlets))
    return nothing("invalid-file", `outlets in ${rel} must be a mapping.`);
  if (isMap(outlets) && block.id in outlets) {
    const message = `${rel} already declares ${block.id}. Name this one with --outlet-id, like --outlet-id ${block.id}-beta.`;
    return refuse(message, [simple("duplicate-outlet", message)]);
  }

  let text: string;
  try {
    if (!existing) {
      text = renderOutletBlock(channel.id, identity, {
        format: "yaml",
        outletId,
      });
    } else if (asJson) {
      const doc = isMap(loaded.distribution) ? loaded.distribution : {};
      text = `${JSON.stringify({ ...doc, outlets: { ...(outlets ?? {}), [block.id]: block.entry } }, null, 2)}\n`;
    } else {
      text = appendYaml(await readFile(file, "utf8"), block);
    }
  } catch (e) {
    if (e instanceof Refusal) return nothing("invalid-file", e.message);
    throw e;
  }

  const next: unknown = asJson ? JSON.parse(text) : YAML.parse(text);
  const after = { ...loaded, distributionPath: file, distribution: next };
  const result = validateLoadedManifest(after);
  if (!result.ok) {
    const own = `/outlets/${block.id}/`;
    const lines = result.errors.map((e) => {
      const field = e.path.startsWith(own) ? e.path.slice(own.length) : "";
      return field in identity
        ? `--field ${field} ${e.message.replace(`outlets.${block.id}.${field} `, "")}`
        : `${e.file}${e.path}: ${e.message}`;
    });
    return refuse(
      `Nothing written. ${lines.length === 1 ? lines[0] : `${lines.length} problems:\n${lines.map((l) => `  ${l}`).join("\n")}`}`,
      result.errors.map((e) => messageEntry(after, e, io.cwd)),
    );
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  if (json) {
    io.stdout.write(
      envelope("channel add", 0, {
        channel: channel.id,
        outlet: block.id,
        file: rel,
        created: !existing,
      }),
    );
    return 0;
  }
  const shown = renderOutletBlock(channel.id, identity, {
    format: asJson ? "json" : "yaml",
    outletId,
  });
  const unset = unsetFields(channel.id, channel.outlet.kind, identity);
  io.stdout.write(
    `${untrustedLines(
      [
        existing
          ? `Added ${block.id} to ${rel}.`
          : `Created ${rel} with ${block.id}.`,
        "",
        shown.trimEnd(),
        "",
        ...(unset ? [unset] : []),
        "Next: pkey channel sync --dry-run",
      ].join("\n"),
      io.env,
    )}\n`,
  );
  return 0;
}
