/**
 * DC-15 — the generated per-release `SHA256SUMS` (`services/distribution/checksums.ts`), served
 * as `files/<releaseId>/SHA256SUMS` through the file byte route on both hosts, and linked from the
 * public download page.
 *
 * Negative controls: a changed artifact digest changes the sums, another release has other sums,
 * and a tampered SHA256SUMS fails the same verification the genuine one passes.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import { blobKey } from "../src/core/assets/blobs.js";
import {
  SLUG,
  bytesFor,
  model,
  onBytes,
  onConsole,
  setup,
  sha,
} from "./downloadWorld.js";
import { renderDownloadPage } from "../src/services/distribution/page/render.js";
import {
  SHA256SUMS_NAME,
  sha256sumsBody,
} from "../src/services/distribution/checksums.js";
import type { CatalogSourceArtifact } from "../src/core/hooks.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** What `sha256sum --check` does: every line's digest must equal the digest of that file's bytes. */
function verify(
  sums: string,
  fileBytes: (name: string) => Uint8Array | undefined,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const lines = sums.split("\n").filter((l) => l !== "");
  if (lines.length === 0) failures.push("(empty)");
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) {
      failures.push(`malformed: ${line}`);
      continue;
    }
    const bytes = fileBytes(m[2]!);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== m[1])
      failures.push(m[2]!);
  }
  return { ok: failures.length === 0, failures };
}

const art = (
  name: string,
  sha256: string | null,
  locations: CatalogSourceArtifact["locations"] = [{ provider: "github" }],
): CatalogSourceArtifact => ({
  releaseId: "r",
  artifactId: name,
  name,
  buildId: null,
  role: "payload",
  platform: null,
  arch: null,
  contentType: null,
  sizeBytes: null,
  sha256,
  metadata: null,
  locations,
});

const H = (c: string) => c.repeat(64);

describe("sha256sumsBody", () => {
  it("writes sha256sum's text format, sorted by name, one line per file", () => {
    const body = sha256sumsBody([art("b.zip", H("b")), art("a.zip", H("a"))]);
    expect(body).toBe(`${H("a")}  a.zip\n${H("b")}  b.zip\n`);
  });

  it("leaves out what cannot be verified or served", () => {
    const body = sha256sumsBody([
      art("ok.zip", H("1")),
      art("nohash.zip", null),
      art("bad.zip", "XYZ"),
      art("store-only.ipa", H("2"), [{ provider: "store" }]),
      art("gated.pck", H("3"), [
        { provider: "r2", key: blobKey(H("3"), { gated: true }) },
      ]),
      art("new\nline.zip", H("4")),
      art("back\\slash.zip", H("5")),
      art("dir/inner.zip", H("6")),
      art(SHA256SUMS_NAME, H("7")),
    ]);
    expect(body).toBe(`${H("1")}  ok.zip\n`);
  });

  it("sorts by the name's UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E (EF BD 9E) sorts after U+1F600 (F0 9F 98 80) by code unit (0xFF5E > 0xD83D) but
    // before it by UTF-8 byte.
    const body = sha256sumsBody([
      art("\u{1F600}.zip", H("a")),
      art("\uFF5E.zip", H("b")),
    ]);
    expect(body).toBe(`${H("b")}  \uFF5E.zip\n${H("a")}  \u{1F600}.zip\n`);
  });

  it("a name carrying two different digests is left out whole; the same digest twice is one line", () => {
    const body = sha256sumsBody([
      art("dup.zip", H("a")),
      art("dup.zip", H("b")),
      art("same.zip", H("c")),
      art("same.zip", H("c")),
      art("other.zip", H("d")),
    ]);
    expect(body).toBe(`${H("d")}  other.zip\n${H("c")}  same.zip\n`);
    expect(
      sha256sumsBody([art("dup.zip", H("a")), art("dup.zip", H("b"))]),
    ).toBeNull();
  });

  it("is null when nothing qualifies, and never writes an MD5 line", () => {
    expect(sha256sumsBody([])).toBeNull();
    expect(sha256sumsBody([art("x", null)])).toBeNull();
    expect(sha256sumsBody([art("x", H("a"))])).not.toMatch(/md5/i);
  });
});

describe("files/<releaseId>/SHA256SUMS", () => {
  it("lists every payload of the release, and every digest verifies against its bytes", async () => {
    const w = await setup();
    const m = await model(w);
    const releaseId = m.release!.releaseId;
    const builds = m.platforms
      .flatMap((g) => g.builds)
      .filter((b) => b.releaseId === releaseId);
    expect(builds.length).toBeGreaterThan(0);
    for (const host of [onBytes, onConsole]) {
      const res = await host(
        w,
        `/${SLUG}/distribution/files/${encodeURIComponent(releaseId)}/SHA256SUMS`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const text = await res.text();
      // Every build of the release (seven in the fixture), not only the page's pick.
      expect(text.split("\n").filter(Boolean)).toHaveLength(7);
      for (const b of builds)
        expect(text).toContain(`${b.sha256}  ${b.name}\n`);
      expect(verify(text, (n) => bytesFor(n)).ok).toBe(true);
    }
    // Bytes host: no text type at all; console host: text/plain.
    const onB = await onBytes(
      w,
      `/${SLUG}/distribution/files/${encodeURIComponent(releaseId)}/SHA256SUMS`,
    );
    expect(onB.headers.get("content-type")).toBe("application/octet-stream");
    const onC = await onConsole(
      w,
      `/${SLUG}/distribution/files/${encodeURIComponent(releaseId)}/SHA256SUMS`,
    );
    expect(onC.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("negative control: a tampered SHA256SUMS fails the verification the genuine one passes", async () => {
    const w = await setup();
    const m = await model(w);
    const id = encodeURIComponent(m.release!.releaseId);
    const text = await (
      await onBytes(w, `/${SLUG}/distribution/files/${id}/SHA256SUMS`)
    ).text();
    expect(verify(text, (n) => bytesFor(n)).ok).toBe(true);
    // One digest flipped.
    const flipped = text.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const bad = verify(flipped, (n) => bytesFor(n));
    expect(bad.ok).toBe(false);
    expect(bad.failures).toHaveLength(1);
    // A file whose bytes changed under the same name.
    expect(verify(text, (n) => new TextEncoder().encode(`evil ${n}`)).ok).toBe(
      false,
    );
    // A line dropped, a name changed: the verifier sees a missing file.
    expect(
      verify(text.replace(/ {2}Diceroll/, "  Other"), (n) => bytesFor(n)).ok,
    ).toBe(false);
  });

  it("negative control: a changed artifact digest changes the sums; another release has other sums", async () => {
    const w = await setup();
    const m = await model(w);
    const id = m.release!.releaseId;
    const url = (r: string) =>
      `/${SLUG}/distribution/files/${encodeURIComponent(r)}/SHA256SUMS`;
    const before = await (await onBytes(w, url(id))).text();
    const older = await (await onBytes(w, url("app@1.0.0"))).text();
    expect(older.length).toBeGreaterThan(0);
    expect(older).not.toBe(before);

    const first = before.split("\n")[0]!;
    const [oldHex, name] = [first.slice(0, 64), first.slice(66)];
    await w.db.run(
      `UPDATE release_artifacts SET sha256 = ? WHERE product = ? AND release_id = ? AND sha256 = ?`,
      sha("changed"),
      SLUG,
      id,
      oldHex,
    );
    const after = await (await onBytes(w, url(id))).text();
    expect(after).not.toBe(before);
    expect(after).toContain(`${sha("changed")}  ${name}\n`);
    expect(after).not.toContain(oldHex);
    // The stored digest no longer matches the bytes, so verification now fails.
    expect(verify(after, (n) => bytesFor(n)).ok).toBe(false);
  });

  it("a developer-published file of that name is not served in its place", async () => {
    const w = await setup();
    const m = await model(w);
    const id = m.release!.releaseId;
    const first = m.platforms.flatMap((g) => g.builds)[0]!;
    await w.db.run(
      `UPDATE release_artifacts SET name = ? WHERE product = ? AND release_id = ? AND name = ?`,
      SHA256SUMS_NAME,
      SLUG,
      id,
      first.name,
    );
    const text = await (
      await onBytes(
        w,
        `/${SLUG}/distribution/files/${encodeURIComponent(id)}/SHA256SUMS`,
      )
    ).text();
    expect(text).not.toContain(SHA256SUMS_NAME);
    expect(text).not.toContain(first.sha256!);
  });

  it("an unknown release, a wrong method and a non-public mode are refused", async () => {
    const w = await setup();
    const miss = await onBytes(
      w,
      `/${SLUG}/distribution/files/app%409.9.9/SHA256SUMS`,
    );
    expect(miss.status).toBe(404);
    const post = await onBytes(
      w,
      `/${SLUG}/distribution/files/app%401.1.0/SHA256SUMS`,
      { method: "POST" },
    );
    expect(post.status).toBe(405);

    const gated = await setup({ access: "entitled" });
    const res = await onBytes(
      gated,
      `/${SLUG}/distribution/files/app%401.1.0/SHA256SUMS`,
    );
    expect([401, 403]).toContain(res.status);
    expect(await res.text()).not.toMatch(/[0-9a-f]{64} {2}/);
  });

  it("MD5 is never offered: there is no MD5SUMS", async () => {
    const w = await setup();
    for (const n of ["MD5SUMS", "SHA256SUMS.md5", "md5sums"]) {
      const res = await onBytes(
        w,
        `/${SLUG}/distribution/files/app%401.1.0/${n}`,
      );
      expect(res.status, n).toBe(404);
    }
  });
});

describe("the download page", () => {
  it("links the release's SHA256SUMS next to the file table", async () => {
    const w = await setup();
    const m = await model(w);
    const html = renderDownloadPage(m, {
      platform: "macos",
      arch: null,
      touchAmbiguous: false,
    });
    const href = `${m.pageUrl!.replace(`/${SLUG}`, "")}/${SLUG}/distribution/files/${encodeURIComponent(m.release!.releaseId)}/SHA256SUMS`;
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain("sha256sum --check SHA256SUMS");
    expect(html).not.toMatch(/md5/i);
    // No release, no link.
    const none = renderDownloadPage(
      { ...m, release: null },
      { platform: "macos", arch: null, touchAmbiguous: false },
    );
    expect(none).not.toContain("SHA256SUMS");
  });
});
