/**
 * Outfnd — Clipper orchestrator
 * Purpose: Run JSON-LD and DOM extractors, then merge into one result.
 */
import type { ClipResponse, ExtractedProduct } from "@outfnd/shared/clip";
import { extractFromJsonLd } from "./jsonld";
import { extractFromDom } from "./domExtract";

function merge(a: ExtractedProduct | null, b: ExtractedProduct | null): ExtractedProduct | null {
    if (!a && !b) return null;
    if (a && !b) return a;
    if (!a && b) return b;

    // Merge (prefer JSON-LD for structured fields; fill gaps from DOM)
    const json = a!;
    const dom = b!;
    return {
        title: json.title || dom.title,
        description: json.description || dom.description,
        images: json.images.length ? json.images : dom.images,
        retailer: json.retailer || dom.retailer,
        url: json.url || dom.url,
        price: json.price ?? dom.price ?? null,
        currency: json.currency ?? dom.currency ?? null,
        returnsText: json.returnsText || dom.returnsText,
        jsonLd: json.jsonLd ?? undefined,
        source: "mixed"
    };
}

export async function clipCurrentDocument(): Promise<ClipResponse> {
    try {
        const json = extractFromJsonLd(document);
        const dom = extractFromDom(document);
        const product = merge(json, dom) || json || dom;

        if (!product) {
            return { ok: false, error: "No product details found on this page." };
        }
        return { ok: true, product };
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: message };
    }
}
