/**
 * Outfnd — Clip types (shared)
 * Purpose: Common result shape for product extraction (JSON-LD / DOM).
 */
export type ClipSource = "json-ld" | "dom" | "mixed";

export interface ExtractedProduct {
    title: string;
    description?: string;
    images: string[];
    /** Explicit anchors for similarity: usually og:image + hero packshot. */
    anchors?: string[];
    retailer?: string;
    url: string;
    price?: number | null;
    currency?: string | null;
    language?: string;
    returnsText?: string;
    jsonLd?: unknown;
    source: ClipSource;
}

export interface ClipResponse {
    ok: boolean;
    product?: ExtractedProduct;
    error?: string;
}
