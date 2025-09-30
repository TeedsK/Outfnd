/**
 * Firebase Function: aiLogic (single endpoint router)
 * Ops:
 *  - health           -> { ok, ... }
 *  - summarize        -> { bullets, debug }
 *  - detectLanguage   -> { language, debug }
 *  - translate        -> { translated, debug }
 *  - classify         -> schema‑constrained JSON (+ __modelUsed)
 *  - composeLooks     -> { looks, debug }
 *  - describeGarment  -> garment hints JSON (+ __modelUsed)
 *  - selectProductImages -> { groups, selected, debug }
 *  - renderLook       -> { dataUrl, debug }
 */
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { SUMMARIZE_INSTR, DETECT_LANGUAGE_INSTR, TRANSLATE_INSTR, CLASSIFY_INSTR, COMPOSE_LOOKS_INSTR, DESCRIBE_GARMENT_PREFACE, SELECT_PRODUCT_IMAGES_HEADER, RENDER_STYLE_LINE, RENDER_BG_LINE } from "./prompts.js";
import { featuresFromBuffer, minDistanceToAnchors, colorDistance } from "./vision.js";
initializeApp();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const REGION = "us-central1";
const TEXT_MODEL = (process.env.TEXT_MODEL || "gemini-1.5-flash").trim();
const IMAGE_MODEL = (process.env.IMAGE_MODEL || "gemini-2.5-flash-image-preview").trim();
const API_VERSION_ORDER = ["v1beta", "v1"];
/* ---------------- Utilities ---------------- */
function ok(res, data) { res.status(200).json(data); }
function bad(res, code, msg) { res.status(code).json({ error: msg }); }
function ensureKey() { if (!GEMINI_API_KEY)
    throw new Error("GEMINI_API_KEY is not set"); }
function extractText(anyResp) {
    const r = anyResp;
    const c = r?.candidates?.[0];
    const parts = c?.content?.parts ?? [];
    const t = parts.find((p) => typeof p?.text === "string")?.text;
    return typeof t === "string" ? t : "";
}
function extractJson(anyResp) {
    const txt = extractText(anyResp);
    try {
        const obj = JSON.parse(txt);
        if (obj && typeof obj === "object")
            return obj;
    }
    catch { /* ignore */ }
    return {};
}
async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API ${res.status}: ${text}`);
    }
    return await res.json();
}
function normalizeModelNameForGL(input, kind) {
    let name = (input || "").trim();
    if (!name)
        return kind === "image" ? "gemini-2.5-flash-image-preview" : "gemini-1.5-flash";
    name = name.replace(/^models\//i, "");
    name = name.replace(/^projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\//i, "");
    const m = name.match(/^(gemini-[\w.-]*?)-(?:\d+|00[1-9])$/i);
    if (m)
        name = `${m[1]}-latest`;
    return name;
}
function isNotFoundModelError(err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return /not[_\- ]found/.test(msg) || /\b404\b/.test(msg);
}
function apiUrlForModel(model, apiVersion) {
    return `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
}
async function generateContentWithFallback(requestedModel, request, kind) {
    ensureKey();
    const normalized = normalizeModelNameForGL(requestedModel, kind);
    const tryModels = [normalized];
    if (!/latest$/i.test(normalized))
        tryModels.push(`${normalized}-latest`.replace(/-latest-latest$/i, "-latest"));
    if (kind === "text") {
        for (const m of ["gemini-1.5-flash-latest", "gemini-1.5-flash"])
            if (!tryModels.includes(m))
                tryModels.push(m);
    }
    else {
        for (const m of ["gemini-2.5-flash-image-preview", "gemini-1.5-flash"])
            if (!tryModels.includes(m))
                tryModels.push(m);
    }
    let lastErr = undefined;
    for (const apiVersion of API_VERSION_ORDER) {
        for (const model of tryModels) {
            try {
                const url = apiUrlForModel(model, apiVersion);
                logger.info(`[aiLogic] generateContent -> model=${model} api=${apiVersion}`);
                const resp = await postJson(url, request);
                return { resp, modelUsed: model, apiVersionUsed: apiVersion, modelRequested: requestedModel };
            }
            catch (e) {
                lastErr = e;
                const nf = isNotFoundModelError(e);
                logger.warn(`[aiLogic] model failed model=${model} api=${apiVersion} reason=${nf ? "NOT_FOUND" : "error"} msg=${String(e).slice(0, 240)}`);
                if (!nf)
                    break;
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
async function fetchAsInline(url) {
    try {
        const res = await fetch(url);
        if (!res.ok)
            return undefined;
        const ct = res.headers.get("content-type") || "image/jpeg";
        const buf = new Uint8Array(await res.arrayBuffer());
        const b64 = Buffer.from(buf).toString("base64");
        return { mime: ct, base64: b64 };
    }
    catch {
        return undefined;
    }
}
function parseDataUrl(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m)
        return undefined;
    return { mime: m[1], base64: m[2] };
}
async function generateImageFromParts(prompt, images) {
    const parts = [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.base64 } }))];
    const req = { contents: [{ role: "user", parts }] };
    const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(IMAGE_MODEL, req, "image");
    const candidate = resp?.candidates?.[0];
    const outParts = candidate?.content?.parts ?? [];
    const img = outParts.find((p) => p?.inline_data?.data)?.inline_data;
    if (img?.data)
        return { dataUrl: `data:${img.mime_type || "image/png"};base64,${img.data}`, modelUsed, apiVersionUsed };
    throw new Error("Image generation unavailable (no inline image in response)");
}
/* ---------------- Ops (text) ---------------- */
async function opSummarize(payload) {
    const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(TEXT_MODEL, { contents: [{ role: "user", parts: [{ text: `${SUMMARIZE_INSTR}\n\n${payload.text}` }] }] }, "text");
    const text = extractText(resp);
    const bullets = text.split("\n").map((l) => l.trim().replace(/^[-*•]\s*/, "")).filter(Boolean).slice(0, 5);
    return { bullets, debug: { modelUsed, apiVersionUsed } };
}
async function opDetectLanguage(payload) {
    const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${DETECT_LANGUAGE_INSTR}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    }, "text");
    const code = extractText(resp).trim().split(/\s+/)[0] || "und";
    return { language: code, debug: { modelUsed, apiVersionUsed } };
}
async function opTranslate(payload) {
    const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${TRANSLATE_INSTR(payload.from, payload.to)}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    }, "text");
    return { translated: extractText(resp), debug: { modelUsed, apiVersionUsed } };
}
/* ---------------- Ops (JSON mode) ---------------- */
async function opClassify(payload) {
    const parts = [{ text: `${CLASSIFY_INSTR}\n\nProduct details:\n${payload.text}` }];
    if (payload.imageDataUrl?.startsWith("data:")) {
        const parsed = parseDataUrl(payload.imageDataUrl);
        if (parsed)
            parts.push({ inline_data: { mime_type: parsed.mime, data: parsed.base64 } });
    }
    const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(TEXT_MODEL, {
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: payload.schema }
    }, "text");
    const json = extractJson(resp);
    json.__modelUsed = modelUsed;
    json.__apiVersionUsed = apiVersionUsed;
    return json;
}
async function opComposeLooks(payload) {
    const instr = COMPOSE_LOOKS_INSTR(payload.createdFromItemId);
    const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${instr}\n\nWardrobe:\n${JSON.stringify(payload.wardrobe, null, 2)}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: payload.schema }
    }, "text");
    const obj = extractJson(resp);
    return { looks: Array.isArray(obj["looks"]) ? obj["looks"] : [], debug: { modelUsed, apiVersionUsed } };
}
/* ---------------- describeGarment ---------------- */
const DEFAULT_GARMENT_SCHEMA = {
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
async function opDescribeGarment(payload) {
    const schema = payload.schema ?? DEFAULT_GARMENT_SCHEMA;
    const parts = [{ text: `${DESCRIBE_GARMENT_PREFACE}\n\nTitle: ${payload.title ?? ""}\n\nDetails:\n${payload.text ?? ""}` }];
    const images = [];
    for (const u of payload.imageUrls ?? []) {
        const inl = await fetchAsInline(u);
        if (inl)
            images.push(inl);
    }
    for (const d of payload.imageDataUrls ?? []) {
        const inl = parseDataUrl(d);
        if (inl)
            images.push(inl);
    }
    for (const img of images) {
        parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
    }
    const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(TEXT_MODEL, {
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema }
    }, "text");
    const json = extractJson(resp);
    json.__modelUsed = modelUsed;
    json.__apiVersionUsed = apiVersionUsed;
    return json;
}
/* ---------------- selectProductImages (3 buckets) ---------------- */
const SELECT_GROUPS_SCHEMA = {
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
async function opSelectProductImages(payload) {
    const anchors = Array.isArray(payload.anchors) ? payload.anchors.slice(0, 3) : [];
    const maxInline = Math.max(6, Math.min(payload.maxInline ?? 12, 12));
    logger.info(`[aiLogic] selectProductImages request`, {
        anchorsCount: anchors.length,
        candidateCount: payload.candidates.length,
        pageTitle: payload.pageTitle ?? ""
    });
    // 1) Anchor features
    const anchorFeatures = [];
    for (const u of anchors) {
        try {
            const res = await fetch(u);
            if (!res.ok)
                continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const f = await featuresFromBuffer(buf);
            anchorFeatures.push({ dhash: f.dhashHex, avg: f.avg });
        }
        catch (e) {
            logger.warn(`[aiLogic] anchor fetch failed: ${u} :: ${String(e)}`);
        }
    }
    const anchorHashes = anchorFeatures.map((a) => a.dhash);
    const avgAnchorColor = anchorFeatures.length
        ? anchorFeatures.reduce((acc, a) => ({ r: acc.r + a.avg.r, g: acc.g + a.avg.g, b: acc.b + a.avg.b }), { r: 0, g: 0, b: 0 })
        : { r: 128, g: 128, b: 128 };
    if (anchorFeatures.length) {
        avgAnchorColor.r = Math.round(avgAnchorColor.r / anchorFeatures.length);
        avgAnchorColor.g = Math.round(avgAnchorColor.g / anchorFeatures.length);
        avgAnchorColor.b = Math.round(avgAnchorColor.b / anchorFeatures.length);
    }
    // 2) Candidate features
    const enriched = await Promise.all(payload.candidates.map(async (c) => {
        let dhash;
        let dist;
        let colorSim = 0;
        try {
            const res = await fetch(c.url);
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                const f = await featuresFromBuffer(buf);
                dhash = f.dhashHex;
                dist = minDistanceToAnchors(f.dhashHex, anchorHashes);
                const cd = colorDistance(f.avg, avgAnchorColor); // 0..441.7
                colorSim = 1 - Math.min(cd, 441.67) / 441.67; // 0..1
            }
        }
        catch (e) {
            logger.warn(`[aiLogic] candidate fetch failed: ${c.url} :: ${String(e)}`);
        }
        // Heuristics from URL
        const url = c.url;
        const isEditorial = /(?:-e(?:\.|\/|-)|editorial|lookbook|campaign|lifestyle|kids|baby)/i.test(url) ? 1 : 0;
        const looksLikePackshot = /(\/p\/|_p\.|\/product|packshot|studio)/i.test(url) ? 1 : 0;
        // Aspect hint
        let arHint = 0.5;
        try {
            const u = new URL(url);
            const w = Number(new URLSearchParams(u.search).get("w") || "0");
            if (w)
                arHint = w >= 800 ? 1 : w >= 560 ? 0.8 : 0.6;
        }
        catch { /* ignore */ }
        // Composite: emphasize color a bit more
        const distScore = typeof dist === "number" ? 1 - Math.min(dist, 32) / 32 : 0.25;
        const urlBias = looksLikePackshot ? 0.15 : 0;
        const editorialPenalty = isEditorial ? -0.25 : 0;
        const composite = Math.max(0, Math.min(1, 0.45 * distScore + 0.35 * colorSim + 0.15 * arHint + urlBias + editorialPenalty));
        return {
            ...c,
            dhash,
            dist,
            colorSim: Number.isFinite(colorSim) ? Number(colorSim.toFixed(3)) : 0,
            isEditorial,
            looksLikePackshot,
            composite: Number(composite.toFixed(3))
        };
    }));
    // 3) Rule-based pre-buckets (relaxed)
    const groups = { confident: [], semiConfident: [], notConfident: [] };
    const borderline = [];
    enriched.forEach((e, i) => {
        const id = `C${i + 1}`;
        const d = e.dist ?? 64;
        const s = e.composite ?? 0;
        const highColor = (e.colorSim ?? 0) >= 0.86;
        const nearDist = d <= 12;
        const medDist = d <= 20;
        const farButLikely = d <= 28 && highColor && e.looksLikePackshot && e.isEditorial === 0;
        if (e.isEditorial === 0 && e.looksLikePackshot && ((nearDist && s >= 0.60) || (medDist && highColor && s >= 0.55))) {
            groups.confident.push(e.url);
        }
        else if (e.isEditorial === 0 && ((d <= 28 && s >= 0.45) || farButLikely)) {
            groups.semiConfident.push(e.url);
            borderline.push({ id, url: e.url, composite: s, dist: e.dist });
        }
        else {
            groups.notConfident.push(e.url);
        }
    });
    // 4) LLM reassignment
    const inlineParts = [];
    let inlineImageCount = 0;
    for (const u of anchors) {
        const inl = await fetchAsInline(u);
        if (!inl)
            continue;
        inlineParts.push({ text: `ANCHOR` }, { inline_data: { mime_type: inl.mime, data: inl.base64 } });
        inlineImageCount++;
    }
    const toInline = [];
    if (enriched.length <= maxInline) {
        enriched.forEach((e, i) => toInline.push({ id: `C${i + 1}`, url: e.url }));
    }
    else {
        const ambis = borderline.slice(0, Math.max(4, maxInline - 6));
        toInline.push(...ambis.map((b) => ({ id: b.id, url: b.url })));
        const takeFew = (arr, n) => arr.slice(0, n).map((url, idx) => ({ id: `S${idx + 1}`, url }));
        toInline.push(...takeFew(groups.confident, 3), ...takeFew(groups.notConfident, 3));
    }
    const uniqueInline = Array.from(new Map(toInline.map((x) => [x.url, x])).values()).slice(0, maxInline);
    for (const c of uniqueInline) {
        const inl = await fetchAsInline(c.url);
        if (!inl)
            continue;
        inlineParts.push({ text: `CANDIDATE ${c.id} ${c.url}` }, { inline_data: { mime_type: inl.mime, data: inl.base64 } });
        inlineImageCount++;
    }
    const header = SELECT_PRODUCT_IMAGES_HEADER({ pageTitle: payload.pageTitle, contextText: payload.pageText });
    const list = [
        `All candidates (${enriched.length}):`,
        ...enriched.map((e, i) => `C${i + 1}: ${e.url}\n  score=${e.score ?? 0} dist=${e.dist ?? "NA"} colorSim=${e.colorSim ?? 0} composite=${e.composite ?? 0} editorial=${e.isEditorial} packshot=${e.looksLikePackshot}`)
    ].join("\n");
    const parts = [{ text: header }, ...inlineParts, { text: list }];
    let llmGroups = { confident: [], semiConfident: [], notConfident: [] };
    let textModelUsed = "";
    let textApiVersionUsed = "";
    try {
        const { resp, modelUsed, apiVersionUsed } = await generateContentWithFallback(TEXT_MODEL, { contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", responseSchema: SELECT_GROUPS_SCHEMA } }, "text");
        textModelUsed = modelUsed;
        textApiVersionUsed = apiVersionUsed;
        const obj = extractJson(resp);
        const g = obj["groups"];
        if (g) {
            const arr = (v) => (Array.isArray(v) ? v.map(String) : []);
            llmGroups = {
                confident: arr(g["confident"]),
                semiConfident: arr(g["semiConfident"]),
                notConfident: arr(g["notConfident"])
            };
        }
    }
    catch (e) {
        logger.warn("selectProductImages: LLM reassignment failed", e);
    }
    // 5) Merge & invariants
    const allUrls = new Set(enriched.map((e) => e.url));
    const final = {
        confident: new Set(groups.confident),
        semiConfident: new Set(groups.semiConfident),
        notConfident: new Set(groups.notConfident)
    };
    const apply = (target, urls) => {
        for (const u of urls)
            if (allUrls.has(u)) {
                final.confident.delete(u);
                final.semiConfident.delete(u);
                final.notConfident.delete(u);
                final[target].add(u);
            }
    };
    apply("confident", llmGroups.confident);
    apply("semiConfident", llmGroups.semiConfident);
    apply("notConfident", llmGroups.notConfident);
    // Hard rule: if an anchor appears in candidates, force it into "confident".
    const anchorsInCandidates = [];
    for (const u of anchors) {
        if (allUrls.has(u)) {
            anchorsInCandidates.push(u);
            final.confident.add(u);
            final.semiConfident.delete(u);
            final.notConfident.delete(u);
        }
    }
    // Ensure every url is placed
    for (const u of allUrls) {
        if (!final.confident.has(u) && !final.semiConfident.has(u) && !final.notConfident.has(u)) {
            final.semiConfident.add(u);
        }
    }
    // Order helpers
    const scoreMap = new Map(enriched.map((e) => [e.url, e.composite ?? 0]));
    const distMap = new Map(enriched.map((e) => [e.url, e.dist ?? 64]));
    const order = (a, b) => {
        const sc = (scoreMap.get(b) - scoreMap.get(a));
        if (sc !== 0)
            return sc;
        return (distMap.get(a) - distMap.get(b));
    };
    // If confident is empty, auto-promote top items (prefer semiConfident).
    let autoPromoted = [];
    if (final.confident.size === 0) {
        const semi = Array.from(final.semiConfident).sort(order);
        const src = semi.length ? semi : Array.from(allUrls).sort(order);
        autoPromoted = src.slice(0, Math.min(2, src.length));
        for (const u of autoPromoted) {
            final.confident.add(u);
            final.semiConfident.delete(u);
            final.notConfident.delete(u);
        }
    }
    const outGroups = {
        confident: Array.from(final.confident).sort(order),
        semiConfident: Array.from(final.semiConfident).sort(order),
        notConfident: Array.from(final.notConfident).sort(order)
    };
    const debug = {
        anchorsCount: anchors.length,
        inlineImageCount,
        totals: {
            confident: outGroups.confident.length,
            semiConfident: outGroups.semiConfident.length,
            notConfident: outGroups.notConfident.length,
            all: enriched.length
        },
        promotions: {
            anchorsForcedConfident: anchorsInCandidates.length,
            autoPromoted: autoPromoted.length
        },
        models: {
            textModelRequested: TEXT_MODEL,
            textModelUsed: textModelUsed,
            apiVersionUsed: textApiVersionUsed
        }
    };
    logger.info(`[aiLogic] selectProductImages result`, debug);
    // Legacy "selected" mirrors "confident" for back-compat.
    return {
        groups: outGroups,
        selected: outGroups.confident.slice(),
        debug
    };
}
/* ---------------- renderLook (multi-image per item) ---------------- */
async function opRenderLook(payload) {
    const images = [];
    if (payload.mannequinDataUrl?.startsWith("data:")) {
        const parsed = parseDataUrl(payload.mannequinDataUrl);
        if (parsed)
            images.push(parsed);
    }
    else if (payload.mannequinUrl) {
        const man = await fetchAsInline(payload.mannequinUrl);
        if (man)
            images.push(man);
    }
    for (const it of payload.items) {
        const urls = [];
        if (it.imageUrls && it.imageUrls.length)
            urls.push(...it.imageUrls.slice(0, 4));
        else if (it.imageUrl)
            urls.push(it.imageUrl);
        for (const u of urls) {
            const img = await fetchAsInline(u);
            if (img)
                images.push(img);
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
        const { dataUrl, modelUsed, apiVersionUsed } = await generateImageFromParts(prompt, images);
        return { dataUrl, debug: { imageModelUsed: modelUsed, apiVersionUsed } };
    }
    catch {
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
/* ---------------- health ---------------- */
async function opHealth() {
    return {
        ok: true,
        textModelConfigured: TEXT_MODEL,
        textModelNormalized: normalizeModelNameForGL(TEXT_MODEL, "text"),
        imageModelConfigured: IMAGE_MODEL,
        imageModelNormalized: normalizeModelNameForGL(IMAGE_MODEL, "image"),
        apiVersionsTried: API_VERSION_ORDER
    };
}
/* ---------------- HTTP entrypoint ---------------- */
logger.info("[aiLogic] boot", {
    textModelConfigured: TEXT_MODEL,
    textModelNormalized: normalizeModelNameForGL(TEXT_MODEL, "text"),
    imageModelConfigured: IMAGE_MODEL,
    imageModelNormalized: normalizeModelNameForGL(IMAGE_MODEL, "image"),
    apiVersionsTried: API_VERSION_ORDER
});
export const aiLogic = onRequest({ region: REGION, cors: true, timeoutSeconds: 120, memory: "1GiB" }, async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-outfnd-client");
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    if (req.method !== "POST") {
        bad(res, 405, "POST only");
        return;
    }
    let op = "";
    let payload = undefined;
    try {
        op = String(req.body?.op || "");
        payload = req.body?.payload ?? {};
    }
    catch {
        bad(res, 400, "Invalid JSON body");
        return;
    }
    const clientTag = String(req.headers["x-outfnd-client"] || "unknown");
    logger.info(`[aiLogic] op=${op} client=${clientTag}`);
    try {
        switch (op) {
            case "health":
                ok(res, await opHealth());
                return;
            case "summarize":
                ok(res, await opSummarize(payload));
                return;
            case "detectLanguage":
                ok(res, await opDetectLanguage(payload));
                return;
            case "translate":
                ok(res, await opTranslate(payload));
                return;
            case "classify":
                ok(res, await opClassify(payload));
                return;
            case "composeLooks": {
                if (!payload?.schema) {
                    bad(res, 400, "Missing schema");
                    return;
                }
                ok(res, await opComposeLooks(payload));
                return;
            }
            case "describeGarment":
                ok(res, await opDescribeGarment(payload));
                return;
            case "selectProductImages":
                ok(res, await opSelectProductImages(payload));
                return;
            case "renderLook":
                ok(res, await opRenderLook(payload));
                return;
            default:
                bad(res, 400, `Unknown op: ${op}`);
                return;
        }
    }
    catch (e) {
        logger.error(e);
        bad(res, 500, e.message || "Internal error");
    }
});
