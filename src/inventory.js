import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isWithin } from "./security/path-guard.js";
import { redactText } from "./audit/redact.js";

const IGNORED = new Set([".git", ".deepwork", "node_modules", "target", ".next", "dist", "build", ".venv", "venv", "__pycache__"]);
const MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "composer.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml"
]);

function run(command, args, cwd, timeout = 10_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout,
    maxBuffer: 5 * 1024 * 1024
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: redactText(result.stdout || ""),
    stderr: redactText(result.stderr || ""),
    unavailable: result.error?.code === "ENOENT"
  };
}

async function fallbackFileList(root, limit = 10_000) {
  const files = [];
  async function walk(directory) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (IGNORED.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return files;
}

async function listFiles(root) {
  const args = [
    "--files",
    "--hidden",
    "-g", "!.git/**",
    "-g", "!.deepwork/**",
    "-g", "!node_modules/**",
    "-g", "!target/**",
    "-g", "!dist/**",
    "-g", "!build/**",
    "-g", "!.next/**",
    "-g", "!.venv/**"
  ];
  const result = run("rg", args, root);
  if (result.ok) {
    return {
      source: "rg",
      files: result.stdout.split(/\r?\n/).filter(Boolean).map((file) => file.split(path.sep).join("/")).sort()
    };
  }
  return { source: "filesystem-fallback", files: await fallbackFileList(root) };
}

function summarizeExtensions(files) {
  const counts = new Map();
  for (const file of files) {
    const base = path.basename(file);
    const extension = path.extname(base).toLowerCase() || "[no extension]";
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([extension, count]) => ({ extension, count }));
}

async function summarizeManifest(root, relative) {
  const name = path.basename(relative).toLowerCase();
  const result = { path: relative, kind: name };
  if (name === "package.json" || name === "composer.json") {
    try {
      const raw = await fs.readFile(path.join(root, relative), "utf8");
      if (raw.length > 1_000_000) return { ...result, note: "manifest too large to summarize" };
      const parsed = JSON.parse(raw);
      result.name = typeof parsed.name === "string" ? redactText(parsed.name) : undefined;
      result.scripts = Object.keys(parsed.scripts || {}).sort().slice(0, 30);
      result.dependencies = Object.keys(parsed.dependencies || {}).sort().slice(0, 30);
      result.devDependencies = Object.keys(parsed.devDependencies || {}).sort().slice(0, 30);
    } catch {
      result.note = "manifest could not be parsed";
    }
  }
  return result;
}

async function scanLinks(root, limit = 10_000) {
  const links = [];
  let visited = 0;
  let truncated = false;
  async function walk(directory) {
    if (visited >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited++ >= limit) {
        truncated = true;
        break;
      }
      if (IGNORED.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        let target = "[unreadable]";
        let resolved = null;
        try {
          target = await fs.readlink(absolute);
          resolved = await fs.realpath(absolute);
        } catch {}
        links.push({ path: relative, target: redactText(target), escapesWorkspace: resolved ? !isWithin(root, resolved) : null });
        continue;
      }
      if (entry.isDirectory()) await walk(absolute);
    }
  }
  await walk(root);
  return { links: links.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 100), truncated: truncated || links.length > 100 };
}

function gitSummary(root) {
  const inside = run("git", ["-C", root, "rev-parse", "--show-toplevel"], root);
  if (!inside.ok) return { detected: false };
  const branch = run("git", ["-C", root, "branch", "--show-current"], root);
  const status = run("git", ["-C", root, "status", "--short"], root);
  const diff = run("git", ["-C", root, "diff", "--stat", "--", "."], root);
  const changes = status.ok ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
  return {
    detected: true,
    topLevel: inside.stdout.trim(),
    branch: branch.stdout.trim() || null,
    changedCount: changes.length,
    changedFiles: changes.slice(0, 100),
    diffStat: diff.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 30)
  };
}

function gitChangedPaths(root) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], {
    cwd: root,
    encoding: "buffer",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0 || result.error) return { paths: [], complete: false };
  const chunks = result.stdout.toString("utf8").split("\0").filter(Boolean);
  const paths = new Set();
  for (let index = 0; index < chunks.length; index += 1) {
    const entry = chunks[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.add(entry.slice(3).split(path.sep).join("/"));
    if (/[RC]/.test(status) && chunks[index + 1]) paths.add(chunks[++index].split(path.sep).join("/"));
  }
  return { paths: [...paths].sort(), complete: true };
}

export function deriveGitDiffSummary(root) {
  const inside = run("git", ["-C", root, "rev-parse", "--show-toplevel"], root);
  if (!inside.ok) {
    return { detected: false, status: [], unstagedStat: [], stagedStat: [] };
  }
  const status = run("git", ["-C", root, "status", "--short", "--", "."], root);
  const unstaged = run("git", ["-C", root, "diff", "--stat", "--", "."], root);
  const staged = run("git", ["-C", root, "diff", "--cached", "--stat", "--", "."], root);
  const changed = gitChangedPaths(root);
  return {
    detected: true,
    topLevel: inside.stdout.trim(),
    status: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200) : [],
    unstagedStat: unstaged.ok ? unstaged.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100) : [],
    stagedStat: staged.ok ? staged.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100) : [],
    changedPaths: changed.paths,
    scopeComplete: changed.complete,
    truncated: (status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).length : 0) > 200 || !changed.complete
  };
}

export async function inspectRepository(root) {
  const { source, files } = await listFiles(root);
  const manifestPaths = files.filter((file) => MANIFESTS.has(path.basename(file).toLowerCase())).slice(0, 50);
  const manifests = [];
  for (const manifest of manifestPaths) manifests.push(await summarizeManifest(root, manifest));
  const topLevelDirectories = [...new Set(files.filter((file) => file.includes("/")).map((file) => file.split("/")[0]))].sort().slice(0, 50);
  const linkScan = await scanLinks(root);
  return {
    workspaceRoot: root,
    fileInventory: {
      source,
      count: files.length,
      sample: files.slice(0, 120),
      truncated: files.length > 120,
      topLevelDirectories,
      extensions: summarizeExtensions(files)
    },
    manifests,
    git: gitSummary(root),
    links: linkScan
  };
}
