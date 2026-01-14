import { assertEquals } from "@std/assert";
import { log, type OutputOptions, verboseLog } from "./output.ts";

Deno.test("log: outputs message when quiet is false", () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => messages.push(msg);

  try {
    const options: OutputOptions = { quiet: false };
    log("test message", options);
    assertEquals(messages, ["test message"]);
  } finally {
    console.error = originalError;
  }
});

Deno.test("log: outputs message when quiet is undefined", () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => messages.push(msg);

  try {
    const options: OutputOptions = {};
    log("test message", options);
    assertEquals(messages, ["test message"]);
  } finally {
    console.error = originalError;
  }
});

Deno.test("log: suppresses message when quiet is true", () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => messages.push(msg);

  try {
    const options: OutputOptions = { quiet: true };
    log("test message", options);
    assertEquals(messages, []);
  } finally {
    console.error = originalError;
  }
});

Deno.test("verboseLog: outputs message when verbose is true", () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => messages.push(msg);

  try {
    const options: OutputOptions = { verbose: true };
    verboseLog("test message", options);
    assertEquals(messages, ["[verbose] test message"]);
  } finally {
    console.error = originalError;
  }
});

Deno.test("verboseLog: suppresses message when verbose is false", () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => messages.push(msg);

  try {
    const options: OutputOptions = { verbose: false };
    verboseLog("test message", options);
    assertEquals(messages, []);
  } finally {
    console.error = originalError;
  }
});

Deno.test("verboseLog: suppresses message when verbose is undefined", () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => messages.push(msg);

  try {
    const options: OutputOptions = {};
    verboseLog("test message", options);
    assertEquals(messages, []);
  } finally {
    console.error = originalError;
  }
});

Deno.test("verboseLog: suppresses message when quiet is true even if verbose is true", () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => messages.push(msg);

  try {
    const options: OutputOptions = { verbose: true, quiet: true };
    verboseLog("test message", options);
    assertEquals(messages, []);
  } finally {
    console.error = originalError;
  }
});
