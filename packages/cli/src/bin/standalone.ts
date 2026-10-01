/**
 * The entry of the standalone bundle (`actions/publish/dist/index.js`, P2-06): one file that is
 * both the `polaris-key/publish` Action (started with no arguments and `INPUT_*` variables) and a
 * dependency-free `pkey` (`node pkey.mjs validate`) for repositories with no `node_modules`.
 */
import { runPkey } from "../index.js";
import { isActionInvocation, runAction } from "../action.js";

const argv = process.argv.slice(2);
process.exitCode = isActionInvocation(argv, process.env)
  ? await runAction({
      env: process.env,
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    })
  : await runPkey(argv);
