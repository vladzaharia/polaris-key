// The program the real-process stdin rows run (cliContract.test.ts, the `cli` family's `stdin`
// rows): `activate` on the process's own stdin and stdout, with a stub client, so the descriptor
// kind (file, FIFO, socket, character device), the bound and the process's exit are the real ones.
// Run with tsx; it prints the flow's result: exit code, state, error code, whether the key it got
// is `PKEY_EXPECT_KEY` ("key", "other" or "none"), and how long the flow took in milliseconds.

import { createKitContext } from "../../src/cli/context.js";
import { activateFlow } from "../../src/cli/flows.js";
import { stubClient } from "./harness.js";

const ctx = await createKitContext({
  slug: "tidewater",
  bin: "tidewater",
  io: { env: { NO_COLOR: "1" } },
  presentation: null,
  queryScheme: false,
});
let received: string | null = null;
const client = stubClient({
  license: {
    activateWithKey: async (key: string) => {
      received = key;
      return { kind: "ok", token: "pkeyt_secret", schemaVersion: 1 };
    },
  },
});
const t0 = Date.now();
const r = await activateFlow(ctx, client);
const ms = Date.now() - t0;
ctx.close();
const got =
  received === null
    ? "none"
    : received === process.env.PKEY_EXPECT_KEY
      ? "key"
      : "other";
process.stdout.write(
  `\nRESULT ${r.exitCode} ${r.state ?? "-"} ${r.error?.code ?? "-"} ${got} ${ms}\n`,
);
// No process.exit: the test is that the process ends by itself once the flow has.
process.exitCode = r.exitCode;
