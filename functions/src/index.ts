/**
 * Firebase Function: aiLogic (single endpoint router)
 * Ops:
 *  - summarize        -> { bullets: string[] }
 *  - detectLanguage   -> { language: string }
 *  - translate        -> { translated: string }
 *  - classify         -> schema-constrained JSON { category, colors, ... }
 *  - composeLooks     -> { looks: [...] }
 *  - describeGarment  -> { bullets: string[], ...aux render hints... }
 *  - renderLook       -> { dataUrl: "data:image/png;base64,..." }
 *
 * Image previews are now generated with Gemini 2.5 Flash Image **Preview** (aka “Nano Banana”),
 * using the mannequin as the base layer and blending the wardrobe item images on top.
 * If hints are not provided, we auto-describe garments to extract fit/placement/drift cues.
 */

import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";

initializeApp();

type Json = Record<string, unknown>;

/** ---------- Config ---------- */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const REGION = "us-central1";
const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-1.5-flash";

/**
 * IMPORTANT: default to the preview image model, which supports editing/multi-image fusion.
 * See: https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/ ,
 *      https://ai.google.dev/gemini-api/docs/image-generation
 */
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image-preview";

/** ---------- Utilities ---------- */

function ok(res: any, data: unknown): void {
    res.status(200).json(data);
}
function bad(res: any, code: number, msg: string): void {
    res.status(code).json({ error: msg });
}
function ensureKey(): void {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
}

/** extract the first plain text part from a generateContent response */
function extractText(anyResp: unknown): string {
    const r = anyResp as any;
    const c = r?.candidates?.[0];
    const parts = c?.content?.parts ?? [];
    const t = parts.find((p: any) => typeof p?.text === "string")?.text;
    return typeof t === "string" ? t : "";
}

/** parse JSON placed in the first text part from a generateContent response */
function extractJson(anyResp: unknown): Json {
    const txt = extractText(anyResp);
    try {
        const obj = JSON.parse(txt);
        if (obj && typeof obj === "object") return obj as Json;
    } catch {
        /* noop: fallthrough */
    }
    return {};
}

async function postJson(url: string, body: unknown): Promise<any> {
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

async function generateContent(model: string, request: Json): Promise<any> {
    ensureKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
    )}:generateContent`;
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
    } catch {
        return undefined;
    }
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | undefined {
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return undefined;
    return { mime: m[1], base64: m[2] };
}

/** ---------- Image generation helpers (Nano Banana) ---------- */

/**
 * Try image editing / fusion using:
 *  1) generateContent on IMAGE_MODEL with responseMimeType=image/png and inline_data parts
 *  2) fallback to v1beta images:generate
 */
async function generateOutfitImageNanoBanana(
    prompt: string,
    images: Array<{ mime: string; base64: string }>
): Promise<string> {
    ensureKey();

    // Attempt 1: generateContent with inline_data
    try {
        const parts: any[] = [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.base64 } }))];
        const req = {
            contents: [{ role: "user", parts }],
            generationConfig: {
                responseMimeType: "image/png"
            }
        };
        const resp = await generateContent(IMAGE_MODEL, req as Json);
        const candidate = resp?.candidates?.[0];
        const outParts = candidate?.content?.parts ?? [];
        const img = outParts.find((p: any) => p?.inline_data?.data)?.inline_data;
        if (img?.data) return `data:${img.mime_type || "image/png"};base64,${img.data}`;
    } catch (e) {
        logger.warn("generateContent(image) failed; will try fallback", e as Error);
    }

    // Attempt 2: images:generate (preview supports text+image fusion)
    try {
        const url = "https://generativelanguage.googleapis.com/v1beta/images:generate";
        const req = {
            model: IMAGE_MODEL,
            prompt: { text: prompt },
            images: images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.base64 } }))
        };
        const resp = await postJson(url, req);
        const first = resp?.images?.[0];
        if (first?.inlineData?.data) {
            return `data:${first.inlineData.mimeType || "image/png"};base64,${first.inlineData.data}`;
        }
    } catch (e) {
        logger.warn("images:generate failed", e as Error);
    }

    throw new Error("Image generation unavailable (model or endpoint not enabled)");
}

/** ---------- Text ops ---------- */

async function opSummarize(payload: { text: string }) {
    const instr = "Summarize the following product information into 3–5 concise bullet points (fit, care, returns).";
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${instr}\n\n${payload.text}` }] }]
    });
    const text = extractText(resp);
    const bullets = text
        .split("\n")
        .map((l) => l.trim().replace(/^[-*•]\s*/, ""))
        .filter(Boolean)
        .slice(0, 5);
    return { bullets };
}

async function opDetectLanguage(payload: { text: string }) {
    const instr = "Detect the language and return ONLY a BCP‑47 code (e.g., en, es, fr).";
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${instr}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    });
    const code = extractText(resp).trim().split(/\s+/)[0] || "und";
    return { language: code };
}

async function opTranslate(payload: { text: string; from?: string; to: string }) {
    const instr = `Translate from ${payload.from || "auto"} to ${payload.to}. Return only the translation.`;
    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${instr}\n\n${payload.text}` }] }],
        generationConfig: { responseMimeType: "text/plain" }
    });
    return { translated: extractText(resp) };
}

/** ---------- JSON‑mode ops ---------- */

async function opClassify(payload: { text: string; imageDataUrl?: string; schema: Json }) {
    const instruction = [
        "You are a fashion product attribute classifier.",
        "Return ONLY JSON that conforms to the provided schema.",
        "Use common fashion terms (e.g., 'navy', 'ecru', 'pinstripe').",
        "Infer reasonable attributes if not explicitly stated."
    ].join(" ");

    const parts: any[] = [{ text: `${instruction}\n\nProduct details:\n${payload.text}` }];
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
    const instruction = [
        "Compose three outfits for the following occasions: casual, office, evening.",
        "Use ONLY the provided wardrobe item ids.",
        payload.createdFromItemId ? `Include the seed item id "${payload.createdFromItemId}" in each look.` : "",
        "Return ONLY JSON that conforms to the schema. Avoid commentary outside JSON."
    ].join(" ");

    const resp = await generateContent(TEXT_MODEL, {
        contents: [{ role: "user", parts: [{ text: `${instruction}\n\nWardrobe:\n${JSON.stringify(payload.wardrobe, null, 2)}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: payload.schema }
    });

    const obj = extractJson(resp);
    return { looks: Array.isArray(obj["looks"]) ? (obj["looks"] as unknown[]) : [] };
}

/** ---------- Garment description (image+text → placement hints) ---------- */

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

    const preface = [
        "You are a fashion vision-language expert. Analyze the garment in the provided image(s) and optional text.",
        "Return ONLY JSON per the schema. Be specific and concise.",
        "Include body-position cues (e.g., 'hem hits at knees', 'cropped above ankle'), fit (slim/relaxed/oversized), silhouette, rise/waist.",
        "Provide stylingNotes that help place and align this garment on a blank mannequin realistically."
    ].join(" ");

    const parts: any[] = [{ text: `${preface}\n\nTitle: ${payload.title ?? ""}\n\nDetails:\n${payload.text ?? ""}` }];

    // Inline images (URLs and data URLs)
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

/** ---------- Image render (mannequin + garments → fused preview) ---------- */

/** Local type for hints (kept in-sync with apps/extension shared type without importing). */
type Hints = {
    bullets?: string[];
    fit?: string;
    silhouette?: string;
    length?: string;
    waist?: string;
    rise?: string;
    sleeve?: string;
    neckline?: string;
    drape?: string;
    fabricWeight?: string;
    pattern?: string;
    placementCues?: string[];
    stylingNotes?: string[];
    mannequinRecommendation?: string;
};

function buildHintBullets(h?: Hints | null): string[] {
    if (!h) return [];
    const out: string[] = [];
    if (h.fit) out.push(`fit: ${h.fit}`);
    if (h.silhouette) out.push(`silhouette: ${h.silhouette}`);
    if (h.length) out.push(`length: ${h.length}`);
    if (h.waist) out.push(`waist: ${h.waist}`);
    if (h.rise) out.push(`rise: ${h.rise}`);
    if (h.sleeve) out.push(`sleeve: ${h.sleeve}`);
    if (h.neckline) out.push(`neckline: ${h.neckline}`);
    if (h.drape) out.push(`drape: ${h.drape}`);
    if (h.fabricWeight) out.push(`fabricWeight: ${h.fabricWeight}`);
    if (h.pattern) out.push(`pattern: ${h.pattern}`);
    for (const p of h.placementCues ?? []) out.push(`placement: ${p}`);
    for (const s of h.stylingNotes ?? []) out.push(`style: ${s}`);
    for (const b of h.bullets ?? []) out.push(b);
    return out;
}

async function opRenderLook(payload: {
    mannequinUrl?: string;
    mannequinDataUrl?: string;
    items: Array<{ title: string; role: string; imageUrl?: string; hintBullets?: string[]; hints?: Hints }>;
    style?: string;
    background?: string;
}) {
    /** 1) Collect images: mannequin first, then each garment */
    const images: Array<{ mime: string; base64: string }> = [];

    // Mannequin (URL or data URL)
    if (payload.mannequinDataUrl?.startsWith("data:")) {
        const parsed = parseDataUrl(payload.mannequinDataUrl);
        if (parsed) images.push(parsed);
    } else if (payload.mannequinUrl) {
        const man = await fetchAsInline(payload.mannequinUrl);
        if (man) images.push(man);
    }

    // Garment images
    const itemsResolved = [];
    for (const it of payload.items.slice(0, 4)) {
        let imgInline: { mime: string; base64: string } | undefined;
        if (it.imageUrl) imgInline = await fetchAsInline(it.imageUrl);
        if (imgInline) images.push(imgInline);

        // Ensure we have usable hints: prefer provided, otherwise auto‑describe from image.
        let hints: Hints | undefined = it.hints;
        if ((!hints || buildHintBullets(hints).length === 0) && it.imageUrl) {
            try {
                const desc = await opDescribeGarment({ title: it.title, imageUrls: [it.imageUrl] });
                const coerce = (k: string) => (typeof (desc as any)[k] === "string" ? String((desc as any)[k]) : undefined);
                const coerceArr = (k: string) => (Array.isArray((desc as any)[k]) ? (desc as any)[k].map(String) : undefined);
                hints = {
                    bullets: coerceArr("bullets"),
                    fit: coerce("fit"),
                    silhouette: coerce("silhouette"),
                    length: coerce("length"),
                    waist: coerce("waist"),
                    rise: coerce("rise"),
                    sleeve: coerce("sleeve"),
                    neckline: coerce("neckline"),
                    drape: coerce("drape"),
                    fabricWeight: coerce("fabricWeight"),
                    pattern: coerce("pattern"),
                    placementCues: coerceArr("placementCues"),
                    stylingNotes: coerceArr("stylingNotes"),
                    mannequinRecommendation: coerce("mannequinRecommendation")
                };
            } catch (err) {
                logger.warn("describeGarment during render failed; continuing without hints", err as Error);
            }
        }

        itemsResolved.push({ ...it, hints });
    }

    /** 2) Compose guidance text */
    const garmentList = itemsResolved.map((i) => `${i.role}: ${i.title}`).join("; ");

    const perItemGuidance = itemsResolved
        .map((i) => {
            const bullets = [
                ...(i.hintBullets ?? []),
                ...buildHintBullets(i.hints)
            ];
            const bulletText = bullets.length ? `\n- ${bullets.join("\n- ")}` : "";
            return `For ${i.role} (“${i.title}”):${bulletText}`;
        })
        .join("\n\n");

    const bg = payload.background || "soft neutral studio backdrop (#f7f7f7), subtle drop shadow";
    const style =
        payload.style ||
        "realistic garment draping on a neutral mannequin, true-to-color, minimal reflections, high detail, product photography, PNG output";

    const prompt = [
        // System-style guardrails for Nano Banana compositing
        "Use the FIRST inline image as the base mannequin.",
        "Blend the subsequent garment images onto the mannequin to form a single outfit preview.",
        "Keep the mannequin static and centered; do not change the body pose. Respect gravity and seam alignment. Preserve the original garment colors/patterns.",
        "Scale and position garments to match realistic proportions. Align shoulder seams, waist/rise, and hems per guidance. Avoid adding extra accessories.",
        `Outfit items: ${garmentList}.`,
        "Per-item guidance:",
        perItemGuidance,
        `Style: ${style}. Background: ${bg}.`,
        "Output a single front-facing product preview image in PNG format."
    ]
        .filter(Boolean)
        .join("\n");

    /** 3) Generate the image */
    try {
        const dataUrl = await generateOutfitImageNanoBanana(prompt, images);
        return { dataUrl };
    } catch (e) {
        // Graceful placeholder SVG to avoid UI breakage
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

/** ---------- HTTP entrypoint ---------- */

export const aiLogic = onRequest(
    { region: REGION, cors: true, timeoutSeconds: 120, memory: "1GiB" },
    async (req, res): Promise<void> => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        if (req.method === "OPTIONS") {
            res.status(204).send("");
            return;
        }
        if (req.method !== "POST") {
            bad(res, 405, "POST only");
            return;
        }

        let op = "";
        let payload: any = undefined;
        try {
            op = String(req.body?.op || "");
            payload = req.body?.payload ?? {};
        } catch {
            bad(res, 400, "Invalid JSON body");
            return;
        }

        try {
            switch (op) {
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
                case "renderLook":
                    ok(res, await opRenderLook(payload));
                    return;
                default:
                    bad(res, 400, `Unknown op: ${op}`);
                    return;
            }
        } catch (e) {
            logger.error(e);
            bad(res, 500, (e as Error).message || "Internal error");
        }
    }
);
