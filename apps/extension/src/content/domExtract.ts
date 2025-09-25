/**
 * Outfnd — DOM fallback extractor
 * Purpose: Heuristics for sites lacking good JSON-LD. Uses meta tags + visible DOM.
 * Update: expose raw DOM ImageCandidates for selection; keep extractor for fallback.
 */
import type { ExtractedProduct } from "@outfnd/shared/clip";
import { finalizeImageCandidates, type ImageCandidate } from "./imageFilter";

/* Meta helpers */
function meta(doc: Document, names: string[]): string | undefined {
    for (const n of names) {
        const el =
            doc.querySelector(`meta[name="${n}"]`) ||
            doc.querySelector(`meta[property="${n}"]`);
        const v = el?.getAttribute("content")?.trim();
        if (v) return v;
    }
}

function firstNonEmpty(...candidates: Array<string | undefined | null>) {
    for (const c of candidates) if (c && c.trim()) return c.trim();
}

/* Price helpers */
function parsePriceFromText(text?: string | null): { price: number | null; currency: string | null } {
    if (!text) return { price: null, currency: null };
    const currencyMatch = text.match(/(?:USD|EUR|GBP|JPY|AUD|CAD|CHF|CNY|HKD|SGD)/i);
    const symbolMatch = text.match(/[$€£¥]/);
    const currency = currencyMatch?.[0]?.toUpperCase() ?? (symbolMatch ? symbolMatch[0] : null);
    const numMatch = text.replace(/\s/g, "").match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})?)/);
    if (!numMatch) return { price: null, currency };
    const normalized = numMatch[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const price = Number(normalized);
    return { price: Number.isFinite(price) ? price : null, currency };
}

/* URL helpers */
function absUrl(doc: Document, u: string | null | undefined): string | null {
    try {
        if (!u) return null;
        const href = new URL(u, doc.location.href).href;
        if (/\.(svg|gif|ico)(\?|#|$)/i.test(href)) return null;
        if (!/^data:image\//i.test(href) && !/\.(jpe?g|png|webp|avif)(\?|#|$)/i.test(href)) return null;
        return href;
    } catch {
        return null;
    }
}

function pickBestFromSrcset(doc: Document, srcset: string | null | undefined): string | null {
    if (!srcset) return null;
    let bestUrl: string | null = null;
    let bestScore = -1;
    for (const part of srcset.split(",")) {
        const seg = part.trim();
        if (!seg) continue;
        const [u, d] = seg.split(/\s+/);
        const urlAbs = absUrl(doc, u);
        if (!urlAbs) continue;

        let score = 0;
        if (d) {
            const mW = d.match(/(\d+)\s*w/i);
            const mX = d.match(/(\d+(?:\.\d+)?)\s*x/i);
            if (mW) score = parseInt(mW[1], 10);
            else if (mX) score = Math.round(parseFloat(mX[1]) * 1000);
        }
        if (score > bestScore) { bestScore = score; bestUrl = urlAbs; }
    }
    return bestUrl;
}

function extractBgUrl(styleVal: string | null | undefined): string | null {
    if (!styleVal) return null;
    const m = styleVal.match(/url\((["']?)([^"')]+)\1\)/i);
    return m?.[2] ?? null;
}

/* --- Exported: collect DOM candidates --- */
export function collectDomImageCandidates(doc: Document): ImageCandidate[] {
    const cands: ImageCandidate[] = [];

    // OG/Twitter
    const og = meta(doc, ["og:image", "twitter:image"]);
    if (og) {
        const a = absUrl(doc, og);
        if (a) cands.push({ url: a, origin: "meta" });
    }

    // <img>
    const imgs = Array.from(doc.querySelectorAll("img"));
    for (const img of imgs) {
        const el = img as HTMLImageElement;
        const direct = absUrl(doc, el.getAttribute("src") || el.src);
        const bestFromSrcset = pickBestFromSrcset(doc, el.getAttribute("srcset"));
        const dataSrc = absUrl(
            doc,
            el.getAttribute("data-src") ||
            el.getAttribute("data-original") ||
            el.getAttribute("data-zoom-image") ||
            el.getAttribute("data-image") ||
            el.getAttribute("data-image-url")
        );
        const dataSrcsetBest = pickBestFromSrcset(doc, el.getAttribute("data-srcset"));

        const area =
            (el.naturalWidth && el.naturalHeight && el.naturalWidth * el.naturalHeight) ||
            (el.clientWidth * el.clientHeight) ||
            undefined;

        for (const u of [bestFromSrcset, dataSrcsetBest, direct, dataSrc]) {
            if (!u) continue;
            cands.push({
                url: u,
                origin: "img",
                alt: el.getAttribute("alt") ?? undefined,
                classList: el.getAttribute("class") ?? undefined,
                area
            });
        }
    }

    // <picture><source>
    const sources = Array.from(doc.querySelectorAll("picture source"));
    for (const src of sources) {
        const best = pickBestFromSrcset(doc, (src as HTMLSourceElement).getAttribute("srcset"));
        if (best) cands.push({ url: best, origin: "source", classList: src.getAttribute("class") ?? undefined });
    }

    // Inline background-image
    const bgEls = Array.from(doc.querySelectorAll<HTMLElement>("[style*='background-image']"));
    for (const el of bgEls) {
        const u = extractBgUrl(el.getAttribute("style"));
        const a = absUrl(doc, u || undefined);
        if (a) cands.push({ url: a, origin: "bg", classList: el.className || undefined, area: el.clientWidth * el.clientHeight });
    }

    // <link rel="preload" as="image">
    const preloadLinks = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]'));
    for (const l of preloadLinks) {
        const a = absUrl(doc, l.getAttribute("href") || undefined);
        const best = pickBestFromSrcset(doc, l.getAttribute("imagesrcset"));
        const bestAny = best || a;
        if (bestAny) cands.push({ url: bestAny, origin: "link" });
    }

    // <a href="...jpg"> (zoom/gallery)
    const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const a of anchors) {
        const href = absUrl(doc, a.getAttribute("href") || undefined);
        if (href) cands.push({ url: href, origin: "a", classList: a.className || undefined });
    }

    return cands;
}

function findReturnsText(doc: Document): string | undefined {
    const blocks = Array.from(doc.querySelectorAll("details, section, div, article, li"))
        .slice(0, 300)
        .map((el) => el.textContent || "");

    const idx = blocks.findIndex((t) =>
        /return|refund|exchange|devolución|retour|retorno|返品/i.test(t)
    );
    if (idx >= 0) {
        return blocks[idx].trim().replace(/\s{2,}/g, " ").slice(0, 1000);
    }
}

/* --- Fallback extractor (no LLM) --- */
export function extractFromDom(doc: Document): ExtractedProduct | null {
    const title = firstNonEmpty(
        meta(doc, ["og:title", "twitter:title"]),
        doc.querySelector("h1")?.textContent || undefined,
        doc.title
    );

    const description = firstNonEmpty(
        meta(doc, ["og:description", "description", "twitter:description"])
    );

    // Price & currency from meta first
    const priceContent = firstNonEmpty(
        meta(doc, ["product:price:amount", "og:price:amount"]),
        meta(doc, ["twitter:data1"])
    );
    const currencyContent = firstNonEmpty(
        meta(doc, ["product:price:currency", "og:price:currency"])
    );

    let price: number | null = null;
    let currency: string | null = null;

    if (priceContent || currencyContent) {
        const parsed = parsePriceFromText(`${currencyContent || ""} ${priceContent || ""}`);
        price = parsed.price;
        currency = parsed.currency;
    } else {
        const candidate = doc.querySelector(
            '[itemprop="price"], .price, .ProductPrice, [data-testid*="price"]'
        )?.textContent;
        const parsed = parsePriceFromText(candidate || undefined);
        price = parsed.price;
        currency = parsed.currency;
    }

    const url = meta(doc, ["og:url"]) || doc.location.href;

    const images = finalizeImageCandidates(collectDomImageCandidates(doc), 24);

    const retailer = new URL(doc.location.href).hostname.replace(/^www\./, "");
    const returnsText = findReturnsText(doc);

    if (!title && images.length === 0) return null;

    return {
        title: title || "Untitled product",
        description,
        images,
        retailer,
        url,
        price: price ?? null,
        currency: currency ?? null,
        returnsText,
        source: "dom"
    };
}
