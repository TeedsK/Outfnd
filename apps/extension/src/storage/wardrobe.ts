/**
 * Local wardrobe storage (Chrome storage with localStorage fallback).
 * Fix: added no-op statements inside catch blocks to satisfy no-empty.
 */
import type { WardrobeItem, WardrobeAttributes, RenderHints } from "@outfnd/shared/types";

const KEY = "outfnd/wardrobe/v1";

async function getStore(): Promise<WardrobeItem[]> {
    try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            const data = await chrome.storage.local.get(KEY);
            const arr = (data?.[KEY] ?? []) as WardrobeItem[];
            return Array.isArray(arr) ? arr : [];
        }
    } catch {
        // noop (fallback to localStorage)
        void 0;
    }
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as WardrobeItem[]) : [];
}

async function setStore(items: WardrobeItem[]): Promise<void> {
    try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            await chrome.storage.local.set({ [KEY]: items });
            return;
        }
    } catch {
        // noop (fallback to localStorage)
        void 0;
    }
    localStorage.setItem(KEY, JSON.stringify(items));
}

export async function listWardrobeItems(): Promise<WardrobeItem[]> {
    return await getStore();
}

export function indexById<T extends { id: string }>(arr: T[]): Record<string, T> {
    const m: Record<string, T> = {};
    for (const it of arr) m[it.id] = it;
    return m;
}

export async function addItemFromAnalysis(
    product: { title: string; url: string; images?: string[] },
    attributes: WardrobeAttributes,
    language?: string,
    renderHints?: RenderHints
): Promise<WardrobeItem> {
    const items = await getStore();
    const now = Date.now();
    const id = `itm_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const item: WardrobeItem = {
        id,
        title: product.title,
        sourceUrl: product.url,
        images: product.images ?? [],
        attributes: { ...attributes, language },
        renderHints,
        createdAt: now,
        updatedAt: now
    };
    items.unshift(item);
    await setStore(items);
    return item;
}
