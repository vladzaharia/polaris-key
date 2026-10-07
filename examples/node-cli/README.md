# Commander CLI with sign-in

`registerPolarisCommands` adds the whole CLI kit to your own program: `activate`, `enroll`,
`login` (the browser, or a code when headless; alias `sign-in`), `devices list|rename|deauthorize`, `config get|list|set|reset`,
`update check|apply`, `changelog`, `packs status|ensure`, `offline-request`, `import-bundle`,
`doctor`, `secret` and `mint`. The tool's own command boots the client and runs only when the
gate is `ready`.

```sh
npm install
npx tsx cli.ts doctor
npx tsx cli.ts sign-in
npx tsx cli.ts download https://example.com/a.mp4
```

## Device limit reached

`activate` answers `Device limit reached … [device_limit]` when every seat is taken. This device
holds no credential yet, so free a seat from somewhere that does: the account portal, or any
device already activated on the licence:

```sh
# on a device that holds a seat
npx tsx cli.ts devices list               # * marks that device
npx tsx cli.ts devices deauthorize <id>   # free a seat you no longer use

# back on the new device
npx tsx cli.ts activate <key>
```
