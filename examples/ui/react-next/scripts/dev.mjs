import { spawn } from "node:child_process";

let live = false;
const nextArgs = [];

for (const arg of process.argv.slice(2)) {
  if (arg === "--live") {
    live = true;
  } else {
    nextArgs.push(arg);
  }
}

const next = process.platform === "win32" ? "next.cmd" : "next";
const child = spawn(next, ["dev", ...nextArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    // Keep the default deterministic even when a shell previously exported this variable.
    NEXT_PUBLIC_POLARIS_LIVE: live ? "1" : "0",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
