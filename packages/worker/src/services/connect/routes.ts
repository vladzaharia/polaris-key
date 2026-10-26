/// <reference types="@cloudflare/workers-types" />

/**
 * Cloud Connect's routes, as a table (`core/http/routes.ts`). Empty in CC-02.1: the service row
 * and descriptor land first; the identity and devices routes follow in CC-06.2 and the relay
 * routes in CC-07.3. An empty table serves nothing and documents nothing.
 */

import { serviceRoutes } from "../../core/http/routes.js";

export const CONNECT_ROUTES = serviceRoutes("connect", []);
