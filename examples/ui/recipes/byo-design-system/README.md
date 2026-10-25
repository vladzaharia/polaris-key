# Bring your own design system

The gate inside a host design system ("Harbor DS", `--hds-*` tokens), on the Tidewater fixtures.
Three seams and nothing else:

1. **Tokens.** The host's shape tokens (radius, control height, focus width, font) map onto
   `--pk-*` on `pk-provider`. The kit sets its scales on `:host`, so `pk-gate` takes the provider's
   value with `inherit`. The spacing scale and the three type weights are left as they are.
2. **Structure.** `::part(primary)`, `::part(secondary)`, `::part(card)`: parts only.
3. **Accent.** The host's brand color goes in as `theme.accent`, which the kit resolves for
   contrast in each scheme. Colors are not mapped token by token.

No style is written into a shadow root. `?theme=dark|light`, `?state=needs-activation|ok|grace|expired|revoked`.
