import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalWorkspaceRoot, isWithin } from "./security/path-guard.js";
import { DeepworkError, invariant } from "./errors.js";

const CONTROL_DIRECTORIES = Object.freeze([".deepwork", ".deepwork-test-state", ".git"]);
const GENERATED_DIRECTORIES = Object.freeze([
  ".gradle",
  ".mypy_cache",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv"
]);

export const FINGERPRINT_EXCLUDED_DIRECTORIES = Object.freeze([
  ...CONTROL_DIRECTORIES,
  ...GENERATED_DIRECTORIES
]);

export const FINGERPRINT_BOUNDS = Object.freeze({
  maxEntries: 100_000,
  maxFiles: 50_000,
  maxLinks: 2_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxGitOutputBytes: 32 * 1024 * 1024
});

const EXCLUDED = new Set(FINGERPRINT_EXCLUDED_DIRECTORIES.map((value) => value.toLowerCase()));

function comparable(value) {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function relativePath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}

function hashValue(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedOptions(options) {
  const merged = { ...FINGERPRINT_BOUNDS, ...options };
  for (const [name, value] of Object.entries(merged)) {
    invariant(Number.isSafeInteger(value) && value > 0, "INVALID_FINGERPRINT_BOUNDS", `${name} must be a positive safe integer`);
  }
  return merged;
}

function assertWithinBounds(condition, message) {
  invariant(condition, "FINGERPRINT_LIMIT", message);
}

function sameStableStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function contentDigest(absolute, expectedSize) {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(absolute)) {
      bytes += chunk.length;
      invariant(bytes <= expectedSize, "FINGERPRINT_UNSTABLE", `File grew while fingerprinting: ${absolute}`);
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof DeepworkError) throw error;
    throw new DeepworkError("FINGERPRINT_INCOMPLETE", `Could not read a workspace file while fingerprinting: ${absolute}`);
  }
  invariant(bytes === expectedSize, "FINGERPRINT_UNSTABLE", `File changed size while fingerprinting: ${absolute}`);
  return hash.digest("hex");
}

function pathUsesExcludedDirectory(relative) {
  return relative.split("/").some((segment) => EXCLUDED.has(segment.toLowerCase()));
}

async function scanWorkspaceTree(root, bounds) {
  const aggregate = createHash("sha256");
  const linkAggregate = createHash("sha256");
  const counts = { entries: 0, files: 0, directories: 0, links: 0, bytes: 0 };

  async function addRecord(record) {
    aggregate.update(`${JSON.stringify(record)}\n`);
  }

  async function walk(directory, initialStat) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      throw new DeepworkError("FINGERPRINT_INCOMPLETE", `Could not enumerate workspace directory: ${directory}`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativePath(root, absolute);
      counts.entries += 1;
      assertWithinBounds(counts.entries <= bounds.maxEntries, `Workspace exceeds ${bounds.maxEntries} fingerprint entries`);

      let stat;
      try {
        stat = await fs.lstat(absolute, { bigint: true });
      } catch {
        throw new DeepworkError("FINGERPRINT_INCOMPLETE", `Could not inspect workspace entry: ${relative}`);
      }

      if (stat.isSymbolicLink()) {
        counts.links += 1;
        assertWithinBounds(counts.links <= bounds.maxLinks, `Workspace exceeds ${bounds.maxLinks} links`);
        let target;
        let resolved;
        try {
          target = await fs.readlink(absolute);
          resolved = await fs.realpath(absolute);
        } catch {
          throw new DeepworkError("FINGERPRINT_UNSAFE_LINK", `Refusing unreadable or dangling workspace link: ${relative}`);
        }
        invariant(isWithin(root, resolved), "FINGERPRINT_UNSAFE_LINK", `Workspace link escapes the canonical root: ${relative}`);
        const resolvedRelative = relativePath(root, resolved);
        invariant(!pathUsesExcludedDirectory(resolvedRelative), "FINGERPRINT_UNSAFE_LINK", `Workspace link targets excluded control or generated state: ${relative}`);
        const record = ["link", relative, Number(stat.mode), target, resolvedRelative];
        await addRecord(record);
        linkAggregate.update(`${JSON.stringify(record)}\n`);
        continue;
      }

      if (stat.isDirectory()) {
        if (EXCLUDED.has(entry.name.toLowerCase())) {
          await addRecord(["excluded-directory", relative, Number(stat.mode)]);
          continue;
        }
        let real;
        try {
          real = await fs.realpath(absolute);
        } catch {
          throw new DeepworkError("FINGERPRINT_INCOMPLETE", `Could not resolve workspace directory: ${relative}`);
        }
        invariant(comparable(real) === comparable(absolute), "FINGERPRINT_UNSAFE_LINK", `Workspace directory is redirected by a link or reparse point: ${relative}`);
        counts.directories += 1;
        await addRecord(["directory", relative, Number(stat.mode)]);
        await walk(absolute, stat);
        continue;
      }

      invariant(stat.isFile(), "FINGERPRINT_UNSAFE_ENTRY", `Refusing special workspace entry: ${relative}`);
      invariant(stat.nlink === 1n, "FINGERPRINT_UNSAFE_LINK", `Refusing multiply-linked workspace file: ${relative}`);
      const size = Number(stat.size);
      invariant(Number.isSafeInteger(size), "FINGERPRINT_LIMIT", `Workspace file is too large to fingerprint safely: ${relative}`);
      assertWithinBounds(size <= bounds.maxFileBytes, `Workspace file exceeds the ${bounds.maxFileBytes}-byte per-file fingerprint bound: ${relative}`);
      counts.files += 1;
      counts.bytes += size;
      assertWithinBounds(counts.files <= bounds.maxFiles, `Workspace exceeds ${bounds.maxFiles} fingerprint files`);
      assertWithinBounds(counts.bytes <= bounds.maxTotalBytes, `Workspace exceeds the ${bounds.maxTotalBytes}-byte fingerprint bound`);
      const digest = await contentDigest(absolute, size);
      let after;
      try {
        after = await fs.lstat(absolute, { bigint: true });
      } catch {
        throw new DeepworkError("FINGERPRINT_UNSTABLE", `Workspace file disappeared while fingerprinting: ${relative}`);
      }
      invariant(sameStableStat(stat, after), "FINGERPRINT_UNSTABLE", `Workspace file changed while fingerprinting: ${relative}`);
      await addRecord(["file", relative, Number(stat.mode), size, digest]);
    }
    let directoryAfter;
    try {
      directoryAfter = await fs.lstat(directory, { bigint: true });
    } catch {
      throw new DeepworkError("FINGERPRINT_UNSTABLE", `Workspace directory disappeared while fingerprinting: ${relativePath(root, directory)}`);
    }
    invariant(sameStableStat(initialStat, directoryAfter), "FINGERPRINT_UNSTABLE", `Workspace directory changed while fingerprinting: ${relativePath(root, directory)}`);
  }

  const rootStat = await fs.lstat(root, { bigint: true });
  await walk(root, rootStat);
  return {
    treeDigest: aggregate.digest("hex"),
    linkDigest: linkAggregate.digest("hex"),
    ...counts
  };
}

function runGit(root, args, bounds) {
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-C", root,
    ...args
  ], {
    cwd: root,
    encoding: "buffer",
    windowsHide: true,
    shell: false,
    timeout: 20_000,
    maxBuffer: bounds.maxGitOutputBytes
  });
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    error: result.error || null
  };
}

async function hasGitMarker(root) {
  let cursor = root;
  while (true) {
    try {
      await fs.lstat(path.join(cursor, ".git"));
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new DeepworkError("FINGERPRINT_INCOMPLETE", `Could not inspect Git control state near: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function requireGitResult(result, label) {
  invariant(!result.error, "FINGERPRINT_INCOMPLETE", `Git ${label} failed while fingerprinting: ${result.error?.code || "unknown error"}`);
  invariant(result.status === 0, "FINGERPRINT_INCOMPLETE", `Git ${label} failed while fingerprinting`);
  return result.stdout;
}

async function fingerprintGitState(root, bounds) {
  const markerPresent = await hasGitMarker(root);
  const probe = runGit(root, ["rev-parse", "--show-toplevel"], bounds);
  if (probe.status !== 0 || probe.error) {
    invariant(!markerPresent && probe.error?.code !== "ENOBUFS", "FINGERPRINT_INCOMPLETE", "Git metadata exists but could not be fingerprinted completely");
    return { detected: false, digest: hashValue("not-a-git-worktree") };
  }

  const topLevelText = requireGitResult(probe, "worktree discovery").toString("utf8").trim();
  let canonicalTopLevel;
  try {
    canonicalTopLevel = await fs.realpath(topLevelText);
  } catch {
    throw new DeepworkError("FINGERPRINT_INCOMPLETE", "Git reported a worktree root that could not be resolved");
  }
  invariant(isWithin(canonicalTopLevel, root), "FINGERPRINT_INCOMPLETE", "Workspace root is outside the canonical Git worktree");

  const headResult = runGit(root, ["rev-parse", "--verify", "HEAD"], bounds);
  const head = headResult.status === 0 && !headResult.error
    ? headResult.stdout.toString("utf8").trim()
    : "[unborn]";
  const commands = {
    trackedIndex: ["ls-files", "--stage", "-z", "--", "."],
    worktreeRawDiff: ["diff", "--no-ext-diff", "--raw", "-z", "--", "."],
    indexRawDiff: ["diff", "--cached", "--no-ext-diff", "--raw", "-z", "--", "."],
    status: ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=no", "--", "."]
  };
  const digests = {};
  for (const [name, args] of Object.entries(commands)) {
    digests[`${name}Digest`] = hashValue(requireGitResult(runGit(root, args, bounds), name));
  }
  const metadata = {
    detected: true,
    canonicalTopLevel,
    head,
    ...digests
  };
  return { ...metadata, digest: hashValue(JSON.stringify(metadata)) };
}

export function assertCompleteFingerprint(fingerprint) {
  invariant(fingerprint?.complete === true, "FINGERPRINT_INCOMPLETE", "Workspace fingerprint is missing or incomplete");
  invariant(fingerprint.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(fingerprint.digest || ""), "FINGERPRINT_INCOMPLETE", "Workspace fingerprint digest is invalid");
  invariant(/^[a-f0-9]{64}$/.test(fingerprint.treeDigest || ""), "FINGERPRINT_INCOMPLETE", "Workspace tree fingerprint is invalid");
  invariant(/^[a-f0-9]{64}$/.test(fingerprint.git?.digest || ""), "FINGERPRINT_INCOMPLETE", "Workspace Git fingerprint is invalid");
  return fingerprint;
}

export function fingerprintsEqual(left, right) {
  assertCompleteFingerprint(left);
  assertCompleteFingerprint(right);
  return left.digest === right.digest && left.canonicalRoot === right.canonicalRoot;
}

export async function createWorkspaceFingerprint(rootInput, options = {}) {
  const bounds = boundedOptions(options);
  const canonicalRoot = await canonicalWorkspaceRoot(rootInput);
  const tree = await scanWorkspaceTree(canonicalRoot, bounds);
  const git = await fingerprintGitState(canonicalRoot, bounds);
  const digest = hashValue(JSON.stringify({
    version: 1,
    canonicalRoot: comparable(canonicalRoot),
    treeDigest: tree.treeDigest,
    linkDigest: tree.linkDigest,
    gitDigest: git.digest,
    exclusions: FINGERPRINT_EXCLUDED_DIRECTORIES
  }));
  return assertCompleteFingerprint({
    version: 1,
    complete: true,
    algorithm: "sha256",
    canonicalRoot,
    digest,
    ...tree,
    git,
    excludedDirectories: [...FINGERPRINT_EXCLUDED_DIRECTORIES],
    bounds
  });
}
