/**
 * Outfnd — Shared data model types
 * Purpose: One source of truth for wardrobe items, outfits, and attribute structures.
 */
export type Bcp47 = string;

/** Hints used to place/compose garments on a mannequin render. */
export interface RenderHints {
    bullets?: string[];
    fit?: string;
    silhouette?: string;
    length?: string;       // e.g., "mid-calf", "ankle", "above-knee"
    waist?: string;        // e.g., "high waist", "mid rise"
    rise?: string;
    sleeve?: string;
    neckline?: string;
    drape?: string;
    fabricWeight?: string;
    pattern?: string;
    placementCues?: string[];
    stylingNotes?: string[];
    mannequinRecommendation?: "female" | "male" | "auto";
}

export interface WardrobeAttributes {
    category: string;
    colors: string[];
    material?: string[];
    pattern?: string[];
    seasonality?: string[];
    styleTags: string[];
    occasionTags?: string[];
    fitNotes?: string;
    careNotes?: string;
    returnPolicy?: string;
    retailer?: string;
    price?: number | null;
    currency?: string | null;
    language?: Bcp47;
}

export interface WardrobeItem {
    id: string;
    title: string;
    sourceUrl: string;
    images: string[];
    /** User-selected images most representative of this garment. */
    selectedImages?: string[];
    attributes: WardrobeAttributes;
    /** Optional garment description & placement hints derived from image+text. */
    renderHints?: RenderHints;
    createdAt: number;
    updatedAt: number;
}

export type OutfitOccasion = "casual" | "office" | "evening";

export interface OutfitItemRef {
    itemId: string;
    role: "top" | "bottom" | "outerwear" | "shoes" | "accessory" | "bag";
}

export interface Outfit {
    id: string;
    occasion: OutfitOccasion;
    items: OutfitItemRef[];
    rationale?: string;
    createdFromItemId?: string;
    createdAt: number;
}
