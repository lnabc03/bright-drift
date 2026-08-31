# bright-drift (dsh adapter)

The DeepSeek Harness plugin package. See the [repository root README](../../README.md) for the full story.

```bash
dsh plugin --profile web add bright-drift
```

Installing from a local checkout instead (pre-publish)? See
[Development install](../../README.md#development-install-local-checkout-pre-publish)
in the repository root README — the `bright-drift-core` override step is
required, or pnpm fails on the adapter's `workspace:*` dependency.

Mounts as a host-plane bundle (`cordis.patch.yml` insert row). Host-only; no browser UI.

- Commands: `/bright-drift status | diff <path> | pause | resume`
- Global settings namespace: `bright-drift` (see root README for the schema)
- Project override: `<workspace>/.dsh/bright-drift.yml`
- Logs: `~/.dsh/logs/bright-drift/<date>.log` (hashes/paths/counts only — never file contents)

License: MIT
