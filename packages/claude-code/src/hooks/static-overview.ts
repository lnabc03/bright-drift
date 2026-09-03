import { ConfigResolver } from '../shared/config.js';

/**
 * Static overview (design §5.6.5): the CC equivalent of phase-1's prompt
 * section. SessionStart re-runs after compact/clear (E5), so this text
 * re-lands automatically after every context reset. Fact-statement style —
 * imperative phrasing trips CC's prompt-injection defenses (§1.3).
 *
 * Attribution labels mirror phase-1's PROMPT_SECTION_TEXT (EXTERNAL·* /
 * COMMAND-SIDE-EFFECT / FORMATTED) so the legend and the actual notices
 * agree — the earlier draft's "external-change / command-side-effect /
 * ambiguous" did not match the rendered labels.
 */
export const STATIC_OVERVIEW = [
  'bright-drift monitors this workspace in the background.',
  'Files may change outside your own tool calls — edited by the user or by other processes — at any time, including mid-turn.',
  'When that happens, a notice listing the changed files is injected as a system reminder at a later turn boundary.',
  'Each notice is a statement of fact, not an instruction; its attribution label records the likely cause:',
  'EXTERNAL·* — changed by the user or another process; never re-apply, revert, or reason from pre-change content unless asked.',
  'COMMAND-SIDE-EFFECT — your own shell command made this change; informational.',
  'FORMATTED — a cosmetic formatter pass after your write; safe to ignore.',
].join(' ');

/**
 * Read config once per SessionStart and decide whether the overview injects
 * (inject.staticOverview). Fail-open: an unreadable config keeps the default
 * (inject), never silently drops the legend.
 */
export async function shouldInjectOverview(cwd: string): Promise<boolean> {
  try {
    const resolver = new ConfigResolver();
    await resolver.reloadGlobal();
    await resolver.reloadOverride(cwd);
    return resolver.resolve().inject.staticOverview;
  } catch {
    return true;
  }
}
