---
"@polaris-key/react": minor
---

Polaris Key branding in the UI kit is now optional, and the default is neutral. `defaultTheme` is
greyscale with `font-family: inherit`, follows the OS colour scheme, and its copy no longer names
Polaris Key (`productName` "This app", `oidcButtonLabel` "Continue to sign in"). Opt in with
`<PolarisKeyProvider branding="polaris-key">` (or `polarisKeyTheme`), which uses the
`@polaris-key/brand` palette, marks and copy. New Provider options: `branding`, `colorScheme` and
`poweredBy` (the "Powered by Polaris Key" badge, off by default under both brandings). Every
blocking screen is now a centred card and `PolarisLogin` stacks into one column. The Provider root
sets `color-scheme`, which native controls inside it follow. `highContrastTheme` is greyscale.

Breaking for hand-built themes: `PolarisThemeTokens` gains required `surfaceSunken`, `textStrong`,
`borderStrong`, `warning`, `warningSubtle`, `success`, `info` and `controlRadius`, and
`PolarisThemeCopy` gains `orDivider`. Inputs and secondary buttons read `--pk-border-strong`
rather than `--pk-border`.
