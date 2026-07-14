# Security policy

Deepwork is a defense-in-depth layer, not an operating-system sandbox. Verification commands execute repository-controlled code, and hooks cannot eliminate filesystem time-of-check/time-of-use races. Use a disposable, low-privilege environment for untrusted repositories and keep credentials out of the agent process.

## Report a vulnerability

Do not publish exploit details in a public issue. Use the repository's GitHub **Security** tab to submit a private vulnerability report. Include the affected version or commit, operating system, reproduction steps, observed impact, and the smallest safe proof of concept.

## Supported version

Until a stable release line exists, security fixes target the latest commit on `main`.

## Important trust boundaries

- Deepwork does not make arbitrary repository tests safe; it detects relevant mutations around planned verification.
- The local MCP and hooks have the same operating-system identity as the Windsurf process that launches them.
- Enterprise MCP enablement and allowlisting remain administrator-controlled.
- Native Arena, hosted model routing, billing, provider availability, and editor vulnerabilities remain outside this project's control.
- A future WhatsApp or remote-control service would be a separate security boundary and is not included in this repository.
