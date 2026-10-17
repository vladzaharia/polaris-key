## Review fix round (2026-10-16)

UX review fixes: the host's help rows and the kit's share one description column (commander's
`padWidth`), follow the host's styling and stack together below 50 columns; a mount past the
end-user set gets one section per kit group; mounted verbs and groups carry catalog copy in both
adapters; `onCollision: "skip"` is silent unless `onSkip`, `warn` or `DEBUG=polaris` asks; the gate
shows "Checking your license…" after 400 ms, leads the inline flow with `cli.gate.needs`, prints
the refusal on Esc and keeps its closing row under `frame: false`; fix-row text keeps the normal
colour. New copy keys `cli.help.namespace` and `cli.gate.needs` (nine locales). Goldens at 40 and
32 columns for the host-help and gate scenarios.

Left for the UK-51 corpus `cli` gate rows (they pin the refusal copy keys and fix verbs): the
not-entitled and version-too-new fix rows (upgrade link, no `update apply`), the
"{command} needs a license" refusal title, the not-entitled copy naming the command, and a fix row
that survives a skipped `status`. The terminal.html shots belong to UK-59.
