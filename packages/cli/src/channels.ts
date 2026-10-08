/**
 * `pkey release promote|pin|unpin|yank` (P2-06): drive channel policy from CI through P2-05's
 * routes, with the same credential as the publish (`release:promote`; `release:yank` is opt-in
 * per product, granted by an operator).
 *
 *   promote <releaseId> --channel <c>   POST /<p>/release/channels/<c>/promote  {releaseId}
 *   pin     <releaseId> --channel <c>   POST /<p>/release/channels/<c>/pin      {releaseId}
 *   unpin              --channel <c>    POST /<p>/release/channels/<c>/unpin    {}
 *   yank    <releaseId> --reason <text> POST /<p>/release/releases/<id>/yank    {reason}
 *
 * `--deliverable` rides along when given (the routes default to the app).
 */

import { ciClient, type Out, type Sleep } from "./ci.js";
import { resolveCiToken, type CiEnv } from "./oidc.js";

export type PointerOp = "promote" | "pin" | "unpin";

export const CHANNEL_USAGE =
  "Usage: pkey release promote|pin <releaseId> --channel <c> --product <slug> [--deliverable id] [--base-url url]\n" +
  "       pkey release unpin --channel <c> --product <slug> [--deliverable id] [--base-url url]\n" +
  "       pkey release yank <releaseId> --reason <text> --product <slug> [--base-url url]";

export interface ChannelCommandOptions {
  product: string;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

async function clientFor(opts: ChannelCommandOptions) {
  const token = await resolveCiToken({
    baseUrl: opts.baseUrl,
    product: opts.product,
    env: opts.env,
    out: opts.stdout,
    log: opts.stderr,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  return ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
    env: opts.env,
  });
}

export async function movePointer(
  opts: ChannelCommandOptions & {
    op: PointerOp;
    channel: string;
    releaseId?: string;
    deliverable?: string;
  },
): Promise<Record<string, unknown>> {
  if (!opts.channel)
    throw new Error(`--channel is required.\n${CHANNEL_USAGE}`);
  if (opts.op !== "unpin" && !opts.releaseId)
    throw new Error(
      `pkey release ${opts.op} needs a release id.\n${CHANNEL_USAGE}`,
    );
  const client = await clientFor(opts);
  const body = await client.postJson(
    `release/channels/${encodeURIComponent(opts.channel)}/${opts.op}`,
    {
      what: `${opts.op[0]!.toUpperCase()}${opts.op.slice(1)} on ${opts.channel}`,
      body: {
        ...(opts.op !== "unpin" ? { releaseId: opts.releaseId } : {}),
        ...(opts.deliverable ? { deliverable: opts.deliverable } : {}),
      },
    },
  );
  const verb = { promote: "Promoted", pin: "Pinned", unpin: "Unpinned" }[
    opts.op
  ];
  opts.stdout.write(
    opts.op === "unpin"
      ? `${verb} ${opts.channel}\n`
      : `${verb} ${opts.releaseId} ${opts.op === "pin" ? "on" : "to"} ${opts.channel}\n`,
  );
  return body;
}

export async function yankRelease(
  opts: ChannelCommandOptions & { releaseId: string; reason: string },
): Promise<Record<string, unknown>> {
  if (!opts.releaseId)
    throw new Error(`pkey release yank needs a release id.\n${CHANNEL_USAGE}`);
  if (!opts.reason) throw new Error(`--reason is required.\n${CHANNEL_USAGE}`);
  const client = await clientFor(opts);
  const body = await client.postJson(
    `release/releases/${encodeURIComponent(opts.releaseId)}/yank`,
    { what: `Yanking ${opts.releaseId}`, body: { reason: opts.reason } },
  );
  opts.stdout.write(`Yanked ${opts.releaseId}\n`);
  return body;
}
