/**
 * Firebase Function: aiLogic (single endpoint router)
 * Ops:
 *  - summarize        -> { bullets }
 *  - detectLanguage   -> { language }
 *  - translate        -> { translated }
 *  - classify         -> schema-constrained JSON
 *  - composeLooks     -> { looks }
 *  - describeGarment  -> garment hints JSON
 *  - selectProductImages -> { groups: {confident, semiConfident, notConfident}, debug }
 *  - renderLook       -> { dataUrl }
 */
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import {
    SUMMARIZE_INSTR,
    DETECT_LANGUAGE_INSTR,
    TRANSLATE_INSTR,
    CLASSIFY_INSTR,
    COMPOSE_LOOKS_INSTR,
    DESCRIBE_GARMENT_PREFACE,
    SELECT_PRODUCT_IMAGES_HEADER,
    RENDER_STYLE_LINE,
    RENDER_BG_LINE
} from "./prompts";
import { featuresFromBuffer, minDistanceToAnchors, colorDistance } from "./vision";

initializeApp();

type Json = Record<string, unknown>;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const REGION = "us-central1";
const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-1.5-flash";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image-preview";

/* ---------------- Utilities ---------------- */

function ok(res: any, data: unknown): void { res.status(200).json(data); }
function bad(res: any, code: number, msg: string): void { res.status(code).json({ error: msg }); }
function ensureKey(): void { if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set"); }

function extractText(anyResp: unknown): string {
    const r = anyResp as any;
    const c = r?.candidates?.[0];
    const parts = c?.content?.parts ?? [];
    const t = parts.find((p: any) => typeof p?.text === "string")?.text;
    return typeof t === "string" ? t : "";
}
function extractJson(anyResp: unknown): Json {
    const txt = extractText(anyResp);
    try { const obj = JSON.parse(txt); if (obj && typeof obj === "object") return obj as Json; }
    catch { /* ignore */ }
    return {};
}

async function postJson(url: string, body: unknown): Promise<any> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) { const text = await res.text(); throw new Error(`Gemini API ${res.status}: ${text}`); }
    return await res.json();
}

async function generateContent(model: string, request: Json): Promise<any> {
    ensureKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return await postJson(url, request);
}

async function fetchAsInline(url: string): Promise<{ mime: string; base64: string } | undefined> {
    try {
        const res = await fetch(url);
        if (!res.ok) return undefined;
        const ct = res.headers.get("content-type") || "image/jpeg";
        const buf = new Uint8Array(await res.arrayBuffer());
        const b64 = Buffer.from(buf).toString("base64");
        return { mime: ct, base64: b64 };
    } catch { return undefined; }
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | undefined {
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return undefined;
    return { mime: m[1], base64: m[2] };
}

async function generateImageFromParts(
    prompt: string,
    images: Array<{ mime: string; base64: string }>
): Promise<string> {
    ensureKey();
    const parts: any[] = [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.base64 } }))];
    const req = { contents: [{ role: "user", parts }] };
    const resp = await generateContent(IMAGE_MODEL, req as Json);
    const candidate = resp?.candidates?.[0];
    const outParts = candidate?.content?.parts ?? [];
    const img = outParts.find((p: any) => p?.inline_data?.data)?.inline_data;
    if (img?.data) return `data:${img.mime_type || "image/png"};base64,${img.data}`;
    throw new Error("Image generation unavailable (no inline image in response)");
}

/* ---------------- Ops (text) ---------------- */

async function opSummarize(payload: { text: string }) {
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${SUMMARIZE_INSTR}\n\n${payload.text}` }] }]
    });
    const text = extractText(resp);
    const bullets = text.split("\n").map((l) => l.trim().replace(/^[-*•]\s*/, "")).filter(Boolean).slice(0, 5);
    return { bullets };
}

async function opDetectLanguage(payload: { text: string }) {
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${DETECT_LANGUAGE_INSTR}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    });
    const code = extractText(resp).trim().split(/\s+/)[0] || "und";
    return { language: code };
}

async function opTranslate(payload: { text: string; from?: string; to: string }) {
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${TRANSLATE_INSTR(payload.from, payload.to)}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    });
    return { translated: extractText(resp) };
}

/* ---------------- Ops (JSON mode) ---------------- */

async function opClassify(payload: { text: string; imageDataUrl?: string; schema: Json }) {
    const parts: any[] = [{ text: `${CLASSIFY_INSTR}\n\nProduct details:\n${payload.text}` }];
    if (payload.imageDataUrl?.startsWith("data:")) {
        const parsed = parseDataUrl(payload.imageDataUrl);
        if (parsed) parts.push({ inline_data: { mime_type: parsed.mime, data: parsed.base64 } });
    }
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: payload.schema }
    });
    return extractJson(resp);
}

async function opComposeLooks(payload: {
    wardrobe: Array<{ id: string; title: string; category: string; colors: string[]; styleTags: string[] }>;
    createdFromItemId?: string;
    schema: Json;
}) {
    const instr = COMPOSE_LOOKS_INSTR(payload.createdFromItemId);
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${instr}\n\nWardrobe:\n${JSON.stringify(payload.wardrobe, null, 2)}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: payload.schema }
    });
    const obj = extractJson(resp);
    return { looks: Array.isArray(obj["looks"]) ? (obj["looks"] as unknown[]) : [] };
}

/* ---------------- describeGarment ---------------- */

const DEFAULT_GARMENT_SCHEMA: Json = {
    type: "object",
    properties: {
        bullets: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 12 },
        fit: { type: "string" },
        silhouette: { type: "string" },
        length: { type: "string" },
        waist: { type: "string" },
        rise: { type: "string" },
        sleeve: { type: "string" },
        neckline: { type: "string" },
        drape: { type: "string" },
        fabricWeight: { type: "string" },
        pattern: { type: "string" },
        placementCues: { type: "array", items: { type: "string" } },
        stylingNotes: { type: "array", items: { type: "string" } },
        mannequinRecommendation: { type: "string" }
    },
    required: ["bullets"]
};

async function opDescribeGarment(payload: {
    title?: string;
    text?: string;
    imageUrls?: string[];
    imageDataUrls?: string[];
    schema?: Json;
}) {
    const schema = payload.schema ?? DEFAULT_GARMENT_SCHEMA;

    const parts: any[] = [{ text: `${DESCRIBE_GARMENT_PREFACE}\n\nTitle: ${payload.title ?? ""}\n\nDetails:\n${payload.text ?? ""}` }];

    const images: Array<{ mime: string; base64: string }> = [];
    for (const u of payload.imageUrls ?? []) {
        const inl = await fetchAsInline(u);
        if (inl) images.push(inl);
    }
    for (const d of payload.imageDataUrls ?? []) {
        const inl = parseDataUrl(d);
        if (inl) images.push(inl);
    }
    for (const img of images) {
        parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
    }

    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema }
    });

    return extractJson(resp);
}

/* ---------------- selectProductImages (3 buckets) ---------------- */

const SELECT_GROUPS_SCHEMA: Json = {
    type: "object",
    properties: {
        groups: {
            type: "object",
            properties: {
                confident: { type: "array", items: { type: "string" } },
                semiConfident: { type: "array", items: { type: "string" } },
                notConfident: { type: "array", items: { type: "string" } }
            },
            required: ["confident", "semiConfident", "notConfident"]
        }
    },
    required: ["groups"]
};

async function opSelectProductImages(payload: {
    anchors?: string[];
    candidates: Array<{ url: string; score?: number; origin?: string }>;
    pageTitle?: string;
    pageText?: string;
    maxInline?: number;
}) {
    const anchors = Array.isArray(payload.anchors) ? payload.anchors.slice(0, 3) : [];
    const maxInline = Math.max(6, Math.min(payload.maxInline ?? 12, 12));

    // 1) Extract features for anchors (dHash & color baseline).
    const anchorFeatures: { dhash: string; avg: { r: number; g: number; b: number } }[] = [];
    for (const u of anchors) {
        try {
            const res = await fetch(u);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const f = await featuresFromBuffer(buf);
            anchorFeatures.push({ dhash: f.dhashHex, avg: f.avg });
        } catch { /* ignore */ }
    }
    const anchorHashes = anchorFeatures.map((a) => a.dhash);
    const avgAnchorColor = anchorFeatures.length
        ? anchorFeatures.reduce(
            (acc, a) => ({ r: acc.r + a.avg.r, g: acc.g + a.avg.g, b: acc.b + a.avg.b }),
            { r: 0, g: 0, b: 0 }
        )
        : { r: 128, g: 128, b: 128 };
    if (anchorFeatures.length) {
        avgAnchorColor.r = Math.round(avgAnchorColor.r / anchorFeatures.length);
        avgAnchorColor.g = Math.round(avgAnchorColor.g / anchorFeatures.length);
        avgAnchorColor.b = Math.round(avgAnchorColor.b / anchorFeatures.length);
    }

    // 2) Compute features for all candidates
    const enriched = await Promise.all(
        payload.candidates.map(async (c) => {
            let dhash: string | undefined;
            let dist: number | undefined;
            let colorSim = 0;
            try {
                const res = await fetch(c.url);
                if (res.ok) {
                    const buf = Buffer.from(await res.arrayBuffer());
                    const f = await featuresFromBuffer(buf);
                    dhash = f.dhashHex;
                    dist = minDistanceToAnchors(f.dhashHex, anchorHashes);
                    const cd = colorDistance(f.avg, avgAnchorColor); // 0..441
                    colorSim = 1 - Math.min(cd, 441.67) / 441.67; // 0..1 (higher is better)
                }
            } catch { /* ignore */ }

            // URL heuristics
            const url = c.url;
            const isEditorial = /(?:-e(?:\.|\/|-)|editorial|lookbook|campaign|lifestyle|kids|baby)/i.test(url) ? 1 : 0;
            const looksLikePackshot = /(\/p\/|_p\.|\/product|packshot|studio)/i.test(url) ? 1 : 0;

            // Aspect ratio hint (often ~1:1 or 4:5 for packshots)
            let arHint = 0.5; // unknown baseline
            try {
                const u = new URL(url);
                const w = Number(new URLSearchParams(u.search).get("w") || "0");
                if (w) {
                    // prefer larger w
                    arHint = w >= 800 ? 1 : w >= 560 ? 0.8 : 0.6;
                }
            } catch { /* ignore */ }

            // Composite score (0..1)
            const distScore = typeof dist === "number" ? 1 - Math.min(dist, 32) / 32 : 0.25;
            const urlBias = looksLikePackshot ? 0.15 : 0;
            const editorialPenalty = isEditorial ? -0.25 : 0;
            const composite = Math.max(0, Math.min(1, 0.55 * distScore + 0.25 * colorSim + 0.15 * arHint + urlBias + editorialPenalty));

            return {
                ...c,
                dhash,
                dist,
                colorSim: Number.isFinite(colorSim) ? Number(colorSim.toFixed(3)) : 0,
                isEditorial,
                looksLikePackshot,
                composite: Number(composite.toFixed(3))
            };
        })
    );

    // 3) Initial rule-based bucketing (everything ends up in a bucket)
    const groups = {
        confident: [] as string[],
        semiConfident: [] as string[],
        notConfident: [] as string[]
    };

    const borderline: { id: string; url: string; composite: number; dist?: number }[] = [];

    enriched.forEach((e, i) => {
        const id = `C${i + 1}`;
        const d = e.dist ?? 64;
        const s = e.composite ?? 0;
        if (d <= 8 && s >= 0.7 && e.isEditorial === 0) groups.confident.push(e.url);
        else if (d <= 16 && s >= 0.5) { groups.semiConfident.push(e.url); borderline.push({ id, url: e.url, composite: s, dist: e.dist }); }
        else groups.notConfident.push(e.url);
    });

    // 4) Give LLM a chance to re-assign top ambiguous (inline subset)
    const inlineParts: any[] = [];
    let inlineImageCount = 0;

    for (const u of anchors) {
        const inl = await fetchAsInline(u);
        if (!inl) continue;
        inlineParts.push({ text: `ANCHOR` }, { inline_data: { mime_type: inl.mime, data: inl.base64 } });
        inlineImageCount++;
    }

    // Inline at most maxInline ambiguous + a few high/low examples from each bucket
    const toInline: { id: string; url: string }[] = [];
    const ambis = borderline.slice(0, Math.max(3, maxInline - 6));
    toInline.push(...ambis.map((b) => ({ id: b.id, url: b.url })));

    const takeFew = (arr: string[], n: number) => arr.slice(0, n).map((url, idx) => ({ id: `S${idx + 1}`, url }));
    toInline.push(...takeFew(groups.confident, 2), ...takeFew(groups.notConfident, 2));

    const uniqueInline = Array.from(new Map(toInline.map((x) => [x.url, x])).values()).slice(0, maxInline);
    for (const c of uniqueInline) {
        const inl = await fetchAsInline(c.url);
        if (!inl) continue;
        inlineParts.push({ text: `CANDIDATE ${c.id} ${c.url}` }, { inline_data: { mime_type: inl.mime, data: inl.base64 } });
        inlineImageCount++;
    }

    const header = SELECT_PRODUCT_IMAGES_HEADER({ pageTitle: payload.pageTitle, contextText: payload.pageText });

    const list = [
        `All candidates (${enriched.length}):`,
        ...enriched.map((e, i) =>
            `C${i + 1}: ${e.url}\n  score=${e.score ?? 0} dist=${e.dist ?? "NA"} colorSim=${e.colorSim ?? 0} composite=${e.composite ?? 0} editorial=${e.isEditorial} packshot=${e.looksLikePackshot}`
        )
    ].join("\n");

    const parts: any[] = [{ text: header }, ...inlineParts, { text: list }];

    let llmGroups = { confident: [] as string[], semiConfident: [] as string[], notConfident: [] as string[] };
    try {
        const resp = await generateContent(TEXT_MODEL, {
            contents: [{ role: "user", parts }],
            generationConfig: { responseMimeType: "application/json", responseSchema: SELECT_GROUPS_SCHEMA }
        });
        const obj = extractJson(resp);
        const g = obj["groups"] as Record<string, unknown> | undefined;
        if (g) {
            const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
            llmGroups = {
                confident: arr(g["confident"]),
                semiConfident: arr(g["semiConfident"]),
                notConfident: arr(g["notConfident"])
            };
        }
    } catch (e) {
        // If LLM step fails, keep rule-based groups; log for debugging.
        logger.warn("selectProductImages: LLM reassignment failed", e as Error);
    }

    // 5) Merge LLM decision conservatively: LLM may promote/demote; ensure partition & include ALL images.
    const allUrls = new Set(enriched.map((e) => e.url));
    const final = {
        confident: new Set<string>(groups.confident),
        semiConfident: new Set<string>(groups.semiConfident),
        notConfident: new Set<string>(groups.notConfident)
    };

    // Apply promotions/demotions from LLM groups
    const apply = (target: "confident" | "semiConfident" | "notConfident", urls: string[]) => {
        for (const u of urls) if (allUrls.has(u)) {
            final.confident.delete(u);
            final.semiConfident.delete(u);
            final.notConfident.delete(u);
            final[target].add(u);
        }
    };
    apply("confident", llmGroups.confident);
    apply("semiConfident", llmGroups.semiConfident);
    apply("notConfident", llmGroups.notConfident);

    // Ensure every url is placed
    for (const u of allUrls) {
        if (!final.confident.has(u) && !final.semiConfident.has(u) && !final.notConfident.has(u)) {
            final.semiConfident.add(u); // fallback neutral bucket
        }
    }

    // Stable deterministic ordering: by composite desc, then by dist asc
    const scoreMap = new Map(enriched.map((e) => [e.url, e.composite ?? 0]));
    const distMap = new Map(enriched.map((e) => [e.url, e.dist ?? 64]));
    const order = (a: string, b: string) => {
        const sc = (scoreMap.get(b)! - scoreMap.get(a)!);
        if (sc !== 0) return sc;
        return (distMap.get(a)! - distMap.get(b)!);
    };

    const outGroups = {
        confident: Array.from(final.confident).sort(order),
        semiConfident: Array.from(final.semiConfident).sort(order),
        notConfident: Array.from(final.notConfident).sort(order)
    };

    return {
        groups: outGroups,
        debug: {
            anchorsCount: anchors.length,
            inlineImageCount,
            totals: {
                confident: outGroups.confident.length,
                semiConfident: outGroups.semiConfident.length,
                notConfident: outGroups.notConfident.length
            }
        }
    };
}

/* ---------------- renderLook (multi-image per item) ---------------- */

async function opRenderLook(payload: {
    mannequinUrl?: string;
    mannequinDataUrl?: string;
    items: Array<{ title: string; role: string; imageUrl?: string; imageUrls?: string[]; hintBullets?: string[] }>;
    style?: string;
    background?: string;
}) {
    const images: Array<{ mime: string; base64: string }> = [];

    // Mannequin
    if (payload.mannequinDataUrl?.startsWith("data:")) {
        const parsed = parseDataUrl(payload.mannequinDataUrl);
        if (parsed) images.push(parsed);
    } else if (payload.mannequinUrl) {
        const man = await fetchAsInline(payload.mannequinUrl);
        if (man) images.push(man);
    }

    // Garments: include all provided imageUrls (cap at 4 per item)
    for (const it of payload.items) {
        const urls: string[] = [];
        if (it.imageUrls && it.imageUrls.length) urls.push(...it.imageUrls.slice(0, 4));
        else if (it.imageUrl) urls.push(it.imageUrl);
        for (const u of urls) {
            const img = await fetchAsInline(u);
            if (img) images.push(img);
        }
    }

    const garmentList = payload.items.map((i) => `${i.role}: ${i.title}`).join("; ");
    const hintText = payload.items
        .map((i) => (i.hintBullets && i.hintBullets.length ? `HINTS for ${i.role}:\n- ${i.hintBullets.join("\n- ")}` : ""))
        .filter(Boolean)
        .join("\n\n");

    const prompt = [
        "Blend the provided garment images onto a blank mannequin to form a single outfit preview.",
        "Keep the mannequin static; align garment edges and natural folds; maintain realistic proportions.",
        `Outfit items: ${garmentList}.`,
        hintText ? `Guidance:\n${hintText}` : "",
        RENDER_STYLE_LINE,
        RENDER_BG_LINE,
        "Output a single front-facing product preview image."
    ].filter(Boolean).join("\n");

    try {
        const dataUrl = await generateImageFromParts(prompt, images);
        return { dataUrl };
    } catch {
        const svg = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900" viewBox="0 0 720 900">`,
            `<rect width="100%" height="100%" fill="#f7f7f7"/>`,
            `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui" font-size="18" fill="#666">Preview unavailable</text>`,
            `</svg>`
        ].join("");
        const b64 = Buffer.from(svg, "utf8").toString("base64");
        return { dataUrl: `data:image/svg+xml;base64,${b64}` };
    }
}

/* ---------------- HTTP entrypoint ---------------- */

export const aiLogic = onRequest(
    { region: REGION, cors: true, timeoutSeconds: 120, memory: "1GiB" },
    async (req, res): Promise<void> => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        if (req.method === "OPTIONS") { res.status(204).send(""); return; }
        if (req.method !== "POST") { bad(res, 405, "POST only"); return; }

        let op = ""; let payload: any = undefined;
        try { op = String(req.body?.op || ""); payload = req.body?.payload ?? {}; }
        catch { bad(res, 400, "Invalid JSON body"); return; }

        try {
            switch (op) {
                case "summarize": ok(res, await opSummarize(payload)); return;
                case "detectLanguage": ok(res, await opDetectLanguage(payload)); return;
                case "translate": ok(res, await opTranslate(payload)); return;
                case "classify": ok(res, await opClassify(payload)); return;
                case "composeLooks": {
                    if (!payload?.schema) { bad(res, 400, "Missing schema"); return; }
                    ok(res, await opComposeLooks(payload)); return;
                }
                case "describeGarment": ok(res, await opDescribeGarment(payload)); return;
                case "selectProductImages": ok(res, await opSelectProductImages(payload)); return;
                case "renderLook": ok(res, await opRenderLook(payload)); return;
                default: bad(res, 400, `Unknown op: ${op}`); return;
            }
        } catch (e) {
            logger.error(e);
            bad(res, 500, (e as Error).message || "Internal error");
        }
    }
);
