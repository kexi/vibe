/**
 * Tests for scripts/verify-deb.ts — asserts that a built .deb ships the binary
 * and the documentation Debian expects: usr/bin/vibe (a regular, executable
 * file), the DEP-5 usr/share/doc/vibe/copyright, and THIRD-PARTY-LICENSES.md
 * for the statically-linked Rust crates. None of these is visible from a smoke
 * test of the installed binary, so a package that drops them would otherwise
 * ship silently.
 *
 * The pure parsing/validation is unit-tested here, plus the producer→consumer
 * pipe wiring driven with stand-in processes (a consumer that leaves before it
 * has drained its input must surface as a reported exit code, not a crash or a
 * hang). The `dpkg-deb` invocation that feeds it is exercised by the CI
 * build-deb steps (it needs a real archive, and dpkg-deb does not exist on
 * macOS dev machines).
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  parseDebContents,
  isRegularFile,
  isExecutable,
  findContentProblems,
  findMarkerProblems,
  resolveDebPath,
  isBrokenPipeError,
  pipeIgnoringBrokenPipe,
} from "../../../scripts/verify-deb";

/** A well-formed `dpkg-deb --contents` listing for a correct package. */
const GOOD_CONTENTS = `drwxr-xr-x root/root         0 2025-01-01 00:00 ./
drwxr-xr-x root/root         0 2025-01-01 00:00 ./usr/
drwxr-xr-x root/root         0 2025-01-01 00:00 ./usr/bin/
-rwxr-xr-x root/root   5242880 2025-01-01 00:00 ./usr/bin/vibe
drwxr-xr-x root/root         0 2025-01-01 00:00 ./usr/share/doc/vibe/
-rw-r--r-- root/root      1234 2025-01-01 00:00 ./usr/share/doc/vibe/copyright
-rw-r--r-- root/root    999999 2025-01-01 00:00 ./usr/share/doc/vibe/THIRD-PARTY-LICENSES.md
`;

function entriesOf(contents: string) {
  return parseDebContents(contents);
}

describe("parseDebContents", () => {
  it("extracts every member with its mode, stripping the leading ./", () => {
    const entries = entriesOf(GOOD_CONTENTS);
    expect(entries).toHaveLength(7);
    expect(entries).toContainEqual({ path: "usr/bin/vibe", mode: "-rwxr-xr-x" });
    expect(entries).toContainEqual({
      path: "usr/share/doc/vibe/copyright",
      mode: "-rw-r--r--",
    });
  });

  it("keeps a path that contains spaces intact", () => {
    // Taking the last whitespace-separated field would truncate this to "name"
    // and report the real member as missing.
    const entries = entriesOf(
      "-rw-r--r-- root/root  10 2025-01-01 00:00 ./usr/share/doc/vibe/a file with name\n",
    );
    expect(entries).toEqual([
      { path: "usr/share/doc/vibe/a file with name", mode: "-rw-r--r--" },
    ]);
  });

  it("records a symlink under its own name, not its target", () => {
    const entries = entriesOf(
      "lrwxrwxrwx root/root  0 2025-01-01 00:00 ./usr/share/doc/vibe/copyright -> ../shared/copyright\n",
    );
    expect(entries).toEqual([
      { path: "usr/share/doc/vibe/copyright", mode: "lrwxrwxrwx" },
    ]);
  });

  it("ignores blank lines and lines with too few fields", () => {
    expect(entriesOf("\n   \ngarbage\n")).toEqual([]);
  });
});

describe("isRegularFile", () => {
  it("accepts a regular file and rejects directories and symlinks", () => {
    expect(isRegularFile("-rw-r--r--")).toBe(true);
    expect(isRegularFile("drwxr-xr-x")).toBe(false);
    expect(isRegularFile("lrwxrwxrwx")).toBe(false);
  });
});

describe("isExecutable", () => {
  it("detects an execute bit in the permission triples", () => {
    expect(isExecutable("-rwxr-xr-x")).toBe(true);
    expect(isExecutable("-rw-r--r--")).toBe(false);
  });

  it("ignores the file-type character so a directory is not 'executable' by its d", () => {
    // Why this matters: the type char is not a permission bit, and reading it as
    // one made every directory look like an executable file.
    expect(isExecutable("drw-r--r--")).toBe(false);
  });
});

describe("findContentProblems", () => {
  it("reports no problems for a complete, correct package", () => {
    expect(findContentProblems(entriesOf(GOOD_CONTENTS))).toEqual([]);
  });

  it("reports a missing copyright file", () => {
    const entries = entriesOf(GOOD_CONTENTS).filter((e) => !e.path.endsWith("/copyright"));
    expect(findContentProblems(entries)).toEqual([
      "missing required file: usr/share/doc/vibe/copyright",
    ]);
  });

  it("reports a missing THIRD-PARTY-LICENSES.md", () => {
    const entries = entriesOf(GOOD_CONTENTS).filter(
      (e) => !e.path.endsWith("THIRD-PARTY-LICENSES.md"),
    );
    expect(findContentProblems(entries)).toEqual([
      "missing required file: usr/share/doc/vibe/THIRD-PARTY-LICENSES.md",
    ]);
  });

  it("reports a missing binary", () => {
    const entries = entriesOf(GOOD_CONTENTS).filter((e) => e.path !== "usr/bin/vibe");
    expect(findContentProblems(entries)).toEqual(["missing required file: usr/bin/vibe"]);
  });

  it("reports a binary that carries no execute bit", () => {
    const entries = entriesOf(GOOD_CONTENTS).map((e) =>
      e.path === "usr/bin/vibe" ? { ...e, mode: "-rw-r--r--" } : e,
    );
    expect(findContentProblems(entries)).toEqual([
      "usr/bin/vibe is not executable (mode -rw-r--r--)",
    ]);
  });

  it("rejects a directory occupying the binary's path", () => {
    // A bare presence check would accept this and call the package valid.
    const entries = entriesOf(GOOD_CONTENTS).map((e) =>
      e.path === "usr/bin/vibe" ? { ...e, mode: "drwxr-xr-x" } : e,
    );
    expect(findContentProblems(entries)).toEqual([
      "usr/bin/vibe is not a regular file (mode drwxr-xr-x)",
    ]);
  });

  it("rejects a copyright symlink (its target need not ship in the package)", () => {
    const entries = entriesOf(GOOD_CONTENTS).map((e) =>
      e.path.endsWith("/copyright") ? { ...e, mode: "lrwxrwxrwx" } : e,
    );
    expect(findContentProblems(entries)).toEqual([
      "usr/share/doc/vibe/copyright is not a regular file (mode lrwxrwxrwx)",
    ]);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    expect(findContentProblems([])).toHaveLength(3);
  });
});

describe("findMarkerProblems", () => {
  it("returns nothing when every marker is present", () => {
    expect(findMarkerProblems("copyright", "Format: x\nLicense: MIT\n", ["Format: x", "License: MIT"]))
      .toEqual([]);
  });

  it("names each absent marker", () => {
    expect(findMarkerProblems("copyright", "License: MIT", ["Format: x", "License: MIT"])).toEqual([
      "copyright does not contain: Format: x",
    ]);
  });
});

describe("resolveDebPath", () => {
  const cwd = "/work";

  it("resolves a relative path inside the working directory", () => {
    expect(resolveDebPath("vibe_1.0.0_amd64.deb", cwd)).toBe("/work/vibe_1.0.0_amd64.deb");
  });

  it("allows a nested path under the working directory", () => {
    expect(resolveDebPath("dist/vibe_1.0.0_amd64.deb", cwd)).toBe("/work/dist/vibe_1.0.0_amd64.deb");
  });

  it("rejects an absolute path outside the working directory", () => {
    expect(() => resolveDebPath("/etc/passwd", cwd)).toThrowError(/inside the working directory/);
  });

  it("rejects a parent-directory escape", () => {
    expect(() => resolveDebPath("../outside.deb", cwd)).toThrowError(
      /inside the working directory/,
    );
  });

  it("rejects an escape hidden mid-path", () => {
    expect(() => resolveDebPath("dist/../../outside.deb", cwd)).toThrowError(
      /inside the working directory/,
    );
  });

  it("rejects the working directory itself (empty and '.')", () => {
    // Neither names a .deb file; accepting them would hand a directory to dpkg.
    expect(() => resolveDebPath("", cwd)).toThrowError(/inside the working directory/);
    expect(() => resolveDebPath(".", cwd)).toThrowError(/inside the working directory/);
  });
});

describe("isBrokenPipeError", () => {
  it("recognises every error code raised when the pipe's consumer is gone", () => {
    expect(isBrokenPipeError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" })))
      .toBe(true);
    expect(
      isBrokenPipeError(Object.assign(new Error("after end"), { code: "ERR_STREAM_WRITE_AFTER_END" })),
    ).toBe(true);
  });

  it("does not classify an unrelated stream error as a broken pipe", () => {
    // Swallowing these would hide a real I/O fault behind an empty extraction.
    expect(isBrokenPipeError(Object.assign(new Error("no space"), { code: "ENOSPC" }))).toBe(false);
    expect(isBrokenPipeError(new Error("boom"))).toBe(false);
    expect(isBrokenPipeError(undefined)).toBe(false);
  });
});

describe("pipeIgnoringBrokenPipe", () => {
  /**
   * Streams 64 MB — far more than any pipe buffer holds — so writes are still in
   * flight after the consumer is gone, which is what raises EPIPE. It tolerates
   * its own broken pipe so the test observes the wiring under test rather than
   * the producer's own crash, mirroring dpkg-deb dying of SIGPIPE.
   */
  function spawnSlowProducer() {
    return spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.on('error',()=>process.exit(0));" +
        "const b=Buffer.alloc(1024*1024);" +
        "for(let i=0;i<64;i++)process.stdout.write(b);" +
        "process.stdout.end()",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
  }

  it("reports both exit codes instead of crashing when the consumer exits first", async () => {
    // The failure this guards: the consumer leaves with a non-zero status while
    // the producer is still streaming, and the EPIPE on its stdin aborts the
    // whole verifier with a raw stack trace before either exit code is read.
    const producer = spawnSlowProducer();
    const consumer = spawn(process.execPath, ["-e", "process.exit(2)"], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    pipeIgnoringBrokenPipe(producer.stdout, consumer.stdin);

    const [, consumerCode] = await Promise.all([
      // The producer must terminate too: with nothing draining it any more it
      // would block forever on a full pipe, turning the crash into a hang.
      once(producer, "close").then(([code]) => code as number | null),
      once(consumer, "close").then(([code]) => code as number | null),
    ]);

    expect(consumerCode).toBe(2);
  });

  it("lets both processes finish when the consumer leaves with a success status", async () => {
    // A consumer that has all it needs and exits 0 (tar --fast-read) breaks the
    // pipe just the same, so the same teardown has to apply.
    const producer = spawnSlowProducer();
    const consumer = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    pipeIgnoringBrokenPipe(producer.stdout, consumer.stdin);

    const [, consumerCode] = await Promise.all([
      once(producer, "close").then(([code]) => code as number | null),
      once(consumer, "close").then(([code]) => code as number | null),
    ]);

    expect(consumerCode).toBe(0);
  });

  it("forwards every byte when the consumer drains its input", async () => {
    const producer = spawn(process.execPath, ["-e", "process.stdout.write('hello')"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const consumer = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    pipeIgnoringBrokenPipe(producer.stdout, consumer.stdin);

    const chunks: Buffer[] = [];
    consumer.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const [code] = (await once(consumer, "close")) as [number | null];

    expect(code).toBe(0);
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("hello");
  });

  it("forwards a payload larger than the pipe buffer without truncating it", async () => {
    // Guards the teardown from firing on a healthy stream: destroying the source
    // whenever the sink closes would cut a multi-megabyte member short and the
    // verifier would then read a truncated copyright as a marker mismatch.
    const size = 8 * 1024 * 1024;
    const producer = spawn(process.execPath, [
      "-e",
      `process.stdout.write(Buffer.alloc(${size}, 0x61))`,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    const consumer = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    pipeIgnoringBrokenPipe(producer.stdout, consumer.stdin);

    const chunks: Buffer[] = [];
    consumer.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const [code] = (await once(consumer, "close")) as [number | null];

    expect(code).toBe(0);
    expect(Buffer.concat(chunks)).toHaveLength(size);
  });
});
