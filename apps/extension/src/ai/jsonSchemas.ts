/** JSON Schemas used for deterministic JSON-mode responses. */
export const ATTRIBUTE_SCHEMA = {
    type: "object",
    properties: {
        category: { type: "string" },
        colors: { type: "array", items: { type: "string" } },
        material: { type: "array", items: { type: "string" } },
        pattern: { type: "array", items: { type: "string" } },
        seasonality: { type: "array", items: { type: "string" } },
        styleTags: { type: "array", items: { type: "string" } },
        occasionTags: { type: "array", items: { type: "string" } }
    },
    required: ["category", "colors", "styleTags"]
} as const;

export const LOOKS_SCHEMA = {
    type: "object",
    properties: {
        looks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    occasion: { type: "string", enum: ["casual", "office", "evening"] },
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                itemId: { type: "string" },
                                role: { type: "string" }
                            },
                            required: ["itemId", "role"]
                        }
                    },
                    rationale: { type: "string" }
                },
                required: ["occasion", "items"]
            }
        }
    },
    required: ["looks"]
} as const;

export const GARMENT_HINTS_SCHEMA = {
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
} as const;
