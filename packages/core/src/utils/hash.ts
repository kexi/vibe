import { type AppContext, getGlobalContext } from "../context/index.ts";

/**
 * Calculate SHA-256 hash from file content
 * @param content File content as Uint8Array or BufferSource
 * @returns Hash value (hex format, 64 characters)
 */
export async function calculateHashFromContent(
  content: Uint8Array | BufferSource,
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content as BufferSource);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

/**
 * Calculate SHA-256 hash of a file
 * @param filePath File path
 * @param ctx Application context
 * @returns Hash value (hex format, 64 characters)
 */
export async function calculateFileHash(
  filePath: string,
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  const fileContent = await ctx.runtime.fs.readFile(filePath);
  return await calculateHashFromContent(fileContent);
}

/**
 * Verify if file hash matches expected hash
 * @param filePath File path
 * @param expectedHash Expected hash value
 * @param ctx Application context
 * @returns true if hash matches
 * @throws Error if file cannot be read
 */
export async function verifyFileHash(
  filePath: string,
  expectedHash: string,
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  const actualHash = await calculateFileHash(filePath, ctx);
  return actualHash === expectedHash;
}
