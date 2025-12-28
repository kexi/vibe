import { assertEquals } from "@std/assert";
import { addTrustedPath, isTrusted, loadUserSettings, removeTrustedPath } from "./settings.ts";

Deno.test("loadUserSettings returns default settings when file not exists", async () => {
  const settings = await loadUserSettings();
  assertEquals(settings.permissions.allow, []);
  assertEquals(settings.permissions.deny, []);
});

Deno.test("addTrustedPath and isTrusted work correctly", async () => {
  const testPath = "/test/repo/.vibe.toml";

  // 初期状態では信頼されていない
  const beforeTrust = await isTrusted(testPath);
  assertEquals(beforeTrust, false);

  // 信頼を追加
  await addTrustedPath(testPath);

  // 信頼されている
  const afterTrust = await isTrusted(testPath);
  assertEquals(afterTrust, true);

  // クリーンアップ
  await removeTrustedPath(testPath);
});

Deno.test("removeTrustedPath removes path from allow list", async () => {
  const testPath = "/test/repo2/.vibe.toml";

  // 信頼を追加
  await addTrustedPath(testPath);
  const afterAdd = await isTrusted(testPath);
  assertEquals(afterAdd, true);

  // 信頼を削除
  await removeTrustedPath(testPath);
  const afterRemove = await isTrusted(testPath);
  assertEquals(afterRemove, false);
});

Deno.test("addTrustedPath does not duplicate paths", async () => {
  const testPath = "/test/repo3/.vibe.toml";

  // 2回追加
  await addTrustedPath(testPath);
  await addTrustedPath(testPath);

  const settings = await loadUserSettings();
  const count = settings.permissions.allow.filter((p) => p === testPath).length;
  assertEquals(count, 1);

  // クリーンアップ
  await removeTrustedPath(testPath);
});
