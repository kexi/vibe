/**
 * プロンプト関数のテスト
 *
 * 注意: これらのテストは標準入力のモック化が必要なため、
 * 実際のテストケースは手動テストで確認します。
 * ここでは関数が正しくエクスポートされているかのみを確認します。
 */

import { confirm, select } from "./prompt.ts";
import { assertEquals } from "@std/assert";

Deno.test("confirm function is exported", () => {
  const isConfirmFunction = typeof confirm === "function";
  assertEquals(isConfirmFunction, true);
});

Deno.test("select function is exported", () => {
  const isSelectFunction = typeof select === "function";
  assertEquals(isSelectFunction, true);
});
