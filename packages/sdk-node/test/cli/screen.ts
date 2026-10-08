// A minimal terminal for the goldens: it applies what the kit writes (lines, `\r`, erase line,
// cursor up, cursor show and hide, SGR and OSC 8 passed through) to a screen of lines, so a golden
// is what a person sees, not the redraw traffic that produced it.

/** A fake TTY stdout that records into a screen. */
export class Screen {
  readonly isTTY: boolean;
  columns: number;
  rows: number;
  private lines: string[] = [""];
  private row = 0;
  /** Every byte written, in order (for the no-secret checks). */
  raw = "";

  constructor(opts: { tty?: boolean; columns?: number; rows?: number } = {}) {
    this.isTTY = opts.tty ?? true;
    this.columns = opts.columns ?? 80;
    this.rows = opts.rows ?? 24;
  }

  write(chunk: string): boolean {
    this.raw += chunk;
    // Split into escape sequences and text.
    const re =
      /(\x1b\[\?25[hl])|(\x1b\[2K)|(\x1b\[1A)|(\x1b\[[0-9;]*m)|(\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07))|(\x1b\]52;[^\x07]*\x07)|(\x1b\]11;\?\x07)|(\r)|(\n)|([^\x1b\r\n]+)/g;
    for (const m of chunk.matchAll(re)) {
      const [tok] = m;
      if (m[1] || m[6] || m[7]) continue; // cursor visibility, clipboard, OSC 11 query
      if (m[2]) {
        this.lines[this.row] = "";
        continue;
      }
      if (m[3]) {
        this.row = Math.max(0, this.row - 1);
        continue;
      }
      if (m[8]) continue; // \r: the kit always erases the line after it
      if (m[9]) {
        this.row++;
        if (this.lines.length <= this.row) this.lines.push("");
        continue;
      }
      this.lines[this.row] = (this.lines[this.row] ?? "") + tok;
    }
    return true;
  }

  /** The screen as text, escape sequences kept, trailing blank lines dropped. */
  text(): string {
    const lines = [...this.lines];
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
}
