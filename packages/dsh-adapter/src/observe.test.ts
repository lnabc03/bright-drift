import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveToolPath } from './observe.js';
import { createAgentState } from './state.js';
import { DEFAULT_CONFIG } from './config.js';
import { fakeAgent } from './testkit.js';

const root = path.join(path.sep, 'ws', 'root');

function fakeState(): ReturnType<typeof createAgentState> {
  return createAgentState(fakeAgent('s1', root), root, DEFAULT_CONFIG);
}

describe('resolveToolPath', () => {
  it('resolves relative paths against the workspace root', () => {
    const state = fakeState();
    expect(resolveToolPath(state, 'src/a.ts')).toBe('src/a.ts');
  });

  it('normalizes absolute paths inside the root', () => {
    const state = fakeState();
    expect(resolveToolPath(state, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
  });

  it('rejects paths outside the root', () => {
    const state = fakeState();
    expect(resolveToolPath(state, path.join(path.sep, 'elsewhere', 'x.ts'))).toBeNull();
  });

  it('rejects non-string arguments', () => {
    const state = fakeState();
    expect(resolveToolPath(state, undefined)).toBeNull();
    expect(resolveToolPath(state, 42)).toBeNull();
  });
});
