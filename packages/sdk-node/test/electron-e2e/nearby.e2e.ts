// Sign in from a nearby device in a real Electron runtime (I-47b.4).
// Not typechecked by the package (tsconfig excludes this folder); vitest runs it.
//
//   D  the Electron sample (examples/ui/electron) on a real client, showing the kit's NearbySignIn
//      screen over bridge v5.
//   M  the Node CLI's `devices approve` flow (src/cli/nearby.ts) on a signed-in client, driven
//      with keypresses.
//   Worker  the nearby stub of nearby.e2e.test.ts, served over HTTP on 127.0.0.1 for D (M reaches
//      the same object in process).
//
// The two devices find each other over real multicast DNS on this host's network, so the run is
// opted in like the other live mDNS tests and skips cleanly without it:
//   PKEY_LIVE_MDNS=1 pnpm --filter @polaris-key/node test:electron nearby
// (setup once: pnpm build && pnpm --filter @polaris-key/node test:electron:setup)
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devicesApproveFlow } from "../../src/cli/nearby.js";
import type { PolarisKeyClient } from "../../src/client.js";
import { render, VARIANTS, type Harness } from "../cli/harness.js";
import { BASE, makeClient, markSignedIn, until } from "../lanFixtures.js";
import { NearbyStub } from "../nearbyStub.js";
import { TEST_KID, TEST_PUB } from "../parityFixtures.js";
import { SAMPLE, sampleProblem } from "./sample.mjs";

const LIVE = process.env.PKEY_LIVE_MDNS === "1";
const digits = (s: string): string => s.replace(/\D/g, "");
/** A screen without its colour codes. */
const plain = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;]*m/g, "");

describe.skipIf(!LIVE)(
  "nearby sign-in: Electron sample (D) and CLI (M)",
  () => {
    const dirs: string[] = [];
    const userData = mkdtempSync(join(tmpdir(), "pk-electron-nearby-"));
    const stub = new NearbyStub();
    let server: Server;
    let origin = "";
    let app: ElectronApplication | undefined;
    let m: PolarisKeyClient | undefined;

    beforeAll(async () => {
      const problem = sampleProblem();
      if (problem) throw new Error(`Electron e2e: ${problem}`);
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers))
            if (typeof v === "string") headers[k] = v;
          void (async () => {
            const r = await stub.fetch(`${BASE}${req.url}`, {
              method: req.method,
              headers,
              ...(body === "" ? {} : { body }),
            });
            // The stub names itself by BASE in its discovery document: point it at this server.
            const text = (await r.text()).split(BASE).join(origin);
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(text);
          })();
        });
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const addr = server.address();
      origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      m = await makeClient(stub, "1", dirs);
      markSignedIn(m);
    });

    afterAll(async () => {
      if (app) {
        try {
          await Promise.race([
            app.close(),
            new Promise((_, no) =>
              setTimeout(() => no(new Error("close")), 10_000),
            ),
          ]);
        } catch {
          app.process().kill("SIGKILL");
        }
      }
      m?.close();
      await new Promise<void>((ok) =>
        server ? server.close(() => ok()) : ok(),
      );
      rmSync(userData, { recursive: true, force: true });
      dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    });

    /** The code the window shows to tap on the other device (`482 913`), once it shows one. */
    const shownCode = (page: Page): Promise<string | null> =>
      page.evaluate(() => {
        const t = document.body.innerText;
        const hit = /\b(\d{3})[\s  ]+(\d{3})\b/.exec(t);
        return hit ? `${hit[1]}${hit[2]}` : null;
      });

    it("D asks, M taps the matching code, and the Worker records one approval for D", async () => {
      const electronPath: string = createRequire(`${SAMPLE}package.json`)(
        "electron",
      );
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env))
        if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
      env.PKEY_E2E_SCREEN = "nearby-signin";
      env.PKEY_E2E_NEARBY = JSON.stringify({
        baseUrl: origin,
        productSlug: "djdl",
        kid: TEST_KID,
        pub: TEST_PUB,
      });
      app = await electron.launch({
        executablePath: electronPath,
        args: [
          SAMPLE,
          `--user-data-dir=${join(userData, "d")}`,
          ...(process.platform === "linux" && process.env.CI
            ? ["--no-sandbox"]
            : []),
        ],
        env,
        timeout: 60_000,
      });
      const page = await app.firstWindow();
      await page.waitForSelector(".pk-root", { timeout: 30_000 });

      const run = async (h: Harness) => {
        const done = devicesApproveFlow(h.ctx, m!);
        // D lists M, takes it (one approver) and shows its code.
        let code: string | null = null;
        try {
          await until(
            async () => (code = await shownCode(page)) !== null,
            45_000,
          );
        } catch (e) {
          const text = await page.evaluate(() => document.body.innerText);
          throw new Error(
            `D never showed a code. Window: ${text.replace(/\s+/g, " ")} | M: ${h.screen.text().replace(/\s+/g, " ")} | starts ${stub.starts.size}`,
            { cause: e },
          );
        }
        // M's three codes appear once D's HELLO and code reach it; the person taps D's.
        let key = "";
        try {
          await until(() => {
            for (const r of plain(h.screen.text()).split("\n")) {
              const hit = /(?:^|\s)([123])\s+(\d{3}\s\d{3})(?!\d)/.exec(r);
              if (hit && digits(hit[2]!) === code) key = hit[1]!;
            }
            return key !== "";
          }, 30_000);
        } catch (e) {
          throw new Error(
            `M never showed D's code ${code}. M: ${h.screen.text().replace(/\s+/g, " ")} | starts ${stub.starts.size}`,
            { cause: e },
          );
        }
        h.stdin.press(key);
        const result = await done;
        expect(result.state).not.toBe("error");
      };
      const variant = VARIANTS[0]!;
      await render({ variant, interactive: true }, run);

      // The Worker took exactly one approval, for D's own keys, and D's poll collected the token.
      await until(() => stub.approves.length === 1, 10_000);
      expect(stub.approves[0]).toMatchObject({ decision: "approve" });
      await until(
        () => [...stub.starts.values()].some((s) => s.state === "collected"),
        30_000,
      );
      // D now asks the person to confirm the account.
      await page.waitForFunction(
        () => /ana@example\.com/.test(document.body.innerText),
        undefined,
        { timeout: 20_000 },
      );
    }, 180_000);
  },
);
