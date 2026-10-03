/** A colour role in the kit's layouts. */
export type KitRole =
  | "body"
  | "star"
  | "gold"
  | "text"
  | "muted"
  | "bg"
  | "stroke";

export type KitPalette = Record<KitRole, string>;

/** A kit layout SVG with its colours replaced by `{role}` placeholders. */
export interface KitTemplate {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly desc: string;
  readonly body: string;
}
