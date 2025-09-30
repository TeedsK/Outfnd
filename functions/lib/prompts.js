/**
 * Outfnd — Prompt Library
 * Centralized, tweakable prompts for all Gemini ops.
 */
export const SUMMARIZE_INSTR = `
Summarize the following product information into 3–5 concise bullet points
focused strictly on: fit, care, and returns policy.
Return bullet lines only (no headings).
`.trim();
export const DETECT_LANGUAGE_INSTR = `
Detect the language and return ONLY a BCP‑47 code (e.g., en, es, fr).
`.trim();
export const TRANSLATE_INSTR = (from, to) => `
Translate from ${from || "auto"} to ${to}. Return only the translation text.
`.trim();
export const CLASSIFY_INSTR = `
You are a fashion product attribute classifier.
Return ONLY JSON that conforms to the provided schema.
Prefer common fashion terms, e.g., "navy", "ecru", "pinstripe".
Infer reasonable attributes if not explicitly stated.
`.trim();
export const COMPOSE_LOOKS_INSTR = (seed) => `
Compose three outfits for the following occasions: casual, office, evening.
Use ONLY the provided wardrobe item ids.
${seed ? `Include the seed item id "${seed}" in each look.` : ""}
Return ONLY JSON that conforms to the schema. Avoid commentary outside JSON.
`.trim();
export const DESCRIBE_GARMENT_PREFACE = `
You are a fashion vision-language expert. Analyze the garment in the provided image(s)
and the optional text. Return ONLY JSON per the schema, being specific and concise.
Include body-position cues (e.g., "hem hits at knees", "cropped above ankle"),
fit (slim/relaxed/oversized), silhouette, rise/waist. Provide stylingNotes that help place
and align this garment on a blank mannequin realistically.
`.trim();
/**
 * Selection instruction for keeping only angles/close‑ups of the SAME product.
 * Caller attaches:
 *  - inline "ANCHOR" images (ground truth)
 *  - inline "CANDIDATE Ci <url>" for a subset (or all if small)
 *  - plain‑text list of ALL candidates (id, url, numeric cues, heuristics)
 * The model must assign **every** candidate to exactly one of:
 *   confident | semiConfident | notConfident
 *
 * Upgrade: strongly incorporate product text, then verify visually against anchors.
 */
export const SELECT_PRODUCT_IMAGES_HEADER = (args) => {
    const ctx = (args.contextText ?? "").slice(0, 1600);
    const lines = [
        `Task: Assign EVERY candidate image to one of three buckets with respect to the SAME focal product shown in the ANCHOR images.`,
        ``,
        `Buckets (you will still return keys "confident", "semiConfident", "notConfident"):`,
        `  • "confident" — more images of the SAME product (packshot/angle/close‑up of the same item).`,
        `  • "semiConfident" — similar clothing likely to be the same, but uncertain (lighting/pose/crop/partial view).`,
        `  • "notConfident" — other found images: different product/color/print/wash/fabric, editorial banners, or unverifiable.`,
        ``,
        `Use BOTH sources of truth:`,
        `  (A) The ANCHOR images (ground truth photos).`,
        `  (B) The PRODUCT TEXT below (title + description snippets).`,
        ``,
        `PRODUCT TEXT`,
        `────────────────────────────────────────────────`,
        `Title: ${args.pageTitle || "(unknown)"}`,
        ctx ? `Text:\n${ctx}` : `Text: (none provided)`,
        `────────────────────────────────────────────────`,
        ``,
        `Step 1 — Canonical Product Descriptor (ONE short line):`,
        `  • From PRODUCT TEXT, infer garment type + color + fabric/hardware keywords.`,
        `    Example: "dark navy cotton shirt‑jacket with snap front".`,
        `  • Treat near‑synonyms for color appropriately (navy≈midnight blue, off‑white≈ecru, etc.),`,
        `    but DO NOT conflate distinct colors (black ≠ navy; cream ≠ gray).`,
        ``,
        `Step 2 — Strict "same product" checklist BEFORE 'confident'/'semiConfident':`,
        `  1) Color/Tone: matches descriptor and anchors (allow small studio variance).`,
        `  2) Silhouette & cut: length, collar/neckline, placket/closure, cuff/hem shape.`,
        `  3) Fabric/texture & pattern: same weave/denim/knit; same pattern layout/scale.`,
        `  4) Hardware & trim: number/placement of buttons/snaps/zips, drawcords, labels.`,
        `  5) Logos/labels: present/absent in the same place (if visible).`,
        ``,
        `Heuristics provided in the list:`,
        `  • dHash distance vs anchors (lower is more similar).`,
        `  • colorSim (0–1) vs average anchor color.`,
        `  • URL cues: product vs editorial/lookbook/campaign; "packshot" hints.`,
        ``,
        `Rules:`,
        `  • If a candidate is identical or a near‑duplicate of an ANCHOR, put it in "confident".`,
        `  • Borderline → "semiConfident"; clear mismatches → "notConfident".`,
        `  • Editorial with a person is acceptable ONLY if the focal garment is clearly the same item.`,
        `  • Include ALL candidates in exactly one bucket; do not drop any.`,
        ``,
        `Return ONLY JSON:`,
        `{"groups":{"confident":[urls...],"semiConfident":[urls...],"notConfident":[urls...]}}`
    ];
    return lines.join("\n");
};
/** Style line added to render prompts (tweakable). */
export const RENDER_STYLE_LINE = `
Style: realistic garment draping on a blank mannequin, true-to-color,
minimal reflections, high detail, studio product photography (4k).
`.trim();
export const RENDER_BG_LINE = `
Background: soft neutral studio (#f7f7f7) with subtle drop shadow.
`.trim();
