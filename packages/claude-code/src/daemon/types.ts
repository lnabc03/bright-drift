import type { Attribution, DriftRecord } from 'bright-drift-core';

/** Drift record enriched with detection-time attribution (windows close fast). */
export interface AttributedDrift extends DriftRecord {
  attribution: Attribution;
}
