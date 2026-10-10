// @pkey-feature ui.kit
//
// The kit typechecks for a consumer on React 18 and on React 19 (UK-47). React 19 removed the
// global `JSX` namespace, so a declaration that says `JSX.Element` breaks every consumer whose
// compiler checks library declarations; the kit says `React.JSX.Element`. Each run compiles a
// small consumer (test/consumer/app.tsx) and everything it imports with `skipLibCheck: false`
// against one major's @types/react, and expects no diagnostic at all.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ADMIN = resolve(PKG, "../admin");

/** The directory of the @types package a workspace package resolves, and its major. */
function typesOf(name: string, from: string): { dir: string; major: number } {
  const require = createRequire(join(from, "package.json"));
  const manifest = require.resolve(`${name}/package.json`);
  const version = (require(manifest) as { version: string }).version;
  return { dir: dirname(manifest), major: Number(version.split(".")[0]) };
}

function diagnostics(react: string, reactDom: string): string[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: ["node"],
    typeRoots: [
      join(PKG, "node_modules/@types"),
      join(PKG, "../../node_modules/@types"),
    ],
    baseUrl: PKG,
    paths: {
      "@polaris-key/react": [join(PKG, "src/index.ts")],
      react: [react],
      "react/jsx-runtime": [join(react, "jsx-runtime")],
      "react/jsx-dev-runtime": [join(react, "jsx-dev-runtime")],
      "react-dom": [reactDom],
      "react-dom/client": [join(reactDom, "client")],
    },
  };
  const program = ts.createProgram([join(HERE, "consumer/app.tsx")], options);
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (d) =>
        `${d.file ? `${d.file.fileName}: ` : ""}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
}

describe("a consumer typechecks against the kit (skipLibCheck: false)", () => {
  const cases = [
    [
      "React 18",
      typesOf("@types/react", PKG),
      typesOf("@types/react-dom", PKG),
      18,
    ],
    [
      "React 19",
      typesOf("@types/react", ADMIN),
      typesOf("@types/react-dom", ADMIN),
      19,
    ],
  ] as const;
  for (const [label, react, dom, major] of cases)
    it(`${label}`, () => {
      expect(react.major).toBe(major);
      expect(diagnostics(react.dir, dom.dir)).toEqual([]);
    }, 180_000);
});
