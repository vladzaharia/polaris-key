/**
 * OCI (F-08's registry): an OCI image layout (`docker buildx build --output type=oci,dest=…`,
 * unpacked): `oci-layout`, `index.json` and `blobs/sha256/*`. Every blob reachable from the
 * layout's index is published, typed by how it is referenced (an image index, a manifest, or a
 * plain blob with its descriptor's media type), and named by its digest. `metadata.root` is the
 * digest the version's tag points to: the layout index's single entry.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { scanDir } from "../publish.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractedFile,
  type ExtractInput,
} from "./types.js";

const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
/** The most JSON documents (indexes, manifests) the walk parses. */
const MAX_DOCUMENTS = 256;

interface Descriptor {
  mediaType?: string;
  digest?: string;
  platform?: { os?: string; architecture?: string; variant?: string };
}

async function layoutRoot(dir: string): Promise<string> {
  const files = await scanDir(dir);
  const layout = files.find((f) => f.name === "oci-layout");
  if (!layout)
    throw new PackageExtractError(
      "no OCI image layout (an oci-layout file) under --dir.",
    );
  return path.dirname(layout.path);
}

export async function extractOci(
  input: ExtractInput & { version?: string },
): Promise<Extracted> {
  const root = await layoutRoot(input.dir);
  const index = JSON.parse(
    await readFile(path.join(root, "index.json"), "utf8"),
  ) as { manifests?: Descriptor[] };
  const entries = index.manifests ?? [];
  if (entries.length !== 1 || !entries[0]?.digest)
    throw new PackageExtractError(
      `the layout's index.json lists ${entries.length} images; publish one (a multi-arch image is one image index).`,
    );
  if (!input.version)
    throw new PackageExtractError(
      "an OCI image carries no version: pass --version (it is also the image's tag).",
    );
  const blobDir = path.join(root, "blobs", "sha256");
  const byDigest = new Map<string, { type: string; mediaType: string }>();
  const platforms = new Set<string>();
  let parsed = 0;
  const visit = async (d: Descriptor): Promise<void> => {
    const digest = d.digest ?? "";
    const m = /^sha256:([0-9a-f]{64})$/.exec(digest);
    if (!m) throw new PackageExtractError(`${digest} is not a sha256 digest.`);
    if (byDigest.has(digest)) return;
    const mediaType = d.mediaType ?? "application/octet-stream";
    if (d.platform?.os && d.platform.architecture)
      platforms.add(
        `${d.platform.os}/${d.platform.architecture}${d.platform.variant ? `/${d.platform.variant}` : ""}`,
      );
    const file = path.join(blobDir, m[1]!);
    try {
      await stat(file);
    } catch {
      throw new PackageExtractError(`the layout has no blob ${digest}.`);
    }
    if (INDEX_TYPES.has(mediaType) || MANIFEST_TYPES.has(mediaType)) {
      byDigest.set(digest, {
        type: INDEX_TYPES.has(mediaType) ? "oci-index" : "oci-manifest",
        mediaType,
      });
      if (++parsed > MAX_DOCUMENTS)
        throw new PackageExtractError(
          `the image references more than ${MAX_DOCUMENTS} manifests.`,
        );
      const doc = JSON.parse(await readFile(file, "utf8")) as {
        manifests?: Descriptor[];
        config?: Descriptor;
        layers?: Descriptor[];
      };
      for (const child of [
        ...(doc.manifests ?? []),
        ...(doc.config ? [doc.config] : []),
        ...(doc.layers ?? []),
      ])
        await visit(child);
    } else byDigest.set(digest, { type: "oci-blob", mediaType });
  };
  await visit(entries[0]);
  // Every blob of the layout should be reachable; a stray one is left out, never guessed at.
  const present = new Set(await readdir(blobDir));
  const files: ExtractedFile[] = [...byDigest]
    .filter(([digest]) => present.has(digest.slice("sha256:".length)))
    .map(([digest, v]) => ({
      path: path.join(blobDir, digest.slice("sha256:".length)),
      name: digest,
      type: v.type,
      mediaType: v.mediaType,
    }));
  return {
    version: input.version,
    files,
    metadata: {
      name: input.declaration.name,
      version: input.version,
      root: entries[0].digest,
      mediaType:
        entries[0].mediaType ?? "application/vnd.oci.image.index.v1+json",
      ...(platforms.size ? { platforms: [...platforms].sort() } : {}),
    },
  };
}
