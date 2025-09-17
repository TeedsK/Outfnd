/**
 * Outfnd — On-device AI stubs (strict, lint-safe)
 * Purpose: Mirror the shape of Chrome built-in APIs so we can wire the app
 *          before switching to real Summarizer / Translator / Prompt APIs.
 */

export async function detectLanguage(text: string): Promise<string> {
    // naive: ASCII → 'en', otherwise 'und'
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0x7f) return "und";
    }
    return "en";
}

export async function translate(
    text: string,
    opts: { from?: string; to: string }
): Promise<string> {
    if (opts.from && opts.to && opts.from.toLowerCase() === opts.to.toLowerCase()) {
        return text;
    }
    return text;
}

export async function summarizeKeyPoints(text: string, max = 5): Promise<string[]> {
    const parts = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
    return parts.slice(0, Math.max(1, Math.min(max, 8)));
}

export interface ClassifiedAttributes {
    category: string;
    colors: string[];
    material?: string[];
    pattern?: string[];
    seasonality?: string[];
    styleTags: string[];
    occasionTags?: string[];
}

export async function classifyAttributes(
    _imageDataUrl: string | undefined,
    textContext: string | undefined
): Promise<ClassifiedAttributes> {
    const lower = (textContext || "").toLowerCase();
    const category =
        /jacket|blazer|coat/.test(lower)
            ? "jacket"
            : /dress/.test(lower)
                ? "dress"
                : /pant|trouser/.test(lower)
                    ? "pants"
                    : "top";

    const colors = /black/.test(lower)
        ? ["black"]
        : /navy/.test(lower)
            ? ["navy"]
            : ["unknown"];

    return {
        category,
        colors,
        styleTags: ["minimal"]
    };
}
