import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateVerificationCommand } from "./security/command-policy.js";
import { redactText } from "./audit/redact.js";

const OUTPUT_LIMIT = 1_000_000;
const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "BUN_INSTALL",
  "CARGO_HOME",
  "COMSPEC",
  "CONDA_PREFIX",
  "DOTNET_ROOT",
  "GOMODCACHE",
  "GOPATH",
  "GOROOT",
  "GRADLE_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "JAVA_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "M2_HOME",
  "MAVEN_HOME",
  "NODE_HOME",
  "NPM_CONFIG_CACHE",
  "NUGET_PACKAGES",
  "NUMBER_OF_PROCESSORS",
  "NVM_HOME",
  "NVM_SYMLINK",
  "PATH",
  "PATHEXT",
  "PIP_CACHE_DIR",
  "PNPM_HOME",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "RUSTUP_HOME",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "UV_CACHE_DIR",
  "VIRTUAL_ENV",
  "WINDIR"
]);

export function buildVerificationEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    ALLOWED_ENVIRONMENT_KEYS.has(key.toUpperCase()) && typeof value === "string"
  ));
}

function verificationInvocation(parsed) {
  if (process.platform === "win32" && parsed.executable.toLowerCase() === "npm") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) return { executable: process.execPath, args: [npmCli, ...parsed.args] };
  }
  return { executable: parsed.executable, args: parsed.args };
}

function collector() {
  let value = "";
  let truncated = false;
  return {
    add(chunk) {
      if (value.length >= OUTPUT_LIMIT) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const remaining = OUTPUT_LIMIT - value.length;
      value += text.slice(0, remaining);
      if (text.length > remaining) truncated = true;
    },
    result() {
      return { text: redactText(value), truncated };
    }
  };
}

function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.on("error", () => child.kill("SIGTERM"));
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000).unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 1_000).unref();
}

export async function runVerificationCommand({ command, cwd, timeoutMs = 120_000 }) {
  const parsed = validateVerificationCommand(command);
  const invocation = verificationInvocation(parsed);
  const timeout = Math.max(1_000, Math.min(Number(timeoutMs) || 120_000, 600_000));
  const stdout = collector();
  const stderr = collector();
  const started = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: buildVerificationEnvironment(),
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk) => stdout.add(chunk));
    child.stderr?.on("data", (chunk) => stderr.add(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeout);
    timer.unref();

    function finish(exitCode, signal, spawnError = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = stdout.result();
      const err = stderr.result();
      resolve({
        command: redactText(command),
        normalizedCommand: redactText(parsed.normalized),
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: out.text,
        stderr: spawnError ? redactText(`${err.text}\n${spawnError.message}`.trim()) : err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        passed: !spawnError && !timedOut && exitCode === 0
      });
    }

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}
