// GENERATED FILE — do not edit. Regenerate with `pnpm gen roles-matrix`.
// Source of truth: packages/worker/src/core/rbac/matrix.ts; emitter: tools/gen-roles-matrix.ts.

export type RolesMatrixCell =
  | { kind: "tick" }
  | { kind: "none" }
  | {
      kind: "word";
      word: "Create" | "Invite" | "Name only" | "Most";
      note: string;
    };

export interface RolesMatrixRow {
  id: string;
  name: string;
  detail?: string;
  /** One cell per entry of ROLES_MATRIX.roles, in that order. */
  cells: readonly RolesMatrixCell[];
}

export interface RolesMatrixFootnote {
  id: string;
  word: "Create" | "Invite" | "Name only" | "Most";
  role?: string;
  text: string;
}

export const ROLES_MATRIX: {
  roles: readonly { id: string; name: string }[];
  productRows: readonly RolesMatrixRow[];
  platformRows: readonly RolesMatrixRow[];
  footnotes: readonly RolesMatrixFootnote[];
} = {
  roles: [
    {
      id: "superadmin",
      name: "Superadmin",
    },
    {
      id: "platform_admin",
      name: "Platform admin",
    },
    {
      id: "product_admin",
      name: "Product admin",
    },
    {
      id: "console_access",
      name: "Console access",
    },
  ],
  productRows: [
    {
      id: "core",
      name: "Core",
      detail: "Overview, Integration, Access, Devices, Users, Activity",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "word",
          word: "Name only",
          note: "name-only",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "license",
      name: "Licensing",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "config",
      name: "Managed config",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "ship",
      name: "Ship builds",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "signin",
      name: "Sign-in",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "sync",
      name: "Cloud Sync",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "commerce",
      name: "Commerce",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "keys",
      name: "Keys and secrets",
      detail: "Signing keys, secrets, CI and service tokens",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "settings",
      name: "Settings",
      detail: "Features, presentation, repository, delete product",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "connect",
      name: "Cloud Connect",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "members",
      name: "Members",
      detail: "Who can manage this product",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "word",
          word: "Invite",
          note: "invite-product",
        },
        {
          kind: "none",
        },
      ],
    },
  ],
  platformRows: [
    {
      id: "platform-members",
      name: "Members",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "word",
          word: "Invite",
          note: "invite-platform",
        },
        {
          kind: "none",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "connections",
      name: "Connections",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "platform-settings",
      name: "Platform settings",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "packages-status",
      name: "Packages and Status",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "tick",
        },
        {
          kind: "none",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "new-products",
      name: "New products",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "word",
          word: "Create",
          note: "create",
        },
        {
          kind: "none",
        },
        {
          kind: "none",
        },
      ],
    },
    {
      id: "docs",
      name: "Docs",
      cells: [
        {
          kind: "tick",
        },
        {
          kind: "tick",
        },
        {
          kind: "word",
          word: "Most",
          note: "most",
        },
        {
          kind: "word",
          word: "Most",
          note: "most",
        },
      ],
    },
  ],
  footnotes: [
    {
      id: "name-only",
      word: "Name only",
      text: "Name and status on Home.",
    },
    {
      id: "invite-platform",
      word: "Invite",
      role: "platform_admin",
      text: "Gives Console access and removes people without a platform role.",
    },
    {
      id: "invite-product",
      word: "Invite",
      role: "product_admin",
      text: "Gives Product admin of its product, up to its own areas.",
    },
    {
      id: "create",
      word: "Create",
      text: "Creating a product makes the person its admin.",
    },
    {
      id: "most",
      word: "Most",
      text: "All but the operator pages.",
    },
  ],
};
