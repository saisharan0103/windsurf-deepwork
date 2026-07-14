# Contributing

Issues and pull requests are welcome for reproducible bugs, narrowly scoped hardening, Windows compatibility, documentation corrections, and additional adversarial tests.

Before proposing a change:

1. Describe the failure mode and the trust boundary it affects.
2. Keep unrelated formatting and dependency changes out of the patch.
3. Add a regression test for security or gate behavior.
4. Run `npm ci`, `npm run check`, and `powershell -NoProfile -File .\scripts\test-installer.ps1` on Windows.
5. State any check you could not run.

The repository is publicly visible, but no license has been selected yet. Public visibility alone does not grant permission to redistribute or create derivative works; a maintainer can add a license later after making that decision explicitly.
