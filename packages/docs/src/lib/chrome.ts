/**
 * The chrome of the developer and Operate doors (docs.landing, docs.reference, docs.operate-guide,
 * docs.mobile-menu): the door tabs, the header and footer links, and the eyebrow's words. Help has
 * its own (helpHost.ts); this file never draws it.
 */
import { doorOf, type DoorId } from "./doors";

export interface DoorTab {
  door: Exclude<DoorId, "landing">;
  label: string;
  href: string;
}

/** The tabs of the header and of the phone menu, in door order. */
export const DOOR_TABS: readonly DoorTab[] = [
  { door: "developers", label: "Developers", href: "/docs/start/" },
  { door: "operate", label: "Operate", href: "/docs/operate/" },
  { door: "help", label: "Help", href: "/docs/help/" },
];

/** The links on the header's right and in the phone menu's foot. */
export const DOC_LINKS = [
  {
    label: "Developer changelog",
    href: "/docs/reference/changelog/",
    out: false,
  },
  { label: "Console", href: "/manage/", out: true },
] as const;

/** Page kinds for the chrome: a door page, the landing, or the 404. */
export type Kind = "door" | "landing" | "miss";

export function kindOf(id: string): Kind {
  if (id === "404") return "miss";
  const door = doorOf(id)?.door;
  return door === undefined || door === "landing" ? "landing" : "door";
}

/** The tab that holds a page, or undefined for the landing and the 404. */
export function tabOf(id: string): DoorTab | undefined {
  const door = doorOf(id)?.door;
  return DOOR_TABS.find((t) => t.door === door);
}

/** "Last reviewed October 9, 2026" from a YYYY-MM-DD date. */
export function reviewedLabel(date: string | undefined): string | undefined {
  return date === undefined
    ? undefined
    : new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
}
