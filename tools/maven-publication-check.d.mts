/** Types for `maven-publication-check.mjs` (the pre-upload Maven publication check). */
export function globMatches(glob: string, name: string): boolean;
export function mavenDeliverables(
  releaseYaml: string,
): { id: string; name: string | null; match: string | null }[];
export function checkPublication(
  repoDir: string,
  version: string,
  releaseYaml: string,
): string[];
