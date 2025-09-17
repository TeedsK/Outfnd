/**
 * Outfnd — Settings Panel (minimal)
 * Fixes: removes imports of firebaseProjectId / ensureFirebase; uses simple local settings.
 */
import React from "react";
import { loadSettings, saveSettings, type Settings } from "../settings/store";

export function SettingsPanel() {
    const [s, setS] = React.useState<Settings | null>(null);

    React.useEffect(() => {
        loadSettings().then(setS);
    }, []);

    if (!s) return null;

    const onToggle = <K extends keyof Settings>(key: K) => {
        const next: Settings = { ...s, [key]: !s[key] } as Settings;
        setS(next);
        void saveSettings(next);
    };

    return (
        <div className="card">
            <strong>Settings</strong>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                        type="checkbox"
                        checked={s.allowCloudFallback}
                        onChange={() => onToggle("allowCloudFallback")}
                    />
                    Allow cloud fallback (Gemini via Firebase Function)
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                        type="checkbox"
                        checked={s.enableFirebaseSync}
                        onChange={() => onToggle("enableFirebaseSync")}
                    />
                    Enable Firebase sync (wardrobe)
                </label>
            </div>
        </div>
    );
}
