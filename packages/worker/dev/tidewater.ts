/**
 * The built-in example product `pkey dev` seeds when the directory has no `.pkey/`: Tidewater
 * Studio, a photo-editing app. It runs every service an integrator tries first (License, Config,
 * Identity, Release, Distribution, Update), with two tiers, a small catalog and an app
 * deliverable. SP-36's examples run against the same product.
 */
import type { ManifestDocumentName } from "@polaris-key/manifest";

export const TIDEWATER_SLUG = "tidewater";

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "render.quality",
      kind: "config",
      category: "Rendering",
      label: "Render quality",
      description: "Default render quality.",
      accessor: "render.quality",
      schema: { type: "string", enum: ["draft", "standard", "high"] },
      ui: { widget: "select" },
    },
    {
      key: "export.maxResolution",
      kind: "config",
      category: "Export",
      label: "Max export resolution",
      description: "Longest edge in pixels.",
      accessor: "export.maxResolution",
      schema: { type: "integer", minimum: 256, maximum: 16384 },
    },
    {
      key: "exportPro",
      kind: "flag",
      category: "Export",
      label: "Pro export",
      description: "Batch and RAW export.",
      accessor: "exportPro",
      schema: { type: "boolean" },
    },
  ],
};

/** The localhost origins a browser app is likely to run on (web.origins accepts exact origins). */
export const DEV_WEB_ORIGINS: readonly string[] = [
  3000, 4173, 5173, 8080,
].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);

/**
 * The release deliverable's builds: one per platform the Node SDK canonicalises `os.platform()` to
 * (`darwin` → `macos`, `win32` → `windows`, `linux`; `PLATFORM_SPELLINGS`), so a dev release has a
 * feed target and an eligible build on whatever host the integrator runs. `universal` matches every arch.
 */
export const TIDEWATER_BUILDS = (["macos", "windows", "linux"] as const).map(
  (platform) =>
    ({
      id: platform,
      platform,
      arch: "universal",
      format: "zip",
    }) as const,
);

/** The `.pkey/` documents as text, with the dev release key declared in `.pkey/release`. */
export function tidewaterFiles(
  releaseKey: { kid: string; publicKey: string },
  webOrigins: readonly string[],
): Partial<Record<ManifestDocumentName, string>> {
  return {
    product: JSON.stringify({
      slug: TIDEWATER_SLUG,
      name: "Tidewater Studio",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      defaultDeviceLimit: 3,
      modules: {
        license: { enabled: true },
        config: { enabled: true },
        identity: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
      },
      web: { origins: [...webOrigins] },
      tiers: [
        { id: "pro", label: "Pro", policyDeviceLimit: 3 },
        { id: "solo", label: "Solo", policyDeviceLimit: 1 },
      ],
    }),
    schema: JSON.stringify(CATALOG),
    release: JSON.stringify({
      release: {
        provider: { type: "github", owner: "tidewater-dev", repo: "tidewater" },
        binaryName: "tidewater",
        releaseKeys: [releaseKey],
        deliverables: {
          app: {
            kind: "app",
            versioning: { scheme: "semver" },
            artifacts: TIDEWATER_BUILDS.map((b) => ({
              ...b,
              match: `tidewater-*-${b.platform}.${b.format}`,
            })),
          },
        },
      },
    }),
  };
}
