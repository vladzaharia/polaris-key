/// <reference types="@cloudflare/workers-types" />

/**
 * License's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/license`.
 *
 * Unmatched is `null`, not a 404: only Core knows whether "no route here" should be a not-found
 * (`core/registry.ts`). A matched path with another method is the plain 405 the table answers
 * before the handler runs; every handler keeps its own method guard as well.
 */

import { serviceRoutes } from "../../core/http/routes.js";
import {
  handleActivate,
  handleDeauthorize,
  handleToken,
} from "./activation.js";
import { handleLicenseDocument } from "./document.js";
import { handleEnroll } from "./enroll.js";

export const LICENSE_ROUTES = serviceRoutes("license", [
  {
    path: "activate",
    cors: true,
    methods: ["POST"],
    auth: { kind: "handler" },
    handler: ({ req, env, db, product, now, waitUntil, settings }) =>
      handleActivate(req, env, db, product, now, waitUntil, settings),
  },
  {
    path: "enroll",
    cors: true,
    methods: ["POST"],
    auth: { kind: "handler" },
    handler: ({ req, env, db, product, now, waitUntil }) =>
      handleEnroll(req, env, db, product, now, waitUntil),
  },
  {
    path: "token",
    cors: true,
    methods: ["POST"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleToken(req, env, db, product, now),
  },
  {
    path: "deauthorize",
    cors: true,
    methods: ["POST"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product }) =>
      handleDeauthorize(req, env, db, product),
  },
  {
    path: "document",
    cors: true,
    methods: ["GET"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now, settings }) =>
      handleLicenseDocument(req, env, db, product, now, settings),
  },
]);
