import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalWorkspaceRoot, guardWorkspacePath } from "../src/security/path-guard.js";
import { temporaryWorkspace } from "./helpers.js";

test("canonical path guard allows normal in-workspace targets", async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "index.js"), "export {};\n");
  assert.equal(await canonicalWorkspaceRoot(root), root);
  const guarded = await guardWorkspacePath(root, "src/index.js", { mustExist: true });
  assert.equal(guarded.relative, path.join("src", "index.js"));
});

test("canonical path guard rejects escapes and protected paths", async (t) => {
  const root = await temporaryWorkspace(t);
  await assert.rejects(() => guardWorkspacePath(root, "../outside.txt"), { code: "PATH_ESCAPE" });
  await assert.rejects(() => guardWorkspacePath(root, ".env"), { code: "PROTECTED_PATH" });
  await assert.rejects(() => guardWorkspacePath(root, ".windsurf/hooks.json"), { code: "PROTECTED_PATH" });
  await assert.rejects(() => guardWorkspacePath(root, "credentials.json"), { code: "PROTECTED_PATH" });
});

test("canonical path guard rejects a symlink or junction escape", async (t) => {
  const root = await temporaryWorkspace(t, "deepwork-root-");
  const outside = await temporaryWorkspace(t, "deepwork-outside-");
  await fs.writeFile(path.join(outside, "outside.txt"), "outside fixture");
  const link = path.join(root, "linked");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip(`platform cannot create a test symlink/junction: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(() => guardWorkspacePath(root, "linked/outside.txt"), { code: "PATH_REPARSE_POINT" });
});

test("canonical path guard rejects multiply-linked files", async (t) => {
  const root = await temporaryWorkspace(t);
  const outsideRoot = await temporaryWorkspace(t, "deepwork-outside-");
  const outside = path.join(outsideRoot, "outside.txt");
  const inside = path.join(root, "inside.txt");
  await fs.writeFile(outside, "outside\n");
  try {
    await fs.link(outside, inside);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip(`hardlinks unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(() => guardWorkspacePath(root, inside, { mustExist: true }), /multiply-linked/i);
});
