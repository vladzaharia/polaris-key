/// <reference types="@cloudflare/workers-types" />

/**
 * Config's own sub-router, over the path segments AFTER `/<product>/config`.
 *
 * Note what is NOT here: a bare `/<product>/config`. The fused v2 document is gone, split into
 * `/config/document` and `/license/document` (§R1), and the old path now falls through to the
 * registry's not-found like any other unmatched segment. That is deliberate — a route that
 * used to return a signed document must not quietly return one of the halves.
 *
 * `/config/report` is likewise absent: device telemetry relocated to `POST /<p>/devices/report`,
 * a Core surface (wire v3 §6), because it was licence anti-fraud data that had merely been
 * living under a config path.
 */

import { serviceRoutes } from "../../core/http/routes.js";
import { handleConfigDocument } from "./document.js";
import { handleSchema } from "./schema.js";
import { handleMintAuth, handleMintToken } from "./mint.js";

/** Recipe ids are the same restricted alphabet the pre-suite router matched, so a traversal or
 *  an encoded separator cannot reach the recipe lookup. */
const MINT_ID = /^[a-z0-9-]+$/;

export const CONFIG_ROUTES = serviceRoutes("config", [
  {
    path: "document",
    methods: ["GET"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now, settings }) =>
      handleConfigDocument(req, env, db, product, now, settings),
  },
  {
    path: "schema",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "none" },
    handler: ({ db, product }) => handleSchema(db, product),
  },
  // /config/mint/<id>/{token,auth}
  {
    path: "mint/:mintId/token",
    methods: ["GET", "POST"],
    auth: { kind: "handler" },
    params: { mintId: MINT_ID },
    handler: ({ req, env, db, product, now }, { params }) =>
      handleMintToken(req, env, db, product, params.mintId as string, now),
  },
  {
    path: "mint/:mintId/auth",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "none" },
    params: { mintId: MINT_ID },
    handler: ({ db, product }, { params }) =>
      handleMintAuth(db, product, params.mintId as string),
  },
]);
