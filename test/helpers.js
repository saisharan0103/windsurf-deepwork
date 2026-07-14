import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export async function temporaryWorkspace(t, prefix = "deepwork-test-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return root;
}

export function initializeGitRepository(root) {
  const commands = [
    ["init", "--quiet"],
    ["config", "user.email", "deepwork-test@example.invalid"],
    ["config", "user.name", "Deepwork Test"],
    ["add", "--all"],
    ["commit", "--quiet", "-m", "fixture baseline"]
  ];
  for (const args of commands) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, shell: false });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
}
