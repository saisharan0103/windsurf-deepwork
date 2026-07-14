import { invariant } from "../errors.js";

export function normalizeCommand(command) {
  invariant(typeof command === "string" && command.trim(), "INVALID_COMMAND", "A non-empty command is required");
  const collapsed = command.trim().replace(/\s+/g, " ");
  return process.platform === "win32" ? collapsed.toLowerCase() : collapsed;
}

export class RepeatCommandCircuitBreaker {
  constructor(limit = 2) {
    invariant(Number.isInteger(limit) && limit > 0, "INVALID_LIMIT", "Circuit-breaker limit must be positive");
    this.limit = limit;
    this.attempts = new Map();
  }

  check(executionId, command) {
    const normalized = normalizeCommand(command);
    const key = `${executionId || "default"}\u0000${normalized}`;
    const previous = this.attempts.get(key) || 0;
    if (previous >= this.limit) {
      return { allowed: false, attempts: previous, normalized };
    }
    const attempts = previous + 1;
    this.attempts.set(key, attempts);
    return { allowed: true, attempts, normalized };
  }

  clear(executionId) {
    const prefix = `${executionId || "default"}\u0000`;
    for (const key of this.attempts.keys()) {
      if (key.startsWith(prefix)) this.attempts.delete(key);
    }
  }
}
