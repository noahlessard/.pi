import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "path";

export default function (pi: ExtensionAPI) {
  const root = process.cwd();

  function isAllowed(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  pi.on("tool_call", async (event, _ctx) => {
    // Whitelist bash to read-only commands only
    if (event.toolName === "bash") {
      const command = (event.input.command as string ?? "").trim();

      // Block chaining and piping
      if (/[;&|`]|\$\(/.test(command)) {
        return { block: true, reason: "Command chaining and piping is not allowed." };
      }

      const allowed = [/^ls(\s|$)/, /^grep(\s|$)/, /^find(\s|$)/, /^cat(\s|$)/];
      if (!allowed.some(p => p.test(command))) {
        return { block: true, reason: "Only ls, grep, find, and cat are allowed in bash." };
      }
    }

    // Restrict file tools to cwd and subdirs
    const restrictedTools = ["read", "write", "edit", "grep", "find", "ls"];
    if (restrictedTools.includes(event.toolName)) {
      const filePath = (event.input.path ?? event.input.pattern ?? event.input.directory) as string | undefined;
      if (filePath && !isAllowed(filePath)) {
        return { block: true, reason: `Access denied: ${filePath} is outside the allowed directory` };
      }
    }
  });
}