/**
 * The Godot feed (F-09, plans/F-01.md §6.8): the renderer F-02's materialiser runs for the
 * `godot` ecosystem, and its routes on the registry host. See `documents.ts` for the two editor
 * API shapes and `routes.ts` for the URL layout.
 */

import type { RegistryRenderer } from "../materialise.js";
import { renderGodot } from "./render.js";
import { GODOT_ROUTES } from "./routes.js";

export const GODOT_RENDERER: RegistryRenderer = {
  ecosystem: "godot",
  render: renderGodot,
  routes: GODOT_ROUTES,
};
