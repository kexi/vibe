/**
 * ユーザーに y/n の確認プロンプトを表示
 * @param message プロンプトメッセージ
 * @returns true=続行、false=中断
 */
export async function confirmPrompt(message: string): Promise<boolean> {
  console.log(`${message} (y/n): `);

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);

  const hasInput = n !== null;
  if (!hasInput) {
    return false;
  }

  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim()
    .toLowerCase();
  const isYes = answer === "y" || answer === "yes";

  return isYes;
}
