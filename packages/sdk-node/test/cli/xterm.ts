// A real terminal for the responsive tests: @xterm/headless, the emulator VS Code and the docs'
// renders use, behind the kit's `TerminalOutput`. Unlike the goldens' `Screen`, it soft-wraps a
// line wider than the terminal, scrolls, keeps a scrollback and reflows on a resize, so a test sees
// exactly the rows a person would: a wrapped row, a duplicated header or a stacked progress bar
// shows up here.

import { EventEmitter } from "node:events";
import xterm from "@xterm/headless";

const { Terminal } = xterm;

export interface Row {
  /** The row's text, trailing spaces dropped. */
  text: string;
  /** The row continues the one above it: the terminal wrapped a line wider than itself. */
  wrapped: boolean;
}

export class XtermScreen extends EventEmitter {
  readonly isTTY = true;
  columns: number;
  rows: number;
  readonly term: InstanceType<typeof Terminal>;
  /** Every byte written, in order. */
  raw = "";
  private pending: Promise<void> = Promise.resolve();

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.term = new Terminal({
      cols: columns,
      rows,
      scrollback: 1000,
      allowProposedApi: true,
      // A pty's line discipline (ONLCR) turns "\n" into "\r\n" on the way to the terminal.
      convertEol: true,
    });
  }

  write(chunk: string): boolean {
    this.raw += chunk;
    const prev = this.pending;
    this.pending = prev.then(
      () => new Promise<void>((r) => this.term.write(chunk, () => r())),
    );
    return true;
  }

  /** Wait until the terminal has drawn everything written so far. */
  async flush(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.pending) {
      seen = this.pending;
      await seen;
    }
  }

  /** Resize the window (the terminal reflows, then the process gets SIGWINCH). */
  async resize(columns: number, rows: number): Promise<void> {
    await this.flush();
    this.term.resize(columns, rows);
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
    await this.flush();
  }

  /** Every row, scrollback first, trailing blank rows dropped. */
  all(): Row[] {
    const b = this.term.buffer.active;
    const out: Row[] = [];
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i)!;
      out.push({ text: l.translateToString(true), wrapped: l.isWrapped });
    }
    while (out.length && out[out.length - 1]!.text === "") out.pop();
    return out;
  }

  /** The rows on the screen now (the viewport). */
  viewport(): Row[] {
    const b = this.term.buffer.active;
    const out: Row[] = [];
    for (let i = b.viewportY; i < b.viewportY + this.rows; i++) {
      const l = b.getLine(i);
      if (l)
        out.push({ text: l.translateToString(true), wrapped: l.isWrapped });
    }
    return out;
  }
}
