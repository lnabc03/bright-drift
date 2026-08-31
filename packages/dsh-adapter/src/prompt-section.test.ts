import { describe, it, expect } from 'vitest';
import {
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  PROMPT_SECTION_TEXT,
} from './prompt-section.js';
import { DEFAULT_CONFIG, mergeConfig } from './config.js';

describe('prompt section (§5.5.6)', () => {
  it('stays within its ~90-token budget (≤ 700 chars)', () => {
    expect(PROMPT_SECTION_TEXT.length).toBeLessThanOrEqual(700);
  });

  it('teaches the three attribution categories and the no-revert rule', () => {
    expect(PROMPT_SECTION_TEXT).toContain('EXTERNAL');
    expect(PROMPT_SECTION_TEXT).toContain('COMMAND-SIDE-EFFECT');
    expect(PROMPT_SECTION_TEXT).toContain('FORMATTED');
    expect(PROMPT_SECTION_TEXT).toContain('Never re-apply');
    expect(PROMPT_SECTION_TEXT).toContain('[workspace-drift · bright-drift]');
  });

  it('registers after tool-guidance sections (order 200, unique name)', () => {
    expect(PROMPT_SECTION_ORDER).toBe(200);
    expect(PROMPT_SECTION_NAME).toBe('bright-drift');
  });

  it('is enabled by default and toggleable via config', () => {
    expect(DEFAULT_CONFIG.inject.promptSection).toBe(true);
    const off = mergeConfig(DEFAULT_CONFIG, { inject: { promptSection: false } } as never);
    expect(off.inject.promptSection).toBe(false);
    expect(off.inject.onPreStep).toBe(true); // field-wise merge preserved
  });
});
