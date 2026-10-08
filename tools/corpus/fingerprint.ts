// `fingerprint.json`: the hardware-hash and device-id formulas and the component derivations
// (WIRE-CONTRACT-V3 §6.1, P1b-09).

import { createHash } from "node:crypto";
import {
  type LinuxAnchorExpected,
  refLinuxAnchor,
  refParseWindowsCim,
  refRamBucket,
  type WindowsCimExpected,
} from "./reference/fingerprint.js";

// ── Fingerprint + device-id vectors ──────────────────────────────────────────
// Until now the device-id derivation was the ONE cross-language behaviour with no golden
// vector: three hand-written implementations (Node, Python, Swift) agreed only by code
// review. Hardware fingerprinting multiplies that surface, so both formulas are pinned here.
//
// The digests below are computed from first principles with node:crypto rather than by
// importing the Worker's helper. A golden corpus that shares code with the implementation it
// checks cannot catch a bug in that shared code.

const FINGERPRINT_COMPONENT_ORDER = [
  "machineUuid",
  "boardSerial",
  "cpuModel",
  "primaryMac",
  "bootVolumeUuid",
  "ramBucket",
  "machineModel",
] as const;

type FingerprintComponentName = (typeof FINGERPRINT_COMPONENT_ORDER)[number];

function sha256B64url(input: string, length: number): string {
  return createHash("sha256")
    .update(input, "utf8")
    .digest("base64url")
    .slice(0, length);
}

function componentHash(
  product: string,
  component: FingerprintComponentName,
  raw: string,
): string {
  return sha256B64url(`pkey-hw:${product}:${component}:${raw}`, 22);
}

function hwidOf(
  components: Partial<Record<FingerprintComponentName, string>>,
): string {
  const parts: string[] = [];
  for (const component of FINGERPRINT_COMPONENT_ORDER) {
    const value = components[component];
    if (value !== undefined) parts.push(`${component}=${value}`);
  }
  return sha256B64url(parts.join("\n"), 32);
}

interface FingerprintVector {
  id: string;
  description: string;
  product: string;
  raw: Partial<Record<FingerprintComponentName, string>>;
  components: Partial<Record<FingerprintComponentName, string>>;
  hwid: string;
}

function fingerprintVector(
  id: string,
  description: string,
  product: string,
  raw: Partial<Record<FingerprintComponentName, string>>,
): FingerprintVector {
  const components: Partial<Record<FingerprintComponentName, string>> = {};
  // Iterate the CANONICAL order, not the raw map's insertion order — that is exactly the
  // property the `reversed-input-order` vector below exists to pin.
  for (const component of FINGERPRINT_COMPONENT_ORDER) {
    const value = raw[component];
    if (value !== undefined)
      components[component] = componentHash(product, component, value);
  }
  return {
    id,
    description,
    product,
    raw,
    components,
    hwid: hwidOf(components),
  };
}

const MAC_RAW: Record<FingerprintComponentName, string> = {
  machineUuid: "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
  boardSerial: "C02XK1ABCDEF",
  cpuModel: "Apple M3 Pro:12",
  primaryMac: "a4:83:e7:1b:2c:3d",
  bootVolumeUuid: "8F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0",
  ramBucket: "32",
  machineModel: "MacBookPro18,3",
};

// ── Fingerprint component derivations (WIRE-CONTRACT-V3 §6.1, P1b-09) ───────────────────────
// The three source rules every native SDK must follow when it READS a component, pinned as
// pure input → output cases: the Windows CIM parser (rule 1), the Linux anchor selection
// (rule 2) and the RAM bucket (rule 3). Each case states its expected output literally; the
// generator-local reference functions in `reference/fingerprint.ts` re-derive every one and
// generation fails on any disagreement, so a typo in a hand-written expectation cannot ship.

/** One line with no double quotes (Windows argument quoting cannot mangle it), emitting pure
 *  ASCII (a console code page or a missing console cannot corrupt a value). `[-1]` takes the
 *  last instance, which is the row the old `wmic … /format:csv` parser took; each query has
 *  its own `try`, so a failing class costs only its own component. */
const WINDOWS_CIM_SCRIPT =
  "$ErrorActionPreference='Stop';$b=$null;$m=$null;" +
  "try{$b=@(Get-CimInstance -ClassName Win32_BaseBoard -Property SerialNumber)[-1].SerialNumber}catch{};" +
  "try{$m=@(Get-CimInstance -ClassName Win32_ComputerSystem -Property Model)[-1].Model}catch{};" +
  "$j=ConvertTo-Json -Compress -InputObject @{boardSerial=$b;machineModel=$m};" +
  "$o='';foreach($c in $j.ToCharArray()){$n=[int]$c;if($n -gt 126){$o+='\\u'+$n.ToString('x4')}else{$o+=$c}};$o";

const WINDOWS_CIM_COMMAND = {
  program: "powershell.exe",
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_CIM_SCRIPT,
  ],
  stdin: "null",
  timeoutMs: 10000,
};

const BOTH_CIM =
  '{"boardSerial":"/8YHTG2/CN1234567890/","machineModel":"XPS 15 9530"}';
const BOTH_EXPECTED: WindowsCimExpected = {
  boardSerial: "/8YHTG2/CN1234567890/",
  machineModel: "XPS 15 9530",
};

const WINDOWS_CIM_CASES: {
  id: string;
  description: string;
  stdout: string;
  expected: WindowsCimExpected;
}[] = [
  {
    id: "both",
    description:
      "The script's normal output, CRLF-terminated: both components.",
    stdout: `${BOTH_CIM}\r\n`,
    expected: BOTH_EXPECTED,
  },
  {
    id: "padded",
    description:
      "Leading and trailing spaces are trimmed; inner spaces are kept.",
    stdout:
      '{"boardSerial":"  PF2ABCDE  ","machineModel":"ThinkPad X1 Carbon Gen 11 "}',
    expected: {
      boardSerial: "PF2ABCDE",
      machineModel: "ThinkPad X1 Carbon Gen 11",
    },
  },
  {
    id: "placeholder-kept",
    description:
      "Vendor placeholders are kept verbatim, as wmic returned them; they are not this rule's to judge.",
    stdout:
      '{"boardSerial":"To be filled by O.E.M.","machineModel":"System Product Name"}',
    expected: {
      boardSerial: "To be filled by O.E.M.",
      machineModel: "System Product Name",
    },
  },
  {
    id: "serial-null",
    description: "A null value yields no component; the other is kept.",
    stdout: '{"boardSerial":null,"machineModel":"Surface Laptop 5"}',
    expected: { machineModel: "Surface Laptop 5" },
  },
  {
    id: "empty-and-blank",
    description:
      "An empty string, and one that is blank after trimming, yield nothing.",
    stdout: '{"boardSerial":"","machineModel":" \\t "}',
    expected: {},
  },
  {
    id: "non-ascii-space-kept",
    description:
      "Only U+0009–U+000D and U+0020 are trimmed: U+000B and U+000C go, U+00A0 and U+001F stay. A language's default trim fails this case.",
    stdout:
      '{"boardSerial":"\\u000b\\u00a0PF2ABCDE\\u001f\\u000c","machineModel":"\\u001fThinkPad X1\\u00a0"}',
    expected: {
      boardSerial: "\u00a0PF2ABCDE\u001f",
      machineModel: "\u001fThinkPad X1\u00a0",
    },
  },
  {
    id: "key-order",
    description: "Key order does not matter.",
    stdout: '{"machineModel":"OptiPlex 7090","boardSerial":"7XYZ123"}',
    expected: { boardSerial: "7XYZ123", machineModel: "OptiPlex 7090" },
  },
  {
    id: "pretty",
    description: "Indented JSON over four lines parses the same.",
    stdout:
      '{\r\n    "boardSerial":  "/8YHTG2/CN1234567890/",\r\n    "machineModel":  "XPS 15 9530"\r\n}\r\n',
    expected: BOTH_EXPECTED,
  },
  {
    id: "bom",
    description: "One leading U+FEFF is stripped before parsing.",
    stdout: `\uFEFF${BOTH_CIM}`,
    expected: BOTH_EXPECTED,
  },
  {
    id: "json-escapes",
    description:
      "JSON escapes decode (PowerShell 5.1 escapes &, < and >); a missing key yields no component.",
    stdout: '{"machineModel":"Dell \\u0026 Co \\u003cX\\u003e"}',
    expected: { machineModel: "Dell & Co <X>" },
  },
  {
    id: "escaped-non-ascii",
    description:
      "Non-ASCII as the script emits it, escaped, decodes to the value.",
    stdout: '{"machineModel":"Mod\\u00e8le \\u2014 \\u65e5\\u672c"}',
    expected: { machineModel: "Modèle — 日本" },
  },
  {
    id: "raw-non-ascii",
    description: "Unescaped non-ASCII, decoded as UTF-8, gives the same value.",
    stdout: '{"machineModel":"Modèle — 日本"}',
    expected: { machineModel: "Modèle — 日本" },
  },
  {
    id: "unknown-keys",
    description: "Keys other than the two components are ignored.",
    stdout: '{"boardSerial":"A1","machineModel":"B2","extra":"C3"}',
    expected: { boardSerial: "A1", machineModel: "B2" },
  },
  {
    id: "non-string",
    description: "A value that is not a string yields no component.",
    stdout: '{"boardSerial":12345,"machineModel":true}',
    expected: {},
  },
  {
    id: "not-an-object",
    description: "Valid JSON that is not an object yields nothing.",
    stdout: '["A1","B2"]',
    expected: {},
  },
  {
    id: "error-text",
    description: "Output that is not JSON yields nothing.",
    stdout: "Get-CimInstance : Access denied\r\n",
    expected: {},
  },
  {
    id: "empty",
    description: "No output yields nothing.",
    stdout: "",
    expected: {},
  },
];

const MACHINE_ID = "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c";
const DBUS_MACHINE_ID = "e3b0c44298fc1c149afbf4c8996fb924";
const DMI_FILES = {
  "/sys/class/dmi/id/product_uuid": "4C4C4544-0042-3510-8048-B4C04F4E3732\n",
  "/sys/class/dmi/id/board_serial": ".CN1234567890.\n",
};

const LINUX_ANCHOR_CASES: {
  id: string;
  description: string;
  files: Record<string, string>;
  expected: LinuxAnchorExpected;
}[] = [
  {
    id: "root",
    description:
      "Root can read the DMI files too; they are never read, so the anchor is /etc/machine-id.",
    files: {
      ...DMI_FILES,
      "/etc/machine-id": `${MACHINE_ID}\n`,
      "/var/lib/dbus/machine-id": `${MACHINE_ID}\n`,
    },
    expected: { source: "/etc/machine-id", value: MACHINE_ID },
  },
  {
    id: "unprivileged",
    description:
      "The same host without root yields the same source and value as `root`.",
    files: {
      "/etc/machine-id": `${MACHINE_ID}\n`,
      "/var/lib/dbus/machine-id": `${MACHINE_ID}\n`,
    },
    expected: { source: "/etc/machine-id", value: MACHINE_ID },
  },
  {
    id: "product-uuid-only",
    description:
      "Root on a host with no machine-id, such as a container: no anchor (P1b-09 plan D3).",
    files: { ...DMI_FILES },
    expected: null,
  },
  {
    id: "etc-missing",
    description: "No /etc/machine-id: the dbus file is the anchor.",
    files: { "/var/lib/dbus/machine-id": `${DBUS_MACHINE_ID}\n` },
    expected: { source: "/var/lib/dbus/machine-id", value: DBUS_MACHINE_ID },
  },
  {
    id: "etc-empty",
    description:
      "A blank /etc/machine-id is skipped. Trim first: a reader that tests for emptiness before trimming picks it and fails.",
    files: {
      "/etc/machine-id": " \n",
      "/var/lib/dbus/machine-id": `${DBUS_MACHINE_ID}\n`,
    },
    expected: { source: "/var/lib/dbus/machine-id", value: DBUS_MACHINE_ID },
  },
  {
    id: "etc-uninitialized",
    description: "`uninitialized` (systemd's first-boot marker) is skipped.",
    files: {
      "/etc/machine-id": "uninitialized\n",
      "/var/lib/dbus/machine-id": `${DBUS_MACHINE_ID}\n`,
    },
    expected: { source: "/var/lib/dbus/machine-id", value: DBUS_MACHINE_ID },
  },
  {
    id: "all-uninitialized",
    description:
      "Both files `uninitialized`: no anchor, never a literal shared by every such host.",
    files: {
      "/etc/machine-id": "uninitialized\n",
      "/var/lib/dbus/machine-id": "uninitialized\n",
    },
    expected: null,
  },
  {
    id: "whitespace",
    description: "Surrounding ASCII whitespace, CRLF included, is trimmed.",
    files: { "/etc/machine-id": `  ${MACHINE_ID}  \r\n` },
    expected: { source: "/etc/machine-id", value: MACHINE_ID },
  },
  {
    id: "nbsp-kept",
    description:
      "Only U+0009–U+000D and U+0020 are trimmed: U+000C, U+000B and the newline go, U+001F and U+00A0 stay.",
    files: {
      "/etc/machine-id":
        "\u000c\u001f4e1d2c3b4a5968778695a4b3c2d1e0a9\u00a0\u000b\n",
    },
    expected: {
      source: "/etc/machine-id",
      value: "\u001f4e1d2c3b4a5968778695a4b3c2d1e0a9\u00a0",
    },
  },
  {
    id: "nothing",
    description: "No readable file: no anchor.",
    files: {},
    expected: null,
  },
];

const RAM_BUCKET_CASES: {
  id: string;
  description: string;
  bytes: number;
  bucket: string | null;
}[] = [
  { id: "zero", description: "Zero bytes: omitted.", bytes: 0, bucket: null },
  {
    id: "half-gib",
    description: "Below 1 GiB: omitted, never `0.5`.",
    bytes: 536870912,
    bucket: null,
  },
  {
    id: "just-under-1gib",
    description: "One byte under 1 GiB: omitted.",
    bytes: 1073741823,
    bucket: null,
  },
  { id: "1gib", description: "Exactly 1 GiB.", bytes: 1073741824, bucket: "1" },
  {
    id: "just-under-2gib",
    description: "One byte under 2 GiB stays in the 1 bucket.",
    bytes: 2147483647,
    bucket: "1",
  },
  { id: "2gib", description: "Exactly 2 GiB.", bytes: 2147483648, bucket: "2" },
  {
    id: "linux-16gb-memtotal",
    description:
      "A 16 GB Linux MemTotal (about 15.4 GiB) buckets to 8, not 16.",
    bytes: 16496934912,
    bucket: "8",
  },
  {
    id: "16gib",
    description: "Exactly 16 GiB.",
    bytes: 17179869184,
    bucket: "16",
  },
  {
    id: "windows-32gb-total",
    description: "A 32 GB Windows total (about 31.9 GiB) buckets to 16.",
    bytes: 34200436736,
    bucket: "16",
  },
  {
    id: "64gib",
    description: "Exactly 64 GiB.",
    bytes: 68719476736,
    bucket: "64",
  },
  {
    id: "1tib",
    description: "Exactly 1 TiB.",
    bytes: 1099511627776,
    bucket: "1024",
  },
  {
    id: "6tib",
    description: "6 TiB is not a power of two: 4096.",
    bytes: 6597069766656,
    bucket: "4096",
  },
  {
    id: "just-under-1pib",
    description:
      "One byte under 1 PiB. A float log2(bytes / 2^30) rounds this up to 1048576; dividing first gives 524288.",
    bytes: 1125899906842623,
    bucket: "524288",
  },
];

function selfCheckDerivations(): void {
  const fail = (section: string, id: string): never => {
    throw new Error(`corpus self-check failed: ${section}/${id}`);
  };
  const same = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b);
  for (const c of WINDOWS_CIM_CASES) {
    const got = refParseWindowsCim(c.stdout);
    // Compare per key so key order in the literal cannot matter.
    if (
      got.boardSerial !== c.expected.boardSerial ||
      got.machineModel !== c.expected.machineModel ||
      Object.keys(got).length !== Object.keys(c.expected).length
    )
      fail("windowsCim", c.id);
  }
  for (const c of LINUX_ANCHOR_CASES)
    if (!same(refLinuxAnchor(c.files), c.expected)) fail("linuxAnchor", c.id);
  for (const c of RAM_BUCKET_CASES) {
    if (!Number.isSafeInteger(c.bytes)) fail("ramBuckets", c.id);
    if (refRamBucket(c.bytes) !== c.bucket) fail("ramBuckets", c.id);
  }
}

export function buildFingerprintCorpus(): unknown {
  selfCheckDerivations();

  const vectors: FingerprintVector[] = [
    fingerprintVector(
      "macos-full",
      "All seven components present on macOS.",
      "djdl",
      MAC_RAW,
    ),
    fingerprintVector(
      "windows-full",
      "All seven components present on Windows; same shape, different values.",
      "djdl",
      {
        machineUuid: "9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0",
        boardSerial: "/8YHTG2/CN1234567890/",
        cpuModel: "AMD Ryzen 9 7950X:16",
        primaryMac: "00:1a:2b:3c:4d:5e",
        bootVolumeUuid: "3C4D5E6F",
        ramBucket: "64",
        machineModel: "XPS 15 9530",
      },
    ),
    fingerprintVector(
      "linux-partial",
      "Fail-soft: a host that could only read three components still produces a fingerprint.",
      "djdl",
      {
        machineUuid: "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c",
        cpuModel: "Intel(R) Core(TM) i7-12700H:20",
        ramBucket: "16",
      },
    ),
    fingerprintVector(
      "reversed-input-order",
      "Identical components declared in reverse order must yield the macos-full hwid.",
      "djdl",
      Object.fromEntries(
        [...FINGERPRINT_COMPONENT_ORDER].reverse().map((c) => [c, MAC_RAW[c]]),
      ) as Record<FingerprintComponentName, string>,
    ),
    fingerprintVector(
      "unicode-model",
      "Non-ASCII raw values must hash over UTF-8 bytes identically in every language.",
      "djdl",
      {
        machineUuid: "ünïcödé-uuid-λ",
        machineModel: "Ordinateur — Modèle 日本",
      },
    ),
    fingerprintVector(
      "other-product",
      "Domain separation: the same hardware under a different product slug must differ.",
      "other",
      MAC_RAW,
    ),
  ];

  // The pre-existing `pkey-device:` formula, pinned for the first time.
  const deviceIds = [
    {
      id: "macos-platform-uuid",
      product: "djdl",
      raw: "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
      expected: sha256B64url(
        "pkey-device:djdl:564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
        32,
      ),
    },
    {
      id: "linux-machine-id",
      product: "djdl",
      raw: "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c",
      expected: sha256B64url(
        "pkey-device:djdl:b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c",
        32,
      ),
    },
    {
      id: "other-product-same-hardware",
      product: "other",
      raw: "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
      expected: sha256B64url(
        "pkey-device:other:564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
        32,
      ),
    },
    {
      id: "unicode-raw",
      product: "djdl",
      raw: "ünïcödé-uuid-λ",
      expected: sha256B64url("pkey-device:djdl:ünïcödé-uuid-λ", 32),
    },
  ];

  return {
    fingerprintVersion: 1,
    componentOrder: FINGERPRINT_COMPONENT_ORDER,
    componentHashLength: 22,
    hwidLength: 32,
    deviceIds,
    vectors,
    windowsCimCommand: WINDOWS_CIM_COMMAND,
    windowsCim: WINDOWS_CIM_CASES,
    linuxAnchor: LINUX_ANCHOR_CASES,
    ramBuckets: RAM_BUCKET_CASES,
  };
}
