/**
 * ファイルのSHA-256ハッシュを計算
 * @param filePath ファイルパス
 * @returns ハッシュ値 (hex形式、64文字)
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  const fileContent = await Deno.readFile(filePath);
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileContent);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

/**
 * ファイルのハッシュが一致するか検証
 * @param filePath ファイルパス
 * @param expectedHash 期待されるハッシュ値
 * @returns 一致すればtrue
 */
export async function verifyFileHash(
  filePath: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const actualHash = await calculateFileHash(filePath);
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}
