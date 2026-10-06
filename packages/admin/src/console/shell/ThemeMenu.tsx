import * as React from "react";
import { Monitor, Moon, Pause, Sun, type LucideIcon } from "lucide-react";
import {
  useMotionPreference,
  useSystemReducedMotion,
  type MotionPreference,
} from "../../components/motionPreference.js";
import { useTheme, type ThemePreference } from "../../components/theme.js";
import { Button } from "../../ui/Button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/DropdownMenu.js";

export const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
];

export const MOTION_OPTIONS: {
  value: MotionPreference;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "reduce", label: "Reduced", icon: Pause },
];

/**
 * The theme menu (ADMIN.md §2.2): System (the default), Dark or Light, persisted per viewer. It
 * replaces chunk 1's cycle button, which made "what will a click do" a guess. System follows
 * `prefers-color-scheme` live; dark is the fallback when the OS gives no answer (BRAND.md §3).
 *
 * Below the theme, the Motion row (notes/S-23 §6.6, MO-12): System follows the OS's
 * `prefers-reduced-motion`; Reduced makes every motion an instant swap in this browser.
 */
export function ThemeMenu(): React.ReactElement {
  const { preference, setPreference, theme } = useTheme();
  const [motion, setMotion] = useMotionPreference();
  const osReduced = useSystemReducedMotion();
  const current =
    THEME_OPTIONS.find((o) => o.value === preference) ?? THEME_OPTIONS[0]!;
  const Icon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${current.label}`}
        >
          <Icon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Theme"
          value={preference}
          onValueChange={(v) => setPreference(v as ThemePreference)}
        >
          {THEME_OPTIONS.map(({ value, label, icon: ItemIcon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <ItemIcon aria-hidden />
              {label}
              {value === "system" ? (
                <span className="ml-auto pl-3 text-xs text-fg-muted">
                  {theme === "dark" ? "Dark now" : "Light now"}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Motion</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Motion"
          value={motion}
          onValueChange={(v) => setMotion(v as MotionPreference)}
        >
          {MOTION_OPTIONS.map(({ value, label, icon: ItemIcon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <ItemIcon aria-hidden />
              {label}
              {value === "system" ? (
                <span className="ml-auto pl-3 text-xs text-fg-muted">
                  {osReduced ? "Reduced now" : "Full now"}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
