/**
 * Calculate SHA-256 hash from file content
 * @param content File content as BufferSource
 * @returns Hash value (hex format, 64 characters)
 */
export async function calculateHashFromContent(
  content: BufferSource,
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

/**
 * Calculate SHA-256 hash of a file
 * @param filePath File path
 * @returns Hash value (hex format, 64 characters)
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  const fileContent = await Deno.readFile(filePath);
  return await calculateHashFromContent(fileContent);
}

/**
 * Verify if file hash matches expected hash
 * @param filePath File path
 * @param expectedHash Expected hash value
 * @returns true if hash matches
 * @throws Error if file cannot be read
 */
export async function verifyFileHash(
  filePath: string,
  expectedHash: string,
): Promise<boolean> {
  const actualHash = await calculateFileHash(filePath);
  return actualHash === expectedHash;
}
