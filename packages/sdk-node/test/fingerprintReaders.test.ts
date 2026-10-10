// @pkey-feature devices.fingerprint
// The platform READS behind the fingerprint and the device id (P1b-09 plan §5.1–§5.3): which
// commands run, with which options, and which files are opened. The pure rules are pinned by the
// corpus runner (`conformance/runners/node/fingerprint.test.ts`); this file proves the readers
// actually route through them, driving every OS's branch on any host through the injectable io.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
  stdout: "" as string,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: (
      cmd: string,
      args: string[],
      opts: Record<string, unknown>,
    ) => {
      exec.calls.push({ cmd, args, opts });
      return exec.stdout;
    },
  };
});

import {
  defaultFingerprintIo,
  rawComponents,
  WINDOWS_CIM_COMMAND,
  windowsPowerShellPath,
  type FingerprintIo,
} from "../src/devices/fingerprint.js";
import { deriveDeviceId, rawDeviceId } from "../src/devices/deviceId.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "fingerprint.json",
    ),
    "utf8",
  ),
) as { windowsCimCommand: { args: string[]; timeoutMs: number } };

/** A recording fake: canned command output and file contents; every run and read is logged. */
function fakeIo(
  files: Record<string, string>,
  commands: Record<string, string> = {},
) {
  const runs: { cmd: string; args: readonly string[]; timeoutMs?: number }[] =
    [];
  const reads: string[] = [];
  const io: FingerprintIo = {
    run(cmd, args, timeoutMs) {
      runs.push({ cmd, args, timeoutMs });
      return commands[cmd] ?? null;
    },
    read(path) {
      reads.push(path);
      return files[path] ?? null;
    },
  };
  return { io, runs, reads };
}

const MACHINE_ID = "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c";
const DMI = {
  "/sys/class/dmi/id/product_uuid": "4C4C4544-0042-3510-8048-B4C04F4E3732\n",
  "/sys/class/dmi/id/board_serial": ".CN1234567890.\n",
};
const REG = "C:\\Windows\\System32\\reg.exe";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("Windows: one PowerShell CIM call, no wmic", () => {
  it("runs exactly the pinned argv with the 10 s timeout, and parses its JSON", () => {
    const { io, runs } = fakeIo(
      {},
      {
        [PS]: '{"boardSerial":"  PF2ABCDE ","machineModel":"XPS 15 9530"}\r\n',
        [REG]: "    MachineGuid    REG_SZ    1111-2222\r\n",
      },
    );
    const raw = rawComponents({
      platform: "win32",
      io,
      env: { SystemRoot: "C:\\Windows" },
      totalBytes: 17179869184,
    });
    expect(raw.boardSerial).toBe("PF2ABCDE");
    expect(raw.machineModel).toBe("XPS 15 9530");
    expect(raw.machineUuid).toBe("1111-2222");
    expect(raw.ramBucket).toBe("16");
    const ps = runs.find((r) => r.cmd === PS)!;
    expect([...ps.args]).toEqual(corpus.windowsCimCommand.args);
    expect(ps.timeoutMs).toBe(corpus.windowsCimCommand.timeoutMs);
    expect(runs.some((r) => /wmic/i.test(r.cmd))).toBe(false);
    expect(runs.flatMap((r) => r.args).some((a) => /wmic/i.test(a))).toBe(
      false,
    );
  });

  it("a failed or garbled call costs only the two CIM components", () => {
    const { io } = fakeIo({}, { [PS]: "Get-CimInstance : Access denied\r\n" });
    const raw = rawComponents({
      platform: "win32",
      io,
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(raw.boardSerial).toBeUndefined();
    expect(raw.machineModel).toBeUndefined();
  });

  it("resolves PowerShell under an absolute SystemRoot, else by bare name", () => {
    expect(windowsPowerShellPath({ SystemRoot: "C:\\Windows" })).toBe(PS);
    expect(windowsPowerShellPath({ SystemRoot: "Windows" })).toBe(
      "powershell.exe",
    );
    expect(windowsPowerShellPath({ SystemRoot: "\\Windows" })).toBe(
      "powershell.exe",
    );
    expect(windowsPowerShellPath({})).toBe("powershell.exe");
  });

  describe("the real runner", () => {
    beforeEach(() => {
      exec.calls.length = 0;
      exec.stdout = "";
    });

    it("hides the console window and gives the child a null stdin", () => {
      exec.stdout = '{"boardSerial":"A1","machineModel":"B2"}';
      const out = defaultFingerprintIo.run(
        PS,
        WINDOWS_CIM_COMMAND.args,
        WINDOWS_CIM_COMMAND.timeoutMs,
      );
      expect(out).toBe(exec.stdout);
      const call = exec.calls[0]!;
      expect(call.cmd).toBe(PS);
      expect(call.args).toEqual(corpus.windowsCimCommand.args);
      expect(call.opts.windowsHide).toBe(true);
      expect((call.opts.stdio as string[])[0]).toBe("ignore");
      expect(call.opts.timeout).toBe(10_000);
      expect(call.opts.encoding).toBe("utf8");
    });

    it("every other read also hides the window and ignores stdin (2 s default)", () => {
      defaultFingerprintIo.run("reg", ["query"]);
      const call = exec.calls[0]!;
      expect(call.opts.windowsHide).toBe(true);
      expect((call.opts.stdio as string[])[0]).toBe("ignore");
      expect(call.opts.timeout).toBe(2000);
    });

    it("the device id's registry read goes through the same runner", () => {
      exec.stdout = "    MachineGuid    REG_SZ    abcd-ef01\r\n";
      expect(rawDeviceId("win32")).toBe("abcd-ef01");
      expect(exec.calls[0]!.opts.windowsHide).toBe(true);
      expect((exec.calls[0]!.opts.stdio as string[])[0]).toBe("ignore");
    });
  });
});

describe("Linux: the machine-id anchor, never DMI", () => {
  const machineIds = {
    "/etc/machine-id": `${MACHINE_ID}\n`,
    "/var/lib/dbus/machine-id": `${MACHINE_ID}\n`,
  };

  it("root and unprivileged yield one machineUuid; DMI files are never opened", () => {
    const root = fakeIo({ ...DMI, ...machineIds });
    const user = fakeIo(machineIds);
    const asRoot = rawComponents({ platform: "linux", io: root.io });
    const asUser = rawComponents({ platform: "linux", io: user.io });
    expect(asRoot.machineUuid).toBe(MACHINE_ID);
    expect(asUser.machineUuid).toBe(MACHINE_ID);
    expect(asRoot.boardSerial).toBeUndefined();
    expect(asRoot).toEqual(asUser);
    for (const reads of [root.reads, user.reads]) {
      expect(reads).not.toContain("/sys/class/dmi/id/product_uuid");
      expect(reads).not.toContain("/sys/class/dmi/id/board_serial");
    }
  });

  it("a host with only DMI files (a root container) has no anchor", () => {
    const { io } = fakeIo({ ...DMI });
    expect(
      rawComponents({ platform: "linux", io }).machineUuid,
    ).toBeUndefined();
  });

  it("reads product_name for machineModel and findmnt for the boot volume", () => {
    const { io } = fakeIo(
      { ...machineIds, "/sys/class/dmi/id/product_name": "ThinkPad X1\n" },
      { findmnt: "0d6c3e4a-1111-2222-3333-444455556666\n" },
    );
    const raw = rawComponents({ platform: "linux", io });
    expect(raw.machineModel).toBe("ThinkPad X1");
    expect(raw.bootVolumeUuid).toBe("0d6c3e4a-1111-2222-3333-444455556666");
  });

  describe("the device id uses the same rule", () => {
    it("a missing /etc/machine-id reads the dbus file (no longer a random id)", () => {
      const { io } = fakeIo({ "/var/lib/dbus/machine-id": "dbus-id\n" });
      expect(rawDeviceId("linux", io)).toBe("dbus-id");
    });

    it("two empty files give no raw id, never the hash of an empty string", () => {
      const { io } = fakeIo({
        "/etc/machine-id": "",
        "/var/lib/dbus/machine-id": "\n",
      });
      expect(rawDeviceId("linux", io)).toBeNull();
    });

    it("`uninitialized` is skipped", () => {
      const { io } = fakeIo({
        "/etc/machine-id": "uninitialized\n",
        "/var/lib/dbus/machine-id": "dbus-id\n",
      });
      expect(rawDeviceId("linux", io)).toBe("dbus-id");
    });

    it("root and unprivileged derive the same device id; DMI is never opened", () => {
      const root = fakeIo({ ...DMI, ...machineIds });
      const user = fakeIo(machineIds);
      expect(rawDeviceId("linux", root.io)).toBe(rawDeviceId("linux", user.io));
      expect(root.reads).not.toContain("/sys/class/dmi/id/product_uuid");
    });
  });

  it("deriveDeviceId still falls back when nothing is readable", () => {
    expect(deriveDeviceId("djdl", "fixed-fallback")).toHaveLength(32);
  });
});

describe("ramBucket in the reader", () => {
  it("is omitted below 1 GiB, never `0.5`", () => {
    const { io } = fakeIo({});
    expect(
      rawComponents({ platform: "linux", io, totalBytes: 536870912 }).ramBucket,
    ).toBeUndefined();
  });

  it("buckets a 16 GB Linux MemTotal to 8", () => {
    const { io } = fakeIo({});
    expect(
      rawComponents({ platform: "linux", io, totalBytes: 16496934912 })
        .ramBucket,
    ).toBe("8");
  });
});
