/**
 * Outfnd — Messaging constants & types
 * Purpose: Single source of truth for message keys used across contexts.
 */
export const MSG = {
    REQUEST_CLIP: "OUTFND/REQUEST_CLIP",
    RUN_CLIP: "OUTFND/RUN_CLIP"
} as const;

export type MessageKey = typeof MSG[keyof typeof MSG];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;

export interface RequestClipMessage {
    type: typeof MSG.REQUEST_CLIP;
}
export interface RunClipMessage {
    type: typeof MSG.RUN_CLIP;
}

export const isRequestClipMessage = (m: unknown): m is RequestClipMessage => {
    if (!isRec(m)) return false;
    const t = m["type"];
    return typeof t === "string" && t === MSG.REQUEST_CLIP;
};

export const isRunClipMessage = (m: unknown): m is RunClipMessage => {
    if (!isRec(m)) return false;
    const t = m["type"];
    return typeof t === "string" && t === MSG.RUN_CLIP;
};
