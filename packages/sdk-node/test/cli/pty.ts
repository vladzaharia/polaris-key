// A real pseudo-terminal for the tests: the program runs on a pty (pty-relay.py), its output feeds
// @xterm/headless, and the terminal's answers (to the OSC 11 question and to the cursor-position
// request) go back through the pty as a person's terminal would send them.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XtermScreen } from "./xterm.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const tsx = join(root, "node_modules", ".bin", "tsx");

export const ptyAvailable =
  process.platform !== "win32" && existsSync(tsx) && hasPython();

function hasPython(): boolean {
  return spawnSync("python3", ["-c", "import pty"]).status === 0;
}

export interface PtyOptions {
  columns: number;
  rows: number;
  args: string[];
  env?: Record<string, string>;
  /** The terminal answers the OSC 11 question (default) or stays silent. */
  answerOsc11?: boolean;
  /** The terminal answers cursor-position requests (default) or stays silent. */
  answerCpr?: boolean;
}

export class Pty {
  readonly screen: XtermScreen;
  private readonly child: ChildProcess;
  private buf = "";
  /** Seconds since start → label, for timing assertions. */
  readonly exited: Promise<number>;
  private resolveExit!: (n: number) => void;
  /** Every query the program sent that this terminal answered or ignored. */
  osc11Seen = false;
  /** When the program first asked the OSC 11 question (it is up and reading keys), ms epoch. */
  osc11At: number | undefined;
  /** When the program exited, ms epoch. */
  exitedAt: number | undefined;

  constructor(readonly o: PtyOptions) {
    this.screen = new XtermScreen(o.columns, o.rows);
    this.exited = new Promise((r) => (this.resolveExit = r));
    this.child = spawn(
      "python3",
      [
        join(here, "pty-relay.py"),
        String(o.columns),
        String(o.rows),
        "--",
        tsx,
        join(here, "pty-flow.ts"),
        ...o.args,
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, ...o.env },
      },
    );
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.onData(d));
    if (o.answerCpr !== false)
      this.screen.term.onData((d) => this.send(Buffer.from(d)));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { o?: string; x?: number };
      if (msg.o !== undefined) {
        const text = Buffer.from(msg.o, "base64").toString("utf8");
        if (text.includes("\x1b]11;?")) {
          this.osc11Seen = true;
          this.osc11At ??= Date.now();
          if (this.o.answerOsc11 !== false)
            this.send(Buffer.from("\x1b]11;rgb:0000/0000/0000\x1b\\"));
        }
        this.screen.write(text);
      } else if (msg.x !== undefined) {
        this.exitedAt = Date.now();
        this.resolveExit(msg.x);
      }
    }
  }

  private send(b: Buffer): void {
    this.child.stdin!.write(JSON.stringify({ w: b.toString("base64") }) + "\n");
  }

  type(text: string): void {
    this.send(Buffer.from(text));
  }

  async resize(columns: number, rows: number): Promise<void> {
    await this.screen.flush();
    this.screen.term.resize(columns, rows);
    this.screen.columns = columns;
    this.screen.rows = rows;
    this.child.stdin!.write(JSON.stringify({ r: [columns, rows] }) + "\n");
  }

  signal(n: number): void {
    this.child.stdin!.write(JSON.stringify({ k: n }) + "\n");
  }

  /** Wait until the screen shows `text` (or `ms` pass). */
  async waitFor(text: string, ms = 15_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.screen.flush();
      const rows = this.screen.viewport().map((r) => r.text);
      if (rows.some((r) => r.includes(text))) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  /** Let output and answers settle. */
  async settle(ms = 400): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    await this.screen.flush();
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}
