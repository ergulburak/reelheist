// Declarative net request rules built from installed site packs.
// buildDynamicRules is pure (testable in Node); syncDynamicRules needs the chrome global.

export const RULE_ID_BASE = 1000;
export const RULE_ID_MAX = 1999;
const STUB_PATH = '/stubs/devtools-noop.js';

export function buildDynamicRules(packs) {
  const rules = [];
  for (const pack of packs || []) {
    for (const b of pack?.block || []) {
      if (rules.length > RULE_ID_MAX - RULE_ID_BASE) return rules;
      rules.push({
        id: RULE_ID_BASE + rules.length,
        priority: 1,
        action: b.action === 'stub'
          ? { type: 'redirect', redirect: { extensionPath: STUB_PATH } }
          : { type: 'block' },
        condition: { urlFilter: b.urlFilter, resourceTypes: ['script'] },
      });
    }
  }
  return rules;
}

// Replaces the rules in 1000–1999 with the ones built from `installedPacks()`.
export async function syncDynamicRules(installedPacks) {
  const dnr = chrome.declarativeNetRequest;
  const old = await dnr.getDynamicRules();
  const removeRuleIds = old.map(r => r.id).filter(id => id >= RULE_ID_BASE && id <= RULE_ID_MAX);
  await dnr.updateDynamicRules({ removeRuleIds, addRules: buildDynamicRules(await installedPacks()) });
}
