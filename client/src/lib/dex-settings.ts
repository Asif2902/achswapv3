// Settings for DEX protocol preferences

export interface DexSettings {
  v2Enabled: boolean;
  v3Enabled: boolean;
}

const SETTINGS_KEY = 'dex-settings';

const DEFAULT_SETTINGS: DexSettings = {
  v2Enabled: true,
  v3Enabled: true,
};

export function loadDexSettings(): DexSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (error) {
    console.error('Failed to load DEX settings:', error);
  }
  return DEFAULT_SETTINGS;
}

export function saveDexSettings(settings: DexSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Failed to save DEX settings:', error);
  }
}
