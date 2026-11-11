# live-peer

Cross-SDK live pairing: two SDK drivers, A and B, pair with a code and a QR, open the link both ways,
move 4 MiB and forget, over real TCP on 127.0.0.1. No account and no Worker: each driver answers
discovery itself (`localPairing: true`). The harness is the mDNS broker, so no multicast is needed.

```sh
node tools/live-peer/run.mjs --list                  # drivers and whether they can run here
node tools/live-peer/run.mjs --pair node:python      # one ordered pair: A (node) shows, B (python) joins
node tools/live-peer/run.mjs --matrix linux          # every ordered pair of two different Linux drivers (node, python, kotlin)
node tools/live-peer/run.mjs --matrix macos          # swift against node and python, both ways (macOS only)
```

Node needs `pnpm build` first (the driver loads `packages/sdk-node/dist`). Python runs over
`sdks/python/src` with `PYTHONPATH` set by the harness; set `PKEY_LIVE_PYTHON` to an interpreter with
the SDK's dependencies (default: `sdks/python/.venv/bin/python`, else `python3`). `PKEY_LIVE_VERBOSE=1`
streams driver stderr.
Kotlin needs a JDK 17 and `( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :live-peer:installDist )` once; the
driver is the `:live-peer` module in `tools/live-peer/drivers/kotlin` (not published). Swift needs
`swift build -c release --package-path tools/live-peer/drivers/swift/live-peer-swift` once; it is a SwiftPM
executable that references `sdks/swift` by path (the SDK's `Package.swift` is unchanged). `PKEY_LIVE_SWIFT`
overrides the Swift binary. `PKEY_LIVE_STEP_MS` sets the per-step hang guard (default 60000); no step asserts
on elapsed time.

## Scenarios

Per ordered pair, in order; a failure skips the rest:

1. **pair by code**: A `show`; B joins a wrong code (fails `pairing-code-failed`, reason `wrong`); A's
   code has changed; B joins the new one. `dialsLeft` drops across the two joins. Each side lists one
   link and names the other's platform (the host's).
2. **pair by QR**: A `show {fresh}`; B joins the QR text. Each side holds two links.
3. **open both ways**: B opens the first link to A, then A opens it to B; each hears an inbound link.
4. **transfer 4 MiB**: A sends, B receives; the sha256 matches.
5. **forget**: A forgets the first link. B's open session ends `peer_revoked` and B's next open fails.

## Driver contract

A driver is a process that speaks JSON lines on stdin and stdout. stdout carries protocol only (send
logs to stderr). It prints `{"ready":true,"driver":"<name>"}` when its client is up.

Request: `{"seq":N,"cmd":"<name>", ...args}`. Answer: `{"seq":N,"ok":true, ...fields}` or
`{"seq":N,"ok":false,"error":{"code","reason","cap","message"}, ...fields}`. Commands run
concurrently; answers may come in any order. Link ids are always `id` in a request and `link` in an
answer (`seq` is the only message id).

| Command  | Args                         | Answer                                                                                                   |
| -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `show`   | `fresh?`                     | `{code, qr}`: open a window, or read the current code. `fresh` waits for the last window to close first. |
| `join`   | `code` or `qr`               | `{link, dialsLeft}`; a refusal also carries `dialsLeft`.                                                 |
| `list`   | -                            | `{links:[{id,label,platform,categories,reachable}]}`                                                     |
| `open`   | `id`, `wait?` (default true) | `{link}`. Waits for the peer's advert unless `wait` is false.                                            |
| `send`   | `id`, `bytes`, `sha256`      | `{sha256, bytes}` once delivered. The content is `(i*7+13)&0xff`.                                        |
| `recv`   | -                            | `{sha256, bytes}` of the next delivered transfer.                                                        |
| `forget` | `id`                         | `{removed}`                                                                                              |
| `events` | -                            | `{events:[...]}`, drained: `change`, `link` (inbound), `session-end` (`dir`, `id`, `code`).              |
| `quit`   | -                            | `{}`, then exit and remove the temp state.                                                               |

Both sides confirm the consent themselves. A driver uses a temp state directory per run, installs a
Direct Transfer offer handler at start (category `notes`) and starts its LAN service with loopback
allowed. Every pairing uses categories `["notes"]`.

mDNS: the driver's adapter sends `{"mdns":"advertise","advert":{instance,port,txt}}` and
`{"mdns":"withdraw","instance"}` (no `seq`), and receives `{"mdns":"up","advert":{...}}` and
`{"mdns":"down","instance"}` for the other driver's adverts. Found hosts are always `127.0.0.1`.

## Adding a driver

Write `drivers/<name>.<ext>` (or a directory, as the Kotlin and Swift drivers are) to the contract, add a
row to `DRIVERS` in `run.mjs` (`available`, `command`, `matrices`) and run `--pair <name>:node` and
`--pair node:<name>`. The Godot headless driver follows this way once Godot's local links land.
