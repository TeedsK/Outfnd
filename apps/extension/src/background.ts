/**
 * Outfnd — Background Service Worker (MV3)
 * Purpose: Side-panel click behavior + message router for clip requests.
 */
import type { ClipResponse } from "@outfnd/shared/clip";
import { MSG, isRequestClipMessage } from "./messaging/messages";

chrome.runtime.onInstalled.addListener(async () => {
    if ("sidePanel" in chrome) {
        try {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        } catch (err) {
            // Some environments may not allow sidePanel behavior changes; ignore.
            console.warn("sidePanel.setPanelBehavior error:", err);
        }
    }
});

chrome.runtime.onMessage.addListener(
    (
        message: unknown,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response: ClipResponse) => void
    ) => {
        if (isRequestClipMessage(message)) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs: chrome.tabs.Tab[]) => {
                const tabId = tabs[0]?.id;
                if (!tabId) {
                    sendResponse({ ok: false, error: "No active tab found." });
                    return;
                }

                // Use the 4-argument overload: (tabId, message, options, callback)
                chrome.tabs.sendMessage(
                    tabId,
                    { type: MSG.RUN_CLIP },
                    undefined,
                    (res?: unknown) => {
                        const clip = res as ClipResponse | undefined;
                        if (clip) {
                            sendResponse(clip);
                        } else {
                            sendResponse({ ok: false, error: "No response from content script." });
                        }
                    }
                );
            });

            // Tell Chrome we're replying asynchronously
            return true;
        }

        return undefined;
    }
);
