import fs from "node:fs/promises";
import { constants as fsConstants, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DeepworkError, invariant } from "../errors.js";
import { sanitizeForAudit } from "../audit/redact.js";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TEST_STATE_HOME = process.env.NODE_TEST_CONTEXT ? path.join(os.tmpdir(), `deepwork-state-test-${process.pid}`) : null;
if (TEST_STATE_HOME) process.once("exit", () => { try { rmSync(TEST_STATE_HOME, { recursive: true, force: true }); } catch {} });

function assertTaskId(taskId) {
  invariant(typeof taskId === "string" && TASK_ID.test(taskId), "INVALID_TASK_ID", "taskId must use 1-128 letters, numbers, dots, dashes, or underscores");
}

async function readJsonLines(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const events = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new DeepworkError("STATE_CORRUPT", `Invalid state event at ${path.basename(file)}:${index + 1}`);
    }
  }
  return events;
}

function comparable(value) {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasWindowsShortNameComponent(value) {
  return path.normalize(value).split(/[\\/]/).some((segment) => /~\d+(?:\.[^\\/]*)?$/i.test(segment));
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

async function assertSafeStatePath(target, expectedRoot) {
  const absolute = path.resolve(target);
  const root = path.resolve(expectedRoot);
  const relative = path.relative(root, absolute);
  invariant(relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)), "STATE_PATH_ESCAPE", "State path escaped its configured root");
  const volume = path.parse(absolute).root;
  let cursor = volume;
  for (const segment of absolute.slice(volume.length).split(/[\\/]/).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      invariant(!stat.isSymbolicLink(), "STATE_REPARSE_POINT", `Refusing linked state path: ${cursor}`);
      invariant(!(stat.isFile() && stat.nlink > 1), "STATE_HARDLINK", `Refusing multiply-linked state file: ${cursor}`);
      const real = await fs.realpath(cursor);
      if (comparable(real) !== comparable(cursor)) {
        // Windows can expose a legitimate DOS 8.3 alias such as RUNNER~1 in
        // TEMP while realpath returns the long directory name. The lstat
        // above rejects symlinks and junctions first; matching nonzero file
        // identities then proves this is only an alternate spelling of the
        // same object. Any other realpath redirect remains fail-closed.
        const canonicalStat = await fs.lstat(real);
        const isProvenShortNameAlias = process.platform === "win32"
          && hasWindowsShortNameComponent(cursor)
          && sameFilesystemIdentity(stat, canonicalStat);
        invariant(isProvenShortNameAlias, "STATE_REPARSE_POINT", `Refusing redirected state path: ${cursor}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return absolute;
}

async function ensureSecureDirectory(directory, stateHome) {
  await assertSafeStatePath(directory, stateHome);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeStatePath(directory, stateHome);
}

async function withAppendLock(file, callback) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > 60_000) await fs.unlink(lock);
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) throw new DeepworkError("STATE_LOCK_TIMEOUT", `Timed out acquiring state lock: ${path.basename(file)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
}

async function appendJsonLine(file, value, stateHome) {
  await assertSafeStatePath(file, stateHome);
  await withAppendLock(file, async () => {
    await assertSafeStatePath(file, stateHome);
    await fs.appendFile(file, `${JSON.stringify(sanitizeForAudit(value))}\n`, { encoding: "utf8", mode: 0o600 });
  });
}

export function trajectoryKey(value) {
  return createHash("sha256").update(String(value || "default")).digest("hex").slice(0, 24);
}

export class WorkspaceStateStore {
  constructor(root, options = {}) {
    this.root = root;
    this.stateHome = path.resolve(options.stateHome || process.env.DEEPWORK_STATE_HOME || TEST_STATE_HOME || path.join(os.homedir(), ".codeium", "windsurf", "deepwork-state"));
    const workspaceKey = createHash("sha256").update(comparable(root)).digest("hex");
    this.deepwork = path.join(this.stateHome, "workspaces", workspaceKey);
    this.stateDir = path.join(this.deepwork, "state");
    this.tasksDir = path.join(this.stateDir, "tasks");
    this.hooksDir = path.join(this.stateDir, "hooks");
    this.activeFile = path.join(this.stateDir, "active-task.json");
    this.registryFile = path.join(this.stateDir, "task-roots.jsonl");
    this.auditDir = path.join(this.deepwork, "audits");
  }

  async ensure() {
    await ensureSecureDirectory(this.tasksDir, this.stateHome);
    await ensureSecureDirectory(this.hooksDir, this.stateHome);
  }

  async ensureAudit() {
    await ensureSecureDirectory(this.auditDir, this.stateHome);
  }

  taskFile(taskId) {
    assertTaskId(taskId);
    return path.join(this.tasksDir, `${taskId}.jsonl`);
  }

  async taskExists(taskId) {
    try {
      await fs.access(this.taskFile(taskId));
      return true;
    } catch {
      return false;
    }
  }

  async appendTaskEvent(taskId, type, data = {}) {
    await this.ensure();
    const event = {
      eventId: randomUUID(),
      type,
      at: new Date().toISOString(),
      ...data
    };
    await appendJsonLine(this.taskFile(taskId), event, this.stateHome);
    return event;
  }

  async readTaskEvents(taskId) {
    await this.ensure();
    const events = await readJsonLines(this.taskFile(taskId));
    invariant(events.length > 0, "TASK_NOT_FOUND", `Unknown task: ${taskId}`);
    return events;
  }

  async getTaskState(taskId) {
    return deriveTaskState(taskId, await this.readTaskEvents(taskId));
  }

  async setActiveTask(taskId) {
    assertTaskId(taskId);
    await this.ensure();
    const temporary = `${this.activeFile}.${process.pid}.${randomUUID()}.tmp`;
    await assertSafeStatePath(this.activeFile, this.stateHome);
    await fs.writeFile(temporary, `${JSON.stringify({ taskId, workspaceRoot: this.root })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.activeFile);
  }

  async getActiveTask() {
    try {
      const value = JSON.parse(await fs.readFile(this.activeFile, "utf8"));
      assertTaskId(value.taskId);
      invariant(value.workspaceRoot === this.root, "STATE_CORRUPT", "Active-task workspace does not match its state directory");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof DeepworkError) throw error;
      throw new DeepworkError("STATE_CORRUPT", "Active-task state is invalid");
    }
  }

  async registerTaskRoot(taskId, workspaceRoot) {
    assertTaskId(taskId);
    await this.ensure();
    await appendJsonLine(this.registryFile, {
      eventId: randomUUID(),
      type: "TASK_ROOT_REGISTERED",
      at: new Date().toISOString(),
      taskId,
      workspaceRoot
    }, this.stateHome);
  }

  async findTaskRoot(taskId) {
    assertTaskId(taskId);
    const events = await readJsonLines(this.registryFile);
    return events.findLast((event) => event.taskId === taskId)?.workspaceRoot || null;
  }

  hookFile(trajectoryId) {
    return path.join(this.hooksDir, `${trajectoryKey(trajectoryId)}.jsonl`);
  }

  async readHookEvents(trajectoryId) {
    await this.ensure();
    return readJsonLines(this.hookFile(trajectoryId));
  }

  async appendHookEvent(trajectoryId, type, data = {}) {
    await this.ensure();
    const event = {
      eventId: randomUUID(),
      type,
      at: new Date().toISOString(),
      trajectoryId: String(trajectoryId || "default").slice(0, 256),
      ...data
    };
    await appendJsonLine(this.hookFile(trajectoryId), event, this.stateHome);
    return event;
  }

  async getTrajectoryTask(trajectoryId) {
    const events = await this.readHookEvents(trajectoryId);
    const binding = events.findLast((event) => event.type === "MCP_TASK_BOUND");
    return binding?.taskId || null;
  }
}

export function deriveTaskState(taskId, events) {
  const begun = events.find((event) => event.type === "TASK_BEGUN") || null;
  const inspection = events.findLast((event) => event.type === "INSPECTION_COMPLETED") || null;
  const plan = events.findLast((event) => event.type === "PLAN_RECORDED") || null;
  const verifications = events.filter((event) => event.type === "VERIFICATION_COMPLETED" || event.type === "VERIFICATION_SKIPPED");
  const gate = events.findLast((event) => event.type === "FINAL_GATE_EVALUATED") || null;
  const reads = [...new Set(events.filter((event) => event.type === "HOOK_READ").map((event) => event.path))].sort();
  const writes = [...new Set(events.filter((event) => event.type === "HOOK_WRITE").map((event) => event.path))].sort();
  const lastWriteAt = events.findLast((event) => event.type === "HOOK_WRITE")?.at || null;
  let stage = "not_started";
  if (begun) stage = "begun";
  if (inspection) stage = "inspected";
  if (plan) stage = "planned";
  if (verifications.length) stage = "verified";
  const gateIndex = events.findLastIndex((event) => event.type === "FINAL_GATE_EVALUATED");
  const invalidatingIndex = Math.max(
    events.findLastIndex((event) => event.type === "HOOK_WRITE"),
    events.findLastIndex((event) => event.type === "PLAN_RECORDED"),
    events.findLastIndex((event) => event.type === "VERIFICATION_COMPLETED" || event.type === "VERIFICATION_SKIPPED")
  );
  if (gate?.decision === "PASS" && gateIndex > invalidatingIndex) stage = "passed";
  else if (gate?.decision === "PARTIAL" && gateIndex > invalidatingIndex) stage = "partial";
  return {
    taskId,
    workspaceRoot: begun?.workspaceRoot || null,
    objective: begun?.objective || null,
    acceptanceCriteria: begun?.acceptanceCriteria || [],
    contract: begun ? {
      nonGoals: begun.nonGoals || [],
      constraints: begun.constraints || [],
      allowedPaths: begun.allowedPaths || [],
      protectedPaths: begun.protectedPaths || [],
      assumptions: begun.assumptions || []
    } : null,
    stage,
    begun,
    inspection,
    plan,
    verifications,
    gate,
    reads,
    writes,
    lastWriteAt,
    eventCount: events.length
  };
}
