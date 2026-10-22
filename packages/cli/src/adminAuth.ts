/**
 * How the admin commands (`pkey bundle`, `pkey migrate`, `pkey listing import`) get a credential
 * and what they say when the server answers 403 (ST-34.9).
 *
 *   credential  `adminCredential()`: `PKEY_ADMIN_TOKEN` (a `pkeya_` or `pkeyp_` token), else the
 *               sign-in `pkey login` saved for the origin. The retired cookie variable refuses
 *               first, and the base-URL rule runs before the store is opened.
 *   403         one of three refusals, each ▲ and exit 4 (D-6):
 *               - `no_access`: the person lacks the area. The line names the product and area,
 *                 the person's roles (`GET /me`) and who can grant it (`GET /access/admins`);
 *               - a personal token on a route outside its reach: "isn't available to personal
 *                 tokens";
 *               - a `pkeya_` token on a route that takes personal tokens only: "isn't available
 *                 to API tokens".
 *               Anything else keeps the command's own error (exit 1).
 *
 * The token is never printed, and a lookup that fails only drops its line.
 */

import { wrapSpans } from "@polaris-key/node/terminal";
import { HttpFailure, request } from "./bundle.js";
import {
  adminCredential,
  Refusal,
  type CredentialStore,
  type ResolvedCredential,
} from "./credentials.js";
import type { Term, TermOut } from "./terminal.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";

/** The console's area names (`AREAS` in the Worker's core/rbac/areas.ts), by id. */
const AREA_NAMES: Readonly<Record<string, string>> = {
  console: "Console",
  platform: "Platform",
  members: "Members",
  docs: "Docs",
  core: "Core",
  license: "Licensing",
  config: "Managed config",
  ship: "Ship builds",
  signin: "Sign-in",
  sync: "Cloud Sync",
  commerce: "Commerce",
  keys: "Keys and secrets",
  settings: "Settings",
};

export interface AdminIo {
  baseUrl: string;
  env: UntrustedEnv;
  stderr: TermOut;
  term: (out: TermOut) => Term;
  store: () => Promise<CredentialStore>;
  fetchImpl?: typeof fetch;
  /** One deadline for a caller that makes several requests (`pkey doctor`). */
  signal?: AbortSignal;
}

/** The console's role names (`roleLabel` in the admin SPA), by role id. */
function roleName(role: string, scope: string): string {
  switch (role) {
    case "superadmin":
      return "Superadmin";
    case "platform_admin":
      return "Platform admin";
    case "console_access":
      return "Console access";
    case "product_admin":
      return scope.startsWith("product:")
        ? `${scope.slice("product:".length)} admin`
        : "All products admin";
    default:
      return role;
  }
}

interface Person {
  name: string;
  email: string;
  role: string;
}

/** What a `no_access` 403 shows. */
export interface AccessInfo {
  product: string;
  area: string;
  roles: string[];
  people: Person[];
}

/** `▲  text` over `   continuation` lines, each wrapped to the terminal. */
function wrapped(text: string, t: Term, lead: string, indent: string): string {
  const width = Math.max(1, t.caps.columns - indent.length);
  return wrapSpans([{ text }], width)
    .map((l, i) => `${i === 0 ? lead : indent}${t.painter.line(l)}`)
    .join("\n");
}

/** The access refusal as lines: the sentence, the roles, then one person per line. */
export function accessText(a: AccessInfo, t: Term): string {
  const { painter, symbols, caps } = t;
  const warn = `${painter.style(symbols.warn, ["warning"])}  `;
  const out = [
    wrapped(
      `You don't have access to ${a.product} → ${a.area}.`,
      t,
      warn,
      "   ",
    ),
  ];
  const ask = a.people.length
    ? "Ask one of these people:"
    : "Ask an admin to give you access.";
  out.push(
    wrapped(
      a.roles.length ? `Your roles: ${a.roles.join(", ")}. ${ask}` : ask,
      t,
      "   ",
      "   ",
    ),
  );
  const nameW = Math.max(0, ...a.people.map((p) => p.name.length));
  const mailW = Math.max(0, ...a.people.map((p) => p.email.length));
  for (const p of a.people) {
    const row = `     ${p.name.padEnd(nameW)}  ${p.email.padEnd(mailW)}  ${p.role}`;
    if (row.length <= caps.columns) out.push(row);
    else out.push(`     ${p.name}`, `     ${p.email} · ${p.role}`);
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
        redirect: "manual",
        ...(io.signal ? { signal: io.signal } : {}),
        headers: {
          authorization: `Bearer ${cred.token}`,
          accept: "application/json",
        },
      },
    );
    if (!res.ok) return null;
    const v = (await res.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
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
  const rawRoles =
    ((me?.["permissions"] as { roles?: unknown[] } | undefined)?.roles as
      | { role?: unknown; scope?: unknown }[]
      | undefined) ?? [];
  const roles = [
    ...new Set(
      rawRoles.map((r) =>
        str(roleName(String(r.role), String(r.scope)), io.env),
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
    role: str(roleName(String(p.role), scope), io.env),
  }));
  return {
    product: scope.startsWith("product:")
      ? str(scope.slice("product:".length), io.env)
      : "Platform",
    area: str(AREA_NAMES[area] ?? area, io.env),
    roles,
    people,
  };
}

/**
 * Run an admin command with its credential. A `Refusal` and a 403 that earns one print on
 * stderr and exit 4; everything else is the command's to report.
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
  const token = async (): Promise<string> =>
    (cred ??= await adminCredential({
      env: io.env,
      baseUrl: io.baseUrl,
      store: io.store,
    })).token;
  try {
    return await run(token);
  } catch (e) {
    const t = io.term(io.stderr);
    if (e instanceof Refusal) {
      io.stderr.write(refusalLines(e, t));
      return 4;
    }
    if (e instanceof HttpFailure && e.status === 403 && cred) {
      const isApi = cred.token.startsWith("pkeya_");
      if (e.detail.reason === "no_access") {
        io.stderr.write(accessText(await accessInfo(io, cred, e), t));
        return 4;
      }
      if (!isApi || personalOnly) {
        io.stderr.write(
          refusalLines(
            new Refusal(
              `pkey ${command} isn't available to ${isApi ? "API" : "personal"} tokens.`,
              isApi
                ? "Run pkey login."
                : "Use an API token: /manage -> API tokens.",
            ),
            t,
          ),
        );
        return 4;
      }
    }
    throw e;
  }
}

/** `▲  sentence` and the fix on its own line, wrapped. */
export function refusalLines(r: Refusal, t: Term): string {
  const warn = `${t.painter.style(t.symbols.warn, ["warning"])}  `;
  return `${[wrapped(r.message, t, warn, "   "), ...(r.fix ? [wrapped(r.fix, t, "   ", "   ")] : [])].join("\n")}\n`;
}
