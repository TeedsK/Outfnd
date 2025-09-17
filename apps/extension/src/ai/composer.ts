/**
 * Compose three looks (cloud when available, otherwise a tiny local fallback).
 * Fixes: no-empty catch blocks, strong typing, clean logging.
 */
import type { WardrobeItem, Outfit } from "@outfnd/shared/types";
import { cloudComposeLooks } from "../cloud/aiLogic";
import { isAiLogicConfigured } from "../config/env";

export type ComposeResult = { looks: Outfit[]; path: "device" | "cloud" | "stub" };

export async function composeLooks(
    wardrobe: WardrobeItem[],
    createdFromItemId?: string
): Promise<ComposeResult> {
    if (isAiLogicConfigured && wardrobe.length > 0) {
        try {
            const looks = await cloudComposeLooks(wardrobe, createdFromItemId);
            return { looks, path: "cloud" };
        } catch (err) {
            // fall back to stub
            console.debug("[composeLooks] cloud compose failed -> stub", err);
        }
    }

    // Tiny local heuristic fallback
    const now = Date.now();
    const pick = (n: number) =>
        wardrobe
            .slice(0, n)
            .map((w) => ({ itemId: w.id, role: guessRole(w) as Outfit["items"][number]["role"] }));

    const looks: Outfit[] = [
        { id: `stub_${now}_0`, occasion: "casual", items: pick(3), createdAt: now, createdFromItemId },
        { id: `stub_${now}_1`, occasion: "office", items: pick(3), createdAt: now, createdFromItemId },
        { id: `stub_${now}_2`, occasion: "evening", items: pick(3), createdAt: now, createdFromItemId }
    ];
    return { looks, path: "stub" };
}

function guessRole(w: WardrobeItem): string {
    const c = w.attributes.category.toLowerCase();
    if (/pant|trouser|jean|skirt|short/.test(c)) return "bottom";
    if (/jacket|coat|blazer|outer/.test(c)) return "outerwear";
    if (/shoe|boot|sneaker|heel/.test(c)) return "shoes";
    if (/bag|tote|backpack/.test(c)) return "bag";
    if (/belt|hat|scarf|sunglass|accessor/.test(c)) return "accessory";
    return "top";
}
