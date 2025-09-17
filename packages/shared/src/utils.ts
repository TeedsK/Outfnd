/**
 * Outfnd — Lightweight shared utilities
 */
export const now = () => Date.now();

export const byCreatedDesc = <T extends { createdAt: number }>(a: T, b: T) =>
    b.createdAt - a.createdAt;

export const clamp = (n: number, min: number, max: number) =>
    Math.min(max, Math.max(min, n));
