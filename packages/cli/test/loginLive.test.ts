// m4: while `pkey login` waits on a terminal, the heading, the link and the code are part of the
// live region with the spinner, so a resize lays them out again at the new width (they are not
// printed lines the terminal reflows by itself). When the sign-in ends, the last layout is
// printed once, where the region was.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/credentials.js";
import { runPkey } from "../src/index.js";

const ORIGIN = "https://key.example";
const TOKEN = `pkeyp_${"Q".repeat(39)}h7Q2`;
const CODE = "WDJB-MJHT";
const POLL = `dl_${"a".repeat(43)}`;
const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

class Tty extends EventEmitter {
  isTTY = true;
  rows = 40;
  text = "";
  constructor(public columns: number) {
    super();
  }
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}

describe("m4: a resize while waiting lays the heading, link and code out again", () => {
  it("re-lays the screen out at the new width and prints the last layout when it ends", async () => {
    const out = new Tty(80);
    const err = new Tty(80);
    let polls = 0;
    const f = (async (url: string) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/device-login/start")
        return json(
          201,
          { id: POLL, code: CODE, expiresIn: 300, interval: 3 },
          {
            "set-cookie": `__Host-pkey_device_login=${"c".repeat(43)}; Path=/; Secure`,
          },
        );
      if (p.startsWith("/api/device-login/"))
        return ++polls < 2
          ? json(200, { status: "pending" })
          : json(200, {
              status: "approved",
              token: TOKEN,
              expiresAt: 4_000_000_000,
              label: "pkey on laptop",
            });
      return json(200, {
        name: "Ada",
        email: "ada@example.com",
        permissions: { roles: [] },
      });
    }) as typeof fetch;

    const bare = (t: string) =>
      t
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
    let beforeResize = "";
    const code = await runPkey(["login", "--base-url", ORIGIN], {
      cwd: "/",
      env: { NO_COLOR: "1", TERM: "xterm-256color" },
      stdout: out as never,
      stderr: err as never,
      fetchImpl: f,
      credentialStore: async () => memoryStore(),
      login: {
        openUrl: async () => undefined,
        platform: "darwin",
        hostname: () => "laptop",
        sleep: async () => {
          if (polls === 1 && beforeResize === "") {
            beforeResize = bare(err.text);
            out.columns = 36;
            err.columns = 36;
            err.emit("resize");
          }
        },
      },
    });
    expect(code).toBe(0);
    // At 80 columns the whole link and "matches" showed; nothing was printed to stdout while waiting.
    expect(beforeResize).toContain(
      "Check that the code in your browser matches:",
    );
    expect(beforeResize).toContain("Polaris Key console · key.example");
    // After the resize the region was redrawn at 36: the link drops ?code= and the title wraps.
    const after = bare(err.text).slice(beforeResize.length);
    expect(after).toContain("Enter this code in your browser:");
    expect(after).toContain("Polaris Key console ·");
    expect(after).not.toContain("Check that the code");
    // When it ends, the last layout is printed once to stdout (the region erased its copy).
    const shown = bare(out.text);
    expect(shown.split("Polaris Key console").length - 1).toBe(1);
    expect(shown).toContain("Enter this code in your browser:");
    expect(shown.indexOf("Polaris Key console")).toBe(0);
  });
});
