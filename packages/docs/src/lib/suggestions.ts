/**
 * The links the Help home and the developer landing already show, kept once so the search
 * dialog's opening state lists the same ones (src/components/Search.astro): Help's Top tasks, and
 * the developer landing's Get started. The pages import these; nothing here is search-only copy.
 */
export interface Suggestion {
  title: string;
  description: string;
  href: string;
}

export const HELP_TOP_TASKS: readonly Suggestion[] = [
  {
    title: "Activate your app",
    description: "Use a key or sign in.",
    href: "/docs/help/activate/",
  },
  {
    title: "Device limit reached",
    description: "Free a device to continue.",
    href: "/docs/help/device-limit/",
  },
  {
    title: "Move to a new computer",
    description: "Remove the old device.",
    href: "/docs/help/new-computer/",
  },
  {
    title: "Download your app",
    description: "Find the right download.",
    href: "/docs/help/download/",
  },
  {
    title: "Your code didn’t arrive",
    description: "Check sign-in email.",
    href: "/docs/help/code-didnt-arrive/",
  },
  {
    title: "Refunds",
    description: "Ask the app developer or store.",
    href: "/docs/help/refunds/",
  },
];

export const START_HERE: readonly Suggestion[] = [
  {
    title: "Your first product",
    description: "Create a product, install an SDK, activate a test license.",
    href: "/docs/start/first-product/",
  },
  {
    title: "Choose your integration",
    description: "Drop-in UI kit or your own UI, and your SDK.",
    href: "/docs/start/choose-your-integration/",
  },
];
