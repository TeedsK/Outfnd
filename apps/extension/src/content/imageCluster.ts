/**
 * Outfnd — Image Clustering (single product selection)
 * Goal: from many image candidates, select only those belonging to the primary
 *       product shown on the page (multiple angles), excluding other items/banners.
 *
 * Strategy:
 *  - Extract a "product key" from URLs (e.g., Zara SKU: 06987325409) using
 *    filename/path patterns like "<digits>-p" or any long digit run.
 *  - Gather anchors: OG image + largest product-like IMG.
 *  - Compute anchor similarity (Jaccard over URL tokens) and host matches.
 *  - Cluster candidates by product key; prefer the cluster that matches anchor keys,
 *    same host, and highest summed (score + anchorSim).
 */

import { ImageCandidate, scoreImageCandidate, normalizeForDedupe } from "./imageFilter";

/** Tokenize URL path into parts for similarity. */
function urlTokens(u: string): Set<string> {
    try {
        const { pathname } = new URL(u);
        const base = pathname.toLowerCase();
        const parts = base.split(/[\/._\-]+/).filter(Boolean);
        const digits = base.match(/\d{6,}/g) ?? []; // long number runs
        for (const d of digits) parts.push(d);
        return new Set(parts);
    } catch {
        return new Set();
    }
}

/** Jaccard similarity between two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

/** Extract a "product key" (e.g., SKU digits) from retailer-style URLs. */
export function extractProductKeyFromUrl(u: string): string | null {
    try {
        const { pathname } = new URL(u);
        const p = pathname.toLowerCase();

        // Pattern like ".../06987325409-p/06987325409-p.jpg" or "...06987325409-p.jpg"
        const mSku = p.match(/(\d{6,})[-_](?:p|e)(?:[./_-]|$)/i);
        if (mSku) return mSku[1];

        // Any long digit run (take the longest)
        const runs = p.match(/\d{6,}/g);
        if (runs && runs.length) {
            runs.sort((a, b) => b.length - a.length);
            return runs[0];
        }

        // Fallback: last two segments without extension
        const segs = p.split("/").filter(Boolean);
        if (segs.length) {
            const last = segs[segs.length - 1].replace(/\.[a-z0-9]+$/i, "");
            const prev = segs[segs.length - 2]?.replace(/\.[a-z0-9]+$/i, "");
            return [prev, last].filter(Boolean).join(":") || last || null;
        }
        return null;
    } catch {
        return null;
    }
}

interface ScoredCand {
    cand: ImageCandidate;
    score: number;
    key: string | null;
    anchorSim: number;
    host: string | null;
}

/** Build scored candidates with anchor similarity and product key. */
function scoreAgainstAnchors(cands: ImageCandidate[], anchors: string[]): ScoredCand[] {
    const anchorTokens = anchors.map(urlTokens);
    const anchorHosts = new Set<string>();
    for (const a of anchors) {
        try { anchorHosts.add(new URL(a).hostname); } catch { /* noop */ }
    }

    return cands.map((cand) => {
        const s = scoreImageCandidate(cand);
        let bestSim = 0;
        const t = urlTokens(cand.url);
        for (const at of anchorTokens) bestSim = Math.max(bestSim, jaccard(t, at));
        let host: string | null = null;
        try { host = new URL(cand.url).hostname; } catch { host = null; }
        // Small bump if same host as any anchor
        const hostBump = host && anchorHosts.has(host) ? 0.05 : 0;
        const key = extractProductKeyFromUrl(cand.url);
        return { cand, score: s, key, anchorSim: Math.min(1, bestSim + hostBump), host };
    });
}

function pickHeroImgCandidate(cands: ImageCandidate[]): string | undefined {
    // Heuristic: the IMG with highest (score + area bump)
    let best: { url: string; v: number } | undefined;
    for (const c of cands) {
        if (c.origin !== "img" && c.origin !== "source") continue;
        const v = scoreImageCandidate(c) + (c.area ? Math.min(200, Math.floor(c.area / 4000)) : 0);
        if (!best || v > best.v) best = { url: c.url, v };
    }
    return best?.url;
}

/**
 * Select only the images that belong to the primary product.
 * Returns ordered URLs (best first).
 */
export function selectPrimaryProductImages(
    allCandidates: ImageCandidate[],
    anchors: string[],
    max = 24
): string[] {
    // Ensure we have at least one anchor (fallback to best hero IMG)
    const uniqAnchors = Array.from(new Set(anchors.filter(Boolean)));
    if (uniqAnchors.length === 0) {
        const hero = pickHeroImgCandidate(allCandidates);
        if (hero) uniqAnchors.push(hero);
    }

    const scored = scoreAgainstAnchors(allCandidates, uniqAnchors);

    // Build clusters by product key
    const clusters = new Map<string, ScoredCand[]>();
    for (const sc of scored) {
        const k = sc.key ?? "__nokey__";
        const arr = clusters.get(k) ?? [];
        arr.push(sc);
        clusters.set(k, arr);
    }

    // Extract anchor keys (from the anchors themselves)
    const anchorKeys = uniqAnchors
        .map((u) => extractProductKeyFromUrl(u))
        .filter((x): x is string => !!x);

    // Score clusters
    let bestKey = "";
    let bestClusterScore = -Infinity;

    for (const [key, arr] of clusters.entries()) {
        const sumScore = arr.reduce((acc, sc) => acc + sc.score, 0);
        const sumAnchor = arr.reduce((acc, sc) => acc + sc.anchorSim * 400, 0); // strong weight towards anchor similarity
        const sameKeyBonus = anchorKeys.includes(key) ? 1500 : 0;
        const hasPackshot = arr.some((sc) => /-p(?:\.|\/|-)/i.test(sc.cand.url));
        const packshotBonus = hasPackshot ? 500 : 0;
        const sameHostBonus =
            arr.filter((sc) => {
                try {
                    const h = new URL(sc.cand.url).hostname;
                    return uniqAnchors.some((a) => {
                        try { return new URL(a).hostname === h; } catch { return false; }
                    });
                } catch { return false; }
            }).length * 5;

        const clusterScore = sumScore + sumAnchor + sameKeyBonus + packshotBonus + sameHostBonus;

        if (clusterScore > bestClusterScore) {
            bestClusterScore = clusterScore;
            bestKey = key;
        }
    }

    let chosen = clusters.get(bestKey) ?? [];
    // Extra guard: if chosen cluster is "__nokey__", but there exists a keyed cluster with packshot,
    // prefer the best keyed packshot cluster.
    if (bestKey === "__nokey__") {
        let altKey = bestKey;
        let altScore = bestClusterScore;
        for (const [k, arr] of clusters.entries()) {
            if (k === "__nokey__") continue;
            if (!arr.some((x) => /-p(?:\.|\/|-)/i.test(x.cand.url))) continue;
            const s = arr.reduce((acc, sc) => acc + sc.score, 0) + arr.reduce((acc, sc) => acc + sc.anchorSim * 400, 0) + 300;
            if (s > altScore) { altScore = s; altKey = k; }
        }
        if (altKey !== "__nokey__") chosen = clusters.get(altKey) ?? chosen;
    }

    // Sort chosen by (anchorSim, score), then de-dup, cap
    const ordered = chosen
        .slice()
        .sort((a, b) => {
            if (b.anchorSim !== a.anchorSim) return b.anchorSim - a.anchorSim;
            return b.score - a.score;
        })
        .map((x) => x.cand.url);

    // De-dup normalized
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of ordered) {
        const key = normalizeForDedupe(u);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(u);
        }
        if (out.length >= max) break;
    }

    return out;
}

/** Extract likely anchors from the document: og:image + largest product-like IMG. */
export function findAnchorImagesFromDocument(doc: Document, domCandidates: ImageCandidate[]): string[] {
    const anchors: string[] = [];
    // og:image
    const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]')?.getAttribute("content");
    if (og) anchors.push(new URL(og, doc.location.href).href);
    // biggest product-like IMG
    const hero = pickHeroImgCandidate(domCandidates);
    if (hero) anchors.push(hero);
    return Array.from(new Set(anchors));
}
