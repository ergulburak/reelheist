// User settings kept in chrome.storage.local under "settings".

export const DEFAULT_SETTINGS = {
  theme: 'red',
  lang: 'auto',
  autoUpdatePacks: true,
  motion: 'auto', // 'auto' | 'on' | 'off'
  defaults: {},
  siteMemory: {},
};

export async function loadUiSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveUiSettings(patch) {
  const next = { ...(await loadUiSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
