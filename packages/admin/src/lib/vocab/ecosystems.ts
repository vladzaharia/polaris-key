/**
 * Package ecosystems: the names the console and the portal show for a feed, and the one
 * registry-token variable the setup snippets name (P0-35). The ids, the setup declarations and
 * the product slug of the platform's own feeds are `@polaris-key/manifest`'s; this adds only the
 * words.
 */
import {
  SYSTEM_PRODUCT_SLUG,
  type PackageEcosystem,
} from "@polaris-key/manifest";

export { SYSTEM_PRODUCT_SLUG };

/** The environment variable the docs, the Setup tab and the portal card name the token by. */
export const TOKEN_ENV = "PKEY_REGISTRY_TOKEN";

const NAMES: Readonly<Record<PackageEcosystem, string>> = {
  npm: "npm",
  pypi: "PyPI",
  oci: "Docker / OCI",
  swift: "Swift",
  maven: "Maven / Gradle",
  godot: "Godot",
  cargo: "Cargo",
  go: "Go",
};

/** Every ecosystem's name, for a typed lookup. */
export const ECOSYSTEM_LABELS: Readonly<Record<PackageEcosystem, string>> =
  NAMES;

/** An ecosystem's name; a value the table does not know is shown as sent. */
export function ecosystemLabel(ecosystem: string): string {
  return (NAMES as Readonly<Record<string, string>>)[ecosystem] ?? ecosystem;
}
