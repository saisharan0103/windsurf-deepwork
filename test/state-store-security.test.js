import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStateStore } from "../src/state/store.js";
import { temporaryWorkspace } from "./helpers.js";

function comparable(value) {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

test("state store accepts a safe Windows short-name state-home ancestor", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows 8.3 aliases are Windows-specific");
  const aliasBase = os.tmpdir();
  const canonicalBase = await fs.realpath(aliasBase);
  if (comparable(aliasBase) === comparable(canonicalBase) || !/~\d+(?:[\\/]|$)/i.test(aliasBase)) {
    return t.skip("the runner TEMP path does not expose an 8.3 alias");
  }

  const workspace = await temporaryWorkspace(t, "deepwork-state-alias-workspace-");
  const stateHome = path.join(aliasBase, `deepwork-state-alias-${process.pid}-${Date.now()}`);
  t.after(async () => fs.rm(stateHome, { recursive: true, force: true, maxRetries: 3 }));
  const store = new WorkspaceStateStore(workspace, { stateHome });

  await store.appendTaskEvent("short-alias", "TASK_BEGUN", { workspaceRoot: workspace });
  const state = await store.getTaskState("short-alias");
  assert.equal(state.stage, "begun");
});

test("state store rejects a short-looking linked state-home ancestor", async (t) => {
  const container = await temporaryWorkspace(t, "deepwork-state-link-container-");
  const outside = await temporaryWorkspace(t, "deepwork-state-link-target-");
  const workspace = await temporaryWorkspace(t, "deepwork-state-link-workspace-");
  const linkedStateHome = path.join(container, "RUNNER~1");
  try {
    await fs.symlink(outside, linkedStateHome, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      return t.skip(`platform cannot create a test symlink/junction: ${error.code}`);
    }
    throw error;
  }

  const store = new WorkspaceStateStore(workspace, { stateHome: linkedStateHome });
  await assert.rejects(() => store.ensure(), { code: "STATE_REPARSE_POINT" });
});

test("state store rejects multiply-linked event files", async (t) => {
  const stateHome = await temporaryWorkspace(t, "deepwork-state-hardlink-home-");
  const outside = await temporaryWorkspace(t, "deepwork-state-hardlink-target-");
  const workspace = await temporaryWorkspace(t, "deepwork-state-hardlink-workspace-");
  const store = new WorkspaceStateStore(workspace, { stateHome });
  await store.ensure();

  const outsideFile = path.join(outside, "outside.jsonl");
  await fs.writeFile(outsideFile, "outside\n");
  try {
    await fs.link(outsideFile, store.taskFile("hardlinked"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      return t.skip(`hardlinks unavailable: ${error.code}`);
    }
    throw error;
  }

  await assert.rejects(
    () => store.appendTaskEvent("hardlinked", "TASK_BEGUN", { workspaceRoot: workspace }),
    { code: "STATE_HARDLINK" }
  );
});
