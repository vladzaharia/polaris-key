/**
 * What a package extractor answers (F-03, plans/F-01.md §3.2, §6.8): the files of one package
 * release with their ecosystem types, the version they carry, and the metadata the feeds render
 * from. The Worker never unzips (the P2b-05 rule), so everything a feed needs from inside a
 * package is read here, in CI, and the Worker only checks its shape and agreement.
 */

import type { ManifestPackageDeliverable } from "@polaris-key/manifest";

export interface ExtractedFile {
  /** Absolute path of the bytes to upload. */
  path: string;
  /** The file name the descriptor names (unique within the release). */
  name: string;
  /** The ecosystem's file type (`PACKAGE_FILE_TYPES`). */
  type: string;
  mediaType?: string;
  classifier?: string;
  extension?: string;
}

export interface Extracted {
  /** The version the packed files carry; `pkey release publish` checks `--version` against it. */
  version: string;
  files: ExtractedFile[];
  /** `name`, `version` and the ecosystem's keys (`PACKAGE_METADATA_KEYS`). */
  metadata: Record<string, unknown>;
}

export interface ExtractInput {
  declaration: ManifestPackageDeliverable;
  /** `--dir`, absolute. */
  dir: string;
  /** Where an extractor may write files it derives (PyPI's `core-metadata`). */
  workDir: string;
}

/** A package the CLI cannot read: the publish stops with this message. */
export class PackageExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageExtractError";
  }
}
