/**
 * No-op stub so the extension compiles without the Firebase Web SDK.
 * Fix: mark param as used to satisfy @typescript-eslint/no-unused-vars.
 */
import type { WardrobeItem } from "@outfnd/shared/types";

export async function syncWardrobeItemToFirestore(item: WardrobeItem): Promise<void> {
    void item; // intentionally unused in this stub
    return;
}
