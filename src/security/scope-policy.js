import path from "node:path";
import { invariant } from "../errors.js";

export function normalizeScopePattern(value, field = "path") {
  invariant(typeof value === "string" && value.trim(), "INVALID_SCOPE", `${field} must be a non-empty relative path or glob`);
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  invariant(!path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(normalized), "INVALID_SCOPE", `${field} must be relative to the workspace`);
  invariant(!normalized.split("/").includes(".."), "INVALID_SCOPE", `${field} cannot traverse outside the workspace`);
  invariant(!normalized.includes("\0"), "INVALID_SCOPE", `${field} contains an invalid character`);
  return normalized.replace(/\/$/, "");
}

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesScope(relativePath, pattern) {
  let relative = String(relativePath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  let normalizedPattern = normalizeScopePattern(pattern);
  if (process.platform === "win32") {
    relative = relative.toLowerCase();
    normalizedPattern = normalizedPattern.toLowerCase();
  }
  if (!normalizedPattern.includes("*")) {
    return relative === normalizedPattern || relative.startsWith(`${normalizedPattern}/`);
  }
  const marker = "\u0000DOUBLE_STAR\u0000";
  const expression = escapeRegex(normalizedPattern)
    .replaceAll("**", marker)
    .replaceAll("*", "[^/]*")
    .replaceAll(marker, ".*");
  return new RegExp(`^${expression}(?:/.*)?$`).test(relative);
}

export function contractPathViolation(relativePath, contract = {}, options = {}) {
  const { enforceAllowed = true } = options;
  const protectedPaths = contract.protectedPaths || [];
  const allowedPaths = contract.allowedPaths || [];
  if (protectedPaths.some((pattern) => matchesScope(relativePath, pattern))) {
    return `path is protected by the task contract: ${relativePath}`;
  }
  if (enforceAllowed && allowedPaths.length && !allowedPaths.some((pattern) => matchesScope(relativePath, pattern))) {
    return `path is outside the task contract's allowedPaths: ${relativePath}`;
  }
  return null;
}
