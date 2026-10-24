# tools/lint

The one lint-debt ledger mechanism (P0-46.1). Each toolchain's linters run in their own lane;
this script turns their raw output into a committed, shrink-only ledger. Plain Node ESM, no
dependencies, so a lane can run it before any install. The docs ledger
(`packages/docs/lint-debt.json`) and the kit ledger (`packages/ui-qa/rules/kit-debt.json`) predate it
and keep their own scripts.

## Rules

- A finding above the ledger fails (`new:`); an entry the tool no longer reports, or reports
  fewer times, fails too (`cleared (re-record):`). The ledger only shrinks.
- Tool versions are pinned exactly. An upgrade is its own change that re-records.
- Each toolchain's ledger lives beside its code (`sdks/python/lint-debt.json`, ...), one per lane,
  shared by that lane's tools. A tool only reads and rewrites rules prefixed `<tool>:`.
- Findings in generated files (`generated.json`) and under `build/`, `.venv/`, `node_modules/`,
  `dist/` are dropped before counting.

## Use

```sh
<linter> --json | node tools/lint/lint-debt.mjs check  --tool <id> --ledger <path>
node tools/lint/lint-debt.mjs record --tool <id> --ledger <path> --input out.txt
```

`--input` defaults to stdin. `--root` (default: the repo root) is passed to the adapter.
Exit 0 ok, 1 debt drift, 2 usage or adapter error (it never passes on garbage).

## Ledger

```json
{
  "$comment": "...",
  "version": 1,
  "debt": { "path/from/root.py": { "ruff:E501": 3 } }
}
```

Files and rules sorted by code point; counts are findings per file and rule.

## Adapter interface

`adapters/<tool>.mjs` is loaded by name, so a tool slice adds one file and edits no shared one.

```js
export function parse(text, { root }) {
  return [{ file: "sdks/python/x.py", rule: "ruff:E501" }]; // one entry per finding
}
```

- `file`: repo-relative, `/` separators, no leading `/` or `..` (resolve against `root` if the tool
  prints absolute paths).
- `rule`: prefixed `<tool>:`.
- Throw on input that is not the tool's format; the script reports it and exits 2.

## Adding a tool

1. `adapters/<tool>.mjs` plus a fixture of the tool's real output and a case in the slice's test.
2. The lane's `tools/lint.sh check|record` pipes the pinned tool into `lint-debt.mjs` with the lane
   ledger.
3. A CI step runs `lint.sh check`.

`generated.json` is written by `pnpm gen registry-docs`; do not edit it. `jsonl-test` is a
fixture-only adapter for `lint-debt.test.ts`.
