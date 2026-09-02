import { describe, it, expect, beforeEach } from 'vitest';
import { Attributor, type ShellWindow } from './attributor.js';

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 0;
});

function window(overrides: Partial<ShellWindow> = {}): Omit<ShellWindow, 'effectiveUntil'> {
  return {
    id: 'call-1',
    shell: 'bash',
    command: 'npm run codegen',
    background: false,
    openedAt: clock,
    preSnapshot: {},
    predictedPaths: [],
    ...overrides,
  };
}

describe('Attributor', () => {
  it('classifies drift inside a foreground window as B', () => {
    const a = new Attributor({ now });
    a.openWindow(window());
    clock = 100;
    expect(a.classify(clock)).toMatchObject({
      category: 'B',
      confidence: 'high',
      command: 'npm run codegen',
    });
  });

  it('window stays effective during the grace period after close', () => {
    const a = new Attributor({ now, windowGraceMs: 1500 });
    a.openWindow(window());
    clock = 100;
    a.closeWindow('call-1');
    clock = 1000; // within grace
    expect(a.classify(clock).category).toBe('B');
  });

  it('drift outside window + grace is external (C, high)', () => {
    const a = new Attributor({ now, windowGraceMs: 1500 });
    a.openWindow(window());
    clock = 100;
    a.closeWindow('call-1');
    clock = 100 + 1500 + 1;
    expect(a.classify(clock)).toEqual({ category: 'C', confidence: 'high' });
  });

  it('no windows at all → C high', () => {
    const a = new Attributor({ now });
    expect(a.classify(0)).toEqual({ category: 'C', confidence: 'high' });
  });

  it('E15: commands longer than longCommandMs make drift ambiguous-external', () => {
    const a = new Attributor({ now, longCommandMs: 10_000 });
    a.openWindow(window());
    clock = 11_000;
    a.closeWindow('call-1');
    const r = a.classify(clock);
    expect(r).toMatchObject({
      category: 'C',
      confidence: 'ambiguous-external',
      command: 'npm run codegen',
    });
  });

  it('T13/D5: background windows never close and stay ambiguous', () => {
    const a = new Attributor({ now });
    a.openWindow(window({ background: true }));
    clock = 500;
    a.closeWindow('call-1'); // process "finished", job may live on
    clock = 60_000;
    const r = a.classify(clock);
    expect(r).toMatchObject({
      category: 'C',
      confidence: 'ambiguous-external',
      background: true,
    });
  });

  it('predictedByAnyWindow reports static-analysis hits', () => {
    const a = new Attributor({ now });
    a.openWindow(window({ predictedPaths: ['out.txt'] }));
    expect(a.predictedByAnyWindow('out.txt', clock)).toBe(true);
    expect(a.predictedByAnyWindow('other.txt', clock)).toBe(false);
  });

  it('state survives a JSON roundtrip (PRD §6.2-5 serializability)', () => {
    const a = new Attributor({ now });
    a.openWindow(window({ predictedPaths: ['out.txt'] }));
    clock = 50;
    a.closeWindow('call-1');
    const restored = Attributor.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), { now });
    expect(restored.classify(clock)).toMatchObject({ category: 'B' });
    expect(restored.predictedByAnyWindow('out.txt', clock)).toBe(true);
  });

  it('setWindows re-applies grace/long thresholds live', () => {
    const a = new Attributor({ now, longCommandMs: 10_000 });
    a.openWindow(window());
    clock = 100;
    a.closeWindow('call-1');
    a.setWindows(1500, 50); // now anything > 50ms is ambiguous
    clock = 200;
    expect(a.classify(clock)).toMatchObject({ confidence: 'ambiguous-external' });
  });

  it('D8b: predicted write after grace but within longCommandMs → ambiguous-external', () => {
    const a = new Attributor({ now, windowGraceMs: 1500, longCommandMs: 10_000 });
    a.openWindow(window({ predictedPaths: ['out.txt'] }));
    clock = 100;
    a.closeWindow('call-1'); // effectiveUntil = 1600
    clock = 5000; // past grace, inside the late-write horizon (100 + 10000)
    expect(a.classify(clock, 'out.txt')).toMatchObject({
      category: 'C',
      confidence: 'ambiguous-external',
      command: 'npm run codegen',
    });
  });

  it('D8b: unpredicted path after grace stays plain external', () => {
    const a = new Attributor({ now, windowGraceMs: 1500, longCommandMs: 10_000 });
    a.openWindow(window({ predictedPaths: ['out.txt'] }));
    clock = 100;
    a.closeWindow('call-1');
    clock = 5000;
    expect(a.classify(clock, 'other.txt')).toEqual({ category: 'C', confidence: 'high' });
  });

  it('D8b: predicted write beyond the horizon is plain external (window pruned)', () => {
    const a = new Attributor({ now, windowGraceMs: 1500, longCommandMs: 10_000 });
    a.openWindow(window({ predictedPaths: ['out.txt'] }));
    clock = 100;
    a.closeWindow('call-1');
    clock = 100 + 10_000 + 1;
    expect(a.classify(clock, 'out.txt')).toEqual({ category: 'C', confidence: 'high' });
  });

  it('predictedRecently covers open windows and the late horizon', () => {
    const a = new Attributor({ now, windowGraceMs: 1500, longCommandMs: 10_000 });
    a.openWindow(window({ predictedPaths: ['out.txt'] }));
    expect(a.predictedRecently('out.txt', 50)).toBe(true); // covering
    a.closeWindow('call-1', 100); // effectiveUntil = 1600
    expect(a.predictedRecently('out.txt', 2000)).toBe(true); // past grace, within horizon
    expect(a.predictedRecently('out.txt', 20_000)).toBe(false); // beyond horizon
    expect(a.predictedRecently('nope.txt', 50)).toBe(false);
  });

  it('prunes windows past their coverage', () => {
    const a = new Attributor({ now, windowGraceMs: 100 });
    a.openWindow(window());
    clock = 10;
    a.closeWindow('call-1');
    clock = 10_000;
    expect(a.classify(clock)).toEqual({ category: 'C', confidence: 'high' });
  });
});
