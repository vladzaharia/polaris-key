# r2-range: the S-02 probe for Range, If-Range and caching of R2-backed bytes

The harness behind [notes/S-02](../../notes/S-02.md). It checks how R2 objects behave when a
client asks for byte ranges, and how that changes with the serving path:

- **A**: an R2 custom domain with the zone cache in front;
- **B**: a Worker gateway that reads the R2 binding;
- **C**: `r2.dev`.

It runs today against a local `wrangler dev` (miniflare's R2 and Cache API emulation). With one
env var per path it runs against deployed paths too.

| File                     | What it is                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/src/index.js`    | The probe Worker. Modes: `/b/` (the README §3.5 headers, one R2 read per request); `/c/` (the same plus `caches.default` for full 200s); `/r/` (an R2 pass-through that emulates path A's origin). Also upload, `/_probe/info`, `/_probe/seen` and CORS           |
| `worker/wrangler*.jsonc` | Path B, plain or with the Cache API (`wrangler.jsonc`), and with Workers Caching (`wrangler.wcache.jsonc`). Locally the bucket name is `polaris-key-blobs-dev` (miniflare only); `--env live` binds the throwaway `pk-s02-probe`. Every key must sit under `s02/` |
| `probe.mjs`              | The matrix, per path and object size (below). Writes `out/<run>.csv` and `out/<run>.jsonl`                                                                                                                                                                        |
| `runs.py`                | Takes a `gen.py large` vector set and computes the real v1→v2 missing chunk runs for each bundle                                                                                                                                                                  |
| `summarise.py`           | Turns a JSONL run into the note's markdown tables: behaviour per path × case, or `--timing`                                                                                                                                                                       |
| `browser.mjs`            | Playwright check of cross-origin `fetch()` in Chromium and WebKit: when a CORS preflight fires, what `Accept-Encoding` goes on the wire, and whether `Cache.put` accepts a 206                                                                                    |
| `godot/probe.gd`         | Godot 4 `HTTPRequest` check: does it send `Range` and `If-Range` as given, what `Accept-Encoding` does it add, and does a 206 body arrive intact                                                                                                                  |

Nothing here holds an account id or a token. The upload token is `PROBE_PUT_TOKEN`: locally it
comes from `worker/.dev.vars` (git-ignored; one line, `PROBE_PUT_TOKEN=local-only-token`), and for
a deploy it comes from `wrangler secret put PROBE_PUT_TOKEN`.

## Run it locally

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype/r2-range
echo 'PROBE_PUT_TOKEN=local-only-token' > worker/.dev.vars
WR=../../../../../packages/worker/node_modules/.bin/wrangler   # the repo's pinned wrangler

# Path B (plus /c/ and /r/) on :8797, and the Workers Caching config on :8798
(cd worker && mise exec node@22 -- $WR dev --local --port 8797 --persist-to .wrangler/state) &
(cd worker && mise exec node@22 -- $WR dev -c wrangler.wcache.jsonc --local --port 8798 \
   --inspector-port 9331 --persist-to .wrangler/state) &

export PROBE_LOCAL=http://127.0.0.1:8797 PROBE_BASE_BW=http://127.0.0.1:8798/b/
mise exec node@22 -- node probe.mjs --path B --size 8MiB --cold            # the brief's Verify row
mise exec node@22 -- node probe.mjs --path Aorigin,B,Bc,Bw \
  --size 1MiB,4MiB,8MiB,16MiB,64MiB --reps 3 --quiet --run local-matrix
mise exec node@22 -- node probe.mjs --etag-formats --run local-etag        # R2's native ETag formats
python3 summarise.py out/local-matrix.jsonl
python3 summarise.py out/local-matrix.jsonl --timing
```

To use a real chunk bundle and the real update pattern, build the large vector set first. You
need `v1.pck` and `v2.pck` from the patching experiment in `PACKS_DIR`.

```sh
PACKS_DIR=../patching/out python3 ../content/gen/gen.py large /tmp/vec-large
python3 runs.py /tmp/vec-large > /tmp/runs.json          # 29 runs, 986,945 B for v1 -> v2
mise exec node@22 -- node probe.mjs --runs /tmp/runs.json --path Aorigin,B,Bc \
  --bundle /tmp/vec-large/blobs/bundles/18724fab8558253e36c189b2a058717098a2d7bc5829e6f835f2a5f5a575bbd9
```

For the browser and Godot checks, install Playwright anywhere; it is not a repo dependency.

```sh
(cd /tmp/pw && npm i playwright@1.58.0 && npx playwright install chromium webkit)
PLAYWRIGHT_DIR=/tmp/pw/node_modules/playwright mise exec node@22 -- node browser.mjs chromium,webkit
PROBE_URL=$PROBE_LOCAL/b/s02/blobs/sha256/<hex> PROBE_SHA=<hex> godot --headless --script godot/probe.gd
```

`wrangler dev` rewrites the `Accept-Encoding` of incoming requests: the Worker sees `br, gzip`
whatever the client sent. So the Worker's `/_probe/seen` log does not show the wire value.
`browser.mjs` reads it from Playwright instead. For Godot, point `PROBE_URL` at any plain
listener that logs headers.

## Run it against deployed paths (needs a human; see the note's hand-off)

The live run uses a throwaway bucket, `pk-s02-probe`, never `polaris-key-blobs-dev`: path A
publishes the whole bucket, and the dev bucket holds P2-01's (partly gated, age-locked) objects.
`--env live` in both configs binds the throwaway bucket. Do not use `dl-dev.plrs.im`; it is the
dev bytes host of `packages/worker`.

1. Create the bucket `pk-s02-probe`. Bind a temporary R2 custom domain to it (for example
   `s02-r2.plrs.im`) and add a Cache Rule that makes `s02/*` eligible for cache: keys have no file
   extension, so they are not cached by default. Keep `r2.dev` off except while measuring path C.
2. Deploy the probe Worker twice, each with a temporary Worker custom domain:
   `wrangler deploy --env live` (`pk-r2-probe-live`: B, Bc and `/r/`, for example on
   `s02-b.plrs.im`) and `wrangler deploy -c wrangler.wcache.jsonc --env live`
   (`pk-r2-probe-wcache-live`: Bw, for example on `s02-w.plrs.im`). Then run
   `wrangler secret put PROBE_PUT_TOKEN --env live` for each.
3. Run the probe:

   ```sh
   PROBE_PUT=https://s02-b.plrs.im \
   PROBE_BASE_A=https://s02-r2.plrs.im/ \
   PROBE_BASE_AO=https://s02-b.plrs.im/r/ \
   PROBE_BASE_B=https://s02-b.plrs.im/b/ \
   PROBE_BASE_BC=https://s02-b.plrs.im/c/ \
   PROBE_BASE_BW=https://s02-w.plrs.im/b/ \
   PROBE_BASE_C=https://pub-<id>.r2.dev/ PROBE_PUT_TOKEN=… \
   node probe.mjs --path all --size 1MiB,4MiB,8MiB,16MiB,64MiB,600MiB --reps 3 --vantage <name>
   ```

   Cloudflare documents the Cache API as working for Workers on custom domains, so Bc must use
   the custom domain, not `workers.dev`. Workers Caching (Bw) follows the Worker.

4. Repeat from a second vantage point, such as a GitHub Actions runner, with `--vantage gha`.
5. After P2-01 is deployed to dev, point `PROBE_BASE_B` at a real `dl-dev.plrs.im` byte route
   for one object (row H9).
6. Tear down: delete the bucket with its custom domain, both Workers and their domains.

Every cold case uploads fresh random bytes under a new key and never purges. So no edge state
leaks between trials.
