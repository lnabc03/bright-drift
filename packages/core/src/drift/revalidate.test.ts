import { describe, it, expect } from 'vitest';
import { revalidateRecords } from './revalidate.js';
import type { DriftRecord, FileObservation } from './types.js';

const at = 1000;

function rec(kind: DriftRecord['kind'], path: string, extra: Partial<DriftRecord> = {}): DriftRecord {
  return { path, kind, contentAvailable: false, at, ...extra };
}

/** In-memory probe/baseline fixtures. */
function fixture(files: Record<string, string>, baselineHashes: Record<string, string> = {}) {
  const probe = async (path: string): Promise<FileObservation> =>
    path in files
      ? { path, exists: true, contentHash: `h:${files[path]}`, size: files[path]!.length, mtimeMs: 2000 }
      : { path, exists: false };
  const baseline = {
    get: (path: string) =>
      path in baselineHashes ? { contentHash: baselineHashes[path]! } : undefined,
  };
  return { probe, baseline };
}

describe('revalidateRecords (E19)', () => {
  it('drops a phantom create (created then renamed away before injection)', async () => {
    const { probe, baseline } = fixture({});
    const r = await revalidateRecords([rec('created', '.dsh/新建 文本文档.txt')], probe, baseline);
    expect(r.keep).toHaveLength(0);
    expect(r.dropped).toEqual([{ record: expect.objectContaining({ path: '.dsh/新建 文本文档.txt' }), reason: 'phantom-create' }]);
  });

  it('keeps and refreshes a created record that still exists', async () => {
    const { probe, baseline } = fixture({ 'a.ts': 'v2' });
    const r = await revalidateRecords([rec('created', 'a.ts', { contentHash: 'h:v1', size: 2 })], probe, baseline);
    expect(r.keep).toEqual([expect.objectContaining({ kind: 'created', contentHash: 'h:v2', mtimeMs: 2000 })]);
  });

  it('drops a net-zero modification (edited back to baseline)', async () => {
    const { probe, baseline } = fixture({ 'a.ts': 'same' }, { 'a.ts': 'h:same' });
    const r = await revalidateRecords([rec('modified', 'a.ts')], probe, baseline);
    expect(r.dropped[0]?.reason).toBe('net-zero');
    expect(r.keep).toHaveLength(0);
  });

  it('reclassifies modified→deleted when the file vanished and a baseline exists', async () => {
    const { probe, baseline } = fixture({}, { 'a.ts': 'h:old' });
    const r = await revalidateRecords([rec('modified', 'a.ts')], probe, baseline);
    expect(r.keep).toEqual([expect.objectContaining({ kind: 'deleted', path: 'a.ts', contentHash: 'h:old' })]);
  });

  it('drops phantom-modify when the file vanished and nothing is tracked', async () => {
    const { probe, baseline } = fixture({});
    const r = await revalidateRecords([rec('modified', 'gone.ts')], probe, baseline);
    expect(r.dropped[0]?.reason).toBe('phantom-modify');
  });

  it('drops a recreated-identical deletion (E4 semantics)', async () => {
    const { probe, baseline } = fixture({ 'a.ts': 'same' }, { 'a.ts': 'h:same' });
    const r = await revalidateRecords([rec('deleted', 'a.ts')], probe, baseline);
    expect(r.dropped[0]?.reason).toBe('recreated-identical');
  });

  it('reclassifies deleted→modified when recreated with different content', async () => {
    const { probe, baseline } = fixture({ 'a.ts': 'new' }, { 'a.ts': 'h:old' });
    const r = await revalidateRecords([rec('deleted', 'a.ts')], probe, baseline);
    expect(r.keep).toEqual([expect.objectContaining({ kind: 'modified', path: 'a.ts', contentHash: 'h:new' })]);
  });

  it('reclassifies a phantom rename back to deleted when the source had a baseline', async () => {
    const { probe, baseline } = fixture({}, { 'old.ts': 'h:old' });
    const r = await revalidateRecords(
      [rec('renamed', 'new.ts', { fromPath: 'old.ts', contentHash: 'h:old' })],
      probe,
      baseline,
    );
    expect(r.keep).toEqual([expect.objectContaining({ kind: 'deleted', path: 'old.ts' })]);
  });

  it('preserves extra fields (attribution) through reclassification', async () => {
    const { probe, baseline } = fixture({ 'a.ts': 'new' }, { 'a.ts': 'h:old' });
    type Attributed = DriftRecord & { attribution: { category: string } };
    const record: Attributed = { ...rec('deleted', 'a.ts'), attribution: { category: 'C' } };
    const r = await revalidateRecords<Attributed>([record], probe, baseline);
    expect(r.keep[0]).toMatchObject({ kind: 'modified', attribution: { category: 'C' } });
  });

  it('probe failure fails open (record kept as-is)', async () => {
    const probe = async (): Promise<FileObservation> => { throw new Error('io'); };
    const baseline = { get: () => undefined };
    const record = rec('created', 'a.ts');
    const r = await revalidateRecords([record], probe, baseline);
    expect(r.keep).toEqual([record]);
    expect(r.dropped).toHaveLength(0);
  });

  it('probes each unique path only once', async () => {
    let calls = 0;
    const probe = async (path: string): Promise<FileObservation> => { calls++; return { path, exists: true }; };
    const baseline = { get: () => undefined };
    await revalidateRecords(
      [rec('created', 'a.ts'), rec('modified', 'a.ts'), rec('created', 'b.ts')],
      probe,
      baseline,
    );
    expect(calls).toBe(2);
  });

  it('D9: the suppression marker tracks the fresh probe (set and cleared)', async () => {
    const baseline = { get: () => ({ contentHash: 'h:old' }) };
    const suppressedProbe = async (p: string): Promise<FileObservation> =>
      ({ path: p, exists: true, contentHash: 'h:new', contentSuppressed: true });
    const r1 = await revalidateRecords([rec('modified', 'secret.env')], suppressedProbe, baseline);
    expect(r1.keep[0]).toMatchObject({ diffSuppressed: true });

    const plainProbe = async (p: string): Promise<FileObservation> =>
      ({ path: p, exists: true, contentHash: 'h:new' });
    const r2 = await revalidateRecords(
      [rec('modified', 'secret.env', { diffSuppressed: true })],
      plainProbe,
      baseline,
    );
    expect(r2.keep[0]).not.toHaveProperty('diffSuppressed');
  });
});
