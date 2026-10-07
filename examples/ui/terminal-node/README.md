# tidewater: the Node terminal kit sample

`tidewater` is the demo command line of Tidewater Studio by Harbor Audio, drawn by the Polaris Key
terminal kit (`@polaris-key/node/cli`). It shows:

- **the one-line flow**: one `registerPolarisCommands` call adds every Polaris Key verb to a
  commander program, with the kit's grouped help page and shell completion;
- **the product as the hero**: the chip in Tidewater's accent, its name and its developer, read
  from the SDK's presentation accessor;
- **the gate check**: `tidewater` with no verb runs `checkFlow`, the check a product makes before
  its own work, through `runKitVerb`, so it shares the verbs' rail and `--json` envelope;
- **every screen the kit draws**: masked key entry with its live verdict, the device limit with
  the portal hand-off, browser sign-in, status, grace and blocked states, devices, settings,
  updates with a progress bar, release notes, packs and doctor;
- **the fallbacks**: `--json`, `NO_COLOR`, `--no-color`, `TERM=dumb`, `--ascii`, CI and 60
  columns.

The docs page for the kit is
[Terminal (Node)](/docs/build/ui/frameworks/terminal-node/).

## Run it against the fixtures

By default the sample runs on the fixture client in `fixtures.ts`: no Worker, no network and no
keys. With the SDK from the Polaris Key feed:

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install
npm start -- --help
```

Inside the Polaris Key repository, without the feed, build the SDK once and run the sample on the
workspace's copy (`tsconfig.repo.json` maps `@polaris-key/node` to `packages/sdk-node/dist`):

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node build
cd examples/ui/terminal-node
npm run repo -- --help
npm run repo:typecheck
```

The commands below use `tidewater` for `npm start --` (or `npm run repo --`); an alias saves
typing: `alias tidewater="npx tsx cli.ts"`.

```sh
tidewater status              # not activated yet: the gate and the commands that fix it
tidewater activate            # the masked key prompt; Enter activates, Esc cancels
echo pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA | tidewater activate   # the key from a pipe
tidewater                     # the gate check: "Tidewater Studio Pro · Ready"
tidewater login               # browser sign-in; finishes by itself after about four seconds
tidewater login --device-code # the code instead of the browser
tidewater devices list
tidewater update check
tidewater update apply        # a 61 MB download with a progress bar; Esc cancels
tidewater changelog
tidewater config list         # export.loudnessTarget is locked by the operator
tidewater doctor
tidewater completion zsh
tidewater logout
tidewater deactivate --yes    # back to not activated
```

The fixture behaves like a real product:

| What you do                                           | What happens                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Activate with `pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA` | The Pro license activates                                                    |
| Activate with any other Tidewater key                 | The device limit: 3 of 3 seats, with the portal page that frees one (exit 3) |
| Activate with another product's key                   | Refused                                                                      |
| Type a short or malformed key                         | The live verdict says so before anything is sent                             |
| `login`                                               | Signs in as Mara Fennick after about four seconds; Esc cancels (exit 130)    |
| `logout`                                              | Signs out; a license that came from the sign-in goes with it                 |
| `deactivate`                                          | Releases the license on this device                                          |

The fixture keeps its state between runs in `tidewater-fixture.json` in the OS temp directory
(`TIDEWATER_FIXTURE_FILE` moves it). It never opens a browser: the sign-in page and the device
portal are real pages that know nothing of the fixture's code or key.

`TIDEWATER_STATE` pins the gate for one run, to see the other screens:

```sh
TIDEWATER_STATE=grace tidewater status     # the grace banner: 3 days left
TIDEWATER_STATE=last-day tidewater status
TIDEWATER_STATE=revoked tidewater status   # the status screen and its fixes (exit 3)
TIDEWATER_STATE=version-too-old tidewater  # the gate check falls through to the status
```

The other values are `ok`, `needs-activation`, `expired`, `version-too-new` and
`channel-not-entitled`.

## Scripts, pipes and plain terminals

Every verb takes `--json`: one versioned object on stdout, no prompt and no escape sequence, and
the exit code says how it went (0 done, 1 failed, 2 usage, 3 not usable or a device limit, 4
offline, 130 cancelled). Every `--json` run ends with its `"event": "result"` line;
`login --json` prints a `pending` line with the code first.

```sh
tidewater status --json
# {"v":1,"command":"status","event":"result","ok":true,"exit":0,"state":"key-only","result":{…}}
tidewater --json              # the gate check: {"command":"check","state":"licensed",…}
tidewater login --json        # {"event":"pending",…} then {"event":"result","state":"signedIn",…}
```

Colour and Unicode follow the terminal:

```sh
NO_COLOR=1 tidewater status   # no colour at all (so does --no-color, or a pipe)
tidewater status --ascii      # ASCII symbols: + | ` instead of ┌ │ └
TERM=dumb tidewater status    # both, and nothing animates
CI=1 tidewater update apply   # no spinner, no redraws: each line prints once
LANG=de_DE.UTF-8 tidewater status   # any of the kit's nine locales
```

## Run it with `--live`

`--live` builds a real `PolarisKeyClient` instead of the fixture. It needs the product's slug and
pinned trust keys, from flags, the environment or `polaris.config.ts` (replace that file with the
one `pkey sdk --lang node --write` generates for your product):

| Flag                      | Environment             | Default                                                |
| ------------------------- | ----------------------- | ------------------------------------------------------ |
| `--live`                  | `TIDEWATER_LIVE=1`      | off: the fixture                                       |
| `--product <slug>`        | `TIDEWATER_PRODUCT`     | `productSlug` in `polaris.config.ts` (`tidewater`)     |
| `--pinned-key <kid=key>`  | `TIDEWATER_PINNED_KEYS` | `trust.pinnedKeys` in `polaris.config.ts` (none)       |
| `--app-version <version>` | `TIDEWATER_VERSION`     | this sample's `package.json` version                   |
| `--base-url <url>`        | `TIDEWATER_BASE_URL`    | the SDK's default, `https://key.plrs.im`               |
| `--config-dir <dir>`      |                         | the SDK's default, where the device's credentials live |

`--pinned-key` repeats; `TIDEWATER_PINNED_KEYS` takes `kid=key,kid=key` or a JSON object.

```sh
tidewater status --live --product djdl --pinned-key "pkey-djdl-prod-2026-06=<base64url key>"
```

With `--live`, `login` and the device limit's portal link open your browser. The product's name
comes from the SDK's presentation when it has one, else from this sample's `package.json`
(`productName` and `author`).

## Where to change the look

`registerPolarisCommands(program, factory, options)` takes the kit's options:
`theme` (the UI-kit theme: `preset: "native"`, `accent`, `density`, `motion`, `poweredBy`,
`symbols`, `copy`), `io`, `bin`, `presentation`, `help: "host"` and `kit: false`. They are on the
[framework page](/docs/build/ui/frameworks/terminal-node/).
