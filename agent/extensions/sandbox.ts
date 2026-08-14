/**
 * Sandbox Extension - Filesystem integrity guard
 *
 * Purpose: Prevent any tool or bash command from modifying files outside the
 * directory in which `pi` was started. Read access and any operation within
 * the allowed directory are unrestricted.
 *
 * Works with ssh.ts by intercepting tool calls before remote path mapping,
 * so the same root-directory constraint applies to both local and remote
 * operations.
 */

import { resolve, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const SANDBOX_ROOT = process.cwd();

/**
 * Check whether an absolute path lives inside the allowed root directory.
 * Uses string comparison on resolved paths so that symlink escapes are
 * caught (realpath is resolved by the caller or the underlying tool).
 */
function isOutsideRoot(absolutePath: string): boolean {
  // Allow writes to /dev/null — it's a device sink, not a real file
  if (absolutePath === "/dev/null") return false;

  const normalized = absolutePath.endsWith("/") ? absolutePath.slice(0, -1) : absolutePath;
  const root = SANDBOX_ROOT.endsWith("/") ? SANDBOX_ROOT.slice(0, -1) : SANDBOX_ROOT;
  return normalized !== root && !normalized.startsWith(root + "/");
}

/**
 * Resolve a relative path argument to an absolute path for sandbox checks.
 */
function resolvePath(pathArg: string): string {
  return isAbsolute(pathArg) ? pathArg : resolve(SANDBOX_ROOT, pathArg);
}

// ---------------------------------------------------------------------------
// Bash command analysis helpers
// ---------------------------------------------------------------------------

/**
 * Extract file paths that a bash command might write to or modify.
 * Covers redirections and common file-targeting commands.
 */
function extractBashTargetPaths(command: string): string[] {
  const paths: string[] = [];

  // Redirections: > path  or  >> path
  const redirectRegex = />>?\s*([^;\s|&]+)/g;
  let m;
  while ((m = redirectRegex.exec(command)) !== null) {
    paths.push(m[1]);
  }

  // tee [options] file...
  const teeMatch = command.match(/(?:^|\s|;)tee\s+(?:-[a-zA-Z]+\s+)*([^;\s|&]+)/g);
  if (teeMatch) {
    for (const match of teeMatch) {
      const path = match.replace(/(?:^|\s|;)tee\s+(?:-[a-zA-Z]+\s+)*/, "");
      paths.push(path);
    }
  }

  // Commands that take file path arguments: cp, mv, install, cpio, patch
  const fileCmds = ["cp", "mv", "install", "cpio", "patch"];
  for (const cmd of fileCmds) {
    const re = new RegExp(`(?:^|\\s|;)${cmd}\\s+([^\\n;|&]+)`, "g");
    let cmdMatch;
    while ((cmdMatch = re.exec(command)) !== null) {
      const args = cmdMatch[1].split(/\s+/);
      // Skip flags (start with -)
      for (const arg of args) {
        if (!arg.startsWith("-") && arg.length > 0) {
          paths.push(arg);
        }
      }
    }
  }

  return paths;
}

/**
 * Check if the command starts with a destructive command (rm, chmod, chown,
 * touch, shred, etc.). Returns the list of path arguments found.
 */
function extractDestructiveArgs(command: string): string[] | null {
  const destructiveCmds = ["rm", "chmod", "chown", "touch", "shred"];
  for (const cmd of destructiveCmds) {
    const re = new RegExp(`(?:^|\\s|;)${cmd}\\s+([^\\n;|&]+)`);
    const match = command.match(re);
    if (match) {
      const args = match[1].split(/\s+/);
      return args.filter((a) => !a.startsWith("-"));
    }
  }
  return null;
}

/**
 * Check if the command is a blocked interpreter invocation.
 */
function isBlockedInterpreter(command: string): boolean {
  const blocked = ["python", "python3", "node", "perl", "ruby", "php"];
  const trimmed = command.trimStart();
  return blocked.some(
    (interp) => trimmed === interp || trimmed.startsWith(interp + " ") || trimmed.startsWith(interp + "\t"),
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const RELATIVE_PATH_INSTRUCTION = `
## CRITICAL: Path Rules

You are in a sandbox. You MUST use RELATIVE paths for all file operations. NEVER use absolute paths.

- Use "file.txt" NOT "/root/dir/file.txt"
- Use "src/main.cpp" NOT "/root/dir/src/main.cpp"
- Use "./dir/file" NOT "/root/dir/dir/file"

The current working directory IS the sandbox root. All paths resolve from here.
If you use an absolute path, the write will be blocked.`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    return {
      systemPrompt: event.systemPrompt + RELATIVE_PATH_INSTRUCTION,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    // --- write tool: block writes outside root ---
    if (isToolCallEventType("write", event)) {
      const abs = resolvePath(event.input.path);
      if (isOutsideRoot(abs)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked write outside sandbox: ${event.input.path}`, "warning");
        }
        return {
          block: true,
          reason: `Path "${event.input.path}" is outside the sandbox root. You must use a RELATIVE path (e.g. "src/file.txt" not "/root/dir/src/file.txt").`,
        };
      }
    }

    // --- edit tool: block edits outside root ---
    if (isToolCallEventType("edit", event)) {
      const abs = resolvePath(event.input.path);
      if (isOutsideRoot(abs)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked edit outside sandbox: ${event.input.path}`, "warning");
        }
        return {
          block: true,
          reason: `Path "${event.input.path}" is outside the sandbox root. You must use a RELATIVE path (e.g. "src/file.txt" not "/root/dir/src/file.txt").`,
        };
      }
    }

    // --- bash tool: check for writes outside root and destructive commands ---
    if (isToolCallEventType("bash", event)) {
      // Blocked interpreters
      if (isBlockedInterpreter(event.input.command)) {
        if (ctx.hasUI) {
          ctx.ui.notify("Blocked interpreter command in sandbox", "warning");
        }
        return { block: true, reason: "Interpreter commands are blocked in the sandbox" };
      }

      // File write targets (redirections, cp, mv, tee, etc.)
      const writeTargets = extractBashTargetPaths(event.input.command);
      const outsideWrite = writeTargets.find((p) => isOutsideRoot(resolvePath(p)));
      if (outsideWrite) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked write outside sandbox: ${outsideWrite}`, "warning");
        }
        return {
          block: true,
          reason: `Path "${outsideWrite}" is outside the sandbox root. You must use a RELATIVE path.`,
        };
      }

      // Destructive commands (rm, chmod, chown, touch, shred) targeting outside
      const destructiveArgs = extractDestructiveArgs(event.input.command);
      if (destructiveArgs) {
        const outsideDestructive = destructiveArgs.find((p) => isOutsideRoot(resolvePath(p)));
        if (outsideDestructive) {
          if (ctx.hasUI) {
            ctx.ui.notify(`Blocked destructive command outside sandbox: ${outsideDestructive}`, "warning");
          }
          return {
            block: true,
            reason: `Path "${outsideDestructive}" is outside the sandbox root. You must use a RELATIVE path.`,
          };
        }
      }
    }
  });
}
