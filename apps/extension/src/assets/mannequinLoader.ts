/**
 * Loads a mannequin PNG (male|female) from /public and returns a data URL.
 * We convert to a data URL so the Cloud Function can receive the image body directly.
 */
export type MannequinKind = "female" | "male";

function publicPath(kind: MannequinKind): string {
    const p = kind === "female" ? "mannequin/female.png" : "mannequin/male.png";
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(p);
    }
    return `/${p}`;
}

function blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

export async function loadMannequin(kind: MannequinKind): Promise<string> {
    const url = publicPath(kind);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load mannequin (${kind}) at ${url}: ${res.status}`);
    const blob = await res.blob();
    return await blobToDataURL(blob);
}
