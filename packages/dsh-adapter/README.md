# bright-drift (dsh adapter)

The DeepSeek Harness plugin package. See the [repository root README](../../README.md) for the full story.

**Requires dsh ≥ 0.2.0** (0.4.0 dropped the removed 0.1.x APIs; the peer range is enforced at install time).

```bash
dsh plugin --profile web add bright-drift
```

Installing from a local checkout instead (pre-publish)? See
[Development install](../../README.md#development-install-local-checkout-pre-publish)
in the repository root README — the `bright-drift-core` override step is
required, or pnpm fails on the adapter's `workspace:*` dependency.

Mounts as a host-plane bundle (`cordis.patch.yml` insert row). Host-only; no browser UI.

- Commands: `/bright-drift status | diff <path> | nodiff add|remove|list [pattern] | pause | resume`
- Global config: the `- id: bright-drift` entry's `config:` in `$DSH_HOME/profiles/<name>/cordis.patch.yml`
  (or `$DSH_HOME/cordis.patch.yml` across profiles). Every field is volatile: edits hot-apply
  without a plugin remount. Legacy `~/.dsh/settings.yaml` sections are auto-imported on first
  0.2.0 boot. See the root README for the schema.
- Project override: `<workspace>/.dsh/bright-drift.yml`
- Logs: `~/.dsh/logs/bright-drift/<date>.log` (hashes/paths/counts only — never file contents)

License: MIT
