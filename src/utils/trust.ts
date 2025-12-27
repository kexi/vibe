import { dirname, join } from "@std/path";

const CONFIG_DIR = join(Deno.env.get("HOME") ?? "", ".config", "vibe");
const TRUSTED_FILE = join(CONFIG_DIR, "trusted");

export async function ensureConfigDir(): Promise<void> {
  try {
    await Deno.mkdir(CONFIG_DIR, { recursive: true });
  } catch (error) {
    const isAlreadyExists = error instanceof Deno.errors.AlreadyExists;
    if (!isAlreadyExists) {
      throw error;
    }
  }
}

export async function getTrustedPaths(): Promise<Set<string>> {
  try {
    const content = await Deno.readTextFile(TRUSTED_FILE);
    const paths = content.split("\n").filter((line) => line.trim() !== "");
    return new Set(paths);
  } catch {
    return new Set();
  }
}

export async function addTrustedPath(path: string): Promise<void> {
  await ensureConfigDir();
  const trusted = await getTrustedPaths();
  trusted.add(path);
  await Deno.writeTextFile(TRUSTED_FILE, [...trusted].join("\n") + "\n");
}

export async function isTrusted(vibeFilePath: string): Promise<boolean> {
  const trusted = await getTrustedPaths();
  return trusted.has(vibeFilePath);
}
