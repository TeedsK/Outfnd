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

export const TRANSLATE_INSTR = (from: string | undefined, to: string) => `
Translate from ${from || "auto"} to ${to}. Return only the translation text.
`.trim();

export const CLASSIFY_INSTR = `
You are a fashion product attribute classifier.
Return ONLY JSON that conforms to the provided schema.
Prefer common fashion terms, e.g., "navy", "ecru", "pinstripe".
Infer reasonable attributes if not explicitly stated.
`.trim();

export const COMPOSE_LOOKS_INSTR = (seed?: string) => `
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
 *  - inline "CANDIDATE Ci <url>" for a subset
 *  - plain-text list of all candidates (id, url, similarity features, origin)
 * The model must assign **every** candidate to exactly one of:
 *   confident | semiConfident | notConfident
 */
export const SELECT_PRODUCT_IMAGES_HEADER = (args: {
    pageTitle?: string;
    contextText?: string;
}) => {
    const lines: string[] = [
        `Task: Assign every candidate image to one of three buckets with respect to the ANCHOR product images:`,
        `  • "confident" — definitely the SAME product (packshot/angle/close-up of the same item).`,
        `  • "semiConfident" — likely the same product but with some uncertainty (lighting/pose/crop).`,
        `  • "notConfident" — different product, editorial/lifestyle/banner, or cannot verify.`,
        ``,
        `STRICT checklist for "same product":`,
        `  1) Color/Tone: identical or within small studio variance.`,
        `  2) Silhouette & details: same collar type; pocket/closure count+placement; hem/length; seams.`,
        `  3) Fabric/texture & pattern: same weave/denim/knit; same pattern layout/scale.`,
        `  4) Hardware: buttons/zippers/snaps match in number, color, and position.`,
        `  5) Logos/labels: present/absent in the same place (if visible).`,
        ``,
        `Heuristics provided:`,
        `  • dHash Hamming distance vs anchors (lower is more visually similar).`,
        `  • URL cues: product vs editorial/lookbook/campaign.`,
        `  • We'll inline only a subset of candidates as thumbnails; for others, use the numeric cues.`,
        `Be conservative: borderline → "semiConfident"; clear mismatches → "notConfident".`,
        ``,
    ];
    if (args.pageTitle) lines.push(`Page Title: ${args.pageTitle}`);
    if (args.contextText) lines.push(`Context:\n${args.contextText}`);
    lines.push(
        ``,
        `Return ONLY JSON:`,
        `{"groups":{"confident":[urls...],"semiConfident":[urls...],"notConfident":[urls...]}}`,
        `All candidates must appear in one of the arrays; no commentary outside JSON.`
    );
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
