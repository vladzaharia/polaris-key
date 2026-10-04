/** The six package extractors (F-03, plans/F-01.md §6.8), one per ecosystem. */

import type { PackageEcosystem } from "@polaris-key/manifest";
import { extractGodot } from "./godot.js";
import { extractMaven } from "./maven.js";
import { extractNpm } from "./npm.js";
import { extractOci } from "./oci.js";
import { extractPypi } from "./pypi.js";
import { extractSwift } from "./swift.js";
import type { Extracted, ExtractInput } from "./types.js";

export function extractPackage(
  ecosystem: PackageEcosystem,
  input: ExtractInput & { version?: string },
): Promise<Extracted> {
  switch (ecosystem) {
    case "npm":
      return extractNpm(input);
    case "pypi":
      return extractPypi(input);
    case "swift":
      return extractSwift(input);
    case "maven":
      return extractMaven(input);
    case "oci":
      return extractOci(input);
    case "godot":
      return extractGodot(input);
  }
}
