/** Types for `lint-staged.mjs` (the pre-commit lint of the staged files). */

export interface SdkLane {
  id: string;
  owns: (file: string) => boolean;
  venv?: boolean;
  needs?: string | null;
  probe?: string[];
  setup?: string;
  mode?: string;
  fix: (files: string[]) => string;
}
export declare const SDKS: SdkLane[];
export declare function stagedFiles(cwd?: string): string[];
export declare function lanesFor(
  files: string[],
): (SdkLane & { files: string[] })[];
export declare function pythonVenv(root?: string): string | null;
