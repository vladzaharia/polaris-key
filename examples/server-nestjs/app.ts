// A gated NestJS app on Express: one open route, one entitlement, one tier gate, one sign-in, and
// a /whoami probe. Works on Nest 10 and 11, on the Express or the Fastify platform.

import "reflect-metadata";
import { Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  GetPolarisAuth,
  GetPolarisLicense,
  PolarisKeyModule,
  RequireEntitlement,
  RequireLicense,
  RequireSignIn,
  RequireTier,
  type PolarisAuth,
  type PolarisKeyNestOptions,
  type PolarisLicense,
} from "@polaris-key/server/nestjs";
import polarisConfig from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

@Controller()
export class AppController {
  @Get("health")
  health() {
    return { ok: true };
  }

  @Get("api/export")
  @RequireEntitlement("export.pdf")
  export(@GetPolarisLicense() license: PolarisLicense) {
    return { tier: license.tier };
  }

  @Get("api/team")
  @RequireTier("pro", "team")
  team() {
    return "team";
  }

  @Post("api/saves")
  @RequireSignIn()
  save(@GetPolarisAuth() auth: PolarisAuth) {
    return { owner: auth.user!.subject }; // "ps_…", stable per product
  }

  @Get("whoami")
  @RequireLicense()
  whoami(@GetPolarisAuth() auth: PolarisAuth) {
    const license = auth.license!;
    return {
      licenseId: license.id,
      tier: license.tier,
      ageSeconds: license.ageSeconds,
      signedIn: auth.user !== null,
    };
  }
}

export function createApp(
  options: PolarisKeyNestOptions = { config: polarisConfig },
) {
  @Module({
    imports: [PolarisKeyModule.register(options)],
    controllers: [AppController],
  })
  class AppModule {}
  return NestFactory.create(AppModule, { logger: ["error"] });
}
