import path from "node:path";

const PROTECTED_DIRECTORIES = new Set([".git", ".windsurf", ".devin", ".deepwork", ".ssh", ".aws", ".gnupg"]);
const PROTECTED_FILES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519"
]);

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "").toLowerCase();
}

export function protectedPathReason(relativePath) {
  const normalized = normalize(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => PROTECTED_DIRECTORIES.has(segment))) {
    return "path is inside a protected control or credential directory";
  }
  const name = segments.at(-1) || "";
  if (PROTECTED_FILES.has(name) || name.startsWith(".env.")) {
    return "path may contain credentials or environment secrets";
  }
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name)) {
    return "path has a private-key or credential file extension";
  }
  if (/^(?:secret|secrets|credential|credentials)(?:\.|$)/i.test(name)) {
    return "path is named like a secrets or credentials file";
  }
  return null;
}

export function isAgentControlPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").toLowerCase();
  return /(?:^|\/)\.(?:windsurf|devin)(?:\/|$)/.test(normalized)
    || /(?:windsurf|devin).*(?:mcp|hook|rule)|(?:mcp|hook|rule).*(?:windsurf|devin)/.test(normalized);
}
