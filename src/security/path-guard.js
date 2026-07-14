import fs from "node:fs/promises";
import path from "node:path";
import { DeepworkError, invariant } from "../errors.js";
import { protectedPathReason } from "./protected-paths.js";

function comparable(value) {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertNotLinkOrRedirect(absolutePath) {
  const stat = await fs.lstat(absolutePath);
  invariant(!stat.isSymbolicLink(), "PATH_REPARSE_POINT", `Refusing symlink or junction path: ${absolutePath}`);
  invariant(!(stat.isFile() && stat.nlink > 1), "PATH_HARDLINK", `Refusing multiply-linked file: ${absolutePath}`);
  const real = await fs.realpath(absolutePath);
  invariant(
    comparable(real) === comparable(absolutePath),
    "PATH_REPARSE_POINT",
    `Refusing path redirected through a symlink, junction, or reparse point: ${absolutePath}`
  );
  return stat;
}

async function assertPathChainHasNoLinks(absolutePath) {
  const parsed = path.parse(absolutePath);
  const segments = path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  let stat = await fs.lstat(cursor);
  invariant(!stat.isSymbolicLink(), "PATH_REPARSE_POINT", `Refusing symlink or junction path: ${cursor}`);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    stat = await fs.lstat(cursor);
    invariant(!stat.isSymbolicLink(), "PATH_REPARSE_POINT", `Refusing symlink or junction path: ${cursor}`);
    invariant(!(stat.isFile() && stat.nlink > 1), "PATH_HARDLINK", `Refusing multiply-linked file: ${cursor}`);
  }
  return stat;
}

export async function canonicalWorkspaceRoot(input = process.env.DEEPWORK_WORKSPACE || process.cwd(), base = process.cwd()) {
  invariant(typeof input === "string" && input.trim(), "INVALID_WORKSPACE", "workspaceRoot must be a non-empty path");
  const absolute = path.resolve(base, input);
  try {
    // Windows runners and enterprise profiles may expose a legitimate 8.3
    // alias (for example RUNNER~1) whose realpath is the long directory name.
    // Inspect every path component for links first, then adopt the filesystem's
    // canonical spelling instead of mistaking that alias expansion for a
    // junction redirect.
    await assertPathChainHasNoLinks(absolute);
    const real = await fs.realpath(absolute);
    const canonical = path.resolve(real);
    const canonicalStat = await fs.lstat(canonical);
    invariant(canonicalStat.isDirectory(), "INVALID_WORKSPACE", `Workspace root is not a directory: ${absolute}`);
    return canonical;
  } catch (error) {
    if (error instanceof DeepworkError) throw error;
    throw new DeepworkError("INVALID_WORKSPACE", `Workspace does not exist or cannot be resolved: ${absolute}`);
  }
}

export async function guardWorkspacePath(rootInput, target, options = {}) {
  const { allowProtected = false, mustExist = false } = options;
  const requestedRoot = path.resolve(rootInput);
  const root = await canonicalWorkspaceRoot(requestedRoot);
  invariant(typeof target === "string" && target.trim(), "INVALID_PATH", "A non-empty target path is required");
  const requestedAbsolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(requestedRoot, target);
  let relative;
  if (isWithin(requestedRoot, requestedAbsolute)) relative = path.relative(requestedRoot, requestedAbsolute);
  else if (isWithin(root, requestedAbsolute)) relative = path.relative(root, requestedAbsolute);
  else invariant(false, "PATH_ESCAPE", `Path escapes the workspace: ${target}`);
  const absolute = path.resolve(root, relative);
  invariant(isWithin(root, absolute), "PATH_ESCAPE", `Path escapes the workspace: ${target}`);

  relative = path.relative(root, absolute) || ".";
  if (!allowProtected) {
    const reason = protectedPathReason(relative);
    invariant(!reason, "PROTECTED_PATH", `Refusing protected path ${relative}: ${reason}`);
  }

  const segments = relative === "." ? [] : relative.split(path.sep);
  let cursor = root;
  let foundMissing = false;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (foundMissing) continue;
    try {
      await assertNotLinkOrRedirect(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") {
        foundMissing = true;
        continue;
      }
      throw error;
    }
  }
  invariant(!mustExist || !foundMissing, "PATH_NOT_FOUND", `Path does not exist: ${relative}`);
  return { root, absolute, relative };
}
