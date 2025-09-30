/**
 * Cloud AI Logic client — text ops, looks, garment description, image selection, and image renders.
 * Adds: health ping + richer request/response logs + x-outfnd-client header.
 */
import { aiLogicUrl, isAiLogicConfigured } from "../config/env";
import type { Outfit, WardrobeItem, RenderHints } from "@outfnd/shared/types";
import type { ClassifiedAttributes } from "../ai/stubs";
import { ATTRIBUTE_SCHEMA, LOOKS_SCHEMA, GARMENT_HINTS_SCHEMA } from "../ai/jsonSchemas";

function clientTag(): string {
    try {
        // Chrome extension id is stable across the session; helps correlate logs
        const id = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "noid";
        return `ext/${id}`;
    } catch {
        return "ext/unknown";
    }
}

async function post<T>(op: string, payload: unknown): Promise<T> {
    if (!isAiLogicConfigured || !aiLogicUrl) throw new Error("AI Logic endpoint not configured");
    const res = await fetch(aiLogicUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-outfnd-client": clientTag()
        },
        body: JSON.stringify({ op, payload })
    });
    if (!res.ok) throw new Error(`AI Logic ${op} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
}

/* ------- Health ------- */
export async function cloudHealth(): Promise<Record<string, unknown>> {
    const out = await post<Record<string, unknown>>("health", {});
    // One concise log line
    console.debug("[Outfnd] aiLogic health", out);
    return out;
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
export async function cloudTranslate(text: string, from: string | undefined, to: string): Promise<string> {
    const out = await post<{ translated?: unknown }>("translate", { text, from, to });
    return typeof out.translated === "string" ? out.translated : text;
}

/* ------- Classify attributes ------- */
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

/* ------- Compose looks ------- */
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
        mannequinRecommendation: s("mannequinRecommendation")
    };
}

/* ------- Image selection (3 buckets) ------- */
export interface SelectGroups {
    confident: string[];
    semiConfident: string[];
    notConfident: string[];
}
export interface SelectProductImagesOutput {
    groups: SelectGroups;
    selected?: string[];
    debug?: unknown;
}

export async function cloudSelectProductImages(
    anchors: string[],
    candidates: string[],
    pageTitle?: string,
    pageText?: string
): Promise<SelectProductImagesOutput> {
    const payload = {
        anchors,
        candidates: candidates.map((url) => ({ url })),
        pageTitle,
        pageText,
        maxInline: 12
    };

    console.debug("[Outfnd] selectProductImages:request", {
        aiLogicUrl,
        anchorsCount: anchors.length,
        candidateCount: candidates.length,
        anchorsPreview: anchors.slice(0, 3)
    });

    const out = await post<SelectProductImagesOutput>("selectProductImages", payload);

    // Friendly totals line for DevTools
    const g = out.groups;
    const totals = {
        confident: Array.isArray(g?.confident) ? g.confident.length : 0,
        semiConfident: Array.isArray(g?.semiConfident) ? g.semiConfident.length : 0,
        notConfident: Array.isArray(g?.notConfident) ? g.notConfident.length : 0,
        all: (Array.isArray(g?.confident) ? g.confident.length : 0)
            + (Array.isArray(g?.semiConfident) ? g.semiConfident.length : 0)
            + (Array.isArray(g?.notConfident) ? g.notConfident.length : 0)
    };
    console.debug("[Outfnd] selectProductImages:response", totals);

    return out;
}

/* ------- Render look ------- */
export interface RenderItemInput {
    title: string;
    role: string;
    imageUrl?: string;
    imageUrls?: string[];
    hintBullets?: string[];
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
