import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
initializeApp();

// ---- prompts (inlined from src/prompts.ts build) ----
const SUMMARIZE_INSTR = `Summarize the following product information into 3–5 concise bullet points
focused strictly on: fit, care, and returns policy.
Return bullet lines only (no headings).`;
const DETECT_LANGUAGE_INSTR = `Detect the language and return ONLY a BCP‑47 code (e.g., en, es, fr).`;
const TRANSLATE_INSTR = (from, to) => `Translate from ${from || "auto"} to ${to}. Return only the translation text.`;
const CLASSIFY_INSTR = `You are a fashion product attribute classifier.
Return ONLY JSON that conforms to the provided schema.
Prefer common fashion terms, e.g., "navy", "ecru", "pinstripe".
Infer reasonable attributes if not explicitly stated.`;
const COMPOSE_LOOKS_INSTR = (seed) => `Compose three outfits for the following occasions: casual, office, evening.
Use ONLY the provided wardrobe item ids.
${seed ? `Include the seed item id "${seed}" in each look.` : ""}
Return ONLY JSON that conforms to the schema. Avoid commentary outside JSON.`;
const DESCRIBE_GARMENT_PREFACE = `You are a fashion vision-language expert. Analyze the garment in the provided image(s)
and the optional text. Return ONLY JSON per the schema, being specific and concise.
Include body-position cues (e.g., "hem hits at knees", "cropped above ankle"),
fit (slim/relaxed/oversized), silhouette, rise/waist. Provide stylingNotes that help place
and align this garment on a blank mannequin realistically.`;
const SELECT_PRODUCT_IMAGES_HEADER = (args) => {
    const lines = [
        `Task: From the candidate images, select ONLY those that depict the SAME clothing item as the anchors (ground truth).`,
        `The anchors are the product's main packshot/hero image(s).`,
        `You MUST exclude:`,
        `  • Different products, different colors/prints/washes/fabric.`,
        `  • Editorial/lifestyle scenes, people/children, banners, ad tiles.`,
        `  • Outfits where the focal item is not the same as anchors.`,
        ``,
        `Use this STRICT checklist before selecting any candidate:`,
        `  1) Color/Tone: identical or within small studio variance (lighting).`,
        `  2) Silhouette & details: same collar type, pocket/closure count & placement, hem/length, seams.`,
        `  3) Fabric/texture & pattern: same weave/denim/knit; same pattern layout/scale.`,
        `  4) Hardware: buttons/zippers/snaps match in number, color, and position.`,
        `  5) Logos/labels: present/absent in the same place (if visible).`,
        ``,
        `You are given similarity hints (dHash distance vs. anchors, lower is more similar) and URL path cues.`,
        `Be conservative: if uncertain, do NOT select.`,
        ``,
    ];
    if (args.pageTitle) lines.push(`Page Title: ${args.pageTitle}`);
    if (args.contextText) lines.push(`Context:\n${args.contextText}`);
    lines.push(
        ``,
        `Return JSON with a "selected" array of the chosen absolute URLs.`,
        `Optionally, you may also return "selectedIds" matching the Ci identifiers provided in the list.`,
        `No commentary outside JSON.`
    );
    return lines.join("\n");
};
const RENDER_STYLE_LINE = `Style: realistic garment draping on a blank mannequin, true-to-color,
minimal reflections, high detail, studio product photography (4k).`;
const RENDER_BG_LINE = `Background: soft neutral studio (#f7f7f7) with subtle drop shadow.`;

// ---- vision (inlined build of src/vision.ts) ----
import sharp from "sharp";
async function featuresFromBuffer(buf) {
    const img = sharp(buf).removeAlpha();
    const meta = await img.metadata();
    const stats = await img.stats();
    const small = await img
        .grayscale()
        .resize(9, 8, { fit: "fill" })
        .raw()
        .toBuffer();
    let bits = 0n;
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const left = small[row * 9 + col];
            const right = small[row * 9 + col + 1];
            const isDarker = left > right ? 1n : 0n;
            bits = (bits << 1n) | isDarker;
        }
    }
    const dhashHex = bits.toString(16).padStart(16, "0");
    const avg = {
        r: Math.round(stats.channels[0]?.mean ?? 0),
        g: Math.round(stats.channels[1]?.mean ?? 0),
        b: Math.round(stats.channels[2]?.mean ?? 0)
    };
    return {
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        dhashHex,
        avg,
        bytes: buf.byteLength
    };
}
function hamming(hexA, hexB) {
    const a = BigInt(`0x${hexA}`);
    const b = BigInt(`0x${hexB}`);
    let x = a ^ b;
    let count = 0;
    while (x) {
        x &= x - 1n;
        count++;
    }
    return count;
}
function minDistanceToAnchors(d, anchors) {
    if (!anchors.length) return 64;
    return Math.min(...anchors.map((a) => hamming(d, a)));
}

// ---- core util ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const REGION = "us-central1";
const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-1.5-flash";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image-preview";
function ok(res, data) { res.status(200).json(data); }
function bad(res, code, msg) { res.status(code).json({ error: msg }); }
function ensureKey() { if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set"); }
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
        if (obj && typeof obj === "object") return obj;
    } catch { }
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
async function generateContent(model, request) {
    ensureKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return await postJson(url, request);
}
async function fetchAsInline(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return undefined;
        const ct = res.headers.get("content-type") || "image/jpeg";
        const buf = new Uint8Array(await res.arrayBuffer());
        const b64 = Buffer.from(buf).toString("base64");
        return { mime: ct, base64: b64 };
    } catch { return undefined; }
}
function parseDataUrl(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return undefined;
    return { mime: m[1], base64: m[2] };
}
async function generateImageFromParts(prompt, images) {
    ensureKey();
    const parts = [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.base64 } }))];
    const req = { contents: [{ role: "user", parts }] };
    const resp = await generateContent(IMAGE_MODEL, req);
    const candidate = resp?.candidates?.[0];
    const outParts = candidate?.content?.parts ?? [];
    const img = outParts.find((p) => p?.inline_data?.data)?.inline_data;
    if (img?.data) return `data:${img.mime_type || "image/png"};base64,${img.data}`;
    throw new Error("Image generation unavailable (no inline image in response)");
}

// ---- ops ----
async function opSummarize(payload) {
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${SUMMARIZE_INSTR}\n\n${payload.text}` }] }]
    });
    const text = extractText(resp);
    const bullets = text.split("\n").map((l) => l.trim().replace(/^[-*•]\s*/, "")).filter(Boolean).slice(0, 5);
    return { bullets };
}
async function opDetectLanguage(payload) {
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${DETECT_LANGUAGE_INSTR}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    });
    const code = extractText(resp).trim().split(/\s+/)[0] || "und";
    return { language: code };
}
async function opTranslate(payload) {
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${TRANSLATE_INSTR(payload.from, payload.to)}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    });
    return { translated: extractText(resp) };
}
async function opClassify(payload) {
    const parts = [{ text: `${CLASSIFY_INSTR}\n\nProduct details:\n${payload.text}` }];
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
async function opComposeLooks(payload) {
    const instr = COMPOSE_LOOKS_INSTR(payload.createdFromItemId);
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${instr}\n\nWardrobe:\n${JSON.stringify(payload.wardrobe, null, 2)}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: payload.schema }
    });
    const obj = extractJson(resp);
    return { looks: Array.isArray(obj["looks"]) ? obj["looks"] : [] };
}
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
const SELECT_IMAGES_SCHEMA = {
    type: "object",
    properties: {
        selected: { type: "array", items: { type: "string" } },
        selectedIds: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" }
    },
    required: ["selected"]
};
async function opSelectProductImages(payload) {
    const anchors = Array.isArray(payload.anchors) ? payload.anchors.slice(0, 3) : [];
    const maxReturn = Math.max(1, Math.min(payload.maxReturn ?? 24, 24));
    const maxInline = Math.max(6, Math.min(payload.maxInline ?? 12, 12));
    const anchorHashes = [];
    for (const u of anchors) {
        try {
            const res = await fetch(u);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const f = await featuresFromBuffer(buf);
            anchorHashes.push(f.dhashHex);
        } catch { }
    }
    const enriched = await Promise.all(
        payload.candidates.map(async (c) => {
            let feats = {};
            try {
                const res = await fetch(c.url);
                if (res.ok) {
                    const buf = Buffer.from(await res.arrayBuffer());
                    const f = await featuresFromBuffer(buf);
                    feats = { dhash: f.dhashHex, dist: minDistanceToAnchors(f.dhashHex, anchorHashes) };
                }
            } catch { }
            return { ...c, ...feats };
        })
    );
    const editorialPenalty = (u) =>
        /(?:-e(?:\.|\/|-)|editorial|lookbook|campaign|lifestyle)/i.test(u) ? 1 : 0;
    const ranked = enriched
        .map((c) => ({
            ...c,
            dist: typeof c.dist === "number" ? c.dist : 48,
            penalty: editorialPenalty(c.url)
        }))
        .sort((a, b) => {
            const d = (a.dist ?? 64) - (b.dist ?? 64);
            if (d !== 0) return d;
            const s = (b.score ?? 0) - (a.score ?? 0);
            if (s !== 0) return s;
            return a.penalty - b.penalty;
        });
    let subset = ranked.filter((r) => (r.dist ?? 64) <= 16);
    if (subset.length < 4) subset = ranked.filter((r) => (r.dist ?? 64) <= 22);
    if (subset.length < 4) subset = ranked.slice(0, 20);
    const inlineParts = [];
    let inlineImageCount = 0;
    for (const u of anchors) {
        const inl = await fetchAsInline(u);
        if (!inl) continue;
        inlineParts.push({ text: `ANCHOR` }, { inline_data: { mime_type: inl.mime, data: inl.base64 } });
        inlineImageCount++;
    }
    const enumerated = subset.map((c, i) => ({ id: `C${i + 1}`, ...c }));
    for (const c of enumerated.slice(0, maxInline)) {
        const inl = await fetchAsInline(c.url);
        if (!inl) continue;
        inlineParts.push({ text: `CANDIDATE ${c.id} ${c.url}` }, { inline_data: { mime_type: inl.mime, data: inl.base64 } });
        inlineImageCount++;
    }
    const header = SELECT_PRODUCT_IMAGES_HEADER({
        pageTitle: payload.pageTitle,
        contextText: payload.pageText
    });
    const list = [
        `Candidates (${enumerated.length}):`,
        ...enumerated.map((c) =>
            `${c.id}: ${c.url}\n  origin=${c.origin ?? ""} score=${c.score ?? 0} distToAnchors=${c.dist ?? "NA"} penalty=${c.penalty}`
        ),
        `\nNotes: "distToAnchors" is dHash Hamming distance vs. anchor images. Lower means more visually similar.`
    ].join("\n");
    const parts = [{ text: header }, ...inlineParts, { text: list }];
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SELECT_IMAGES_SCHEMA }
    });
    const obj = extractJson(resp);
    let selected = [];
    if (Array.isArray(obj["selected"])) selected = obj["selected"].map(String);
    else if (Array.isArray(obj["selectedIds"])) {
        const ids = obj["selectedIds"].map(String);
        const map = new Map(enumerated.map((e) => [e.id, e.url]));
        selected = ids.map((id) => map.get(id)).filter(Boolean);
    }
    const allowedSet = new Set(enumerated.map((e) => e.url));
    const deDup = Array.from(new Set(selected)).filter((u) => allowedSet.has(u));
    const orderIndex = new Map(enumerated.map((e, i) => [e.url, i]));
    const final = deDup.sort((a, b) => (orderIndex.get(a) - orderIndex.get(b))).slice(0, maxReturn);
    return {
        selected: final,
        debug: {
            anchorsCount: anchors.length,
            inlineImageCount,
            candidatesSent: enumerated.length,
            receivedSelected: selected.length,
            finalSelected: final.length,
            thresholdInfo: {
                attempted16: ranked.filter((r) => (r.dist ?? 64) <= 16).length,
                attempted22: ranked.filter((r) => (r.dist ?? 64) <= 22).length
            }
        }
    };
}
async function opRenderLook(payload) {
    const images = [];
    if (payload.mannequinDataUrl?.startsWith("data:")) {
        const parsed = parseDataUrl(payload.mannequinDataUrl);
        if (parsed) images.push(parsed);
    } else if (payload.mannequinUrl) {
        const man = await fetchAsInline(payload.mannequinUrl);
        if (man) images.push(man);
    }
    for (const it of payload.items) {
        const urls = [];
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
    } catch (e) {
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

export const aiLogic = onRequest({ region: "us-central1", cors: true, timeoutSeconds: 120, memory: "1GiB" }, async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { bad(res, 405, "POST only"); return; }
    let op = ""; let payload = undefined;
    try { op = String(req.body?.op || ""); payload = req.body?.payload ?? {}; }
    catch { bad(res, 400, "Invalid JSON body"); return; }
    try {
        switch (op) {
            case "summarize": res.status(200).json(await opSummarize(payload)); return;
            case "detectLanguage": res.status(200).json(await opDetectLanguage(payload)); return;
            case "translate": res.status(200).json(await opTranslate(payload)); return;
            case "classify": res.status(200).json(await opClassify(payload)); return;
            case "composeLooks":
                if (!payload?.schema) { bad(res, 400, "Missing schema"); return; }
                res.status(200).json(await opComposeLooks(payload)); return;
            case "describeGarment": res.status(200).json(await opDescribeGarment(payload)); return;
            case "selectProductImages": res.status(200).json(await opSelectProductImages(payload)); return;
            case "renderLook": res.status(200).json(await opRenderLook(payload)); return;
            default: bad(res, 400, `Unknown op: ${op}`); return;
        }
    } catch (e) {
        logger.error(e);
        bad(res, 500, e.message || "Internal error");
    }
});
