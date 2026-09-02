import { describe, it, expect } from 'vitest';
import { shouldInjectAtPreStep, shouldInjectAtUserPrompt } from './policy.js';

describe('shouldInjectAtPreStep (§5.5.3, E16)', () => {
  it('injects into a non-empty batch (normal step)', () => {
    expect(shouldInjectAtPreStep({ batchEmpty: false, toolsRanSinceLastStep: false })).toBe(true);
  });

  it('injects on tool-loop continuation (empty batch but tools ran)', () => {
    expect(shouldInjectAtPreStep({ batchEmpty: true, toolsRanSinceLastStep: true })).toBe(true);
  });

  it('suppresses injection at a suspected turn-closing check', () => {
    expect(shouldInjectAtPreStep({ batchEmpty: true, toolsRanSinceLastStep: false })).toBe(false);
  });

  it('injects for a non-empty batch even when tools ran', () => {
    expect(shouldInjectAtPreStep({ batchEmpty: false, toolsRanSinceLastStep: true })).toBe(true);
  });
});

describe('shouldInjectAtUserPrompt (phase-2 CC channel)', () => {
  it('injects iff the queue is non-empty', () => {
    expect(shouldInjectAtUserPrompt(false)).toBe(true);
    expect(shouldInjectAtUserPrompt(true)).toBe(false);
  });
});
