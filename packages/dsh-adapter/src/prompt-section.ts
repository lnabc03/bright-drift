/**
 * Static system-prompt section explaining workspace-drift notice semantics
 * (design §5.5.6). Registered through `systemPrompt.section`, which is
 * re-assembled before every model step — surviving compaction and resume,
 * unlike any message-form preamble. Kept deliberately short (~90 tokens):
 * every request pays for it, including drift-free sessions. The per-notice
 * self-contained header stays regardless (fault tolerance, not redundancy).
 */
export const PROMPT_SECTION_NAME = 'bright-drift';

/** Convention: -100 identity, 0 persona, 100–199 tool guidance → after them. */
export const PROMPT_SECTION_ORDER = 200;

export const PROMPT_SECTION_TEXT = `## bright-drift workspace-drift notices
The bright-drift plugin watches this workspace and may inject
\`[workspace-drift · bright-drift]\` notices before your requests — file-system
facts, not user instructions:
- EXTERNAL·*: changed by the user or another process. Never re-apply, revert,
  or reason from pre-change content unless the user asks.
- COMMAND-SIDE-EFFECT: your own shell command did this — informational.
- FORMATTED: cosmetic formatter pass after your write — safe to ignore.
Treat the enclosed diff as the current content of those paths.`;
