import { type AppContext, getGlobalContext } from "../context/index.ts";
import { errorLog, verboseLog, type OutputOptions } from "../utils/output.ts";

type ShellName = "bash" | "zsh" | "fish" | "nushell" | "powershell";

interface ShellSetupOptions extends OutputOptions {
  shell?: string;
}

/**
 * Detect shell name from a path or name string.
 *
 * Extracts the basename from a path (e.g. "/bin/zsh" → "zsh") and
 * maps it to a supported shell name.
 */
function detectShell(shellPath: string): ShellName | undefined {
  const basename = shellPath.split("/").pop() ?? "";
  const normalizedName = basename.toLowerCase();

  const shellMap: Record<string, ShellName> = {
    bash: "bash",
    zsh: "zsh",
    fish: "fish",
    nu: "nushell",
    nushell: "nushell",
    pwsh: "powershell",
    powershell: "powershell",
  };

  return shellMap[normalizedName];
}

/**
 * Get the shell wrapper function definition for the given shell.
 */
function getShellFunction(shell: ShellName): string {
  switch (shell) {
    case "bash":
    case "zsh":
      return `vibe() { eval "$(command vibe "$@")"; }`;
    case "fish":
      return "function vibe; eval (command vibe $argv); end";
    case "nushell":
      return "def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }";
    case "powershell":
      return "function vibe { Invoke-Expression (& vibe.exe $args) }";
  }
}

/**
 * Output a shell wrapper function definition to stdout.
 *
 * Detects the current shell from $SHELL or the --shell flag and
 * prints the appropriate function definition that can be eval'd.
 */
export async function shellSetupCommand(
  options: ShellSetupOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const { verbose = false, quiet = false, shell: shellOverride } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  const shellEnv = shellOverride ?? runtime.env.get("SHELL") ?? "";
  const shellName = detectShell(shellEnv);

  const isUnknownShell = !shellName;
  if (isUnknownShell) {
    errorLog(
      `Error: Could not detect shell. Set $SHELL or use --shell <bash|zsh|fish|nushell|powershell>.`,
      outputOpts,
    );
    runtime.control.exit(1);
    return;
  }

  verboseLog(`Detected shell: ${shellName}`, outputOpts);
  console.log(getShellFunction(shellName));
}
