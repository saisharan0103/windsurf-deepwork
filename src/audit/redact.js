const SECRET_KEY = /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|cookie|private[_-]?key|client[_-]?secret|credential)/i;

const TEXT_PATTERNS = [
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]"],
  [/\b(?:ghp|github_pat|glpat|xox[baprs])-[_A-Za-z0-9-]{10,}\b/g, "[REDACTED TOKEN]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED ACCESS KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]"],
  [/(\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|cookie|client[_-]?secret|credential)\b\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]"]
];

export function redactText(value) {
  let output = String(value ?? "");
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function sanitizeForAudit(value, options = {}, seen = new WeakSet(), depth = 0) {
  const { maxDepth = 8, maxArray = 100, maxString = 100_000 } = options;
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value.slice(0, maxString));
  }
  if (typeof value !== "object") {
    return redactText(String(value));
  }
  if (depth >= maxDepth) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((item) => sanitizeForAudit(item, options, seen, depth + 1));
  }
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    clean[key] = SECRET_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeForAudit(child, options, seen, depth + 1);
  }
  return clean;
}

export function safeError(error) {
  return {
    code: redactText(error?.code || "DEEPWORK_ERROR"),
    message: redactText(error?.message || "Deepwork operation failed")
  };
}
