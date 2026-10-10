// The program the real-process stdin tests run (uk45.test.ts): `activate` on the process's own
// stdin and stdout, with a stub client, so the descriptor kind (file, FIFO, socket), the bound and
// the process's exit are the real ones. Run with tsx; it prints the flow's exit code and state.

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
const r = await activateFlow(ctx, stubClient());
ctx.close();
process.stdout.write(`\nRESULT ${r.exitCode} ${r.state ?? ""}\n`);
// No process.exit: the test is that the process ends by itself once the flow has.
process.exitCode = r.exitCode;
