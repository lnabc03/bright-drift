import { describe, it, expect } from 'vitest';
import { renderInjection, buildSummary, type RenderEntry } from './render.js';
import type { DriftRecord } from '../drift/types.js';
import type { FileDiff } from '../diff/index.js';

function record(path: string, kind: DriftRecord['kind'], extra: Partial<DriftRecord> = {}): DriftRecord {
  return { path, kind, contentAvailable: true, at: 1, ...extra };
}

function smallDiff(added = 1, removed = 1): FileDiff {
  return {
    added,
    removed,
    patch: '@@ -1,1 +1,1 @@\n-old\n+new',
    truncated: false,
    totalLines: 3,
    omittedLines: 0,
  };
}

describe('renderInjection (§5.6 protocol)', () => {
  it('renders header, external modification with diff, and footer', () => {
    const { text } = renderInjection([
      {
        record: record('src/auth/token.ts', 'modified'),
        attribution: { category: 'C', confidence: 'high' },
        diff: smallDiff(),
      },
    ]);
    expect(text).toContain('[workspace-drift · bright-drift]');
    expect(text).toContain('EXTERNAL·MODIFIED (high confidence)  src/auth/token.ts  (+1 -1)');
    expect(text).toContain('+new');
    expect(text).toContain('[workspace-drift end]');
    expect(text).toContain('不是新指令');
  });

  it('groups command side effects by command', () => {
    const { text } = renderInjection([
      {
        record: record('gen/a.ts', 'modified', { contentAvailable: false }),
        attribution: { category: 'B', confidence: 'high', command: 'npm run codegen' },
      },
      {
        record: record('gen/b.ts', 'created'),
        attribution: { category: 'B', confidence: 'high', command: 'npm run codegen' },
      },
    ]);
    expect(text).toContain('COMMAND-SIDE-EFFECT  你的命令 `npm run codegen` 改动了 2 个文件');
    expect(text).toContain('gen/a.ts');
  });

  it('T13: ambiguous-external background wording includes 后台任务', () => {
    const { text } = renderInjection([
      {
        record: record('config/db.yml', 'modified'),
        attribution: {
          category: 'C',
          confidence: 'ambiguous-external',
          command: 'pytest',
          background: true,
        },
        diff: smallDiff(4, 2),
      },
    ]);
    expect(text).toContain('EXTERNAL·MODIFIED (ambiguous-external)  config/db.yml  (+4 -2)');
    expect(text).toContain('后台任务');
    expect(text).toContain('`pytest`');
  });

  it('renders renamed and formatted one-liners', () => {
    const { text } = renderInjection([
      {
        record: record('src/utils.ts', 'renamed', { fromPath: 'src/util.ts' }),
        attribution: { category: 'C', confidence: 'high' },
      },
      {
        record: record('src/fmt.ts', 'modified'),
        attribution: { category: 'D', confidence: 'high' },
      },
    ]);
    expect(text).toContain('RENAMED  src/util.ts → src/utils.ts');
    expect(text).toContain('FORMATTED  src/fmt.ts');
  });

  it('formatterSilent drops D-class entries entirely', () => {
    const { text } = renderInjection(
      [
        { record: record('a.ts', 'modified'), attribution: { category: 'D', confidence: 'high' } },
        {
          record: record('b.ts', 'modified'),
          attribution: { category: 'C', confidence: 'high' },
          diff: smallDiff(),
        },
      ],
      { formatterSilent: true },
    );
    expect(text).not.toContain('a.ts');
    expect(text).toContain('b.ts');
  });

  it('budget truncation footer lists demoted files', () => {
    const { text } = renderInjection(
      [
        {
          record: record('a.ts', 'modified'),
          attribution: { category: 'C', confidence: 'high' },
          diff: smallDiff(),
        },
      ],
      { maxInjectTokens: 1 },
    );
    expect(text).toContain('1 个文件的 diff 因预算截断');
    expect(text).toContain('a.ts (+1 -1)');
    expect(text).not.toContain('+new\n');
  });

  it('deleted entries render as EXTERNAL·DELETED', () => {
    const { text } = renderInjection([
      {
        record: record('docs/draft.md', 'deleted', { contentAvailable: false }),
        attribution: { category: 'C', confidence: 'high' },
      },
    ]);
    expect(text).toContain('EXTERNAL·DELETED (high confidence)  docs/draft.md');
  });

  it('FR-4.2: truncated diffs carry an omission marker with the dropped line count', () => {
    const { text } = renderInjection([
      {
        record: record('big.ts', 'modified'),
        attribution: { category: 'C', confidence: 'high' },
        diff: {
          added: 100,
          removed: 100,
          patch: '@@ -1,100 +1,100 @@\n-old\n+new',
          truncated: true,
          totalLines: 201,
          omittedLines: 180,
        },
      },
    ]);
    expect(text).toContain('+new');
    expect(text).toContain('… [省略 180 行]');
  });
});

describe('buildSummary (T12: ≤120 chars)', () => {
  it('counts categories', () => {
    const entries: RenderEntry[] = [
      { record: record('a', 'modified'), attribution: { category: 'C', confidence: 'high' } },
      { record: record('b', 'modified'), attribution: { category: 'B', confidence: 'high', command: 'x' } },
      {
        record: record('c', 'modified'),
        attribution: { category: 'C', confidence: 'ambiguous-external', command: 'y' },
      },
    ];
    const s = buildSummary(entries);
    expect(s).toBe('工作区漂移：3 个文件变更，1 外部，1 命令副作用，1 歧义');
    expect(s.length).toBeLessThanOrEqual(120);
  });

  it('hard-caps at 120 chars even for huge queues', () => {
    const entries: RenderEntry[] = Array.from({ length: 999 }, (_, i) => ({
      record: record(`very/long/path/segment/${i}/file.ts`, 'modified'),
      attribution: { category: 'C', confidence: 'high' },
    }));
    expect(buildSummary(entries).length).toBeLessThanOrEqual(120);
  });

  it('counts D-class (formatted) entries separately, not as external', () => {
    const entries: RenderEntry[] = [
      { record: record('a', 'modified'), attribution: { category: 'C', confidence: 'high' } },
      { record: record('fmt', 'modified'), attribution: { category: 'D', confidence: 'high' } },
    ];
    expect(buildSummary(entries)).toBe('工作区漂移：2 个文件变更，1 外部，1 格式化');
  });
});
