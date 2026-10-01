-- P1b-04 — canonical client metadata (WIRE-CONTRACT-V3 §5.2 rule 3). DATA ONLY: no column,
-- index or table changes.
--
-- SDKs built before §5.2 sent their runtime's own spellings (`darwin`, `win32`, `x64`, `AMD64`,
-- `browser`) and their package names as `X-PKey-SDK`, so one kind of machine was split across
-- several chips in the console's device summary. The Worker now stores the canonical value on
-- every write (`src/core/clientMetadata.ts`); this converges the rows stored before it, including
-- devices that never return. Each statement is idempotent, and replaying the file changes nothing
-- (`test/canonicalClientMetadata.test.ts`).
--
-- The spellings are `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` of `@polaris-key/protocol/core` as of
-- this migration. SQLite's `lower()` folds ASCII only, which is §5.2's folding rule. Unknown values
-- stay as sent, and a stored empty value becomes NULL (absent), as rule 3 says.

UPDATE devices SET platform = 'macos'
  WHERE lower(platform) IN ('macos', 'darwin', 'maccatalyst') AND platform <> 'macos';
UPDATE devices SET platform = 'ios'
  WHERE lower(platform) IN ('ios', 'ipados') AND platform <> 'ios';
UPDATE devices SET platform = 'android'
  WHERE lower(platform) IN ('android') AND platform <> 'android';
UPDATE devices SET platform = 'windows'
  WHERE lower(platform) IN ('windows', 'win32') AND platform <> 'windows';
UPDATE devices SET platform = 'linux'
  WHERE lower(platform) IN ('linux') AND platform <> 'linux';
UPDATE devices SET platform = 'web'
  WHERE lower(platform) IN ('web', 'browser') AND platform <> 'web';

UPDATE devices SET arch = 'arm64'
  WHERE lower(arch) IN ('arm64', 'aarch64', 'arm64-v8a') AND arch <> 'arm64';
UPDATE devices SET arch = 'x86_64'
  WHERE lower(arch) IN ('x86_64', 'x64', 'amd64') AND arch <> 'x86_64';
UPDATE devices SET arch = 'armv7'
  WHERE lower(arch) IN ('armv7', 'armv7l', 'armv8l', 'arm', 'arm32', 'armeabi-v7a')
    AND arch <> 'armv7';
UPDATE devices SET arch = 'wasm32'
  WHERE lower(arch) IN ('wasm32') AND arch <> 'wasm32';

UPDATE devices SET sdk_name = 'node' WHERE sdk_name = '@polaris-key/node';
UPDATE devices SET sdk_name = 'react' WHERE sdk_name = '@polaris-key/react';
UPDATE devices SET sdk_name = 'python' WHERE sdk_name = 'polaris-key-python';
UPDATE devices SET sdk_name = 'swift' WHERE sdk_name = 'PolarisKeySwift';
UPDATE devices SET sdk_name = 'godot' WHERE sdk_name = 'polaris-key-godot';

UPDATE devices SET platform = NULL WHERE platform = '';
UPDATE devices SET arch = NULL WHERE arch = '';
UPDATE devices SET sdk_name = NULL WHERE sdk_name = '';
