/**
 * Outfnd — Content Script
 * Purpose: Listens for RUN_CLIP, extracts product data from current page,
 *          and returns a typed ClipResponse.
 */
import type { ClipResponse } from "@outfnd/shared/clip";
import { isRunClipMessage } from "../messaging/messages";
import { clipCurrentDocument } from "./clipper";

(() => {
    try {
        document.documentElement.dataset.outfndInjected = "1";
    } catch {
        // Some pages block dataset changes; safe to ignore
    }
})();

chrome.runtime.onMessage.addListener(
    (
        message: unknown,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response: ClipResponse) => void
    ) => {
        if (isRunClipMessage(message)) {
            clipCurrentDocument()
                .then(sendResponse)
                .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    sendResponse({ ok: false, error: msg });
                });
            return true; // keep channel open
        }
        return undefined;
    }
);
