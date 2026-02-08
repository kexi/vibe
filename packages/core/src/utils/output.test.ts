import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetColorDetection } from "./ansi.ts";
import {
  errorLog,
  log,
  logDryRun,
  type OutputOptions,
  successLog,
  verboseLog,
  warnLog,
} from "./output.ts";

describe("output utilities", () => {
  let messages: string[];
  let originalError: typeof console.error;

  beforeEach(() => {
    messages = [];
    originalError = console.error;
    console.error = vi.fn((msg: string) => messages.push(msg));
    process.env.FORCE_COLOR = "1";
    resetColorDetection();
  });

  afterEach(() => {
    console.error = originalError;
    delete process.env.FORCE_COLOR;
    resetColorDetection();
  });

  describe("log", () => {
    it("outputs message when quiet is false", () => {
      const options: OutputOptions = { quiet: false };
      log("test message", options);
      expect(messages).toEqual(["test message"]);
    });

    it("outputs message when quiet is undefined", () => {
      const options: OutputOptions = {};
      log("test message", options);
      expect(messages).toEqual(["test message"]);
    });

    it("suppresses message when quiet is true", () => {
      const options: OutputOptions = { quiet: true };
      log("test message", options);
      expect(messages).toEqual([]);
    });
  });

  describe("verboseLog", () => {
    it("outputs message when verbose is true", () => {
      const options: OutputOptions = { verbose: true };
      verboseLog("test message", options);
      expect(messages).toEqual(["[verbose] test message"]);
    });

    it("suppresses message when verbose is false", () => {
      const options: OutputOptions = { verbose: false };
      verboseLog("test message", options);
      expect(messages).toEqual([]);
    });

    it("suppresses message when verbose is undefined", () => {
      const options: OutputOptions = {};
      verboseLog("test message", options);
      expect(messages).toEqual([]);
    });

    it("suppresses message when quiet is true even if verbose is true", () => {
      const options: OutputOptions = { verbose: true, quiet: true };
      verboseLog("test message", options);
      expect(messages).toEqual([]);
    });
  });

  describe("successLog", () => {
    it("outputs message with green color when quiet is false", () => {
      const options: OutputOptions = { quiet: false };
      successLog("success message", options);
      expect(messages).toEqual(["\x1b[32msuccess message\x1b[0m"]);
    });

    it("outputs message with green color when quiet is undefined", () => {
      const options: OutputOptions = {};
      successLog("success message", options);
      expect(messages).toEqual(["\x1b[32msuccess message\x1b[0m"]);
    });

    it("suppresses message when quiet is true", () => {
      const options: OutputOptions = { quiet: true };
      successLog("success message", options);
      expect(messages).toEqual([]);
    });
  });

  describe("errorLog", () => {
    it("always outputs message with red color even when quiet is true", () => {
      const options: OutputOptions = { quiet: true };
      errorLog("error message", options);
      expect(messages).toEqual(["\x1b[31merror message\x1b[0m"]);
    });

    it("outputs message with red color when quiet is false", () => {
      const options: OutputOptions = { quiet: false };
      errorLog("error message", options);
      expect(messages).toEqual(["\x1b[31merror message\x1b[0m"]);
    });

    it("outputs message with red color regardless of verbose setting", () => {
      const options: OutputOptions = { verbose: true, quiet: true };
      errorLog("error message", options);
      expect(messages).toEqual(["\x1b[31merror message\x1b[0m"]);
    });
  });

  describe("warnLog", () => {
    let warnMessages: string[];
    let originalWarn: typeof console.warn;

    beforeEach(() => {
      warnMessages = [];
      originalWarn = console.warn;
      console.warn = vi.fn((msg: string) => warnMessages.push(msg));
    });

    afterEach(() => {
      console.warn = originalWarn;
    });

    it("outputs message with yellow color", () => {
      warnLog("warning message");
      expect(warnMessages).toEqual(["\x1b[33mwarning message\x1b[0m"]);
    });

    it("accepts optional OutputOptions parameter", () => {
      const options: OutputOptions = { quiet: false };
      warnLog("warning message", options);
      expect(warnMessages).toEqual(["\x1b[33mwarning message\x1b[0m"]);
    });
  });

  describe("logDryRun", () => {
    it("outputs message with dim color and dry-run prefix", () => {
      logDryRun("would run command");
      expect(messages).toEqual(["\x1b[2m[dry-run] would run command\x1b[0m"]);
    });
  });
});
