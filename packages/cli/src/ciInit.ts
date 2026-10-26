/**
 * `pkey ci init` (A-32.9, UX-62's One command): write `.github/workflows/release.yml` from
 * `renderCiWorkflow` (the one renderer), and when `.pkey/release` declares no release key, make one.
 *
 * The private half goes to a 0600 file outside the repo and nowhere else: never stdout, never the
 * answer, never a log. The command prints the `gh secret set` line and never runs `gh` or pipes
 * the key (plan D-G6). Nothing is written when the workflow exists (without --force) or `.pkey/`
 * does not validate.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import YAML from "yaml";
import {
  ACTION_REF_PLACEHOLDER,
  PUBLISH_ACTION,
  renderCiWorkflow,
  type ManifestReleaseKey,
} from "@polaris-key/manifest";
import { envelope } from "./account.js";
import type { ChannelArgs, ChannelIo } from "./channel.js";
import { errorLine, manifestError, termOf, unknownOption } from "./channel.js";
import { UsageError } from "./errors.js";
import {
  loadManifest,
  validateLoadedManifest,
  type LoadedManifest,
} from "./manifest.js";
import { generateReleaseKey, RELEASE_KEY_ENV } from "./releaseKeys.js";
import { failLine } from "./terminal.js";
import { untrustedLines } from "./untrusted.js";
import { wrapSpans } from "@polaris-key/node/terminal";

export const CI_INIT_USAGE =
  "Usage: pkey ci init [--channel c] [--dir d] [--action-ref sha] [--force] [--json]";

const KNOWN_FLAGS = ["channel", "dir", "action-ref", "force", "json"];

/** The workflow's path in the repo. */
export const WORKFLOW_PATH = ".github/workflows/release.yml";
const KID = "release-1";

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function declaredKeys(loaded: LoadedManifest): ManifestReleaseKey[] {
  const keys = isMap(loaded.release) ? loaded.release.releaseKeys : undefined;
  return Array.isArray(keys) ? (keys as ManifestReleaseKey[]) : [];
}

/** `.pkey/release` with the key entry added: YAML keeps its comments, JSON is rewritten. */
function withKey(
  loaded: LoadedManifest,
  file: string,
  entry: { kid: string; publicKey: string },
  raw: string,
): { text: string; doc: unknown } {
  if (file.endsWith(".json")) {
    const doc = { ...(isMap(loaded.release) ? loaded.release : {}) };
    doc.releaseKeys = [entry];
    return { text: `${JSON.stringify(doc, null, 2)}\n`, doc };
  }
  const parsed = YAML.parseDocument(raw) as unknown as YAML.Document;
  if (parsed.errors.length > 0)
    throw new UsageError(`${path.basename(file)} is not valid YAML.`);
  if (parsed.contents === null)
    parsed.contents = parsed.createNode({}) as YAML.YAMLMap;
  if (!YAML.isMap(parsed.contents))
    throw new UsageError(`${path.basename(file)} must be a mapping.`);
  parsed.contents.set("releaseKeys", parsed.createNode([entry]));
  return {
    text: parsed.toString({ lineWidth: 0 }),
    doc: parsed.toJS() as unknown,
  };
}

/** Where the private key goes: the user's config directory, never the repo. */
function keyDir(io: ChannelIo): string {
  const xdg = io.env.XDG_CONFIG_HOME;
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "pkey", "release-keys");
}

const RELEASE_DOCS = "https://key.plrs.im/docs/build/manifest/release/";

/** The tag to suggest: the next patch after the highest `vX.Y.Z` here, else v1.0.0. */
function nextTag(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["tag", "-l", "v*"], { cwd, timeout: 5000 }, (err, out) => {
      if (err) return resolve("v1.0.0");
      let best: [number, number, number] | null = null;
      for (const t of String(out).split("\n")) {
        const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(t.trim());
        if (!m) continue;
        const v: [number, number, number] = [+m[1]!, +m[2]!, +m[3]!];
        if (
          !best ||
          v[0] > best[0] ||
          (v[0] === best[0] &&
            (v[1] > best[1] || (v[1] === best[1] && v[2] > best[2])))
        )
          best = v;
      }
      resolve(best ? `v${best[0]}.${best[1]}.${best[2] + 1}` : "v1.0.0");
    });
  });
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A path as the shell takes it: single-quoted only when it has to be. */
function shellPath(p: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(p)
    ? p
    : `'${p.replace(/'/g, `'\\''`)}'`;
}

export async function ciInit(a: ChannelArgs, io: ChannelIo): Promise<number> {
  const bad = unknownOption(a, io, KNOWN_FLAGS);
  if (bad !== null) return bad;
  if (a.positional.length > 1) throw new UsageError(CI_INIT_USAGE);
  const json = a.flags.json === true || a.flags.json === "true";
  const flag = (name: string): string | undefined => {
    const v = a.flags[name];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new UsageError(`--${name} needs a value.`);
    return v;
  };
  const channel = flag("channel") ?? "stable";
  const dir = flag("dir") ?? "dist";
  const ref = flag("action-ref") ?? ACTION_REF_PLACEHOLDER;
  const force = a.flags.force === true || a.flags.force === "true";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(channel))
    throw new UsageError(
      `--channel "${channel}": use lowercase letters, digits, dots, hyphens and underscores.`,
    );
  if (!/^[A-Za-z0-9._/-]+$/.test(dir))
    throw new UsageError(
      `--dir "${dir}": use a plain relative path, like dist.`,
    );
  if (ref !== ACTION_REF_PLACEHOLDER && !/^[0-9a-f]{40}$/.test(ref))
    throw new UsageError(
      "--action-ref must be a full 40-character commit SHA.",
    );

  const term = termOf(io, io.stderr);
  // Every failure here is `errors[{code, message}]` in --json and a failure line in text.
  const refuse = (
    code: string,
    message: string,
    extra = {},
    link?: string,
  ): number => {
    if (json)
      io.stdout.write(
        envelope("ci init", 1, {
          errors: [{ code, message: link ? `${message} ${link}` : message }],
          ...extra,
        }),
      );
    else {
      io.stderr.write(failLine(untrustedLines(message, io.env), term));
      if (link) io.stderr.write(`   ${link}\n`);
    }
    return 1;
  };

  let loaded: LoadedManifest;
  try {
    loaded = await loadManifest(io.cwd);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    return refuse(manifestError(e).error, manifestError(e).message);
  }
  const slug = (
    isMap(loaded.product.product) ? loaded.product.product : loaded.product
  ).slug;
  if (typeof slug !== "string")
    throw new UsageError(".pkey/product has no slug.");

  const workflow = path.join(io.cwd, WORKFLOW_PATH);
  if (!force && (await exists(workflow)))
    return refuse(
      "workflow-exists",
      `${WORKFLOW_PATH} exists. --force replaces it.`,
    );

  const before = validateLoadedManifest(loaded);
  if (!before.ok) {
    const n = before.errors.length;
    if (json)
      return refuse(
        "invalid-manifest",
        `.pkey/ has ${n} error${n === 1 ? "" : "s"}.`,
      );
    io.stderr.write(
      failLine(
        `.pkey/ has ${n} error${n === 1 ? "" : "s"}; fix it first (pkey validate).`,
        term,
      ),
    );
    for (const e of before.errors)
      io.stderr.write(
        `${untrustedLines(errorLine(loaded, e, io.cwd, term), io.env)}\n`,
      );
    return 1;
  }

  // The key: declared already, or made now.
  const declared = declaredKeys(loaded);
  let made: { kid: string; publicKey: string; out: string } | null = null;
  let releaseText: { file: string; text: string } | null = null;
  if (declared.length === 0) {
    const outDir = keyDir(io);
    const repo = path.resolve(io.cwd);
    const rel = path.relative(repo, outDir);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
      return refuse(
        "key-in-repo",
        "The key directory is inside the repo. Set XDG_CONFIG_HOME outside it.",
      );
    const out = path.join(outDir, `${slug}-${KID}.pem`);
    if (await exists(out))
      return refuse(
        "key-exists",
        `${out} exists. Move it first; pkey never overwrites a key.`,
      );
    if (!loaded.releasePath)
      return refuse(
        "no-release",
        "No .pkey/release. Add one, then rerun pkey ci init:",
        {},
        RELEASE_DOCS,
      );
    const file = loaded.releasePath;
    const raw = await readFile(file, "utf8");
    // Dry-run the manifest edit with a stand-in key before any key is written.
    const probe = withKey(
      loaded,
      file,
      { kid: KID, publicKey: "A".repeat(43) },
      raw,
    );
    const after = validateLoadedManifest({
      ...loaded,
      releasePath: file,
      release: probe.doc,
    });
    if (!after.ok)
      return refuse(
        "invalid-release",
        `Nothing written. ${after.errors[0]!.file}${after.errors[0]!.path}: ${after.errors[0]!.message}`,
      );
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const key = await generateReleaseKey({ kid: KID, out });
    made = { kid: KID, publicKey: key.publicKey, out };
    releaseText = {
      file,
      text: withKey(loaded, file, { kid: KID, publicKey: key.publicKey }, raw)
        .text,
    };
  }

  const text = renderCiWorkflow({
    product: slug,
    channel,
    actionRef: ref,
    releaseKeys: true,
    dir,
  });
  try {
    await mkdir(path.dirname(workflow), { recursive: true });
    await writeFile(workflow, text);
    if (releaseText) await writeFile(releaseText.file, releaseText.text);
  } catch (e) {
    // A key whose public half never reached the manifest is of no use, and the next run would
    // refuse to overwrite it: take back the file this run made.
    if (made) await rm(made.out, { force: true });
    throw e;
  }

  const relRelease = path.relative(io.cwd, loaded.releasePath ?? "");
  const pinned = ref !== ACTION_REF_PLACEHOLDER;
  if (json) {
    io.stdout.write(
      envelope("ci init", 0, {
        workflow: WORKFLOW_PATH,
        replaced: force,
        release: relRelease,
        key: made
          ? {
              kid: made.kid,
              publicKey: made.publicKey,
              file: made.out,
              mode: "0600",
            }
          : {
              kid: declared[0]!.kid,
              publicKey: declared[0]!.publicKey,
              file: null,
            },
        secret: RELEASE_KEY_ENV,
        environment: "release",
        pinned,
      }),
    );
    return 0;
  }

  const t = termOf(io, io.stdout);
  const mark = t.painter.style(t.symbols.ok, ["success"]);
  const width = Math.max(20, t.caps.columns - 3);
  const prose = (lead: string, body: string): string[] =>
    wrapSpans([{ text: body }], width).map(
      (l, i) => `${i === 0 ? lead : "   "}${t.painter.line(l)}`,
    );
  const out: string[] = [
    ...prose(`${mark}  `, `${force ? "Replaced" : "Wrote"} ${WORKFLOW_PATH}`),
  ];
  if (made) {
    out.push(
      ...prose(`${mark}  `, `Added public key ${made.kid} to ${relRelease}`),
      ...prose(
        `${mark}  `,
        "Saved the private key outside the repo (mode 0600):",
      ),
      `   ${untrustedLines(made.out, io.env)}`,
    );
  } else {
    out.push(
      ...prose(`${mark}  `, `Kept key ${declared[0]!.kid} in ${relRelease}`),
    );
  }
  out.push("", "Next:");
  let n = 1;
  if (!pinned)
    out.push(
      ...prose(
        `${n++}. `,
        `Replace ${ACTION_REF_PLACEHOLDER} in ${WORKFLOW_PATH} with a ${PUBLISH_ACTION.split("/").slice(0, 2).join("/")} commit SHA.`,
      ),
    );
  // Every command is one unwrapped line: a terminal re-joins a soft wrap on copy.
  out.push(
    `${n++}. Create the release environment, limited to v* tags (skip the first command if it exists: it can reset its reviewers):`,
    "   gh api -X PUT repos/{owner}/{repo}/environments/release -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true' --silent",
    "   gh api -X POST repos/{owner}/{repo}/environments/release/deployment-branch-policies -f 'name=v*' -f type=tag --silent",
  );
  if (made) {
    const keyPath = untrustedLines(made.out, io.env);
    out.push(
      `${n++}. Store the key:`,
      process.platform === "win32"
        ? `   Get-Content -Raw '${keyPath.replace(/'/g, "''")}' | gh secret set ${RELEASE_KEY_ENV} --env release`
        : `   gh secret set ${RELEASE_KEY_ENV} --env release < ${shellPath(keyPath)}`,
    );
  } else
    out.push(
      ...prose(
        `${n++}. `,
        `Store the ${declared[0]!.kid} private key as ${RELEASE_KEY_ENV} in the release environment, unless it is there already.`,
      ),
    );
  const tag = await nextTag(io.cwd);
  out.push(
    `${n}. Commit and release:`,
    `   git add ${WORKFLOW_PATH}${made ? ` ${shellPath(relRelease)}` : ""}`,
    '   git commit -m "Publish releases from CI"',
    `   git tag ${tag} && git push origin HEAD ${tag}`,
  );
  io.stdout.write(`${out.join("\n")}\n`);
  return 0;
}
