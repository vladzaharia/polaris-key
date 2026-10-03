import { buildLabel, type BuildLabel } from "@polaris-key/manifest";

/**
 * The label for a release file: its platform and architecture together (`buildLabel`), or
 * null when the file declares neither. A file the store knows nothing about is not "All
 * platforms" (that is a claim); it is simply unlabelled. The Worker has already given a file
 * without a platform of its own its build's (or its name's) platform.
 */
export function artifactLabel(a: {
  platform: string | null;
  arch: string | null;
}): BuildLabel | null {
  if (!a.platform && !a.arch) return null;
  return buildLabel({ platform: a.platform, arch: a.arch });
}
