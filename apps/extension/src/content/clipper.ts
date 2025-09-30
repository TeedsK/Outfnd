/**
 * Outfnd — Clipper orchestrator
 * Purpose: Run JSON-LD and DOM extractors, then merge into one result.
 *
 * Update (critical):
 *  - DO NOT call the cloud image selector here. We return ALL deduped candidates.
 *  - Also return explicit anchors (og:image + best hero IMG) so the side panel can
 *    drive bucketing with the full set of images.
 *  - Add structured console.debug logs to trace what was discovered.
 */
import type { ClipResponse, ExtractedProduct } from "@outfnd/shared/clip";
import { extractFromJsonLd, collectJsonLdImageCandidates } from "./jsonld";
import { extractFromDom, collectDomImageCandidates } from "./domExtract";
import {
    type ImageCandidate,
    scoreImageCandidate,
    normalizeForDedupe,
    finalizeImageCandidates
} from "./imageFilter";

function merge(a: ExtractedProduct | null, b: ExtractedProduct | null): ExtractedProduct | null {
    if (!a && !b) return null;
    if (a && !b) return a;
    if (!a && b) return b;

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
        source: "mixed",
        // anchors filled later by this orchestrator
        anchors: undefined
    };
}

function pickOgImage(doc: Document): string | undefined {
    const el = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
    const c = el?.getAttribute("content");
    try { return c ? new URL(c, doc.location.href).href : undefined; } catch { return undefined; }
}

/** Likely hero IMG (largest, product-like). */
function pickHeroImg(doc: Document, cands: ImageCandidate[]): string | undefined {
    let best: { u: string; v: number } | undefined;
    for (const c of cands) {
        if (c.origin !== "img" && c.origin !== "source") continue;
        const v = scoreImageCandidate(c) + (c.area ? Math.min(200, Math.floor(c.area / 4000)) : 0);
        if (!best || v > best.v) best = { u: c.url, v };
    }
    return best?.u;
}

/** Collect short page text to help the model (title + description + bullets). */
function collectPageContext(doc: Document): { title: string; text: string } {
    const title = doc.title || "";
    const metaDesc =
        doc.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute("content") || "";

    const headings = Array.from(doc.querySelectorAll("h1, h2, h3"))
        .map((el) => el.textContent || "")
        .filter(Boolean)
        .slice(0, 8)
        .join("\n");

    const bullets = Array.from(doc.querySelectorAll("li"))
        .map((el) => (el.textContent || "").trim())
        .filter((t) => t.length > 0 && t.length < 140)
        .slice(0, 20)
        .join("\n");

    const text = [metaDesc, headings, bullets].filter(Boolean).join("\n\n").slice(0, 1800);
    return { title, text };
}

/** De-duplicate candidates by normalized URL and return a scored list. */
function dedupeAndScore(cands: ImageCandidate[]): Array<{ url: string; score: number; origin?: string }> {
    const byKey = new Map<string, { url: string; score: number; origin?: string }>();
    for (const c of cands) {
        const key = normalizeForDedupe(c.url);
        const s = scoreImageCandidate(c);
        const prev = byKey.get(key);
        if (!prev || s > prev.score) byKey.set(key, { url: c.url, score: s, origin: c.origin });
    }
    return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
}

export async function clipCurrentDocument(): Promise<ClipResponse> {
    try {
        // 1) Baseline merged structure (title, price, etc.)
        const json = extractFromJsonLd(document);
        const dom = extractFromDom(document);
        const merged = merge(json, dom) || json || dom;

        if (!merged) {
            return { ok: false, error: "No product details found on this page." };
        }

        // 2) Gather all image candidates
        const domCands = collectDomImageCandidates(document);
        const jsonCands = collectJsonLdImageCandidates(document);
        const allCands = [...domCands, ...jsonCands];

        // 3) Find anchors
        const anchors: string[] = [];
        const og = pickOgImage(document);
        if (og) anchors.push(og);
        const hero = pickHeroImg(document, domCands);
        if (hero) anchors.push(hero);

        // 4) De-dup + rank (NO cloud filtering here; we want a superset back in the panel)
        const scored = dedupeAndScore(allCands); // keep order by score
        const selected = scored.map((s) => s.url).slice(0, 40); // cap payload size

        // Ensure absolute URLs
        const finalImages = selected
            .map((u) => {
                try { return new URL(u, document.location.href).href; } catch { return u; }
            })
            .filter(Boolean);

        const product: ExtractedProduct = {
            ...merged,
            images: finalImages.length ? finalImages : merged.images,
            anchors: Array.from(new Set(anchors))
        };

        const { title: pageTitle } = collectPageContext(document);
        console.debug("[Outfnd] clipper collected", {
            pageTitle,
            domCandidates: domCands.length,
            jsonLdCandidates: jsonCands.length,
            allCandidates: allCands.length,
            dedupedRanked: scored.length,
            finalImages: product.images.length,
            anchors: product.anchors
        });

        return { ok: true, product };
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: message };
    }
}
