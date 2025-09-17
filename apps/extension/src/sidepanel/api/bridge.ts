/**
 * Outfnd — Side-panel bridge
 * Purpose: Request a clip from the active tab via background, await ClipResponse.
 */
import { MSG } from "../../messaging/messages";
import type { ClipResponse } from "@outfnd/shared/clip";

export function requestClip(): Promise<ClipResponse> {
    return new Promise((resolve) => {
        // Use the 3-argument overload: (message, options, callback)
        chrome.runtime.sendMessage(
            { type: MSG.REQUEST_CLIP },
            undefined,
            (res: unknown) => {
                resolve((res as ClipResponse) ?? { ok: false, error: "Unknown response" });
            }
        );
    });
}
