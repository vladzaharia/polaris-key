/**
 * OCI's ingest rules (F-08): a repository path under the owner. The namespace is the owner
 * itself (every URL carries it), so the feed declares no namespace keys and nothing is outside.
 */

import type { PackageEcosystemRules } from "./rules.js";

export const OCI_PACKAGE_RULES: PackageEcosystemRules<"oci"> = {
  ecosystem: "oci",
  name: {
    // An OCI repository path under the owner: lower-case components joined by `/`.
    pattern:
      /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/,
    maxLength: 255,
    // The grammar is lower case already.
    norm: (name) => name,
  },
  fileTypes: ["oci-blob", "oci-manifest", "oci-index"],
  // An image's blobs.
  maxFiles: 4096,
  // `root`: the digest of the manifest or index the version's tag points to.
  metadataKeys: ["mediaType", "platforms", "root"],
  namespace: {
    fields: {},
    problem: () => null,
  },
};
