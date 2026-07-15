import os from "node:os";
import path from "node:path";
import { canonicalWorkspaceRoot, guardWorkspacePath } from "./security/path-guard.js";
import { WorkspaceStateStore } from "./state/store.js";
import { deriveGitDiffSummary, inspectRepository as buildInventory } from "./inventory.js";
import { runVerificationCommand } from "./verification.js";
import { DeepworkError, invariant } from "./errors.js";
import { contractPathViolation, normalizeScopePattern } from "./security/scope-policy.js";
import { validateVerificationCommand } from "./security/command-policy.js";
import {
  assertCompleteFingerprint,
  createWorkspaceFingerprint,
  fingerprintsEqual
} from "./fingerprint.js";
import { normalizeEffortProfile, requirementsFor, REVIEW_FOCI } from "./effort.js";

function samePath(left, right) {
  const a = process.platform === "win32" ? left.toLowerCase() : left;
  const b = process.platform === "win32" ? right.toLowerCase() : right;
  return a === b;
}

async function runtimeRoots() {
  const candidates = [
    process.env.DEEPWORK_RUNTIME_ROOT,
    path.join(os.homedir(), ".codeium", "windsurf", "deepwork-runtime")
  ].filter(Boolean);
  const roots = [];
  for (const candidate of candidates) {
    try {
      roots.push(await canonicalWorkspaceRoot(candidate, process.cwd()));
    } catch {
      // A missing optional runtime path cannot contain the chosen workspace,
      // but retaining its resolved spelling keeps this protective check
      // conservative if it appears between discovery and comparison.
      roots.push(path.resolve(candidate));
    }
  }
  return roots;
}

async function isInsideRuntime(root) {
  return (await runtimeRoots()).some((runtimeRoot) => {
    const relative = path.relative(runtimeRoot, root);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}

function cleanStrings(values, field) {
  invariant(Array.isArray(values) && values.length > 0, "INVALID_INPUT", `${field} must contain at least one item`);
  const clean = values.map((value) => String(value || "").trim()).filter(Boolean);
  invariant(clean.length === values.length, "INVALID_INPUT", `${field} cannot contain blank items`);
  invariant(new Set(clean).size === clean.length, "INVALID_INPUT", `${field} cannot contain duplicates`);
  return clean;
}

function cleanOptionalStrings(values, field) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length === 0) return [];
  return cleanStrings(values, field);
}

function cleanText(value, field, minimum = 1) {
  const clean = String(value || "").trim();
  invariant(clean.length >= minimum, "INVALID_INPUT", `${field} must contain at least ${minimum} characters`);
  return clean;
}

function taskEffort(state) {
  return normalizeEffortProfile(state.begun?.effortProfile || "standard");
}

export class DeepworkEngine {
  static async create(options = {}) {
    const requested = options.baseRoot || process.env.DEEPWORK_WORKSPACE || process.cwd();
    const baseRoot = await canonicalWorkspaceRoot(requested, process.cwd());
    return new DeepworkEngine(baseRoot);
  }

  constructor(baseRoot) {
    this.baseRoot = baseRoot;
    this.registry = new WorkspaceStateStore(baseRoot);
    this.taskRoots = new Map();
  }

  async resolveChosenRoot(workspaceRoot) {
    return canonicalWorkspaceRoot(workspaceRoot || process.env.DEEPWORK_WORKSPACE || this.baseRoot, this.baseRoot);
  }

  async resolveTask(taskId, explicitRoot = undefined) {
    invariant(typeof taskId === "string" && taskId, "INVALID_TASK_ID", "taskId is required");
    let root;
    if (explicitRoot) {
      root = await this.resolveChosenRoot(explicitRoot);
      const known = this.taskRoots.get(taskId) || await this.registry.findTaskRoot(taskId);
      invariant(!known || samePath(root, known), "WORKSPACE_MISMATCH", "workspaceRoot does not match the task's persisted workspace");
    } else {
      root = this.taskRoots.get(taskId) || await this.registry.findTaskRoot(taskId);
      if (!root) {
        const baseStore = new WorkspaceStateStore(this.baseRoot);
        if (await baseStore.taskExists(taskId)) root = this.baseRoot;
      }
      invariant(root, "TASK_NOT_FOUND", `Unknown task: ${taskId}`);
      root = await canonicalWorkspaceRoot(root);
    }
    const store = new WorkspaceStateStore(root);
    invariant(await store.taskExists(taskId), "TASK_NOT_FOUND", `Unknown task: ${taskId}`);
    this.taskRoots.set(taskId, root);
    return { root, store };
  }

  async taskBegin({
    objective,
    acceptanceCriteria,
    nonGoals,
    constraints,
    allowedPaths,
    protectedPaths,
    assumptions,
    completionCondition,
    effortProfile,
    workspaceRoot,
    taskId
  }) {
    invariant(typeof workspaceRoot === "string" && workspaceRoot.trim(), "INVALID_WORKSPACE", "task_begin requires an explicit workspaceRoot");
    invariant(typeof taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(taskId), "INVALID_TASK_ID", "task_begin requires an explicit safe taskId");
    const root = await this.resolveChosenRoot(workspaceRoot);
    invariant(!(await isInsideRuntime(root)), "INVALID_WORKSPACE", "The installed deepwork runtime cannot be used as the user workspace");
    const store = new WorkspaceStateStore(root);
    invariant(!(await store.taskExists(taskId)), "TASK_EXISTS", `Task already exists: ${taskId}`);
    const cleanObjective = String(objective || "").trim();
    invariant(cleanObjective.length >= 3, "INVALID_INPUT", "objective must be at least 3 characters");
    const criteria = cleanStrings(acceptanceCriteria, "acceptanceCriteria");
    const profile = normalizeEffortProfile(effortProfile || "standard");
    const condition = String(completionCondition || "").trim();
    if (profile !== "standard") {
      invariant(condition.length >= 20, "INVALID_INPUT", "completionCondition must state a measurable end condition for thorough or max effort");
    }
    const contract = {
      nonGoals: cleanOptionalStrings(nonGoals, "nonGoals"),
      constraints: cleanOptionalStrings(constraints, "constraints"),
      allowedPaths: cleanOptionalStrings(allowedPaths, "allowedPaths").map((value) => normalizeScopePattern(value, "allowedPaths")),
      protectedPaths: cleanOptionalStrings(protectedPaths, "protectedPaths").map((value) => normalizeScopePattern(value, "protectedPaths")),
      assumptions: cleanOptionalStrings(assumptions, "assumptions"),
      completionCondition: condition,
      effortProfile: profile
    };
    const baselineGit = deriveGitDiffSummary(root);
    await store.appendTaskEvent(taskId, "TASK_BEGUN", {
      taskId,
      objective: cleanObjective,
      acceptanceCriteria: criteria,
      ...contract,
      baselineGit,
      workspaceRoot: root
    });
    await store.setActiveTask(taskId);
    await this.registry.registerTaskRoot(taskId, root);
    if (!samePath(root, this.baseRoot)) await store.registerTaskRoot(taskId, root);
    this.taskRoots.set(taskId, root);
    return {
      ok: true,
      taskId,
      workspaceRoot: root,
      stage: "begun",
      acceptanceCriteria: criteria,
      contract,
      effortRequirements: requirementsFor(profile)
    };
  }

  async inspectRepository({ taskId, workspaceRoot }) {
    const { root, store } = await this.resolveTask(taskId, workspaceRoot);
    const state = await store.getTaskState(taskId);
    invariant(state.begun, "INVALID_STATE", "task_begin must run before inspection");
    const inventory = await buildInventory(root);
    await store.appendTaskEvent(taskId, "INSPECTION_COMPLETED", { inventory });
    return { ok: true, taskId, inventory };
  }

  async recordResearch({ taskId, lanes, contradictions = [], openQuestions = [] }) {
    const { root, store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    invariant(state.inspection, "INVALID_STATE", "inspect_repository must complete before record_research");
    invariant(Array.isArray(lanes) && lanes.length > 0, "INVALID_INPUT", "lanes must contain at least one research lane");
    const requirements = requirementsFor(taskEffort(state));
    invariant(lanes.length >= requirements.researchLanes, "INSUFFICIENT_EFFORT", `This effort profile requires at least ${requirements.researchLanes} research lanes`);
    const normalized = [];
    for (const [index, lane] of lanes.entries()) {
      const id = cleanText(lane.id || index + 1, `lanes[${index}].id`);
      const focus = cleanText(lane.focus, `lanes[${index}].focus`, 3);
      const findings = cleanStrings(lane.findings, `lanes[${index}].findings`);
      const keyFiles = cleanStrings(lane.keyFiles, `lanes[${index}].keyFiles`)
        .map((value) => normalizeScopePattern(value, `lanes[${index}].keyFiles`));
      for (const keyFile of keyFiles) {
        const violation = contractPathViolation(keyFile, state.contract || {}, { enforceAllowed: false });
        invariant(!violation, "SCOPE_VIOLATION", violation);
        await guardWorkspacePath(root, path.resolve(root, keyFile), { allowProtected: false, mustExist: true });
      }
      normalized.push({ id, focus, findings, keyFiles, unknowns: cleanOptionalStrings(lane.unknowns, `lanes[${index}].unknowns`) });
    }
    invariant(new Set(normalized.map((lane) => lane.id)).size === normalized.length, "INVALID_INPUT", "Research lane ids must be unique");
    invariant(new Set(normalized.map((lane) => lane.focus.toLowerCase())).size === normalized.length, "INVALID_INPUT", "Research lane focuses must be distinct");
    const research = {
      lanes: normalized,
      contradictions: cleanOptionalStrings(contradictions, "contradictions"),
      openQuestions: cleanOptionalStrings(openQuestions, "openQuestions")
    };
    await store.appendTaskEvent(taskId, "RESEARCH_RECORDED", research);
    return { ok: true, taskId, stage: "researched", research, effortRequirements: requirements };
  }

  async recordDesign({
    taskId,
    alternatives,
    selectedId,
    selectionRationale,
    approvalEvidence,
    resolvedQuestions = [],
    unresolvedQuestions = []
  }) {
    const { store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    const requirements = requirementsFor(taskEffort(state));
    invariant(state.inspection, "INVALID_STATE", "inspect_repository must complete before record_design");
    if (requirements.researchLanes > 0) {
      invariant(state.research?.lanes?.length >= requirements.researchLanes, "INVALID_STATE", "Required research lanes must be recorded before design");
    }
    invariant(Array.isArray(alternatives) && alternatives.length > 0, "INVALID_INPUT", "alternatives must contain at least one design");
    invariant(alternatives.length >= requirements.designAlternatives, "INSUFFICIENT_EFFORT", `This effort profile requires at least ${requirements.designAlternatives} design alternatives`);
    const normalized = alternatives.map((alternative, index) => ({
      id: cleanText(alternative.id || index + 1, `alternatives[${index}].id`),
      title: cleanText(alternative.title, `alternatives[${index}].title`, 3),
      summary: cleanText(alternative.summary, `alternatives[${index}].summary`, 10),
      tradeoffs: cleanStrings(alternative.tradeoffs, `alternatives[${index}].tradeoffs`),
      files: cleanOptionalStrings(alternative.files, `alternatives[${index}].files`)
        .map((value) => normalizeScopePattern(value, `alternatives[${index}].files`))
    }));
    invariant(new Set(normalized.map((alternative) => alternative.id)).size === normalized.length, "INVALID_INPUT", "Design alternative ids must be unique");
    const chosen = cleanText(selectedId, "selectedId");
    invariant(normalized.some((alternative) => alternative.id === chosen), "INVALID_INPUT", "selectedId must identify one recorded design alternative");
    const minimumNarrative = taskEffort(state) === "standard" ? 3 : 20;
    const design = {
      alternatives: normalized,
      selectedId: chosen,
      selectionRationale: cleanText(selectionRationale, "selectionRationale", minimumNarrative),
      approvalEvidence: cleanText(approvalEvidence, "approvalEvidence", minimumNarrative),
      resolvedQuestions: cleanOptionalStrings(resolvedQuestions, "resolvedQuestions"),
      unresolvedQuestions: cleanOptionalStrings(unresolvedQuestions, "unresolvedQuestions")
    };
    await store.appendTaskEvent(taskId, "DESIGN_RECORDED", design);
    return { ok: true, taskId, stage: "designed", design, effortRequirements: requirements };
  }

  async recordPlan({
    taskId,
    steps,
    risks = [],
    filesToChange,
    verificationCommands,
    acceptanceMap = [],
    rollbackPlan = ""
  }) {
    const { store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    invariant(state.inspection, "INVALID_STATE", "inspect_repository must complete before record_plan");
    const profile = taskEffort(state);
    const requirements = requirementsFor(profile);
    if (requirements.researchLanes > 0) {
      invariant(state.research?.lanes?.length >= requirements.researchLanes, "INVALID_STATE", "Required research lanes must be recorded before planning");
      invariant(state.design?.alternatives?.length >= requirements.designAlternatives, "INVALID_STATE", "Required design alternatives must be recorded before planning");
      invariant((state.design?.unresolvedQuestions || []).length === 0, "UNRESOLVED_DECISIONS", "Resolve design questions before recording the implementation plan");
    }
    invariant(Array.isArray(steps) && steps.length > 0, "INVALID_INPUT", "steps must contain at least one plan step");
    const normalizedSteps = steps.map((step, index) => ({
      id: String(step.id || index + 1).trim(),
      description: String(step.description || "").trim(),
      status: step.status || "pending"
    }));
    invariant(normalizedSteps.every((step) => step.id && step.description), "INVALID_INPUT", "Every plan step needs an id and description");
    invariant(new Set(normalizedSteps.map((step) => step.id)).size === normalizedSteps.length, "INVALID_INPUT", "Plan step ids must be unique");
    invariant(normalizedSteps.filter((step) => step.status === "in_progress").length <= 1, "INVALID_INPUT", "At most one plan step may be in progress");
    invariant(normalizedSteps.length >= requirements.planSteps, "INSUFFICIENT_EFFORT", `This effort profile requires at least ${requirements.planSteps} concrete plan steps`);
    const normalizedRisks = Array.isArray(risks) ? risks.map((risk) => String(risk).trim()).filter(Boolean) : [];
    invariant(normalizedRisks.length >= requirements.riskItems, "INSUFFICIENT_EFFORT", `This effort profile requires at least ${requirements.riskItems} explicit risk items`);
    invariant(Array.isArray(filesToChange), "INVALID_INPUT", "filesToChange must be an array; use an empty array for review-only work");
    const normalizedFiles = filesToChange.length
      ? cleanStrings(filesToChange, "filesToChange").map((value) => normalizeScopePattern(value, "filesToChange"))
      : [];
    for (const file of normalizedFiles) {
      const violation = contractPathViolation(file, state.begun);
      invariant(!violation, "SCOPE_VIOLATION", violation);
    }
    const normalizedCommands = cleanStrings(verificationCommands, "verificationCommands")
      .map((command) => validateVerificationCommand(command).normalized);
    invariant(new Set(normalizedCommands).size === normalizedCommands.length, "INVALID_INPUT", "verificationCommands cannot contain normalized duplicates");
    const normalizedAcceptanceMap = Array.isArray(acceptanceMap) ? acceptanceMap.map((item, index) => {
      const criterion = cleanText(item.criterion, `acceptanceMap[${index}].criterion`);
      const stepIds = cleanStrings(item.stepIds, `acceptanceMap[${index}].stepIds`);
      invariant(stepIds.every((id) => normalizedSteps.some((step) => step.id === id)), "INVALID_INPUT", `acceptanceMap contains an unknown step id for: ${criterion}`);
      const commands = cleanOptionalStrings(item.verificationCommands, `acceptanceMap[${index}].verificationCommands`)
        .map((command) => validateVerificationCommand(command).normalized);
      invariant(commands.every((command) => normalizedCommands.includes(command)), "INVALID_INPUT", `acceptanceMap contains an unplanned verification command for: ${criterion}`);
      return { criterion, stepIds, verificationCommands: commands };
    }) : [];
    if (profile !== "standard") {
      invariant(normalizedAcceptanceMap.length === state.acceptanceCriteria.length, "INSUFFICIENT_EFFORT", "Map every acceptance criterion to plan steps and verification evidence");
      for (const criterion of state.acceptanceCriteria) {
        invariant(normalizedAcceptanceMap.some((item) => item.criterion === criterion), "INSUFFICIENT_EFFORT", `Acceptance criterion is not mapped: ${criterion}`);
      }
      invariant(new Set(normalizedAcceptanceMap.map((item) => item.criterion)).size === normalizedAcceptanceMap.length, "INVALID_INPUT", "acceptanceMap criteria must be unique");
    }
    const normalizedRollback = String(rollbackPlan || "").trim();
    if (profile !== "standard") {
      invariant(normalizedRollback.length >= 20, "INSUFFICIENT_EFFORT", "Thorough and max plans require a specific rollback or recovery plan");
    }
    await store.appendTaskEvent(taskId, "PLAN_RECORDED", {
      steps: normalizedSteps,
      risks: normalizedRisks,
      filesToChange: normalizedFiles,
      verificationCommands: normalizedCommands,
      acceptanceMap: normalizedAcceptanceMap,
      rollbackPlan: normalizedRollback
    });
    return {
      ok: true,
      taskId,
      stage: "planned",
      steps: normalizedSteps,
      risks: normalizedRisks,
      filesToChange: normalizedFiles,
      verificationCommands: normalizedCommands,
      acceptanceMap: normalizedAcceptanceMap,
      rollbackPlan: normalizedRollback,
      effortRequirements: requirements
    };
  }

  async recordCheckpoint({ taskId, label, summary, completedStepIds, remainingStepIds }) {
    const { root, store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    invariant(state.plan, "INVALID_STATE", "record_plan must complete before record_checkpoint");
    const completed = cleanOptionalStrings(completedStepIds, "completedStepIds");
    const remaining = cleanOptionalStrings(remainingStepIds, "remainingStepIds");
    const planned = state.plan.steps.map((step) => step.id);
    invariant(completed.every((id) => planned.includes(id)), "INVALID_INPUT", "completedStepIds contains an unknown plan step");
    invariant(remaining.every((id) => planned.includes(id)), "INVALID_INPUT", "remainingStepIds contains an unknown plan step");
    invariant(!completed.some((id) => remaining.includes(id)), "INVALID_INPUT", "A plan step cannot be both completed and remaining");
    invariant(new Set([...completed, ...remaining]).size === planned.length && planned.every((id) => completed.includes(id) || remaining.includes(id)), "INVALID_INPUT", "Checkpoint step coverage must include every current plan step exactly once");
    const fingerprint = await createWorkspaceFingerprint(root);
    assertCompleteFingerprint(fingerprint);
    const checkpoint = {
      label: cleanText(label, "label", 3),
      summary: cleanText(summary, "summary", 20),
      completedStepIds: completed,
      remainingStepIds: remaining,
      fingerprint,
      git: deriveGitDiffSummary(root)
    };
    await store.appendTaskEvent(taskId, "CHECKPOINT_RECORDED", checkpoint);
    return { ok: true, taskId, stage: "checkpointed", checkpoint };
  }

  async recordReview({ taskId, reviews, summary }) {
    const { root, store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    invariant(state.plan, "INVALID_STATE", "record_plan must complete before record_review");
    invariant(Array.isArray(reviews) && reviews.length > 0, "INVALID_INPUT", "reviews must contain at least one review pass");
    const requirements = requirementsFor(taskEffort(state));
    const normalized = reviews.map((review, index) => {
      const focus = cleanText(review.focus, `reviews[${index}].focus`).toLowerCase();
      invariant(REVIEW_FOCI.includes(focus), "INVALID_INPUT", `Unknown review focus: ${focus}`);
      const verdict = String(review.verdict || "").trim().toLowerCase();
      invariant(["pass", "issues"].includes(verdict), "INVALID_INPUT", `reviews[${index}].verdict must be pass or issues`);
      const findings = Array.isArray(review.findings) ? review.findings.map((finding, findingIndex) => {
        const severity = String(finding.severity || "").trim().toLowerCase();
        invariant(["critical", "high", "medium", "low", "info"].includes(severity), "INVALID_INPUT", `Invalid finding severity in reviews[${index}]`);
        const confidence = Number(finding.confidence);
        invariant(Number.isInteger(confidence) && confidence >= 80 && confidence <= 100, "LOW_CONFIDENCE_FINDING", "Only findings with confidence from 80 to 100 may enter the evidence ledger");
        const status = String(finding.status || "open").trim().toLowerCase();
        invariant(["open", "resolved", "accepted", "false-positive"].includes(status), "INVALID_INPUT", `Invalid finding status in reviews[${index}]`);
        return {
          severity,
          confidence,
          issue: cleanText(finding.issue, `reviews[${index}].findings[${findingIndex}].issue`, 5),
          evidence: cleanText(finding.evidence, `reviews[${index}].findings[${findingIndex}].evidence`, 5),
          status,
          resolution: String(finding.resolution || "").trim()
        };
      }) : [];
      invariant(verdict === "issues" || findings.length === 0, "INVALID_INPUT", "A passing review cannot contain findings");
      invariant(verdict === "pass" || findings.length > 0, "INVALID_INPUT", "An issues verdict must include at least one high-confidence finding");
      return {
        focus,
        reviewer: cleanText(review.reviewer, `reviews[${index}].reviewer`, 3),
        verdict,
        findings,
        uncertainties: cleanOptionalStrings(review.uncertainties, `reviews[${index}].uncertainties`)
      };
    });
    invariant(new Set(normalized.map((review) => review.focus)).size === normalized.length, "INVALID_INPUT", "Review focuses must be unique within one review record");
    if (requirements.reviewFoci.length > 1) {
      invariant(new Set(normalized.map((review) => review.reviewer.toLowerCase())).size === normalized.length, "INSUFFICIENT_EFFORT", "Required review passes must use distinct reviewer identities or fresh pass labels");
    }
    for (const focus of requirements.reviewFoci) {
      invariant(normalized.some((review) => review.focus === focus), "INSUFFICIENT_EFFORT", `This effort profile requires a ${focus} review pass`);
    }
    const fingerprint = await createWorkspaceFingerprint(root);
    assertCompleteFingerprint(fingerprint);
    const reviewRecord = {
      reviews: normalized,
      summary: cleanText(summary, "summary", 20),
      fingerprint,
      git: deriveGitDiffSummary(root)
    };
    await store.appendTaskEvent(taskId, "REVIEW_RECORDED", reviewRecord);
    return { ok: true, taskId, stage: "reviewed", review: reviewRecord, effortRequirements: requirements };
  }

  async runVerification({ taskId, command, timeoutMs, noTestsEvidence }) {
    const { root, store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    invariant(state.plan, "INVALID_STATE", "record_plan must complete before run_verification");
    const hasCommand = typeof command === "string" && command.trim();
    const hasEvidence = typeof noTestsEvidence === "string" && noTestsEvidence.trim();
    invariant(Boolean(hasCommand) !== Boolean(hasEvidence), "INVALID_INPUT", "Provide exactly one of command or noTestsEvidence");
    if (hasEvidence) {
      const evidence = noTestsEvidence.trim();
      invariant(evidence.length >= 20, "INSUFFICIENT_EVIDENCE", "No-tests evidence must be a specific explanation of at least 20 characters");
      const fingerprintBefore = await createWorkspaceFingerprint(root);
      const fingerprintAfter = await createWorkspaceFingerprint(root);
      invariant(fingerprintsEqual(fingerprintBefore, fingerprintAfter), "FINGERPRINT_UNSTABLE", "Workspace changed while no-tests evidence was recorded");
      await store.appendTaskEvent(taskId, "VERIFICATION_SKIPPED", {
        noTestsEvidence: evidence,
        fingerprintBefore,
        fingerprintAfter
      });
      return { ok: true, taskId, skipped: true, noTestsEvidence: evidence, fingerprint: fingerprintAfter };
    }
    const requestedCommand = command.trim();
    const normalizedCommand = validateVerificationCommand(requestedCommand).normalized;
    invariant(
      state.plan.verificationCommands.includes(normalizedCommand),
      "COMMAND_NOT_PLANNED",
      `Verification command is not in the current plan: ${normalizedCommand}`
    );
    const fingerprintBefore = await createWorkspaceFingerprint(root);
    const commandResult = await runVerificationCommand({ command: requestedCommand, cwd: root, timeoutMs });
    let fingerprintAfter;
    try {
      fingerprintAfter = await createWorkspaceFingerprint(root);
    } catch (error) {
      const result = {
        ...commandResult,
        normalizedCommand,
        commandPassed: commandResult.passed,
        passed: false,
        workspaceMutationDetected: null,
        fingerprintComplete: false,
        fingerprintBefore,
        fingerprintAfter: null,
        fingerprintError: { code: error?.code || "FINGERPRINT_INCOMPLETE", message: error?.message || "Fingerprint failed" }
      };
      await store.appendTaskEvent(taskId, "VERIFICATION_COMPLETED", { result });
      throw error;
    }
    const workspaceMutationDetected = !fingerprintsEqual(fingerprintBefore, fingerprintAfter);
    const result = {
      ...commandResult,
      normalizedCommand,
      commandPassed: commandResult.passed,
      passed: commandResult.passed && !workspaceMutationDetected,
      workspaceMutationDetected,
      fingerprintComplete: true,
      fingerprintBefore,
      fingerprintAfter
    };
    await store.appendTaskEvent(taskId, "VERIFICATION_COMPLETED", { result });
    return { ok: result.passed, taskId, skipped: false, result };
  }

  async taskStatus({ taskId }) {
    const { store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    const requirements = requirementsFor(taskEffort(state));
    const nextActions = [];
    if (!state.inspection) nextActions.push("inspect_repository");
    else if (requirements.researchLanes > 0 && !state.research) nextActions.push("record_research");
    else if (requirements.designAlternatives > 0 && !state.design) nextActions.push("record_design");
    else if (!state.plan) nextActions.push("record_plan");
    else {
      if (state.checkpoints.length < requirements.checkpoints) nextActions.push("record_checkpoint");
      if (requirements.reviewFoci.length && !state.review) nextActions.push("record_review");
      if (!state.verifications.length) nextActions.push("run_verification");
      nextActions.push("final_gate");
    }
    return { ok: true, state, effortProfile: taskEffort(state), effortRequirements: requirements, nextActions: [...new Set(nextActions)] };
  }

  async finalGate({ taskId, acceptanceEvidence, diffSummary }) {
    const { root, store } = await this.resolveTask(taskId);
    const events = await store.readTaskEvents(taskId);
    const state = await store.getTaskState(taskId);
    const failures = [];
    const profile = taskEffort(state);
    const requirements = requirementsFor(profile);
    if (!state.inspection) failures.push("repository inspection is missing");
    if (!state.plan) failures.push("recorded plan is missing");
    if (requirements.researchLanes > 0 && (state.research?.lanes?.length || 0) < requirements.researchLanes) {
      failures.push(`fewer than ${requirements.researchLanes} research lanes were recorded`);
    }
    if (requirements.designAlternatives > 0 && (state.design?.alternatives?.length || 0) < requirements.designAlternatives) {
      failures.push(`fewer than ${requirements.designAlternatives} design alternatives were recorded`);
    }
    if ((state.design?.unresolvedQuestions || []).length) failures.push("design still has unresolved questions");
    const repositoryFileCount = Number(state.inspection?.inventory?.fileInventory?.count || 0);
    const requiredReads = profile === "standard" ? 0 : Math.min(requirements.uniqueReads, repositoryFileCount);
    if (new Set(state.reads || []).size < requiredReads) {
      failures.push(`fewer than ${requiredReads} required unique repository reads were recorded`);
    }

    const summary = String(diffSummary || "").trim();
    if (summary.length < 10) failures.push("diff summary must specifically describe the resulting changes");

    const evidenceItems = Array.isArray(acceptanceEvidence) ? acceptanceEvidence.map((item) => ({
      criterion: String(item.criterion || "").trim(),
      kind: String(item.kind || "").trim(),
      evidence: String(item.evidence || "").trim()
    })) : [];
    for (const criterion of state.acceptanceCriteria) {
      const match = evidenceItems.find((item) => item.criterion === criterion && item.evidence.length >= 3);
      if (!match) failures.push(`acceptance criterion lacks evidence: ${criterion}`);
    }

    const lastWriteIndex = events.findLastIndex((event) => event.type === "HOOK_WRITE");
    const planIndex = events.findLastIndex((event) => event.type === "PLAN_RECORDED");
    const baseline = Math.max(lastWriteIndex, planIndex);
    const partialReasons = [];
    for (const item of evidenceItems) {
      if (!["command", "file", "manual"].includes(item.kind)) failures.push(`acceptance evidence has an invalid kind: ${item.criterion}`);
      if (item.kind === "manual") partialReasons.push(`acceptance criterion relies on manual evidence: ${item.criterion}`);
    }
    const currentFingerprint = await createWorkspaceFingerprint(root);
    assertCompleteFingerprint(currentFingerprint);
    const checkpointEntries = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "CHECKPOINT_RECORDED");
    if (checkpointEntries.length < requirements.checkpoints) {
      failures.push(`fewer than ${requirements.checkpoints} required checkpoints were recorded`);
    }
    const latestCheckpoint = checkpointEntries.at(-1);
    if (requirements.checkpoints > 1 && checkpointEntries.length >= requirements.checkpoints) {
      const earlierProgressCheckpoint = checkpointEntries
        .slice(0, -1)
        .some(({ event, index }) => index > planIndex && (event.remainingStepIds || []).length > 0);
      if (!earlierProgressCheckpoint) failures.push("an earlier checkpoint must capture meaningful remaining plan work");
    }
    if (requirements.checkpoints > 0 && latestCheckpoint) {
      if (latestCheckpoint.index <= Math.max(lastWriteIndex, planIndex)) {
        failures.push("latest checkpoint predates the current plan or final write");
      }
      const plannedStepIds = state.plan?.steps?.map((step) => step.id) || [];
      const completed = latestCheckpoint.event.completedStepIds || [];
      if ((latestCheckpoint.event.remainingStepIds || []).length || !plannedStepIds.every((id) => completed.includes(id))) {
        failures.push("latest checkpoint does not mark every plan step complete");
      }
      if (!latestCheckpoint.event.fingerprint || !fingerprintsEqual(latestCheckpoint.event.fingerprint, currentFingerprint)) {
        failures.push("workspace changed after the latest checkpoint");
      }
    }

    const reviewEntries = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "REVIEW_RECORDED");
    const latestReview = reviewEntries.at(-1);
    if (requirements.reviewFoci.length && !latestReview) failures.push("required independent review record is missing");
    if (latestReview) {
      if (latestReview.index <= Math.max(lastWriteIndex, planIndex)) failures.push("latest review predates the current plan or final write");
      const focuses = new Set((latestReview.event.reviews || []).map((review) => review.focus));
      for (const focus of requirements.reviewFoci) {
        if (!focuses.has(focus)) failures.push(`required review focus is missing: ${focus}`);
      }
      if (!latestReview.event.fingerprint || !fingerprintsEqual(latestReview.event.fingerprint, currentFingerprint)) {
        failures.push("workspace changed after the latest review");
      }
      for (const review of latestReview.event.reviews || []) {
        for (const finding of review.findings || []) {
          if (["critical", "high"].includes(finding.severity) && !["resolved", "false-positive"].includes(finding.status)) {
            failures.push(`unresolved ${finding.severity} ${review.focus} finding: ${finding.issue}`);
          } else if (finding.severity === "medium" && !["resolved", "false-positive"].includes(finding.status)) {
            partialReasons.push(`medium ${review.focus} finding remains: ${finding.issue}`);
          }
        }
      }
    }
    const plannedCommands = state.plan?.verificationCommands || [];
    for (const plannedCommand of plannedCommands) {
      const latest = events
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => index > baseline
          && event.type === "VERIFICATION_COMPLETED"
          && event.result?.normalizedCommand === plannedCommand)
        .at(-1)?.event;
      if (!latest) {
        failures.push(`planned verification has not run after the current baseline: ${plannedCommand}`);
        continue;
      }
      if (!latest.result?.passed) {
        failures.push(latest.result?.workspaceMutationDetected
          ? `planned verification mutated fingerprinted workspace state: ${plannedCommand}`
          : `latest planned verification did not pass: ${plannedCommand}`);
        continue;
      }
      assertCompleteFingerprint(latest.result.fingerprintBefore);
      assertCompleteFingerprint(latest.result.fingerprintAfter);
      if (!fingerprintsEqual(latest.result.fingerprintBefore, latest.result.fingerprintAfter)) {
        failures.push(`planned verification changed fingerprinted workspace state: ${plannedCommand}`);
        continue;
      }
      if (!fingerprintsEqual(latest.result.fingerprintAfter, currentFingerprint)) {
        failures.push(`workspace changed after planned verification: ${plannedCommand}`);
      }
    }
    const skipped = events
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => index > baseline && event.type === "VERIFICATION_SKIPPED")
      .at(-1)?.event;
    if (skipped) {
      if (String(skipped.noTestsEvidence || "").length < 20) failures.push("no-tests evidence is insufficient");
      else partialReasons.push("no-tests evidence cannot replace any verification command recorded in the current plan");
    }

    const actualDiff = deriveGitDiffSummary(root);
    if (!actualDiff.detected) {
      partialReasons.push("Git is unavailable; final changed-path scope cannot be independently verified");
    } else if (!actualDiff.scopeComplete || actualDiff.truncated) {
      failures.push("Git changed-path scope is incomplete or truncated");
    } else {
      const baselinePaths = new Set(state.begun?.baselineGit?.changedPaths || []);
      const newChangedPaths = actualDiff.changedPaths.filter((changedPath) => !baselinePaths.has(changedPath));
      for (const changedPath of newChangedPaths) {
        const contractViolation = contractPathViolation(changedPath, state.contract || {}, { enforceAllowed: true });
        if (contractViolation) failures.push(`actual diff violates task contract: ${contractViolation}`);
        if (!(state.plan?.filesToChange || []).length) failures.push(`actual diff violates review-only plan: ${changedPath}`);
        else {
          const planViolation = contractPathViolation(changedPath, { allowedPaths: state.plan.filesToChange }, { enforceAllowed: true });
          if (planViolation) failures.push(`actual diff violates current plan: ${planViolation}`);
        }
      }
    }
    const decision = failures.length ? "REFUSE" : partialReasons.length ? "PARTIAL" : "PASS";
    await store.appendTaskEvent(taskId, "FINAL_GATE_EVALUATED", {
      decision,
      failures,
      partialReasons,
      diffSummary: summary,
      actualDiff,
      acceptanceEvidence: evidenceItems,
      currentFingerprint
    });
    return {
      ok: decision === "PASS",
      decision,
      taskId,
      effortProfile: profile,
      effortRequirements: requirements,
      failures,
      partialReasons,
      actualDiff,
      message: decision === "PASS"
        ? "Quality gate passed."
        : decision === "PARTIAL"
          ? "Evidence is partial. Run an executable verification command to earn PASS."
          : "Final answer refused until every quality gate is satisfied."
    };
  }

  async appendTrackedPath(taskId, type, relativePath, trajectoryId) {
    const { store } = await this.resolveTask(taskId);
    invariant(type === "HOOK_READ" || type === "HOOK_WRITE", "INVALID_EVENT", "Unsupported tracked path event");
    return store.appendTaskEvent(taskId, type, { path: relativePath, trajectoryId });
  }
}

export { DeepworkError };
