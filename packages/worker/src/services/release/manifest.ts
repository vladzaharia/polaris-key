export {
  parseManifest,
  // R9-01: the manifest validator's issuer rule, re-exported for THIS service's ingest paths.
  // Identity applies the SAME rule at the sink, importing it straight from `@polaris-key/manifest`
  // (a service may not import a sibling). Ingest-only validation would leave every
  // `oidc_config` row written before this landed — or by any future writer that bypasses
  // `parseManifest` — able to steer the token POST that carries the product's client secret.
  isSafeIssuerUrl,
  issuerUrlProblem,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_DEPTH,
  type ManifestEdgeMint,
  type ManifestOidc,
  type ManifestProduct,
  type ManifestProfile,
  type ManifestProvisioning,
  type ManifestRelease,
  type ManifestTier,
  type ParsedManifest,
  type ParseManifestResult,
} from "@polaris-key/manifest";
