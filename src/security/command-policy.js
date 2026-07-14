import path from "node:path";
import { DeepworkError, invariant } from "../errors.js";

const SHELL_META = /[;&|<>`\r\n\0]|\$\(|\$\{|%[^%\r\n]+%|\^/;
const SHELL_LAUNCHER = /^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|sh|zsh|fish|wsl(?:\.exe)?)$/i;
const SAFE_SCRIPT = /^(?:test|lint|build|check|typecheck|verify)(?::[A-Za-z0-9_.-]+)*$/;

export function tokenizeCommand(command) {
  invariant(typeof command === "string" && command.trim(), "INVALID_COMMAND", "A non-empty command is required");
  const tokens = [];
  let current = "";
  let quote = null;
  const input = command.trim();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && ["\\", '"'].includes(input[index + 1])) {
        current += input[index + 1];
        index += 1;
      }
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  invariant(!quote, "INVALID_COMMAND", "Command contains an unterminated quote");
  if (current) tokens.push(current);
  invariant(tokens.length > 0, "INVALID_COMMAND", "A non-empty command is required");
  return tokens;
}

function executableName(token) {
  const name = path.basename(token).toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

const DESTRUCTIVE_EXECUTABLES = new Set(["rm", "rmdir", "del", "erase", "rd", "diskpart", "format"]);
const NETWORK_EXECUTABLES = new Set(["curl", "wget", "scp", "sftp", "ftp", "nc", "netcat", "ssh"]);
const INLINE_INTERPRETERS = new Set(["node", "deno", "python", "python3", "ruby", "perl", "php"]);
const SIMPLE_READ_ONLY = new Set(["pwd", "get-location", "ls", "get-childitem", "where", "whereis"]);

function isInlineInterpreterArgument(argument) {
  return /^(?:-e|-c|-p|-r)(?:.+|=.+)?$/i.test(argument)
    || /^(?:--eval|--print)(?:=.+)?$/i.test(argument)
    || argument === "-";
}

function tokenTouchesProtectedPath(token) {
  const normalized = String(token || "")
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("\\", "/")
    .toLowerCase();
  return /(?:^|\/)(?:\.windsurf|\.devin|\.ssh|\.aws|\.gnupg)(?:\/|$)/.test(normalized)
    || /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\.json)?|id_rsa|id_ed25519|\.npmrc|\.pypirc)(?:$|\/)/.test(normalized)
    || /(?:^|\/)(?:hooks?|mcp(?:_config)?)\.json$/.test(normalized)
    || /(?:^|\/)(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|microsoft\.powershell_profile\.ps1)$/.test(normalized);
}

function isReadOnlyInspectionCommand(executable, args) {
  if (SIMPLE_READ_ONLY.has(executable)) {
    return !args.some((arg) => /^(?:-recurse|\/s)$/i.test(arg));
  }
  if (["rg", "ripgrep"].includes(executable)) {
    return !args.some((arg) => /^(?:--pre(?:=|$)|--pre-glob(?:=|$)|--hidden$|--no-ignore(?:=|$)|-u+$)/i.test(arg));
  }
  if (executable !== "git") return false;
  const verb = String(args[0] || "").toLowerCase();
  if (["status", "diff", "log", "show", "grep", "ls-files", "rev-parse", "describe"].includes(verb)) {
    return !args.some((arg) => /^(?:--ext-diff|--textconv|--output(?:=|$)|-o$)/i.test(arg));
  }
  if (verb === "branch") {
    return args.slice(1).every((arg) => /^(?:--show-current|--list|-a|-r|--contains(?:=|$)|--no-color)$/i.test(arg));
  }
  return false;
}

function isSafePackageCommand(executable, args) {
  if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
    if (["test", "lint", "build", "check", "typecheck"].includes(args[0])) return true;
    if (args[0] === "run" && SAFE_SCRIPT.test(args[1] || "")) return true;
    if (executable === "npm" && args[0] === "t") return true;
  }
  return false;
}

export function validateVerificationCommand(command) {
  invariant(!SHELL_META.test(command), "COMMAND_INJECTION", "Shell chaining, redirection, substitution, and control characters are forbidden");
  const tokens = tokenizeCommand(command);
  const executable = executableName(tokens[0]);
  const args = tokens.slice(1);
  invariant(!SHELL_LAUNCHER.test(executable), "COMMAND_INJECTION", "Shell launchers are not valid verification commands");
  invariant(!tokens[0].includes("/") && !tokens[0].includes("\\"), "UNSAFE_EXECUTABLE", "Verification executables must be resolved from PATH");

  let allowed = isSafePackageCommand(executable, args);
  allowed ||= executable === "node" && args[0] === "--test" && !args.some(isInlineInterpreterArgument);
  allowed ||= ["pytest", "ruff", "eslint", "vitest", "jest"].includes(executable);
  allowed ||= ["python", "python3"].includes(executable) && args[0] === "-m" && ["pytest", "unittest", "ruff"].includes(args[1]);
  allowed ||= executable === "go" && ["test", "vet", "build"].includes(args[0]);
  allowed ||= executable === "cargo" && ["test", "check", "build", "clippy"].includes(args[0]);
  allowed ||= executable === "dotnet" && ["test", "build"].includes(args[0]);
  allowed ||= ["mvn", "mvnw"].includes(executable) && args.some((arg) => ["test", "verify", "package"].includes(arg));
  allowed ||= ["gradle", "gradlew"].includes(executable) && args.some((arg) => /^(?:test|check|build)$/.test(arg));
  allowed ||= executable === "make" && args.length > 0 && args.every((arg) => /^(?:test|lint|build|check|verify)(?:-[A-Za-z0-9_.-]+)?$/.test(arg));
  allowed ||= executable === "tsc" && args.includes("--noEmit");

  invariant(!args.some((arg) => /^(?:--fix$|--fix=(?!false$|0$).+|--write(?:=|$)|format$)/i.test(arg)), "MUTATING_VERIFIER", "Mutating formatter/fix flags are not valid verification commands");

  invariant(allowed, "COMMAND_NOT_ALLOWED", "Only recognized test, lint, check, typecheck, or build commands may run");
  return { executable: tokens[0], args, normalized: [executable, ...args].join(" ") };
}

const HOOK_BLOCK_RULES = [
  { pattern: /(?:^|\s)(?:rm|rmdir|del|erase|remove-item|rd)(?:\s|$)/i, reason: "destructive file deletion" },
  { pattern: /(?:git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|restore\s)|terraform\s+destroy|kubectl\s+delete)/i, reason: "destructive repository or infrastructure operation" },
  { pattern: /(?:format(?:\.com)?\s|diskpart|shutdown|stop-computer|restart-computer)/i, reason: "destructive system operation" },
  { pattern: /(?:^|\s)(?:ln\s+-s|mklink|new-item\b[^\r\n]*(?:symboliclink|junction))(?:\s|$)/i, reason: "symlink or junction creation" },
  { pattern: /(?:^|\s)(?:curl|wget|scp|sftp|ftp|nc|netcat|ssh|invoke-webrequest|invoke-restmethod)(?:\s|$)/i, reason: "network transfer or possible exfiltration" },
  { pattern: /(?:^|\s)(?:printenv|set\s*$|get-childitem\s+env:|dir\s+env:)(?:\s|$)/i, reason: "environment-secret enumeration" },
  { pattern: /(?:^|\s)git\s+push(?:\s|$)/i, reason: "external repository mutation" },
  { pattern: /(?:drop\s+(?:database|table)|truncate\s+table|delete\s+from\s+\S+\s*;)/i, reason: "destructive database operation" },
  { pattern: /(?:^|[\\/\s"'])(?:\.windsurf|\.devin|\.ssh)(?:[\\/\s"']|$)|(?:^|[\\/])(?:hooks?|mcp(?:_config)?)\.json(?:\s|$)|(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|microsoft\.powershell_profile\.ps1|\$profile)/i, reason: "protected agent-control, SSH, or shell-profile path" }
];

export function classifyHookCommand(command) {
  if (typeof command !== "string" || !command.trim()) {
    return { allowed: false, reason: "pre_run requires a command" };
  }
  if (SHELL_META.test(command)) {
    return { allowed: false, reason: "shell chaining, redirection, or substitution is forbidden" };
  }
  for (const rule of HOOK_BLOCK_RULES) {
    if (rule.pattern.test(command)) return { allowed: false, reason: rule.reason };
  }
  try {
    const tokens = tokenizeCommand(command);
    const executable = executableName(tokens[0]);
    const args = tokens.slice(1);
    if (DESTRUCTIVE_EXECUTABLES.has(executable)) {
      return { allowed: false, reason: "destructive file or system operation" };
    }
    if (NETWORK_EXECUTABLES.has(executable)) {
      return { allowed: false, reason: "network transfer or possible exfiltration" };
    }
    if (SHELL_LAUNCHER.test(executable)) {
      return { allowed: false, reason: "nested shell launch is forbidden" };
    }
    if (INLINE_INTERPRETERS.has(executable) && args.some(isInlineInterpreterArgument)) {
      return { allowed: false, reason: "inline interpreter execution is forbidden" };
    }
    if (["npx", "bunx"].includes(executable)
      || (["npm"].includes(executable) && ["exec", "x"].includes(args[0]))
      || executable === "pnpm" && args[0] === "dlx"
      || ["yarn", "bun"].includes(executable) && ["dlx", "x"].includes(args[0])) {
      return { allowed: false, reason: "package executors are forbidden" };
    }
    if ((["npm", "pnpm", "yarn", "bun"].includes(executable) && ["install", "i", "add", "remove", "uninstall", "ci"].includes(args[0]))
      || (["pip", "pip3", "gem"].includes(executable) && ["install", "uninstall"].includes(args[0]))
      || (executable === "uv" && args[0] === "pip" && ["install", "uninstall"].includes(args[1]))
      || (executable === "cargo" && ["install", "uninstall"].includes(args[0]))
      || ["apt", "apt-get", "winget", "choco", "scoop"].includes(executable)) {
      return { allowed: false, reason: "package installation or removal is forbidden" };
    }
    if (executable === "git" && args[0] === "config") {
      return { allowed: false, reason: "git configuration mutation or credential access is forbidden" };
    }
    if (executable === "git" && ["apply", "am"].includes(args[0])) {
      return { allowed: false, reason: "untracked repository mutation command is forbidden" };
    }
    if ((executable === "fsutil" && args[0]?.toLowerCase() === "hardlink")
      || (executable === "mklink" && args.some((arg) => /^\/h$/i.test(arg)))
      || (executable === "new-item" && args.some((arg) => /^(?:hardlink|symboliclink|junction)$/i.test(arg)))) {
      return { allowed: false, reason: "hardlink, symlink, or junction creation is forbidden" };
    }
    if (tokens.some(tokenTouchesProtectedPath)) {
      return { allowed: false, reason: "protected control, credential, or secret path" };
    }
    if (!isReadOnlyInspectionCommand(executable, args)) {
      return {
        allowed: false,
        reason: "command is outside the fail-closed read-only inspection allowlist; run planned tests/builds through deepwork.run_verification with approval"
      };
    }
  } catch (error) {
    if (error instanceof DeepworkError) return { allowed: false, reason: error.message };
    throw error;
  }
  return { allowed: true, mode: "read-only-inspection" };
}
