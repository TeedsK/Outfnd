/**
 * Outfnd — Image helpers
 * Purpose: Fetch remote product images (if CORS allows) and convert to data URLs
 *          so they can be passed to the Prompt API as multimodal input.
 */

export async function fetchImageAsDataUrl(url: string): Promise<string | undefined> {
    try {
        const res = await fetch(url, { mode: "cors" });
        if (!res.ok) return undefined;
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("Failed to read blob as data URL"));
            reader.readAsDataURL(blob);
        });
    } catch {
        return undefined;
    }
}
