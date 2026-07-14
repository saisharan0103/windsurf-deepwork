export { DeepworkEngine, DeepworkError } from "./core.js";
export { createDeepworkServer, startStdioServer, TOOL_NAMES } from "./server.js";
export { handleHook } from "./hooks.js";
export { runDoctor } from "./doctor.js";
export { inspectRepository } from "./inventory.js";
export {
  createWorkspaceFingerprint,
  assertCompleteFingerprint,
  fingerprintsEqual,
  FINGERPRINT_BOUNDS,
  FINGERPRINT_EXCLUDED_DIRECTORIES
} from "./fingerprint.js";
export { canonicalWorkspaceRoot, guardWorkspacePath, isWithin } from "./security/path-guard.js";
export { validateVerificationCommand, classifyHookCommand, tokenizeCommand } from "./security/command-policy.js";
export { RepeatCommandCircuitBreaker, normalizeCommand } from "./security/circuit-breaker.js";
export { protectedPathReason, isAgentControlPath } from "./security/protected-paths.js";
export { normalizeScopePattern, matchesScope, contractPathViolation } from "./security/scope-policy.js";
export { writeTranscriptAudit } from "./audit/transcript-audit.js";
