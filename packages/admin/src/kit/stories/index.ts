import { KIT_GROUPS, type Story } from "../types.js";
import { stories as actions } from "./actions.js";
import { stories as forms } from "./forms.js";
import { stories as overlays } from "./overlays.js";
import { stories as feedback } from "./feedback.js";
import { stories as status } from "./status.js";
import { stories as data } from "./data.js";
import { stories as values } from "./values.js";
import { stories as charts } from "./charts.js";
import { stories as templates } from "./templates.js";

/** Every story, grouped in `KIT_GROUPS` order. */
export const STORIES: Story[] = [
  ...actions,
  ...forms,
  ...overlays,
  ...feedback,
  ...status,
  ...data,
  ...values,
  ...charts,
  ...templates,
].sort((a, b) => KIT_GROUPS.indexOf(a.group) - KIT_GROUPS.indexOf(b.group));
