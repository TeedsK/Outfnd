export interface Settings {
    preferOnDevice: boolean;
    allowCloudFallback: boolean;
    enableFirebaseSync: boolean;
}

const KEY = "outfnd/settings/v1";
const DEFAULTS: Settings = {
    preferOnDevice: true,
    allowCloudFallback: true,
    enableFirebaseSync: false
};

export async function loadSettings(): Promise<Settings> {
    try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            const data = await chrome.storage.local.get(KEY);
            const s = data?.[KEY] as Partial<Settings> | undefined;
            return { ...DEFAULTS, ...(s ?? {}) };
        }
    } catch { 
        console.log("Failed to load settings from chrome.storage, falling back to localStorage");
    }
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
}

export async function saveSettings(next: Settings): Promise<void> {
    try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            await chrome.storage.local.set({ [KEY]: next });
            return;
        }
    } catch {
        console.log("Failed to save settings to chrome.storage, falling back to localStorage");
    }
    localStorage.setItem(KEY, JSON.stringify(next));
}
