/**
 * Cloud AI Logic client — text ops, looks, garment description, and image renders.
 * Update: renderLook now accepts rich per-item `hints` (RenderHints) in addition to legacy `hintBullets`.
 */
import { aiLogicUrl, isAiLogicConfigured } from "../config/env";
import type { Outfit, WardrobeItem, RenderHints } from "@outfnd/shared/types";
import type { ClassifiedAttributes } from "../ai/stubs";
import { ATTRIBUTE_SCHEMA, LOOKS_SCHEMA, GARMENT_HINTS_SCHEMA } from "../ai/jsonSchemas";

async function post<T>(op: string, payload: unknown): Promise<T> {
    if (!isAiLogicConfigured || !aiLogicUrl) throw new Error("AI Logic endpoint not configured");
    const res = await fetch(aiLogicUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Client": "Outfnd/extension"
        },
        body: JSON.stringify({ op, payload })
    });
    if (!res.ok) throw new Error(`AI Logic ${op} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
}

/* ------- Optional text ops ------- */
export async function cloudSummarizeKeyPoints(text: string): Promise<string[]> {
    const out = await post<{ bullets?: unknown }>("summarize", { text, type: "key-points" });
    const arr = Array.isArray(out.bullets) ? out.bullets.map((x) => String(x)) : [];
    return arr.slice(0, 5);
}
export async function cloudDetectLanguage(text: string): Promise<string> {
    const out = await post<{ language?: unknown }>("detectLanguage", { text });
    return typeof out.language === "string" ? out.language : "und";
}
export async function cloudTranslate(
    text: string,
    from: string | undefined,
    to: string
): Promise<string> {
    const out = await post<{ translated?: unknown }>("translate", { text, from, to });
    return typeof out.translated === "string" ? out.translated : text;
}

/* ------- Classify attributes (returns ClassifiedAttributes) ------- */
export async function cloudClassifyAttributes(
    imageDataUrl: string | undefined,
    textContext: string
): Promise<ClassifiedAttributes> {
    const raw = await post<Record<string, unknown>>("classify", {
        text: textContext,
        imageDataUrl,
        schema: ATTRIBUTE_SCHEMA
    });

    const arr = (k: string): string[] => {
        const v = raw[k];
        return Array.isArray(v) ? v.map(String) : [];
    };
    const str = (k: string): string | undefined =>
        typeof raw[k] === "string" ? (raw[k] as string) : undefined;

    const out: ClassifiedAttributes = {
        category: str("category") || "top",
        colors: arr("colors").length ? arr("colors") : ["unknown"],
        styleTags: arr("styleTags").length ? arr("styleTags") : ["minimal"]
    };

    const material = arr("material");
    const pattern = arr("pattern");
    const seasonality = arr("seasonality");
    const occasionTags = arr("occasionTags");
    if (material.length) out.material = material;
    if (pattern.length) out.pattern = pattern;
    if (seasonality.length) out.seasonality = seasonality;
    if (occasionTags.length) out.occasionTags = occasionTags;

    return out;
}

/* ------- Compose looks (cloud JSON mode) ------- */
export async function cloudComposeLooks(
    wardrobe: WardrobeItem[],
    createdFromItemId?: string
): Promise<Outfit[]> {
    const payload = {
        wardrobe: wardrobe.map((w) => ({
            id: w.id,
            title: w.title,
            category: w.attributes.category,
            colors: w.attributes.colors,
            styleTags: w.attributes.styleTags
        })),
        createdFromItemId,
        schema: LOOKS_SCHEMA
    };
    const out = await post<{ looks?: unknown[] }>("composeLooks", payload);
    const arr = Array.isArray(out.looks) ? out.looks : [];
    const now = Date.now();
    return arr.map((e, i) => {
        const r = (e ?? {}) as Record<string, unknown>;
        const itemsRaw = Array.isArray(r["items"]) ? (r["items"] as unknown[]) : [];
        const items = itemsRaw.map((it) => {
            const ir = (it ?? {}) as Record<string, unknown>;
            return {
                itemId: String(ir["itemId"] ?? ""),
                role: String(ir["role"] ?? "top") as Outfit["items"][number]["role"]
            };
        });
        return {
            id: `cloud_${now}_${i}`,
            occasion: String(r["occasion"] ?? "casual") as Outfit["occasion"],
            items,
            rationale: typeof r["rationale"] === "string" ? r["rationale"] : undefined,
            createdFromItemId,
            createdAt: now
        };
    });
}

/* ------- Garment description (image+text → hints) ------- */
export interface DescribeGarmentInput {
    title?: string;
    text?: string;
    imageUrls?: string[];
    imageDataUrls?: string[];
}
export async function cloudDescribeGarment(input: DescribeGarmentInput): Promise<RenderHints> {
    const out = await post<Record<string, unknown>>("describeGarment", {
        ...input,
        schema: GARMENT_HINTS_SCHEMA
    });
    const s = (k: string) => (typeof out[k] === "string" ? (out[k] as string) : undefined);
    const a = (k: string) => (Array.isArray(out[k]) ? (out[k] as unknown[]).map(String) : undefined);

    return {
        bullets: a("bullets") ?? [],
        fit: s("fit"),
        silhouette: s("silhouette"),
        length: s("length"),
        waist: s("waist"),
        rise: s("rise"),
        sleeve: s("sleeve"),
        neckline: s("neckline"),
        drape: s("drape"),
        fabricWeight: s("fabricWeight"),
        pattern: s("pattern"),
        placementCues: a("placementCues"),
        stylingNotes: a("stylingNotes"),
        mannequinRecommendation: s("mannequinRecommendation") as RenderHints["mannequinRecommendation"]
    };
}

/* ------- Render look ------- */
export interface RenderItemInput {
    title: string;
    role: string;
    imageUrl?: string;
    /** Legacy support: brief bullets */
    hintBullets?: string[];
    /** Preferred rich hints */
    hints?: RenderHints;
}
export interface RenderLookInput {
    mannequinUrl?: string;
    mannequinDataUrl?: string;
    items: RenderItemInput[];
    style?: string;
    background?: string;
}
export async function cloudRenderLookPreview(input: RenderLookInput): Promise<string> {
    const out = await post<{ dataUrl?: string }>("renderLook", input);
    return typeof out.dataUrl === "string" ? out.dataUrl : "";
}
