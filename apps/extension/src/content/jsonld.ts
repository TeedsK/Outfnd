/**
 * Outfnd — JSON-LD extractor
 * Purpose: Parse <script type="application/ld+json"> blocks and locate a Product.
 * Update: expose image candidates for LLM selection; keep extractor for fallback only.
 */
import type { ExtractedProduct } from "@outfnd/shared/clip";
import type { ImageCandidate } from "./imageFilter";
import { finalizeImageCandidates } from "./imageFilter";

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const toArray = <T>(v: T | T[] | undefined | null): T[] =>
    v == null ? [] : Array.isArray(v) ? v : [v];

function safeParse(text: string): unknown | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function asProductCandidate(obj: unknown): JsonObject | null {
    if (!isObject(obj)) return null;
    const t = obj["@type"];
    if (typeof t === "string" && t.toLowerCase() === "product") return obj;
    if (Array.isArray(t) && t.some((s) => String(s).toLowerCase() === "product")) return obj;
    return null;
}

function findProduct(node: unknown): JsonObject | null {
    if (!node) return null;

    const direct = asProductCandidate(node);
    if (direct) return direct;

    if (isObject(node)) {
        const g = node["@graph"];
        if (Array.isArray(g)) {
            for (const item of g) {
                const p = asProductCandidate(item);
                if (p) return p;
            }
        }
        for (const key of Object.keys(node)) {
            const p = findProduct(node[key]);
            if (p) return p;
        }
    } else if (Array.isArray(node)) {
        for (const item of node) {
            const p = findProduct(item);
            if (p) return p;
        }
    }
    return null;
}

function parsePrice(numLike: unknown): number | null {
    if (typeof numLike === "number") return numLike;
    if (typeof numLike === "string") {
        const normalized = numLike.replace(/[^\d,.-]/g, "").replace(/,(\d{2})$/, ".$1");
        const n = Number(normalized);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** Recursively collect any image-like URLs from a JSON object. */
function collectImagesDeep(node: unknown): string[] {
    const out: string[] = [];
    const visit = (v: unknown) => {
        if (typeof v === "string") {
            if (/^data:image\//i.test(v) || /\.(jpe?g|png|webp|avif)(\?|#|$)/i.test(v)) out.push(v);
            return;
        }
        if (Array.isArray(v)) {
            for (const x of v) visit(x);
            return;
        }
        if (isObject(v)) {
            for (const [, val] of Object.entries(v)) visit(val);
        }
    };
    visit(node);
    return out;
}

/** Exported: collect JSON-LD image candidates for selection. */
export function collectJsonLdImageCandidates(doc: Document): ImageCandidate[] {
    const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
        const raw = s.textContent || "";
        const parsed = safeParse(raw);
        if (!parsed) continue;
        const product = findProduct(parsed);
        if (!product) continue;

        const primary = toArray<string>(product.image as string | string[] | undefined).filter(Boolean);
        const deep = collectImagesDeep(product);
        const urls = [...primary, ...deep];
        return urls.map((url) => ({ url, origin: "jsonld" }));
    }
    return [];
}

/** Legacy extractor (fallback only when no selection is applied). */
export function extractFromJsonLd(doc: Document): ExtractedProduct | null {
    const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
        const raw = s.textContent || "";
        const parsed = safeParse(raw);
        if (!parsed) continue;

        const product = findProduct(parsed);
        if (!product) continue;

        const name = (product.name as string | undefined) ?? (product.title as string | undefined);
        const desc = (product.description as string | undefined) ??
            ((product as JsonObject)["descriptionShort"] as string | undefined);

        const primary = toArray<string>(product.image as string | string[] | undefined).filter(Boolean);
        const deep = collectImagesDeep(product);

        const imageArr = finalizeImageCandidates([...primary, ...deep].map((u) => ({ url: u, origin: "jsonld" })), 24);

        const offers = toArray<JsonObject>(product.offers as JsonObject | JsonObject[] | undefined);

        const brandVal = product.brand as unknown;
        const brand =
            (isObject(brandVal) ? (brandVal.name as string | undefined) : (brandVal as string)) ||
            undefined;

        let price: number | null = null;
        let currency: string | null = null;

        if (offers.length > 0) {
            const off = offers[0];
            price =
                parsePrice(off?.price) ??
                parsePrice((off?.priceSpecification as JsonObject | undefined)?.["price"]);
            const curr =
                (off?.priceCurrency as string | undefined) ??
                ((off?.priceSpecification as JsonObject | undefined)?.[
                    "priceCurrency"
                ] as string | undefined) ??
                (off?.priceCurrencyCode as string | undefined) ??
                null;
            currency = curr ?? null;
        }

        const url = (product.url as string | undefined) || doc.location.href;

        const candidate: ExtractedProduct = {
            title: name || doc.title || "Untitled product",
            description: desc,
            images: imageArr.length ? imageArr : [],
            retailer: brand || new URL(doc.location.href).hostname.replace(/^www\./, ""),
            url,
            price,
            currency,
            source: "json-ld",
            jsonLd: product
        };

        return candidate;
    }
    return null;
}
