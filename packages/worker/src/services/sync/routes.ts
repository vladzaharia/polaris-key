/// <reference types="@cloudflare/workers-types" />

/**
 * Cloud Sync's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/sync`.
 *
 * U-05.12 adds the pull, `GET /<p>/sync` (path `""`). Every route takes the device bearer and is
 * unsigned; `auth: device` is declared here and enforced in the handler (`handlers/common.ts`).
 * U-05.13 adds the push, `POST /<p>/sync/ops`. U-10 adds the file routes under
 * `files/{collection}/{id}`; every one answers `404` while the launch gate `launch.syncFiles` is off
 * (`handlers/files.ts`). A path no row matches is `null` (Core's not-found).
 */

import { serviceRoutes } from "../../core/http/routes.js";
import {
  FILE_PARAMS,
  handleFileBegin,
  handleUploadAbort,
  handleUploadStatus,
} from "./handlers/files.js";
import { handleFinalize } from "./handlers/fileFinalize.js";
import { handlePartPut, handleUploadPut } from "./handlers/fileUpload.js";
import { handlePull } from "./handlers/pull.js";
import { handlePush } from "./handlers/push.js";

export const SYNC_ROUTES = serviceRoutes("sync", [
  {
    path: "",
    methods: ["GET"],
    auth: { kind: "device" },
    // U-05.12: the device bearer is never ambient, so a listed origin reaches only what that
    // page's own device token already can.
    cors: true,
    handler: (ctx) => handlePull(ctx),
  },
  // U-05.13: the push. The 256 KiB cap (`SYNC_MAX_PUSH_BYTES`) is applied in the handler, not as
  // a `bodyCap` here: the row cap belongs to CI rows (`serviceRouteTables`) and its reader answers
  // `400`, where the contract says `413 body_too_large`. The body is read only after the bearer,
  // the principal, the pause and the trust check.
  {
    path: "ops",
    methods: ["POST"],
    auth: { kind: "device" },
    cors: true, // U-05.13, as the pull
    handler: (ctx) => handlePush(ctx),
  },
  // U-10.5: the file routes. Device bearer, browser-readable and writable like the push (a page's
  // own device token is the credential); the gate, the principal and the limits are the handler's.
  {
    path: "files/:collection/:id/begin",
    methods: ["POST"],
    auth: { kind: "device" },
    cors: true,
    params: { collection: FILE_PARAMS.collection, id: FILE_PARAMS.id },
    handler: (ctx, match) => handleFileBegin(ctx, match),
  },
  {
    path: "files/:collection/:id/upload/:uploadId",
    methods: ["GET", "PUT", "DELETE"],
    auth: { kind: "device" },
    cors: true,
    params: {
      collection: FILE_PARAMS.collection,
      id: FILE_PARAMS.id,
      uploadId: FILE_PARAMS.uploadId,
    },
    handler: (ctx, match) =>
      ctx.req.method === "DELETE"
        ? handleUploadAbort(ctx, match)
        : ctx.req.method === "PUT"
          ? handleUploadPut(ctx, match)
          : handleUploadStatus(ctx, match),
  },
  // U-10.6: part `n` of a multipart upload (from 1).
  {
    path: "files/:collection/:id/upload/:uploadId/parts/:n",
    methods: ["PUT"],
    auth: { kind: "device" },
    cors: true,
    params: FILE_PARAMS,
    handler: (ctx, match) => handlePartPut(ctx, match),
  },
  // U-10.7: the commit of an upload.
  {
    path: "files/:collection/:id/finalize",
    methods: ["POST"],
    auth: { kind: "device" },
    cors: true,
    params: { collection: FILE_PARAMS.collection, id: FILE_PARAMS.id },
    handler: (ctx, match) => handleFinalize(ctx, match),
  },
]);
