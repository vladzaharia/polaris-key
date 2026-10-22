/**
 * How the admin commands (`pkey bundle`, `pkey migrate`, `pkey listing import`) get a credential
 * and what they say when the server refuses (ST-34.9).
 *
 *   credential  `adminCredential()`: `PKEY_ADMIN_TOKEN` (a `pkeya_` or `pkeyp_` token), else the
 *               sign-in `pkey login` saved for the origin. The retired cookie variable refuses
 *               first, and the base-URL rule runs before the store is opened. A stored sign-in
 *               that has ended is refused before anything is sent.
 *   401         the sign-in or the token ended: the same ▲ whoami shows, exit 4.
 *   403         one of three refusals, each ▲ and exit 4 (D-6):
 *               - `no_access`: the person lacks the area. The line names the product and area,
 *                 the person's roles (`GET /me`) and who can grant it (`GET /access/admins`);
 *               - a personal token on a route outside its reach: "isn't available to personal
 *                 tokens";
 *               - a `pkeya_` token on a route that takes personal tokens only: "isn't available
 *                 to API tokens".
 *               Anything else keeps the command's own error (exit 1).
 *   --json      every outcome is one `{"v":1,…}` result line on stdout: a refusal at exit 4 (the
 *               access refusal also carries product, area, roles and people), a failure at 1.
 *
 * The token is never printed, and a lookup that fails only drops its line.
 */

import { cellWidth, wrapSpans, type Line } from "@polaris-key/node/terminal";
import {
  AREA_NAMES,
  Failure,
  Usage,
  block,
  endedRefusal,
  envelope,
  fit,
  networkCode,
  originFor,
  plain,
  roleText,
  text,
} from "./account.js";
import {
  UsageError,
  isInternalError,
  isUsageError,
  networkMessage,
} from "./errors.js";
import { HttpFailure, request } from "./bundle.js";
import { REQUEST_TIMEOUT_MS, readCappedJson } from "./httpRead.js";
import {
  adminCredential,
  Refusal,
  type CredentialStore,
  type ResolvedCredential,
} from "./credentials.js";
import type { Term, TermOut } from "./terminal.js";
import { untrusted, untrustedLines, type UntrustedEnv } from "./untrusted.js";

export interface AdminIo {
  baseUrl: string;
  env: UntrustedEnv;
  stderr: TermOut;
  term: (out: TermOut) => Term;
  store: () => Promise<CredentialStore>;
  fetchImpl?: typeof fetch;
  /** `--json`: every outcome is one `{"v":1,…}` result line on `stdout` (`account.ts` `envelope`). */
  json?: boolean;
  stdout?: TermOut;
  /** One deadline for a caller that makes several requests (`pkey doctor`). */
  signal?: AbortSignal;
  /** Epoch seconds; a test seam. */
  now?: () => number;
}

interface Person {
  name: string;
  email: string;
  role: string;
}

/** What a `no_access` 403 shows. */
export interface AccessInfo {
  /** The product's name as the console shows it, or `Platform`. */
  product: string;
  area: string;
  roles: string[];
  people: Person[];
  /** True when the scope is the platform: the sentence names no area. */
  platform?: boolean;
}

/** Below this many columns each person stacks as name, address and role. */
const STACK_BELOW = 40;
const PEOPLE_INDENT = 5;

/**
 * The access refusal as lines: the sentence ("Product → Area" one bold unit), the roles, then one
 * person per row. Laid out with the account helpers, so nothing overflows: a name is a unit, an
 * address breaks as a URL, the role is muted. Below 40 columns each person stacks.
 */
export function accessText(a: AccessInfo, t: Term): string {
  const { painter, caps } = t;
  const arrow = caps.unicode ? "→" : "->";
  const subject = a.platform ? "Platform" : `${a.product} ${arrow} ${a.area}`;
  const ask = a.people.length
    ? "Ask one of these people:"
    : "Ask an admin to give you access.";
  const roles: Line = a.roles.length
    ? [
        text("Your roles: "),
        ...a.roles.flatMap(
          (r, i): Line => [...(i ? [text(", ")] : []), text(r, { unit: true })],
        ),
        text(`. ${ask}`),
      ]
    : [text(ask)];
  const out = [
    block(t, "warn", [
      [
        text("You don't have access to "),
        text(subject, { style: ["strong"], unit: true }),
        text("."),
      ],
    ]).trimEnd(),
  ];
  const width = Math.max(1, caps.columns - 3);
  for (const l of wrapSpans(fit(roles, width), width))
    out.push(`   ${painter.line(l)}`);

  const room = Math.max(1, caps.columns - PEOPLE_INDENT);
  const pad = " ".repeat(PEOPLE_INDENT);
  const nameW = Math.max(0, ...a.people.map((p) => cellWidth(p.name)));
  const mailW = Math.max(0, ...a.people.map((p) => cellWidth(p.email)));
  for (const p of a.people) {
    const name: Line = [text(p.name, { unit: true })];
    const mail: Line = [text(p.email, { break: "url" })];
    const role: Line = [text(p.role, { style: ["muted"], unit: true })];
    const rows: Line[] =
      caps.columns < STACK_BELOW
        ? [name, mail, role]
        : nameW + 2 + mailW + 2 + cellWidth(p.role) <= room
          ? [
              [
                ...name,
                text(" ".repeat(nameW - cellWidth(p.name) + 2)),
                ...mail,
                text(" ".repeat(mailW - cellWidth(p.email) + 2)),
                ...role,
              ],
            ]
          : [[...name, text("  "), ...mail, text("  "), ...role]];
    for (const row of rows)
      for (const l of wrapSpans(fit(row, room), room))
        out.push(`${pad}${painter.line(l)}`);
  }
  return `${out.join("\n")}\n`;
}

async function getJson(
  io: AdminIo,
  cred: ResolvedCredential,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await request(
      io.fetchImpl ?? fetch,
      `${cred.origin}/manage/api${path}`,
      {
        // The caller's deadline when it has one (`pkey doctor`), else this request's own.
        signal: io.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${cred.token}`,
          accept: "application/json",
        },
      },
    );
    if (!res.ok) return null;
    return await readCappedJson(res);
  } catch {
    return null;
  }
}

const str = (v: unknown, env: UntrustedEnv): string => untrusted(v, env);

export async function accessInfo(
  io: AdminIo,
  cred: ResolvedCredential,
  f: HttpFailure,
): Promise<AccessInfo> {
  const scope = f.detail.scope ?? "platform";
  const area = f.detail.area ?? "console";
  const [me, admins] = await Promise.all([
    getJson(io, cred, "/me"),
    getJson(
      io,
      cred,
      `/access/admins?scope=${encodeURIComponent(scope)}&area=${encodeURIComponent(area)}`,
    ),
  ]);
  // The console's own names for products (`GET /me`), else the slug.
  const names = new Map<string, string>();
  if (Array.isArray(me?.["products"]))
    for (const p of me["products"] as { slug?: unknown; name?: unknown }[])
      if (typeof p?.slug === "string" && typeof p.name === "string")
        names.set(p.slug, p.name);
  const productName = (slug: string): string => names.get(slug) ?? slug;
  const sep = io.term(io.stderr).symbols.separator;
  const rawRoles =
    ((me?.["permissions"] as { roles?: unknown[] } | undefined)?.roles as
      | { role?: unknown; scope?: unknown; areas?: unknown }[]
      | undefined) ?? [];
  const roles = [
    ...new Set(
      rawRoles.map((r) =>
        roleText(
          String(r.role),
          String(r.scope),
          r.areas,
          productName,
          sep,
          io.env,
        ),
      ),
    ),
  ];
  const people = (
    (admins?.["admins"] as
      | { name?: unknown; email?: unknown; role?: unknown }[]
      | undefined) ?? []
  ).map((p) => ({
    name: str(p.name ?? p.email ?? "", io.env),
    email: str(p.email ?? "", io.env),
    role: roleText(String(p.role), scope, null, productName, sep, io.env),
  }));
  const platform = !scope.startsWith("product:");
  return {
    product: platform
      ? "Platform"
      : str(productName(scope.slice("product:".length)), io.env),
    area: str(
      Object.hasOwn(AREA_NAMES, area) ? AREA_NAMES[area] : area,
      io.env,
    ),
    roles,
    people,
    ...(platform ? { platform } : {}),
  };
}

/** The refusal or failure as one `--json` line, else a block on stderr. */
function report(
  io: AdminIo,
  t: Term,
  command: string,
  exit: number,
  kind: "warn" | "fail",
  code: string,
  lines: Line[],
  extra: Record<string, unknown> = {},
): number {
  if (io.json && io.stdout)
    io.stdout.write(
      envelope(command, exit, {
        error: code,
        message: lines.map((l) => l.map((s) => s.text).join("")).join(" "),
        ...extra,
      }),
    );
  else io.stderr.write(block(t, kind, lines));
  return exit;
}

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The access refusal's sentence, as a `--json` message. */
const accessMessage = (a: AccessInfo): string =>
  a.platform
    ? "You don't have access to Platform."
    : `You don't have access to ${a.product} → ${a.area}.`;

/**
 * Run an admin command with its credential. A `Refusal`, a 401 and a 403 that earns one print
 * (stderr, or the result line under `--json`) and exit 4; a failure is exit 1; everything else is
 * the command's to report.
 */
export async function withAdminCredential(
  io: AdminIo,
  command: string,
  run: (token: () => Promise<string>) => Promise<number>,
  /** Commands whose route takes a personal token only: a `pkeya_` token there is refused by kind. */
  personalOnly = false,
): Promise<number> {
  let cred: ResolvedCredential | undefined;
  // Resolved when the command asks, after its own usage checks: a typo in a flag is a usage
  // error whether or not anyone is signed in.
  const token = async (): Promise<string> => {
    if (!cred) {
      // The https rule first: one ▲ sentence, and no word of a token nobody set.
      originFor(io, command);
      const found = await adminCredential({
        env: io.env,
        baseUrl: io.baseUrl,
        store: io.store,
      });
      cred = found;
      const now = (io.now ?? (() => Math.floor(Date.now() / 1000)))();
      if (
        found.source === "store" &&
        found.expiresAt !== null &&
        found.expiresAt <= now
      )
        throw endedRefusal(found);
    }
    return cred.token;
  };
  try {
    return await run(token);
  } catch (e) {
    const t = io.term(io.stderr);
    if (e instanceof Refusal)
      return report(
        io,
        t,
        command,
        e instanceof Usage ? 2 : 4,
        "warn",
        e.code,
        (e as { lines?: Line[] }).lines ?? plain(e.message, e.fix),
      );
    if (e instanceof Failure)
      return report(
        io,
        t,
        command,
        1,
        "fail",
        e.code,
        e.lines ?? plain(e.message, e.fix),
        e.extra,
      );
    if (e instanceof HttpFailure && cred) {
      if (e.status === 401) {
        const r = endedRefusal(cred);
        return report(
          io,
          t,
          command,
          4,
          "warn",
          r.code,
          plain(r.message, r.fix),
        );
      }
      if (e.status === 403) {
        const isApi = cred.token.startsWith("pkeya_");
        if (e.detail.reason === "no_access") {
          const a = await accessInfo(io, cred, e);
          if (io.json && io.stdout)
            io.stdout.write(
              envelope(command, 4, {
                error: "no-access",
                message: accessMessage(a),
                product: a.product,
                area: a.area,
                roles: a.roles,
                people: a.people,
              }),
            );
          else io.stderr.write(accessText(a, t));
          return 4;
        }
        if (!isApi || personalOnly) {
          const what = `pkey ${command} isn't available to ${isApi ? "API" : "personal"} tokens.`;
          const apiTokens = `${cred.origin}/manage/#/tokens`;
          return report(
            io,
            t,
            command,
            4,
            "warn",
            "token-refused",
            isApi
              ? plain(what, "Run pkey login.")
              : [
                  [text(what)],
                  [
                    text("Make an API token at "),
                    text(apiTokens, { break: "url", link: apiTokens }),
                  ],
                ],
          );
        }
      }
    }
    // Under --json a bug is the result line too; without it, and for a usage error (which stays
    // on stderr with stdout empty), the generic path is the caller's one-line report.
    if (io.json && io.stdout) {
      if (isInternalError(e)) {
        io.stdout.write(
          envelope(command, 1, {
            error: "internal",
            message: untrusted(errorText(e), io.env),
          }),
        );
        return 1;
      }
    }
    // Any other failure of the command is the same ✗ sentence-and-fix every account command
    // draws (or the same result line under --json).
    if (!(e instanceof UsageError) && !isInternalError(e)) {
      const message = untrustedLines(networkMessage(e), io.env);
      if (!isUsageError(message)) {
        const [first = "", ...rest] = message.split("\n");
        if (io.json && io.stdout)
          io.stdout.write(
            envelope(command, 1, {
              error: networkCode(e) ? "network" : "failed",
              message: first,
              ...(rest.length ? { fix: rest.join(" ") } : {}),
              ...(e instanceof HttpFailure ? { status: e.status } : {}),
            }),
          );
        else io.stderr.write(block(t, "fail", plain(first, ...rest)));
        return 1;
      }
    }
    throw e;
  }
}

/** `▲  sentence` and the fix on its own line, wrapped (the shared ▲ block). */
export function refusalLines(r: Refusal, t: Term): string {
  return block(t, "warn", plain(r.message, r.fix));
}
