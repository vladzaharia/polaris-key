/**
 * `pkey channel add <id>` (A-25.2, UX-56): append a channel's outlet to `.pkey/distribution`.
 *
 * The block comes from `outletBlockEntry` (one declaration, shared with the console). YAML is
 * edited through the `yaml` Document API so the file's comments and layout survive; JSON is
 * rewritten with two-space indent (D-A8). The whole `.pkey/` is validated before anything is
 * written, and a refusal writes nothing.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  OUTLET_ID_PATTERN,
  outletBlockEntry,
  renderOutletBlock,
  type OutletBlockEntry,
} from "@polaris-key/manifest";
import type { ChannelArgs, ChannelIo } from "./channel.js";
import { CHANNEL_USAGE } from "./channel.js";
import { UsageError } from "./errors.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";

const KNOWN_FLAGS = ["field", "outlet-id", "json"];

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

export async function channelAdd(
  a: ChannelArgs,
  io: ChannelIo,
): Promise<number> {
  const unknown = Object.keys(a.flags).find((k) => !KNOWN_FLAGS.includes(k));
  if (unknown !== undefined)
    throw new UsageError(`Unknown option --${unknown}.\n${CHANNEL_USAGE}`);
  const [, id, ...extra] = a.positional;
  if (!id || extra.length > 0) throw new UsageError(CHANNEL_USAGE);
  const json = a.flags.json === true || a.flags.json === "true";
  const outletId = a.flags["outlet-id"];
  if (outletId !== undefined && typeof outletId !== "string")
    throw new UsageError("--outlet-id needs a value.");
  if (a.flags.field === true) throw new UsageError("--field needs a value.");
  const identity = parseFields(a.multi.field ?? []);
  if (outletId !== undefined && !OUTLET_ID_PATTERN.test(outletId))
    throw new UsageError(
      `--outlet-id "${outletId}" must match ${OUTLET_ID_PATTERN.source}.`,
    );

  let block: OutletBlockEntry;
  try {
    block = outletBlockEntry(id, identity, { outletId });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }

  const refuse = (problems: string[]): number => {
    if (json)
      io.stdout.write(
        `${JSON.stringify({ v: 1, command: "channel add", event: "result", ok: false, exit: 1, channel: id, outlet: block.id, errors: problems })}\n`,
      );
    else
      io.stderr.write(
        `Nothing written. ${problems.length === 1 ? problems[0] : `${problems.length} problems:\n${problems.map((p) => `  ${p}`).join("\n")}`}\n`,
      );
    return 1;
  };

  const loaded = await loadManifest(io.cwd);
  const file =
    loaded.distributionPath ?? path.join(loaded.rootDir, "distribution.yaml");
  const asJson = file.endsWith(".json");
  const existing = loaded.distributionPath !== undefined;
  const rel = path.relative(io.cwd, file);

  if (existing && !isMap(loaded.distribution) && loaded.distribution != null)
    return refuse([`${rel} must be a mapping.`]);
  const outlets = isMap(loaded.distribution)
    ? loaded.distribution.outlets
    : undefined;
  if (outlets != null && !isMap(outlets))
    return refuse([`outlets in ${rel} must be a mapping.`]);
  if (isMap(outlets) && block.id in outlets)
    return refuse([
      `${rel} already declares outlet ${block.id}. Pick another with --outlet-id.`,
    ]);

  let text: string;
  try {
    if (!existing) {
      text = renderOutletBlock(id, identity, { format: "yaml", outletId });
    } else if (asJson) {
      const doc = isMap(loaded.distribution) ? loaded.distribution : {};
      text = `${JSON.stringify({ ...doc, outlets: { ...(outlets ?? {}), [block.id]: block.entry } }, null, 2)}\n`;
    } else {
      text = appendYaml(await readFile(file, "utf8"), block);
    }
  } catch (e) {
    if (e instanceof Refusal) return refuse([e.message]);
    throw e;
  }

  const next: unknown = asJson ? JSON.parse(text) : YAML.parse(text);
  const result = validateLoadedManifest({
    ...loaded,
    distributionPath: file,
    distribution: next,
  });
  if (!result.ok)
    return refuse(result.errors.map((e) => `${e.file}${e.path}: ${e.message}`));

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  if (json)
    io.stdout.write(
      `${JSON.stringify({ v: 1, command: "channel add", event: "result", ok: true, exit: 0, channel: id, outlet: block.id, file: rel, created: !existing })}\n`,
    );
  else
    io.stdout.write(
      `${existing ? "Added" : "Created"} outlet ${block.id} in ${rel}.\n\n${text}\nNext: pkey validate\n`,
    );
  return 0;
}
