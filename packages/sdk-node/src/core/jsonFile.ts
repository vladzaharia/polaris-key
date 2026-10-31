// Small persisted JSON files in the product's state directory (the update-health journal, the
// boot guard's slots, local config overrides). Reads never throw — a missing or corrupt file is
// the fallback — and writes are atomic: a temporary file in the same directory, then a rename,
// so a crash mid-write leaves the previous contents rather than half a file.

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** The parsed file, or `fallback` when it is missing, unreadable or not JSON. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Synchronous `readJson`, for state a constructor needs (local config overrides). */
export function readJsonSync<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write `data` atomically, creating the directory (0700) when needed. The temporary file is
 *  created exclusively (`wx`, so a planted symlink or file is refused), flushed to disk, then
 *  renamed over `path`. */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const f = await open(tmp, "wx", 0o600);
  try {
    await f.writeFile(data);
    await f.sync();
  } catch (e) {
    await f.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  await f.close();
  await rename(tmp, path);
}

/** Write `value` as JSON, atomically (`writeFileAtomic`). */
export function writeJson(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, JSON.stringify(value));
}

/** Remove `path`; a missing file is fine and so is a failure (the caller has nothing to retry). */
export async function removeJson(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}
