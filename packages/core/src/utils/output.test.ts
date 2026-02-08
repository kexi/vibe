import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { errorLog, log, type OutputOptions, successLog, verboseLog } from "./output.ts";

describe("output utilities", () => {
  let messages: string[];
  let originalError: typeof console.error;

  beforeEach(() => {
    messages = [];
    originalError = console.error;
    console.error = vi.fn((msg: string) => messages.push(msg));
  });

  afterEach(() => {
    console.error = originalError;
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
    it("always outputs message even when quiet is true", () => {
      const options: OutputOptions = { quiet: true };
      errorLog("error message", options);
      expect(messages).toEqual(["error message"]);
    });

    it("outputs message when quiet is false", () => {
      const options: OutputOptions = { quiet: false };
      errorLog("error message", options);
      expect(messages).toEqual(["error message"]);
    });

    it("outputs message regardless of verbose setting", () => {
      const options: OutputOptions = { verbose: true, quiet: true };
      errorLog("error message", options);
      expect(messages).toEqual(["error message"]);
    });
  });
});
