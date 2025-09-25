/**
 * Outfnd — Vision utilities
 * Perceptual hash (dHash) + color stats using Sharp.
 */

import sharp from "sharp";

export interface ImageFeatures {
    width: number;
    height: number;
    dhashHex: string;      // 16 hex chars (64 bits)
    avg: { r: number; g: number; b: number };
    bytes: number;
}

export async function featuresFromBuffer(buf: Buffer): Promise<ImageFeatures> {
    const img = sharp(buf).removeAlpha();

    const meta = await img.metadata();
    const stats = await img.stats();

    // dHash: grayscale → 9x8 → compare horizontal neighbors (8x8 bits)
    const small = await img
        .grayscale()
        .resize(9, 8, { fit: "fill" })
        .raw()
        .toBuffer();

    let bits = 0n;
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const left = small[row * 9 + col];
            const right = small[row * 9 + col + 1];
            const isDarker = left > right ? 1n : 0n;
            bits = (bits << 1n) | isDarker;
        }
    }

    const dhashHex = bits.toString(16).padStart(16, "0");
    const avg = {
        r: Math.round(stats.channels[0]?.mean ?? 0),
        g: Math.round(stats.channels[1]?.mean ?? 0),
        b: Math.round(stats.channels[2]?.mean ?? 0)
    };

    return {
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        dhashHex,
        avg,
        bytes: buf.byteLength
    };
}

export function hamming(hexA: string, hexB: string): number {
    const a = BigInt(`0x${hexA}`);
    const b = BigInt(`0x${hexB}`);
    let x = a ^ b;
    let count = 0;
    while (x) {
        x &= x - 1n;
        count++;
    }
    return count;
}

export function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db); // 0..~441.7
}

/** A small distance → higher similarity. */
export function minDistanceToAnchors(d: string, anchors: string[]): number {
    if (!anchors.length) return 64;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return Math.min(...anchors.map((a) => hamming(d, a)));
}
