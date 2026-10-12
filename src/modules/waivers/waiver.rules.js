// Pure waiver rules (no database access) shared by the access engine and the waiver routes.

export const WAIVER_DEFAULTS = { askMembers: false, requireForEntry: false, currentVersion: 0, minVersion: 0 };
export const waiverSettings = (settings = {}) => ({ ...WAIVER_DEFAULTS, ...(settings?.waiver || {}) });

/** Version a member must have signed: the oldest one still accepted (at least version 1). */
export const requiredVersion = (settings) => Math.max(1, waiverSettings(settings).minVersion || 0);

/** True when a waiver exists and the member has not signed an accepted version. */
export function waiverPending(member, settings) {
  const w = waiverSettings(settings);
  if (!w.currentVersion) return false;
  return (member?.waiver?.version || 0) < requiredVersion(settings);
}

/** "Require signed waiver for entry" is on and this member still has to sign. */
export const waiverBlocksEntry = (member, settings) => waiverSettings(settings).requireForEntry && waiverPending(member, settings);
