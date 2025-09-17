/**
 * Outfnd — DOM fallback extractor
 * Purpose: Heuristics for sites lacking good JSON-LD. Uses meta tags + visible DOM.
 */
import type { ExtractedProduct } from "@outfnd/shared/clip";

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

function parsePriceFromText(
    text?: string | null
): { price: number | null; currency: string | null } {
    if (!text) return { price: null, currency: null };
    const currencyMatch = text.match(
        /(?:USD|EUR|GBP|JPY|AUD|CAD|CHF|CNY|HKD|SGD)/i
    );
    const symbolMatch = text.match(/[$€£¥]/);
    const currency = currencyMatch?.[0]?.toUpperCase() ?? (symbolMatch ? symbolMatch[0] : null);

    // numbers like 1,299.99 or 1299,99
    const numMatch = text
        .replace(/\s/g, "")
        .match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})?)/);
    if (!numMatch) return { price: null, currency };
    const normalized = numMatch[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const price = Number(normalized);
    return { price: Number.isFinite(price) ? price : null, currency };
}

function gatherImages(doc: Document): string[] {
    const set = new Set<string>();
    const og = meta(doc, ["og:image", "twitter:image"]);
    if (og) set.add(og);

    doc
        .querySelectorAll(
            'img[src*="product"], img[src*="hero"], .product img, [data-testid*="image"] img'
        )
        .forEach((img) => {
            const src = (img as HTMLImageElement).src;
            if (src) set.add(src);
        });

    return Array.from(set);
}

function findReturnsText(doc: Document): string | undefined {
    // Heuristic: look for sections mentioning returns/exchanges
    const blocks = Array.from(doc.querySelectorAll("details, section, div, article"))
        .slice(0, 100)
        .map((el) => el.textContent || "");

    const idx = blocks.findIndex((t) =>
        /return|refund|exchange|devolución|retour|retorno|返品/i.test(t)
    );
    if (idx >= 0) {
        return blocks[idx].trim().replace(/\s{2,}/g, " ").slice(0, 600);
    }
}

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
        // Try visible price nodes
        const candidate = doc.querySelector(
            '[itemprop="price"], .price, .ProductPrice, [data-testid*="price"]'
        )?.textContent;
        const parsed = parsePriceFromText(candidate || undefined);
        price = parsed.price;
        currency = parsed.currency;
    }

    const url = meta(doc, ["og:url"]) || doc.location.href;
    const images = gatherImages(doc);
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
