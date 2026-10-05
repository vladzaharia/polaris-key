/**
 * The setup snippets of the package feeds (F-12, plans/F-01.md §6.7 and §6.9; plans/F-20.md §3
 * and §6.3): what a client needs to install from one feed, rendered by ONE pure function,
 * `renderFeedSetup`, which the console's Setup tabs and the CLI's `pkey feeds setup` both call,
 * so the two can never disagree.
 *
 * DRIVEN BY DECLARATIONS. Each ecosystem declares its setup once, in `FEED_SETUP`: the clients the
 * docs and the console name, the inputs its snippets read (`inputs`) and the feed's path on the
 * registry host. The Worker's feed adapter for the ecosystem
 * (`packages/worker/src/services/distribution/registry/<ecosystem>/index.ts`) points its `setup` at
 * the same object, and its conformance suite (`test/feedAdapters.test.ts`) checks the path and
 * the namespace inputs against the adapter. A template reads its inputs only through the values
 * `renderFeedSetup` resolves from that list: reading an undeclared one throws, so `inputs` is
 * exactly what each snippet depends on.
 *
 * STRICT ROUTERS ONLY (plans/F-01.md §6.7 point 4, notes/S-12 §8.3). Every snippet sends only the
 * feed's own names to the feed: the npm scope, uv `explicit = true`, Poetry `priority = "explicit"`,
 * Gradle `exclusiveContent`, SwiftPM `--scope`, a fully qualified OCI reference, the Godot
 * editor's settings name per editor version, Cargo's `registry =` per dependency. Where a client
 * has no router (pip, Maven) the snippet carries a `warning` saying so; pip's warns against
 * `--extra-index-url`.
 *
 * CREDENTIALS (plans/F-20.md §3): `{kind: "none"}` is a public feed's setup; `env` names an
 * environment variable holding a registry token (the docs, `pkey feeds setup --token-env`);
 * `token` writes a shown-once token into the snippets (the console's token dialog, F-21);
 * `godot-url` is the Godot editor's tokenised URL. A Godot feed takes only `godot-url`; every
 * other feed ignores it. Nothing here mints, stores or validates a token beyond its shape.
 */

import {
  PACKAGE_ECOSYSTEM_RULES,
  isPackageEcosystem,
  type PackageEcosystem,
} from "./packages.js";

/**
 * An input a feed's setup snippets read: the feed's base URL, the bare registry host (docker),
 * the owner slug, a namespace key the ecosystem's ingest rules declare (`namespace.scope`), or
 * the package and version being shown.
 */
export type FeedSetupInput =
  | "baseUrl"
  | "registryHost"
  | "owner"
  | "package.name"
  | "package.version"
  | `namespace.${string}`;

/** What the snippets authenticate with (plans/F-20.md §3). */
export type FeedSetupCredential =
  | { readonly kind: "none" }
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "godot-url"; readonly value: string };

/** The highlighting a snippet asks for (a subset of the console's `CodeBlock` languages). */
export type FeedSnippetLanguage = "sh" | "toml" | "yaml" | "json" | "text";

/** One copy-paste snippet. */
export interface FeedSnippet {
  /** Stable within an ecosystem (`npmrc`, `uv`), for keys and tests. */
  readonly id: string;
  /** The client or clients it is for, as the docs name them. */
  readonly clients: string;
  readonly title: string;
  readonly description?: string;
  /** Something the reader must not get wrong (pip's `--extra-index-url`). */
  readonly warning?: string;
  /** The file the code goes into, when it is a file. */
  readonly filename?: string;
  readonly language: FeedSnippetLanguage;
  readonly code: string;
}

/** Everything `renderFeedSetup` may read; each template sees only what its feed declares. */
export interface FeedSetupContext {
  /** The registry host's origin, `https://pkg.plrs.im` (no trailing slash). */
  readonly origin: string;
  /** The owning product's slug. */
  readonly owner: string;
  /** The feed's `namespace_json`, as the settings hold it. */
  readonly namespace?: Readonly<Record<string, unknown>>;
  /** One package (and version) to show the setup for; omitted for the feed as a whole. */
  readonly package?: {
    readonly name: string;
    readonly version?: string | null;
  };
  readonly credential?: FeedSetupCredential;
}

/** The resolved inputs a template reads, by declared name. */
interface FeedSetupValues {
  /** A declared input's value; `undefined` when the context has none. Throws for an undeclared one. */
  get(input: FeedSetupInput): unknown;
  readonly credential: FeedSetupCredential;
}

/** One ecosystem's setup declaration. */
export interface FeedSetupDeclaration {
  /** The clients the docs and the console name. */
  readonly clients: readonly string[];
  /** What the snippets read; nothing else reaches the template. */
  readonly inputs: readonly FeedSetupInput[];
  /** The feed's base path on the registry host for one (already URL-encoded) owner. */
  feedPath(owner: string): string;
  render(values: FeedSetupValues): FeedSnippet[];
}

/** The default registry origin (`PKG_ORIGIN` in production). */
export const DEFAULT_REGISTRY_ORIGIN = "https://pkg.plrs.im";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** A token or URL token as it may appear inside a snippet: no quoting is ever needed. */
const TOKEN_VALUE = /^[A-Za-z0-9_.~-]{8,512}$/;
const OWNER = /^[a-z0-9-]{1,64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

/** Is `v` a usable environment-variable name for `--token-env`? */
export function isFeedTokenEnvName(v: string): boolean {
  return ENV_NAME.test(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function list(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x !== "")
    : [];
}

function hostOf(origin: string): string {
  return new URL(origin).host;
}

function noSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A Gradle repository name (its credential property prefix) from the owner slug. */
function repoName(owner: string): string {
  return owner.replace(/[^A-Za-z0-9]/g, "_");
}

/** `UV_INDEX_<NAME>_…`: uv upper-cases the index name and turns anything else into `_`. */
function uvEnvName(index: string): string {
  return index.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The secret as a shell expression (`"$NAME"`) or a literal token. */
function shSecret(c: FeedSetupCredential): string | null {
  if (c.kind === "env") return `"$${c.name}"`;
  if (c.kind === "token") return c.value;
  return null;
}

/** The secret as a config file's environment reference (`${NAME}`) or a literal token. */
function fileSecret(c: FeedSetupCredential, env: (name: string) => string) {
  if (c.kind === "env") return env(c.name);
  if (c.kind === "token") return c.value;
  return null;
}

function lines(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string").join("\n");
}

// ── per-ecosystem declarations ─────────────────────────────────────────────────────

const NPM_SETUP: FeedSetupDeclaration = {
  clients: ["npm", "pnpm", "Yarn Berry", "Bun"],
  inputs: ["baseUrl", "namespace.scope", "package.name", "package.version"],
  feedPath: (owner) => `/npm/${owner}/`,
  render(v) {
    const baseUrl = v.get("baseUrl") as string;
    const name = str(v.get("package.name"));
    const version = str(v.get("package.version"));
    const scope =
      str(v.get("namespace.scope")) ?? /^(@[^/]+)\//.exec(name ?? "")?.[1];
    const s = scope ?? "@scope";
    const bare = s.slice(1);
    const authPath = baseUrl.replace(/^https?:/, "");
    const npmrcToken = fileSecret(v.credential, (n) => `\${${n}}`);
    const yarnToken = fileSecret(v.credential, (n) => `\${${n}}`);
    const bunToken = fileSecret(v.credential, (n) => `$${n}`);
    return [
      {
        id: "npmrc",
        clients: "npm, pnpm",
        title: "npm and pnpm: route the scope to this feed",
        description: `Only ${s} packages are looked up here; every other package stays on its usual registry.`,
        filename: ".npmrc",
        language: "text",
        code: lines(
          `${s}:registry=${baseUrl}`,
          npmrcToken !== null && `${authPath}:_authToken=${npmrcToken}`,
        ),
      },
      {
        id: "yarn",
        clients: "Yarn Berry",
        title: "Yarn Berry",
        filename: ".yarnrc.yml",
        language: "yaml",
        code: lines(
          "npmScopes:",
          `  ${bare}:`,
          `    npmRegistryServer: ${JSON.stringify(baseUrl)}`,
          yarnToken !== null &&
            `    npmAuthToken: ${JSON.stringify(yarnToken)}\n    npmAlwaysAuth: true`,
        ),
      },
      {
        id: "bun",
        clients: "Bun",
        title: "Bun",
        filename: "bunfig.toml",
        language: "toml",
        code: lines(
          "[install.scopes]",
          bunToken === null
            ? `${JSON.stringify(s)} = ${JSON.stringify(baseUrl)}`
            : `${JSON.stringify(s)} = { url = ${JSON.stringify(baseUrl)}, token = ${JSON.stringify(bunToken)} }`,
        ),
      },
      {
        id: "install",
        clients: "npm",
        title: "Install",
        language: "sh",
        code: `npm install ${name ? `${name}${version ? `@${version}` : ""}` : `${s}/<package>`}`,
      },
    ];
  },
};

const PYPI_SETUP: FeedSetupDeclaration = {
  clients: ["pip", "uv", "Poetry"],
  inputs: [
    "baseUrl",
    "owner",
    "namespace.names",
    "package.name",
    "package.version",
  ],
  feedPath: (owner) => `/pypi/${owner}/simple/`,
  render(v) {
    const baseUrl = v.get("baseUrl") as string;
    const index = v.get("owner") as string;
    // The feed's one project name, when it has exactly one, stands in for the package.
    const names = list(v.get("namespace.names"));
    const name =
      str(v.get("package.name")) ??
      (names.length === 1 ? names[0] : undefined) ??
      "<package>";
    const version = str(v.get("package.version"));
    const secret = shSecret(v.credential);
    const uvVar = uvEnvName(index);
    const authed = secret !== null;
    const pipUrl =
      v.credential.kind === "env"
        ? baseUrl.replace(
            /^(https?:\/\/)/,
            `$1__token__:\${${v.credential.name}}@`,
          )
        : v.credential.kind === "token"
          ? baseUrl.replace(
              /^(https?:\/\/)/,
              `$1__token__:${v.credential.value}@`,
            )
          : baseUrl;
    const snippets: FeedSnippet[] = [
      {
        id: "uv",
        clients: "uv",
        title: "uv: an explicit index for this project only",
        description:
          "explicit = true keeps every other dependency on its usual index.",
        filename: "pyproject.toml",
        language: "toml",
        code: lines(
          "[[tool.uv.index]]",
          `name = ${JSON.stringify(index)}`,
          `url = ${JSON.stringify(baseUrl)}`,
          "explicit = true",
          authed && `authenticate = "always"`,
          "",
          "[tool.uv.sources]",
          `${JSON.stringify(name)} = { index = ${JSON.stringify(index)} }`,
        ),
      },
    ];
    if (authed)
      snippets.push({
        id: "uv-credentials",
        clients: "uv",
        title: "uv: the index credentials",
        language: "sh",
        code: lines(
          `export UV_INDEX_${uvVar}_USERNAME=__token__`,
          `export UV_INDEX_${uvVar}_PASSWORD=${secret}`,
        ),
      });
    snippets.push(
      {
        id: "poetry",
        clients: "Poetry",
        title: "Poetry 2: an explicit source",
        language: "sh",
        code: lines(
          `poetry source add --priority=explicit ${index} ${baseUrl}`,
          authed && `poetry config http-basic.${index} __token__ ${secret}`,
          `poetry add --source ${index} ${name}${version ? `==${version}` : ""}`,
        ),
      },
      {
        id: "pip",
        clients: "pip",
        title: "pip: the package alone, without its dependencies",
        description:
          "pip cannot route one project to one index: install the dependencies from your usual index first, then this package from the feed.",
        warning:
          "Never add this feed with --extra-index-url. pip has no per-project routing: with two indexes it takes the highest version from either, so a public package with the same name could win.",
        language: "sh",
        code: `pip install --no-deps --index-url ${pipUrl} ${name}${version ? `==${version}` : ""}`,
      },
    );
    return snippets;
  },
};

const SWIFT_SETUP: FeedSetupDeclaration = {
  clients: ["SwiftPM"],
  inputs: ["baseUrl", "namespace.scope", "package.name", "package.version"],
  feedPath: (owner) => `/swift/${owner}/`,
  render(v) {
    const url = noSlash(v.get("baseUrl") as string);
    const name = str(v.get("package.name"));
    const version = str(v.get("package.version"));
    const scope =
      str(v.get("namespace.scope")) ??
      (name?.includes(".") ? name.split(".")[0] : undefined) ??
      "<scope>";
    const id = name ?? `${scope}.<Package>`;
    const secret = shSecret(v.credential);
    return [
      {
        id: "registries-json",
        clients: "SwiftPM",
        title: "Route the scope to this feed and refuse an unsigned release",
        description:
          "The whole file, in place of swift package-registry set: SwiftPM needs version and registries beside security. For every project on the machine, ~/.swiftpm/configuration/registries.json. Unless the signer chains to a root SwiftPM already trusts, add trustedRootCertificatesPath under signing.",
        filename: ".swiftpm/configuration/registries.json",
        language: "json",
        code: JSON.stringify(
          {
            version: 1,
            registries: { [scope]: { url } },
            security: {
              default: {
                signing: {
                  onUnsigned: "error",
                  onUntrustedCertificate: "error",
                },
              },
            },
          },
          null,
          2,
        ),
      },
      ...(secret !== null
        ? [
            {
              id: "registry-login",
              clients: "SwiftPM",
              title: "Sign in to the feed",
              description:
                "After the file above: login adds its authentication entry to it.",
              language: "sh" as const,
              code: `swift package-registry login ${url} --token ${secret} --no-confirm`,
            },
          ]
        : []),
      {
        id: "package-swift",
        clients: "SwiftPM",
        title: "Depend on the package",
        filename: "Package.swift",
        language: "text",
        code: `.package(id: ${JSON.stringify(id)}, from: ${JSON.stringify(version ?? "1.0.0")})`,
      },
    ];
  },
};

const MAVEN_SETUP: FeedSetupDeclaration = {
  clients: ["Gradle", "Maven"],
  inputs: [
    "baseUrl",
    "owner",
    "namespace.groupPrefixes",
    "package.name",
    "package.version",
  ],
  feedPath: (owner) => `/maven/${owner}/`,
  render(v) {
    const baseUrl = v.get("baseUrl") as string;
    const owner = v.get("owner") as string;
    const repo = repoName(owner);
    const name = str(v.get("package.name"));
    const version = str(v.get("package.version"));
    const groups = list(v.get("namespace.groupPrefixes"));
    const fallback = name?.split(":")[0] ?? groups[0] ?? "<group.prefix>";
    const filters = (groups.length ? groups : [fallback])
      .map(
        (g) => `                includeGroupAndSubgroups(${JSON.stringify(g)})`,
      )
      .join("\n");
    const coord = name
      ? `${name}:${version ?? "<version>"}`
      : `${fallback}:<artifact>:<version>`;
    const authed = v.credential.kind === "env" || v.credential.kind === "token";
    const snippets: FeedSnippet[] = [
      {
        id: "gradle",
        clients: "Gradle",
        title: "Gradle: this feed, for its groups only",
        filename: "settings.gradle.kts",
        language: "text",
        code: lines(
          "dependencyResolutionManagement {",
          "    repositories {",
          "        exclusiveContent {",
          "            forRepository {",
          authed
            ? lines(
                "                maven {",
                `                    name = ${JSON.stringify(repo)}`,
                `                    url = uri(${JSON.stringify(baseUrl)})`,
                "                    credentials(PasswordCredentials::class)",
                "                }",
              )
            : `                maven { url = uri(${JSON.stringify(baseUrl)}) }`,
          "            }",
          "            filter {",
          filters,
          "            }",
          "        }",
          "        mavenCentral()",
          "    }",
          "}",
        ),
      },
    ];
    if (v.credential.kind === "env")
      snippets.push({
        id: "gradle-credentials",
        clients: "Gradle",
        title: "Gradle: the repository credentials",
        language: "sh",
        code: lines(
          `export ORG_GRADLE_PROJECT_${repo}Username=__token__`,
          `export ORG_GRADLE_PROJECT_${repo}Password="$${v.credential.name}"`,
        ),
      });
    else if (v.credential.kind === "token")
      snippets.push({
        id: "gradle-credentials",
        clients: "Gradle",
        title: "Gradle: the repository credentials",
        filename: "~/.gradle/gradle.properties",
        language: "text",
        code: lines(
          `${repo}Username=__token__`,
          `${repo}Password=${v.credential.value}`,
        ),
      });
    snippets.push(
      {
        id: "gradle-dependency",
        clients: "Gradle",
        title: "Depend on the artifact",
        filename: "build.gradle.kts",
        language: "text",
        code: `implementation(${JSON.stringify(coord)})`,
      },
      {
        id: "maven",
        clients: "Maven",
        title: "Maven: the repository, with a fatal checksum policy",
        warning:
          "Maven asks every repository for every artifact. Keep the feed's group prefixes ones you hold on Maven Central, so no one else can publish under them there.",
        filename: "pom.xml",
        language: "text",
        code: lines(
          "<repositories>",
          "  <repository>",
          `    <id>${xml(owner)}</id>`,
          `    <url>${xml(baseUrl)}</url>`,
          "    <releases><checksumPolicy>fail</checksumPolicy></releases>",
          "    <snapshots><enabled>false</enabled></snapshots>",
          "  </repository>",
          "</repositories>",
        ),
      },
    );
    const mavenSecret = fileSecret(v.credential, (n) => `\${env.${n}}`);
    if (mavenSecret !== null)
      snippets.push({
        id: "maven-credentials",
        clients: "Maven",
        title: "Maven: the server credentials",
        filename: "~/.m2/settings.xml",
        language: "text",
        code: lines(
          "<servers>",
          "  <server>",
          `    <id>${xml(owner)}</id>`,
          "    <username>__token__</username>",
          `    <password>${xml(mavenSecret)}</password>`,
          "  </server>",
          "</servers>",
        ),
      });
    return snippets;
  },
};

const OCI_SETUP: FeedSetupDeclaration = {
  clients: ["docker", "podman", "crane"],
  inputs: ["registryHost", "owner", "package.name", "package.version"],
  feedPath: (owner) => `/v2/${owner}/`,
  render(v) {
    const host = v.get("registryHost") as string;
    const owner = v.get("owner") as string;
    const repo = str(v.get("package.name")) ?? "<repository>";
    const tag = str(v.get("package.version")) ?? "latest";
    const login =
      v.credential.kind === "env"
        ? `echo "$${v.credential.name}" | docker login ${host} -u __token__ --password-stdin`
        : v.credential.kind === "token"
          ? `echo ${v.credential.value} | docker login ${host} -u __token__ --password-stdin`
          : null;
    return [
      {
        id: "pull",
        clients: "docker, podman, crane",
        title: "Pull by the fully qualified reference",
        description:
          "podman pull and crane pull take the same reference; it never resolves on another registry.",
        language: "sh",
        code: lines(login, `docker pull ${host}/${owner}/${repo}:${tag}`),
      },
    ];
  },
};

const GODOT_SETUP: FeedSetupDeclaration = {
  clients: ["The Godot editor's asset library", "GodotEnv"],
  inputs: ["baseUrl"],
  feedPath: (owner) => `/godot/${owner}/`,
  render(v) {
    const base = v.get("baseUrl") as string;
    const root =
      v.credential.kind === "godot-url"
        ? `${base}t/${v.credential.value}/`
        : base;
    return [
      {
        id: "editor-4.6",
        clients: "Godot 4.4 to 4.6",
        title: "Godot 4.6 and earlier: Asset Library → Available URLs",
        description: "Editor Settings, asset_library/available_urls.",
        language: "text",
        code: `${root}asset-library/api`,
      },
      {
        id: "editor-4.7",
        clients: "Godot 4.7 and later",
        title: "Godot 4.7 and later: asset_store/available_urls",
        description: "Editor Settings, asset_store/available_urls.",
        language: "text",
        code: `${root}store/api/v1`,
      },
      {
        id: "godotenv",
        clients: "GodotEnv",
        title: "GodotEnv: copy a version's addons.json entry from the index",
        language: "text",
        code: `${root}index.json`,
      },
    ];
  },
};

/** Cargo's `CARGO_REGISTRIES_<NAME>_TOKEN`: the registry name upper-cased, `-` as `_`. */
function cargoEnvName(registry: string): string {
  return registry.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

const CARGO_SETUP: FeedSetupDeclaration = {
  clients: ["Cargo"],
  inputs: ["baseUrl", "owner", "package.name", "package.version"],
  feedPath: (owner) => `/cargo/${owner}/`,
  render(v) {
    const baseUrl = v.get("baseUrl") as string;
    // The registry's name in `.cargo/config.toml`: the owner slug, which Cargo's grammar takes.
    const registry = v.get("owner") as string;
    const name = str(v.get("package.name")) ?? "<crate>";
    const version = str(v.get("package.version"));
    const envVar = `CARGO_REGISTRIES_${cargoEnvName(registry)}_TOKEN`;
    const snippets: FeedSnippet[] = [
      {
        id: "config",
        clients: "Cargo",
        title: "Cargo: name the feed as a registry",
        description:
          "A sparse index (Cargo 1.68 and later). Nothing comes from it unless a dependency names it with registry =.",
        filename: ".cargo/config.toml",
        language: "toml",
        code: lines(
          `[registries.${registry}]`,
          `index = ${JSON.stringify(`sparse+${baseUrl}`)}`,
        ),
      },
    ];
    if (v.credential.kind === "env")
      snippets.push({
        id: "token",
        clients: "Cargo",
        title: "Cargo: the registry token",
        description:
          "Cargo 1.74 and later send it on every request to a feed whose config.json says auth-required.",
        language: "sh",
        code: `export ${envVar}="$${v.credential.name}"`,
      });
    else if (v.credential.kind === "token")
      snippets.push({
        id: "token",
        clients: "Cargo",
        title: "Cargo: the registry token",
        description:
          "Stored in ~/.cargo/credentials.toml. Cargo 1.74 and later send it on every request to a feed whose config.json says auth-required.",
        language: "sh",
        code: `echo ${v.credential.value} | cargo login --registry ${registry}`,
      });
    snippets.push({
      id: "dependency",
      clients: "Cargo",
      title: "Depend on the crate from this registry",
      filename: "Cargo.toml",
      language: "toml",
      code: lines(
        "[dependencies]",
        `${name} = { version = ${JSON.stringify(version ?? "*")}, registry = ${JSON.stringify(registry)} }`,
      ),
    });
    return snippets;
  },
};

/**
 * Every ecosystem's setup declaration. The mapped type makes a new `PACKAGE_ECOSYSTEMS` entry a
 * compile error until its setup exists. The Worker's feed adapters point their `setup` here.
 */
export const FEED_SETUP: {
  readonly [E in PackageEcosystem]: FeedSetupDeclaration;
} = {
  npm: NPM_SETUP,
  pypi: PYPI_SETUP,
  swift: SWIFT_SETUP,
  maven: MAVEN_SETUP,
  oci: OCI_SETUP,
  godot: GODOT_SETUP,
  cargo: CARGO_SETUP,
};

/** A feed's base URL on the registry host (the console's and the admin API's `baseUrl`). */
export function feedSetupBaseUrl(
  ecosystem: PackageEcosystem,
  origin: string,
  owner: string,
): string {
  return `${noSlash(origin)}${FEED_SETUP[ecosystem].feedPath(encodeURIComponent(owner))}`;
}

/** Why `ctx` cannot be rendered for `ecosystem`, or `null`. */
export function feedSetupProblem(
  ecosystem: string,
  ctx: FeedSetupContext,
): string | null {
  if (!isPackageEcosystem(ecosystem)) return `unknown ecosystem "${ecosystem}"`;
  let url: URL;
  try {
    url = new URL(ctx.origin);
  } catch {
    return `the registry origin "${ctx.origin}" is not a URL`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "the registry origin must be an http(s) URL";
  if (url.pathname !== "/" || url.search || url.hash || url.username)
    return "the registry origin is an origin only (no path, query or credentials)";
  if (!OWNER.test(ctx.owner)) return `the owner "${ctx.owner}" is not a slug`;
  const rules = PACKAGE_ECOSYSTEM_RULES[ecosystem];
  for (const [key, value] of Object.entries(ctx.namespace ?? {})) {
    const field = rules.namespace.fields[key];
    if (!Object.hasOwn(rules.namespace.fields, key) || !field)
      return `${ecosystem} has no namespace key "${key}"`;
    if (value === undefined || value === null || value === "") continue;
    if (field.kind === "list" && !Array.isArray(value))
      return `namespace.${key} is a list`;
    if (field.kind === "string" && typeof value !== "string")
      return `namespace.${key} is a string`;
    const values = field.kind === "list" ? list(value) : [value as string];
    for (const item of values)
      if (!field.pattern.test(item))
        return `namespace.${key} "${item}" is malformed`;
  }
  if (ctx.package) {
    if (!rules.name.pattern.test(ctx.package.name))
      return `"${ctx.package.name}" is not a ${ecosystem} package name`;
    const version = ctx.package.version;
    if (version !== undefined && version !== null && !VERSION.test(version))
      return `"${version}" is not a version`;
  }
  const c = ctx.credential;
  if (c?.kind === "env" && !ENV_NAME.test(c.name))
    return `"${c.name}" is not an environment variable name`;
  if (
    (c?.kind === "token" || c?.kind === "godot-url") &&
    !TOKEN_VALUE.test(c.value)
  )
    return "the token has characters a snippet cannot carry";
  return null;
}

/**
 * The setup snippets for one feed, for its owner, optionally for one package: the console's Setup
 * tabs and `pkey feeds setup` print exactly this. Throws on a context `feedSetupProblem` refuses.
 */
export function renderFeedSetup(
  ecosystem: PackageEcosystem,
  ctx: FeedSetupContext,
): FeedSnippet[] {
  const problem = feedSetupProblem(ecosystem, ctx);
  if (problem !== null) throw new Error(`renderFeedSetup: ${problem}`);
  const decl = FEED_SETUP[ecosystem];
  const declared = new Set<string>(decl.inputs);
  const origin = noSlash(ctx.origin);
  const resolve = (input: FeedSetupInput): unknown => {
    if (input === "baseUrl")
      return feedSetupBaseUrl(ecosystem, origin, ctx.owner);
    if (input === "registryHost") return hostOf(origin);
    if (input === "owner") return ctx.owner;
    if (input === "package.name") return ctx.package?.name;
    if (input === "package.version") return ctx.package?.version ?? undefined;
    return ctx.namespace?.[input.slice("namespace.".length)];
  };
  const credential = ctx.credential ?? { kind: "none" };
  return decl.render({
    get(input) {
      if (!declared.has(input))
        throw new Error(
          `renderFeedSetup: ${ecosystem} reads "${input}", which its setup does not declare`,
        );
      return resolve(input);
    },
    // A Godot feed authenticates only through its URL; the others never through one.
    credential:
      (ecosystem === "godot") === (credential.kind === "godot-url")
        ? credential
        : { kind: "none" },
  });
}

/**
 * The snippets as `pkey feeds setup` prints them: each under a `#` heading naming it, its file and
 * clients, then any warning and description as `#` lines, then the code verbatim.
 */
export function formatFeedSetup(snippets: readonly FeedSnippet[]): string {
  return snippets
    .map((s) =>
      lines(
        `# ${s.title}${s.filename ? ` (${s.filename})` : ""}`,
        s.warning && `# Warning: ${s.warning}`,
        s.description && `# ${s.description}`,
        s.code,
      ),
    )
    .join("\n\n")
    .concat("\n");
}
