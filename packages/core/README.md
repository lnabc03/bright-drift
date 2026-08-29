# bright-drift-core

Platform-independent workspace-drift detection engine for AI coding agents: file-event reconciliation against a per-session agent knowledge baseline, attribution windows for shell side-effects, budgeted diff rendering, and injection-point policy.

Zero platform dependencies — usable from any agent harness. The dsh plugin lives in `packages/dsh-adapter` (`bright-drift` on npm).

```ts
import {
  AgentKnowledgeBase,
  reconcile,
  Attributor,
  renderInjection,
  planBudget,
} from 'bright-drift-core';
```

APIs are experimental until v1.0. See the [repository root README](../../README.md) and the phase-1 design doc (`bright-drift-design-phase1.md`, Chinese) for contracts.

License: MIT
