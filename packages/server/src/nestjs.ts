// NestJS (v10 and v11) drop-in (framework drop-ins plan §12.1), on the Express or the Fastify
// platform:
//
//   @Module({ imports: [PolarisKeyModule.register({ config: polarisConfig })] })
//   export class AppModule {}
//
//   @Controller("api")
//   export class ApiController {
//     @Get("export")
//     @RequireEntitlement("export.pdf")
//     export(@GetPolarisLicense() license: PolarisLicense) { … }
//   }
//
// A route with no `Require*` decorator stays open. The decorators install `PolarisKeyGuard` (the
// verdict is cached, so a class-level and a method-level decorator verify once) and a filter that
// renders the refusal. None reads `Authorization`, a cookie or a query parameter. The file needs
// `experimentalDecorators`, which every Nest project already sets.

import {
  applyDecorators,
  Catch,
  createParamDecorator,
  HttpException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UseFilters,
  UseGuards,
  type CanActivate,
  type DynamicModule,
  type ExceptionFilter,
  type ArgumentsHost,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  createPolarisKey,
  isCorsPreflight,
  PolarisKeyConfigError,
  PolarisKeyError,
  requirement,
  type PolarisAdapterOptions,
  type PolarisKey,
  type Requirement,
} from "./core.js";
import type { PolarisAuth, PolarisLicense, Problem } from "./context.js";

export { POLARIS_REQUEST_HEADERS } from "@polaris-key/protocol/core";
export { PolarisKeyConfigError, PolarisKeyError } from "./core.js";
export type { PolarisAuth, PolarisLicense, Problem } from "./context.js";
export type { PolarisServerConfig, Requirement } from "./core.js";
export { requirement } from "./core.js";

const NOT_INSTALLED =
  "PolarisKeyModule is not imported: add `PolarisKeyModule.register({ config: polarisConfig })` to your AppModule's imports before using a Require* decorator";

export interface PolarisKeyNestOptions extends PolarisAdapterOptions {
  /** Answer a refusal yourself by returning the exception to throw, for example
   *  `(problem) => new HttpException({ error: problem.code }, problem.status)`.
   *  `errors: "throw"` throws a `PolarisKeyError` instead (catch it with your own filter). */
  onRefusal?: (
    problem: Problem,
    context: ExecutionContext,
  ) => HttpException | Promise<HttpException>;
}

interface Setup {
  core: PolarisKey;
  options: PolarisKeyNestOptions;
}

const SETUP = Symbol("polaris-key:setup");
const REQUIREMENTS = "polaris-key:requirements";

/** The refusal Nest raises by default; the filter renders it as problem+json. */
export class PolarisRefusalException extends HttpException {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.body, problem.status);
    this.problem = problem;
  }
}

// Express and Fastify requests/replies, as far as the adapter touches them.
interface PlatformRequest {
  method: string;
  rawHeaders?: string[];
  raw?: { rawHeaders?: string[] };
  polaris?: PolarisAuth;
}
interface PlatformReply {
  // Fastify
  code?: (status: number) => PlatformReply;
  header?: (name: string, value: string) => PlatformReply;
  hasHeader?: (name: string) => boolean;
  send?: (body: string) => unknown;
  // Express
  status?: (status: number) => PlatformReply;
  getHeader?: (name: string) => unknown;
  setHeader?: (name: string, value: string) => unknown;
  end?: (body: string) => unknown;
}

function fieldsOf(req: PlatformRequest): [string, string][] {
  // `rawHeaders` keeps repeated fields apart, which the verdict counts (§14.1).
  const raw = req.rawHeaders ?? req.raw?.rawHeaders ?? [];
  const fields: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2)
    fields.push([raw[i]!, raw[i + 1]!]);
  return fields;
}

const isFastify = (res: PlatformReply): boolean =>
  typeof res.code === "function" && typeof res.send === "function";

@Injectable()
export class PolarisKeyGuard implements CanActivate {
  constructor(
    @Optional() @Inject(SETUP) private readonly setup: Setup | undefined,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.setup) throw new PolarisKeyConfigError(NOT_INSTALLED);
    const { core, options } = this.setup;
    if (context.getType() !== "http") return true;
    const http = context.switchToHttp();
    const req = http.getRequest<PlatformRequest>();
    const res = http.getResponse<PlatformReply>();
    const fields = fieldsOf(req);
    // A CORS preflight carries no credential: let the CORS layer have it.
    if (options.preflight !== "gate" && isCorsPreflight(req.method, fields))
      return true;
    const requirements =
      this.reflector.getAllAndMerge<Requirement[]>(REQUIREMENTS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const auth = core.require(
      await core.authenticate(fields),
      requirements,
      fields,
    );
    req.polaris = auth;
    if (auth.problem === null) {
      // A gated answer is about this caller: keep shared caches out unless the route says so.
      if (isFastify(res)) {
        if (!res.hasHeader?.("cache-control"))
          res.header?.("cache-control", "private");
      } else if (!res.getHeader?.("Cache-Control")) {
        res.setHeader?.("Cache-Control", "private");
      }
      return true;
    }
    if (options.errors === "throw") throw new PolarisKeyError(auth.problem);
    if (options.onRefusal) throw await options.onRefusal(auth.problem, context);
    throw new PolarisRefusalException(auth.problem);
  }
}

/** Renders a `PolarisRefusalException` as the catalog's problem+json, with the challenge. */
@Catch(PolarisRefusalException)
export class PolarisRefusalFilter implements ExceptionFilter {
  catch(exception: PolarisRefusalException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<PlatformReply>();
    const { problem } = exception;
    const body = JSON.stringify(problem.body);
    if (isFastify(res)) {
      res.code!(problem.status);
      for (const [name, value] of Object.entries(problem.headers))
        res.header!(name, value);
      res.send!(body);
      return;
    }
    res.status!(problem.status);
    for (const [name, value] of Object.entries(problem.headers))
      res.setHeader!(name, value);
    res.end!(body);
  }
}

/** Import once: `PolarisKeyModule.register({ config: polarisConfig })`. */
export class PolarisKeyModule {
  static register(options: PolarisKeyNestOptions): DynamicModule {
    // Built here, so a bad config stops the app at startup.
    const setup: Setup = { core: createPolarisKey(options), options };
    return {
      module: PolarisKeyModule,
      global: true,
      providers: [{ provide: SETUP, useValue: setup }, PolarisKeyGuard],
      exports: [SETUP, PolarisKeyGuard],
    };
  }
}

/** Gate a route (or a whole controller) on `requirements`, checked in order. */
export function RequireAll(
  ...requirements: Requirement[]
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(REQUIREMENTS, requirements),
    UseGuards(PolarisKeyGuard),
    UseFilters(PolarisRefusalFilter),
  ) as MethodDecorator & ClassDecorator;
}

/** Refuse unless the request carries a valid, fresh licence document. */
export const RequireLicense = (): MethodDecorator & ClassDecorator =>
  RequireAll();

/** Refuse unless the document grants boolean entitlement `name`. `test` receives a valued
 *  entitlement instead, e.g. `@RequireEntitlement("seats", (v) => v >= 5)`. */
export const RequireEntitlement = (
  name: string,
  test?: (value: any) => boolean,
): MethodDecorator & ClassDecorator =>
  RequireAll(requirement.entitlement(name, test));

/** Refuse unless the license's tier is one of `tiers`: `@RequireTier("pro", "team")`. */
export const RequireTier = (
  ...tiers: string[]
): MethodDecorator & ClassDecorator => RequireAll(requirement.tier(...tiers));

/** Refuse unless a person is signed in on the device (`profile.user.subject`). */
export const RequireSignIn = (): MethodDecorator & ClassDecorator =>
  RequireAll(requirement.signIn());

function authOf(request: PlatformRequest): PolarisAuth {
  if (!request.polaris)
    throw new PolarisKeyConfigError(
      "this route has no Polaris Key gate: add @RequireLicense() (or another Require* decorator) to the route or its controller",
    );
  return request.polaris;
}

/** The handler's `PolarisAuth`: `@GetPolarisAuth() auth: PolarisAuth`. Needs a `Require*` gate. */
export const GetPolarisAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PolarisAuth =>
    authOf(context.switchToHttp().getRequest<PlatformRequest>()),
);

/** The verified license, typed non-null: `@GetPolarisLicense() license: PolarisLicense`. */
export const GetPolarisLicense = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PolarisLicense => {
    const license = authOf(
      context.switchToHttp().getRequest<PlatformRequest>(),
    ).license;
    if (license === null)
      throw new PolarisKeyConfigError(
        "this request has no verified license: put a Require* decorator on the route that uses @GetPolarisLicense()",
      );
    return license;
  },
);
