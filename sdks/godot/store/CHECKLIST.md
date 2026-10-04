# Owner checklist: publishing the Godot addon

The steps only the owner can take for a Godot SDK release: pushing the tag, the Godot Asset Store
upload and the legacy Asset Library submission. Neither store has an upload API or CLI, so both are
manual. Everything else is automated by `.github/workflows/release-godot.yml`. Written for 0.1.0;
for a later version, substitute it everywhere.

Field values come from `LISTING.md` beside this file. Write each URL down as you get it: the PR (or
the follow-up issue) records the GitHub Release, the Asset Store listing and the Asset Library
entry.

## 0. Before you start

1. The P1-12 branch is merged to `main`, and the `godot` CI job on that commit is green on all six
   legs: 4.7.2 (editor and release template), 4.6.3 (editor and template), 4.5.2 (editor and
   template), 4.4.1 (editor), and the Windows and macOS smoke legs.
2. `addons/polaris_key/plugin.cfg` says `version="0.1.0"`, `polaris_key.gd` says
   `const SDK_VERSION := "0.1.0"`, and `sdks/godot/CHANGELOG.md` has a `## 0.1.0` section.
   Check locally:

   ```sh
   python3 sdks/godot/tools/package.py --check-version --tag godot-v0.1.0
   ```

## 1. Dry run the release workflow

1. GitHub → **Actions** → **Release Godot SDK** → **Run workflow**, branch `main`, tag
   `godot-v0.1.0`.
2. Wait for `validate`, `test`, `package` and both `smoke` jobs to go green. `release` is skipped
   on a dry run.
3. Download the `polaris-key-godot-0.1.0` artefact. It holds both zips, `SHA256SUMS` and
   `NOTES.md`. Optionally rebuild locally from the same commit and compare:

   ```sh
   python3 sdks/godot/tools/package.py --tag godot-v0.1.0 --out /tmp/pk && cat /tmp/pk/SHA256SUMS
   ```

   Identical sums mean the same bytes; a different zlib build can change the deflate output, in
   which case compare the file lists with `unzip -Z1` instead.

## 2. Push the tag (creates the GitHub Release)

```sh
git fetch origin
git tag -a godot-v0.1.0 -m "Polaris Key Godot 0.1.0" origin/main
git push origin godot-v0.1.0
```

1. Watch **Actions** → **Release Godot SDK** for the tag. When it is green, the release
   **Polaris Key Godot 0.1.0** exists with `polaris-key-godot-v0.1.0.zip`,
   `polaris-key-godot-v0.1.0-assetlib.zip` and `SHA256SUMS` attached, and the CHANGELOG section as
   its notes.
2. Record the release URL:
   https://github.com/vladzaharia/polaris-key/releases/tag/godot-v0.1.0
3. If the workflow fails, delete the tag (`git push origin :refs/tags/godot-v0.1.0` and
   `git tag -d godot-v0.1.0`), fix on `main`, and start again from step 1.

## 3. Godot Asset Store (store.godotengine.org)

1. Sign in with your Godot account and click **Upload Asset** (top right).
2. **Publisher**: create one if you have none (Publisher Name, e.g. "Polaris Key"; Publisher URL
   Slug, e.g. `polaris-key`). **Asset Name**: `Polaris Key`. **Asset URL**: `polaris-key`. Read
   and accept the terms, then **Continue**.
3. **Settings** tab: Asset Summary, Detailed description and Tags from `LISTING.md`; Asset type
   **Addon**; License **MIT**; Link to source code `https://github.com/vladzaharia/polaris-key`;
   **AI usage disclosure**: confirm or edit the draft in `LISTING.md` (mandatory). Save.
4. **Media** tab: upload the thumbnail `packages/brand/kit/05-app-icons/key/desktop/app-1024.png`
   (or `app-256.png`). Screenshots are optional (see `LISTING.md`, Previews).
5. **Versions** tab: add a version. Name `0.1.0`; upload `polaris-key-godot-v0.1.0.zip` (the
   canonical zip from the release, not the `-assetlib` one); Changelog: paste the release notes
   (`python3 sdks/godot/tools/package.py --notes 0.1.0`); Minimum Godot version **4.4**; leave the
   maximum empty; Additional information: the zip's SHA-256 from `SHA256SUMS`. Save.
6. **Pricing** tab: free; set a donation link or leave it empty.
7. **Overview** tab: **Submit** for review. Record the listing URL
   (`https://store.godotengine.org/asset/<publisher-slug>/polaris-key/`). If the review asks for
   changes, fix them on `main`, cut a new patch version, and upload that version.

## 4. Asset Library, legacy (godotengine.org/asset-library)

1. Sign in at https://godotengine.org/asset-library/asset and choose **Submit Assets**.
2. Fill the form from `LISTING.md` ("Asset Library (legacy) fields"). The two fields that matter:
   - **Repository host: Custom**, because the repository is a monorepo: a GitHub-commit download
     would install `sdks/godot/addons/...` into the project.
   - **Download Commit/URL**:
     `https://github.com/vladzaharia/polaris-key/releases/download/godot-v0.1.0/polaris-key-godot-v0.1.0-assetlib.zip`
     (the wrapped zip, so the 4.4 to 4.6 installers put the files at `res://addons/polaris_key/`).
3. Submit, wait for moderation, and record the entry URL
   (`https://godotengine.org/asset-library/asset/<id>`). For a later version, use **Edit** on the
   entry and change Asset Version and the Download URL.

## 5. After approval

1. In a Godot 4.7 editor, install Polaris Key from the Asset Store into an empty project; in a 4.4
   or 4.6 editor, from the AssetLib tab. Each time: the files land in `res://addons/polaris_key/`,
   enabling the plugin adds the `PolarisKey` autoload and the Polaris Key dock, and the Output panel
   shows no errors.
2. Add the three URLs (GitHub Release, Asset Store listing, Asset Library entry) to the P1-12 PR or
   its follow-up issue, and tell the program lead so P1-12 can be marked done.
