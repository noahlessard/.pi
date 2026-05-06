/**
 * Sandbox Extension - Filesystem integrity guard
 *
 * Purpose: Prevent any tool or bash command from modifying files outside the
 * directory in which `pi` was started. Read access and any operation within
 * the allowed directory are unrestricted.
 *
 * Mechanisms:
 *   1. Bash `spawnHook` forces the shell cwd to the allowed directory,
 *      neutralising `cd`/`pushd` tricks at the OS level.
 *   2. `tool_call` interceptor:
 *      a. Blocks all pipe/substitution operators entirely (|, ;, &, `, $()).
 *      b. Parses bash commands for write-side operators (>, >>, tee, cp, mv,
 *         dd, etc.) and blocks targets outside the allowed directory.
 *      c. Blocks destructive commands (rm, rmdir, chmod, chown, touch, etc.)
 *         targeting paths outside the allowed directory.
 *      d. Blocks interpreter invocations (python, node, perl, ruby, etc.)
 *         that could be used to write outside the allowed directory via code.
 *   3. File tools (write, edit) resolve paths through symlinks
 *      (`realpathSync` for existing paths, parent-resolved for new files)
 *      and reject anything outside the allowed directory.
 *
 * Sneaky tricks covered:
 *   - Prefix collisions: `/home/user` never matches `/home/user2`
 *   - Symlink escapes: resolved via `realpathSync` before the check;
 *     for new (not-yet-existing) files the parent directory is resolved
 *     so a dangling symlink parent cannot redirect writes outside root.
 *   - Quoted / variable paths: quotes stripped, shell vars removed
 *   - Destructive commands: rm, rmdir, chmod, chown, touch, truncate, shred
 *   - Interpreter-based writes: python, node, perl, ruby, php, bash -c, sh -c
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import * as path from "path";
import * as fs from "fs";

export default function (pi: ExtensionAPI) {
  const root = path.resolve(process.cwd());

  /**
   * Resolve a path to its canonical (symlink-resolved) form.
   *
   * For existing paths, realpathSync is used directly.
   * For not-yet-existing paths, the parent directory is resolved so that a
   * dangling symlink acting as a parent directory cannot redirect a new-file
   * write to a location outside the allowed root.
   */
  function resolvePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    try {
      if (fs.existsSync(resolved)) {
        return fs.realpathSync(resolved);
      }
      // File doesn't exist yet — resolve the parent so symlink parents
      // are caught, then re-join the final filename component.
      const parent = path.dirname(resolved);
      const realParent = fs.existsSync(parent)
        ? fs.realpathSync(parent)
        : parent;
      return path.join(realParent, path.basename(resolved));
    } catch {
      return resolved;
    }
  }

  /**
   * Check if a path is strictly within the allowed directory.
   * Uses === or startsWith(root + sep) to prevent prefix collisions
   * (e.g., /home/user should NOT match /home/user2).
   */
  function isAllowed(filePath: string): boolean {
    const resolved = resolvePath(filePath);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  /** Strip surrounding quotes and shell variable references from a token. */
  function cleanToken(token: string): string {
    return token
      .replace(/^["']|["']$/g, "")
      .replace(/\$\{[^}]*\}/g, "")
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "")
      .trim();
  }

  /**
   * Interpreters that can perform arbitrary filesystem writes via inline code
   * or script arguments. Any invocation of these is blocked outright because
   * it is not feasible to statically analyse the code they are given.
   */
  const INTERPRETER_RE =
    /\b(python3?|node|nodejs|perl|ruby|php|bash|sh|zsh|fish|dash|ksh|tclsh|lua|Rscript)\s+(-[a-zA-Z]*c\s*|[^-])/;

  /**
   * Parse a bash command string and return a block reason if any write
   * operation targeting a path outside the allowed directory is detected,
   * or if a dangerous command is used.
   *
   * NOTE: Pipe operators (|, ;, &, `) and command substitution ($()) are
   * already rejected by the caller before this function is reached, so
   * there is no need to split on && / || here — those operators cannot
   * appear in the command string at this point.
   */
  function checkBashCommand(command: string): string | undefined {
    const trimmed = command.trim();

    // Block directory-changing commands entirely
    if (/\b(cd|pushd|popd|chdir)\b/.test(trimmed)) {
      return "Directory change commands are not allowed.";
    }

    // Block interpreter invocations (python, node, perl, etc.) that could
    // write anywhere via inline code or arbitrary script paths.
    if (INTERPRETER_RE.test(trimmed)) {
      return (
        "Interpreter invocations (python, node, perl, ruby, etc.) are not " +
        "allowed because they can perform unchecked filesystem writes."
      );
    }

    // --- Destructive / metadata-modifying commands ---

    // rm / rmdir
    const rmMatch = trimmed.match(/\b(rm|rmdir)\s+(-[a-zA-Z]+\s+)*([^ ]+)/);
    if (rmMatch) {
      const target = cleanToken(rmMatch[3]);
      if (target && !isAllowed(target)) {
        return `${rmMatch[1]} of "${target}" is outside the allowed directory.`;
      }
    }

    // chmod
    const chmodMatch = trimmed.match(/\bchmod\s+(-[a-zA-Z]+\s+)?[^ ]+\s+([^ ]+)/);
    if (chmodMatch) {
      const target = cleanToken(chmodMatch[2]);
      if (target && !isAllowed(target)) {
        return `chmod of "${target}" is outside the allowed directory.`;
      }
    }

    // chown / chgrp
    const chownMatch = trimmed.match(/\b(chown|chgrp)\s+(-[a-zA-Z]+\s+)?\S+\s+([^ ]+)/);
    if (chownMatch) {
      const target = cleanToken(chownMatch[3]);
      if (target && !isAllowed(target)) {
        return `${chownMatch[1]} of "${target}" is outside the allowed directory.`;
      }
    }

    // touch
    const touchMatch = trimmed.match(/\btouch\s+(-[a-zA-Z]+\s+)?([^ ]+)/);
    if (touchMatch) {
      const target = cleanToken(touchMatch[2]);
      if (target && !isAllowed(target)) {
        return `touch of "${target}" is outside the allowed directory.`;
      }
    }

    // shred
    const shredMatch = trimmed.match(/\bshred\s+(-[a-zA-Z]+\s+)?([^ ]+)/);
    if (shredMatch) {
      const target = cleanToken(shredMatch[2]);
      if (target && !isAllowed(target)) {
        return `shred of "${target}" is outside the allowed directory.`;
      }
    }

    // mkdir (prevent creating directories outside root)
    const mkdirMatch = trimmed.match(/\bmkdir\s+(-[a-zA-Z]+\s+)?([^ ]+)/);
    if (mkdirMatch) {
      const target = cleanToken(mkdirMatch[2]);
      if (target && !isAllowed(target)) {
        return `mkdir of "${target}" is outside the allowed directory.`;
      }
    }

    // --- Write operations ---

    // Output redirections: > and >>
    const redirectMatches = trimmed.matchAll(/>>?\s*(\S+)/g);
    for (const match of redirectMatches) {
      const target = cleanToken(match[1]);
      if (target && !isAllowed(target)) {
        return `Write to "${target}" is outside the allowed directory.`;
      }
    }

    // tee (direct invocation only — piped form is already blocked above)
    const teeMatch = trimmed.match(/\btee\s+(-[a-zA-Z]+\s+)?([^ ]+)/);
    if (teeMatch) {
      const filename = cleanToken(teeMatch[2]);
      if (filename && !isAllowed(filename)) {
        return `Write via tee to "${filename}" is outside the allowed directory.`;
      }
    }

    // cp
    const cpMatch = trimmed.match(/\bcp\s+(-[a-zA-Z]+\s+)?([^ ]+)\s+([^ ]+)/);
    if (cpMatch) {
      const dest = cleanToken(cpMatch[3]);
      if (dest && !isAllowed(dest)) {
        return `Copy to "${dest}" is outside the allowed directory.`;
      }
    }

    // mv
    const mvMatch = trimmed.match(/\bmv\s+(-[a-zA-Z]+\s+)?([^ ]+)\s+([^ ]+)/);
    if (mvMatch) {
      const dest = cleanToken(mvMatch[3]);
      if (dest && !isAllowed(dest)) {
        return `Move to "${dest}" is outside the allowed directory.`;
      }
    }

    // dd
    const ddMatch = trimmed.match(/\bdd\b.*\bof=(\S+)/);
    if (ddMatch) {
      const target = cleanToken(ddMatch[1]);
      if (target && !isAllowed(target)) {
        return `Write via dd to "${target}" is outside the allowed directory.`;
      }
    }

    // truncate
    const truncateMatch = trimmed.match(/\btruncate\s+(-[a-zA-Z]+\s+)?([^ ]+)/);
    if (truncateMatch) {
      const target = cleanToken(truncateMatch[2]);
      if (target && !isAllowed(target)) {
        return `Truncate of "${target}" is outside the allowed directory.`;
      }
    }

    // install
    const installMatch = trimmed.match(/\binstall\s+(-[a-zA-Z]+\s+)?([^ ]+)\s+([^ ]+)/);
    if (installMatch) {
      const dest = cleanToken(installMatch[3]);
      if (dest && !isAllowed(dest)) {
        return `Install to "${dest}" is outside the allowed directory.`;
      }
    }

    // rsync
    const rsyncMatch = trimmed.match(/\brsync\s+(-[a-zA-Z]+\s+)?([^ ]+)\s+([^ ]+)/);
    if (rsyncMatch) {
      const dest = cleanToken(rsyncMatch[3]);
      if (dest && !isAllowed(dest)) {
        return `Rsync to "${dest}" is outside the allowed directory.`;
      }
    }

    // ln (symlink creation — check both source and target)
    const lnMatch = trimmed.match(/\bln\s+(-[a-zA-Z]+\s+)?([^ ]+)\s+([^ ]+)/);
    if (lnMatch) {
      const source = cleanToken(lnMatch[2]);
      const target = cleanToken(lnMatch[3]);
      if ((source && !isAllowed(source)) || (target && !isAllowed(target))) {
        return "Symlink operation involving paths outside the allowed directory.";
      }
    }

    // mkfifo
    const mkfifoMatch = trimmed.match(/\bmkfifo\s+(-[a-zA-Z]+\s+)?([^ ]+)/);
    if (mkfifoMatch) {
      const target = cleanToken(mkfifoMatch[2]);
      if (target && !isAllowed(target)) {
        return `mkfifo of "${target}" is outside the allowed directory.`;
      }
    }

    return undefined; // No issues found
  }

  // Create a bash tool with spawnHook to enforce working directory
  const bashTool = createBashTool(root, {
    spawnHook: ({ command, cwd: _cwd, env }) => ({
      command,
      cwd: root,
      env,
    }),
  });

  pi.registerTool({
    ...bashTool,
    label: "bash (sandboxed)",
  });

  pi.on("tool_call", async (event, _ctx) => {
    // --- Bash command validation ---
    if (event.toolName === "bash") {
      const command = (event.input.command as string ?? "").trim();

      // Block piping and command substitution entirely. This must come first
      // so that checkBashCommand can safely assume no chaining operators are
      // present (making the &&/|| segment-splitting logic unnecessary).
      if (/[;&|`]|\$\(/.test(command)) {
        return { block: true, reason: "Command piping and substitution are not allowed." };
      }

      const blockReason = checkBashCommand(command);
      if (blockReason) {
        return { block: true, reason: blockReason };
      }
    }

    // --- File tool path validation ---
    const fileTools = ["write", "edit"];
    if (fileTools.includes(event.toolName)) {
      const filePath = event.input.path as string | undefined;
      if (filePath && !isAllowed(filePath)) {
        return { block: true, reason: `Access denied: ${filePath} is outside the allowed directory` };
      }
    }
  });
}