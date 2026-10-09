// Evidence run: the Node terminal kit's changed screens on a real pty at the frame matrix (the
// default colour terminal, NO_COLOR, ASCII, and narrow widths), saved as text with the checks each
// frame must pass. It is a tool, not a test:
//
//   node_modules/.bin/tsx packages/sdk-node/test/cli/pty-evidence.ts <out-dir>
//
// Each case is a `pty-flow.ts` mode. A case may need a key typed or a moment's wait, so each says
// when to take its snapshots.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pty } from "./pty.js";

interface Frame {
  id: string;
  columns: number;
  env: Record<string, string>;
}
const FRAMES: Frame[] = [
  { id: "color-80", columns: 80, env: {} },
  { id: "no-color-80", columns: 80, env: { NO_COLOR: "1" } },
  { id: "ascii-80", columns: 80, env: { PKEY_ASCII: "1" } },
  { id: "narrow-40", columns: 40, env: {} },
  { id: "narrow-32", columns: 32, env: {} },
];

interface Case {
  id: string;
  args: string[];
  /** What to do on the running program: (name, ms to wait first, keys to type after). */
  steps: Array<{ name: string; wait: number; type?: string }>;
}

const done = [{ name: "final", wait: 0 }];
const CASES: Case[] = [
  { id: "status-signed-in", args: ["status"], steps: done },
  { id: "status-key-only", args: ["status", "key-only"], steps: done },
  { id: "status-revoked-signed-in", args: ["status", "revoked"], steps: done },
  {
    id: "status-revoked-key-only",
    args: ["status", "revoked-key-only"],
    steps: done,
  },
  { id: "devices-list", args: ["devices"], steps: done },
  ...["npm", "pnpm", "homebrew", "npx", "no-driver", "not-configured"].map(
    (m): Case => ({
      id: `update-apply-${m}`,
      args: ["update", m],
      steps: done,
    }),
  ),
  {
    id: "update-apply-verifying",
    args: ["update", "verifying"],
    steps: [
      { name: "verifying", wait: 2000 },
      { name: "final", wait: 3500 },
    ],
  },
  {
    id: "login-attach-default-no",
    args: ["attach"],
    steps: [
      { name: "question", wait: 1500, type: "\r" },
      { name: "final", wait: 600 },
    ],
  },
  {
    id: "login-attach-yes",
    args: ["attach"],
    steps: [
      { name: "question", wait: 1500, type: "y" },
      { name: "final", wait: 600 },
    ],
  },
  { id: "activate-unauthorized", args: ["activate-unauthorized"], steps: done },
];

const out = process.argv[2];
if (!out) throw new Error("usage: pty-evidence.ts <out-dir>");
mkdirSync(out, { recursive: true });

const summary: Array<Record<string, unknown>> = [];
let failures = 0;

for (const c of CASES)
  for (const f of FRAMES) {
    const p = new Pty({
      columns: f.columns,
      rows: 24,
      args: c.args,
      env: f.env,
    });
    const shots: Record<string, string> = {};
    const checks: Record<string, boolean> = {};
    try {
      for (const s of c.steps) {
        if (s.name === "final") {
          await Promise.race([
            p.exited,
            new Promise((r) => setTimeout(r, 15_000)),
          ]);
          await p.settle(s.wait || 150);
        } else {
          await p.settle(s.wait);
        }
        shots[s.name] = p.screen
          .all()
          .map((r) => r.text.replace(/\s+$/, ""))
          .join("\n")
          .replace(/\n+$/, "");
        if (s.type) p.type(s.type);
      }
      const text = Object.values(shots).join("\n");
      const raw = p.screen.raw;
      // Nothing is wider than the terminal.
      checks.fits = text.split("\n").every((l) => [...l].length <= f.columns);
      // NO_COLOR: no colour escape (bold, reverse video and links stay).
      if (f.env.NO_COLOR)
        checks.noColourEscapes =
          !/\x1b\[(?:[0-9;]*;)?(?:3[0-7]|4[0-7]|9[0-7]|38|48)[;m]/.test(raw);
      // ASCII: the symbols are ASCII (the product's own name and data are ASCII here too).
      if (f.env.PKEY_ASCII) checks.asciiOnly = /^[\x00-\x7f]*$/.test(text);
      // The screen says something and ended.
      checks.exited =
        (await Promise.race([
          p.exited,
          new Promise((r) => setTimeout(() => r(-1), 100)),
        ])) !== -1;
      checks.noRawKey = !raw.includes("7Q2Mx9cLr4TbV0aZ3WPLDA");
    } finally {
      await p.close();
    }
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failures++;
    const body = Object.entries(shots)
      .map(([name, t]) => `##### ${name}\n${t}\n`)
      .join("\n");
    writeFileSync(
      join(out, `${c.id}.${f.id}.txt`),
      `# ${c.id} · ${f.id} · ${f.columns}x24 · exit ${await Promise.race([p.exited, Promise.resolve(null)])}\n# checks: ${JSON.stringify(checks)}\n\n${body}`,
    );
    summary.push({ case: c.id, frame: f.id, checks, ok });
    console.log(`${ok ? "ok  " : "FAIL"} ${c.id} ${f.id}`);
  }

writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`${summary.length - failures}/${summary.length} frames pass`);
process.exit(failures ? 1 : 0);
