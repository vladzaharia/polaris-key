#!/usr/bin/env node
import { runPkey } from "../index.js";

// `pkey --help | head -1` closes the pipe while pkey still writes: that is the reader's choice,
// not a failure, so stop quietly instead of printing Node's unhandled-'error' stack.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

const code = await runPkey(process.argv.slice(2));
process.exitCode = code;
