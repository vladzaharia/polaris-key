/**
 * The pages whose blocks and named symbols must hold (SP-45a's pages, and every page a later work
 * package adds here). Every other source is advisory: its failures are recorded in
 * `advisory-baseline.json` and may only shrink.
 */

export interface Covered {
  /** Repo-relative path, or a directory prefix ending in `/`. */
  path: string;
  language: "ts" | "python" | "swift" | "kotlin" | "gdscript";
}

const BUILD = "packages/docs/src/content/docs/build/";

export const COVERED_PAGES: Covered[] = [
  { path: `${BUILD}quickstart/node.mdx`, language: "ts" },
  { path: `${BUILD}sdks/node/your-own-ui.md`, language: "ts" },
  { path: `${BUILD}quickstart/react.mdx`, language: "ts" },
  { path: `${BUILD}sdks/react/your-own-ui.md`, language: "ts" },
  { path: `${BUILD}ui/frameworks/react.mdx`, language: "ts" },
  { path: `${BUILD}ui/frameworks/terminal-node.mdx`, language: "ts" },
  { path: `${BUILD}ui/frameworks/terminal-python.mdx`, language: "python" },
  { path: `${BUILD}ui/frameworks/qt.mdx`, language: "python" },
  { path: `${BUILD}quickstart/python.mdx`, language: "python" },
  { path: `${BUILD}sdks/python/your-own-ui.md`, language: "python" },
  { path: `${BUILD}quickstart/kotlin.mdx`, language: "kotlin" },
  { path: `${BUILD}sdks/kotlin/your-own-ui.md`, language: "kotlin" },
  { path: `${BUILD}ui/frameworks/compose.mdx`, language: "kotlin" },
  { path: `${BUILD}quickstart/swift.mdx`, language: "swift" },
  { path: `${BUILD}sdks/swift/your-own-ui.md`, language: "swift" },
  { path: `${BUILD}ui/frameworks/swiftui.mdx`, language: "swift" },
  { path: "sdks/swift/README.md", language: "swift" },
  { path: "sdks/python/README.md", language: "python" },
  { path: "packages/sdk-node/README.md", language: "ts" },
  { path: "sdks/kotlin/README.md", language: "kotlin" },
  { path: "sdks/kotlin/ui/README.md", language: "kotlin" },
  { path: "packages/server/README.md", language: "ts" },
  {
    path: "packages/docs/src/content/docs/features/licensing/server-node.mdx",
    language: "ts",
  },
  {
    path: "packages/docs/src/content/docs/features/licensing/server-python.mdx",
    language: "python",
  },
  { path: "sdks/godot/README.md", language: "gdscript" },
  { path: `${BUILD}quickstart/godot.mdx`, language: "gdscript" },
  { path: `${BUILD}sdks/godot/your-own-ui.md`, language: "gdscript" },
  { path: `${BUILD}ui/frameworks/godot.mdx`, language: "gdscript" },
];

export function coveredLanguage(file: string): Covered["language"] | null {
  const hit = COVERED_PAGES.find((c) =>
    c.path.endsWith("/") ? file.startsWith(c.path) : file === c.path,
  );
  return hit?.language ?? null;
}
