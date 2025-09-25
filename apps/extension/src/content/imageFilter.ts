/**
 * Outfnd — Image Filter & Scoring
 * Purpose: centralize heuristics to prefer product-only images (packshots, flat lays)
 *          and down-rank editorial/on-model/lifestyle shots.
 */

export interface ImageCandidate {
    url: string;
    origin?: "jsonld" | "img" | "source" | "bg" | "link" | "a" | "meta";
    alt?: string;
    classList?: string;
    area?: number; // from DOM if available (naturalWidth*naturalHeight or client area)
}

/** Normalize URL for de-duplication (remove volatile params, hashes). */
export function normalizeForDedupe(u: string): string {
    try {
        const url = new URL(u);
        const drop = new Set([
            "w", "h", "width", "height", "q", "quality", "auto", "fit", "crop", "format", "fm",
            "bg", "dpr", "imwidth", "wid", "hei", "resmode", "res", "size"
        ]);
        const kept = new URL(url.href);
        const next = new URLSearchParams();
        url.searchParams.forEach((v, k) => {
            if (!drop.has(k.toLowerCase())) next.set(k, v);
        });
        kept.search = next.toString() ? `?${next.toString()}` : "";
        kept.hash = "";
        return kept.toString();
    } catch {
        return u;
    }
}

function hasAny(hay: string, keys: string[]): boolean {
    const s = hay.toLowerCase();
    return keys.some((k) => s.includes(k));
}

function productLikePath(url: string): number {
    const p = url.toLowerCase();
    let score = 0;
    if (/-p(?:\.|\/|-)/.test(p)) score += 300; // Zara product suffix
    if (hasAny(p, ["packshot", "product", "/p/", "/prod/", "/products/"])) score += 250;
    if (hasAny(p, ["still", "studio", "cutout", "isolated", "isolation"])) score += 180;
    if (hasAny(p, ["front", "back", "side", "detail", "flat", "lay"])) score += 120;
    if (/-e(?:\.|\/|-)/.test(p)) score -= 250; // Zara editorial
    if (hasAny(p, ["look", "outfit", "editorial", "campaign", "lifestyle"])) score -= 200;
    if (hasAny(p, ["model", "catwalk", "runway"])) score -= 160;
    if (hasAny(p, ["/video", ".mp4", ".webm"])) score -= 400;
    return score;
}

function productLikeAlt(alt?: string): number {
    if (!alt) return 0;
    const a = alt.toLowerCase();
    let s = 0;
    if (hasAny(a, ["front", "back", "side", "detail", "product"])) s += 80;
    if (hasAny(a, ["flat", "lay", "packshot", "still"])) s += 120;
    if (hasAny(a, ["model", "on model", "worn"])) s -= 120;
    if (hasAny(a, ["look", "outfit"])) s -= 80;
    return s;
}

function productLikeClass(cls?: string): number {
    if (!cls) return 0;
    const c = cls.toLowerCase();
    let s = 0;
    if (hasAny(c, ["product", "gallery", "packshot", "still", "detail"])) s += 60;
    if (hasAny(c, ["editorial", "look", "outfit", "campaign", "model"])) s -= 120;
    return s;
}

function preferHighRes(url: string): number {
    try {
        const u = new URL(url);
        const w =
            parseInt(u.searchParams.get("w") || u.searchParams.get("width") || u.searchParams.get("imwidth") || u.searchParams.get("wid") || "", 10) || 0;
        if (w) return Math.min(w, 2400) / 4;
    } catch { /* noop */ }
    if (/\/p\/|product|catalog|assets|images/i.test(url)) return 100;
    return 40;
}

/** Score one candidate. Higher is better (product-only packshot preferred). */
export function scoreImageCandidate(c: ImageCandidate): number {
    let score = 0;
    score += productLikePath(c.url);
    score += productLikeAlt(c.alt);
    score += productLikeClass(c.classList);
    if (c.origin === "img" || c.origin === "source") score += 20;
    if (c.origin === "bg" || c.origin === "a") score -= 10;
    if (c.area && c.area > 0) {
        score += Math.min(200, Math.floor(c.area / 4000));
    } else {
        score += preferHighRes(c.url);
    }
    return score;
}

/** Finalize a set of candidates → unique, ranked URL list. */
export function finalizeImageCandidates(cands: ImageCandidate[], max = 24): string[] {
    const byKey = new Map<string, { url: string; score: number }>();
    for (const c of cands) {
        const key = normalizeForDedupe(c.url);
        const s = scoreImageCandidate(c);
        const prev = byKey.get(key);
        if (!prev || s > prev.score) byKey.set(key, { url: c.url, score: s });
    }
    return Array.from(byKey.values())
        .sort((a, b) => b.score - a.score)
        .map((x) => x.url)
        .slice(0, max);
}
