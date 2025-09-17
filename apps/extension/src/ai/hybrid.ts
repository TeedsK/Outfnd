/**
 * Hybrid On-Device + Cloud AI Wrapper
 * Fixes:
 *  - no-empty catch blocks (now logging with console.debug)
 *  - type mismatch for cloudClassifyAttributes (now returns ClassifiedAttributes)
 *  - removed 3rd arg call (schema) to cloudClassifyAttributes (2-arg API)
 */
import {
    summarizeKeyPoints as stubSummarizeKeyPoints,
    detectLanguage as stubDetectLanguage,
    translate as stubTranslate,
    classifyAttributes as stubClassifyAttributes,
    type ClassifiedAttributes
} from "./stubs";
import type { ExtractedProduct } from "@outfnd/shared/clip";
import {
    cloudSummarizeKeyPoints,
    cloudDetectLanguage,
    cloudTranslate,
    cloudClassifyAttributes
} from "../cloud/aiLogic";
import { isAiLogicConfigured } from "../config/env";

export type EnginePath = "device" | "cloud" | "stub";

/* -------- Device (best-effort) -------- */
interface SummarizerInstance { summarize: (input: string) => Promise<string>; }
interface SummarizerNamespace { create: (options: Record<string, unknown>) => Promise<SummarizerInstance>; }
interface TranslatorInstance { translate: (text: string, options: Record<string, unknown>) => Promise<string>; }
interface TranslatorNamespace { create: (options?: Record<string, unknown>) => Promise<TranslatorInstance>; }
interface DetectorInstance { detect: (text: string) => Promise<string | { language: string }>; }
interface DetectorNamespace { create: (options?: Record<string, unknown>) => Promise<DetectorInstance>; }
interface ChromeAI { summarizer?: SummarizerNamespace; translator?: TranslatorNamespace; languageDetector?: DetectorNamespace; }

const getAI = (): ChromeAI | undefined => {
    const g = globalThis as unknown as { ai?: unknown };
    const ai = g.ai;
    if (typeof ai === "object" && ai !== null) return ai as ChromeAI;
    return undefined;
};

async function deviceSummarizeKeyPoints(text: string): Promise<string[]> {
    const ns = getAI()?.summarizer;
    if (!ns) throw new Error("no summarizer");
    const inst = await ns.create({ type: "key-points", length: "medium", format: "markdown" });
    const md = await inst.summarize(text);
    return md
        .split("\n")
        .map((l) => l.trim().replace(/^[-*]\s+/, ""))
        .filter(Boolean)
        .slice(0, 5);
}
async function deviceDetectLanguage(text: string): Promise<string> {
    const ns = getAI()?.languageDetector;
    if (!ns) throw new Error("no detector");
    const inst = await ns.create();
    const out = await inst.detect(text);
    return typeof out === "string" ? out : out?.language || "und";
}
async function deviceTranslate(text: string, from: string | undefined, to: string): Promise<string> {
    const ns = getAI()?.translator;
    if (!ns) throw new Error("no translator");
    const inst = await ns.create();
    return await inst.translate(text, { from, to, sourceLanguage: from, targetLanguage: to });
}
async function deviceClassifyAttributes(_imageDataUrl: string | undefined, textContext: string): Promise<ClassifiedAttributes> {
    // For maximum stability, we re-use the stub classifier for on-device path here.
    return await stubClassifyAttributes(undefined, textContext);
}

/* -------- Try helpers (device → cloud → stub) -------- */
async function trySummarize(text: string): Promise<{ bullets: string[]; path: EnginePath }> {
    try {
        return { bullets: await deviceSummarizeKeyPoints(text), path: "device" };
    } catch (err) {
        console.debug("[hybrid] device summarize failed", err);
    }
    if (isAiLogicConfigured) {
        try {
            return { bullets: await cloudSummarizeKeyPoints(text), path: "cloud" };
        } catch (err) {
            console.debug("[hybrid] cloud summarize failed", err);
        }
    }
    return { bullets: await stubSummarizeKeyPoints(text, 5), path: "stub" };
}

async function tryDetect(text: string): Promise<{ language: string; path: EnginePath }> {
    try {
        return { language: await deviceDetectLanguage(text), path: "device" };
    } catch (err) {
        console.debug("[hybrid] device detect failed", err);
    }
    if (isAiLogicConfigured) {
        try {
            return { language: await cloudDetectLanguage(text), path: "cloud" };
        } catch (err) {
            console.debug("[hybrid] cloud detect failed", err);
        }
    }
    return { language: await stubDetectLanguage(text), path: "stub" };
}

async function tryTranslate(
    text: string,
    from: string | undefined,
    to: string
): Promise<{ translated: string; path: EnginePath }> {
    try {
        return { translated: await deviceTranslate(text, from, to), path: "device" };
    } catch (err) {
        console.debug("[hybrid] device translate failed", err);
    }
    if (isAiLogicConfigured) {
        try {
            return { translated: await cloudTranslate(text, from, to), path: "cloud" };
        } catch (err) {
            console.debug("[hybrid] cloud translate failed", err);
        }
    }
    return { translated: await stubTranslate(text, { from, to }), path: "stub" };
}

async function tryClassify(
    imageDataUrl: string | undefined,
    textContext: string
): Promise<{ attributes: ClassifiedAttributes; path: EnginePath }> {
    try {
        return { attributes: await deviceClassifyAttributes(imageDataUrl, textContext), path: "device" };
    } catch (err) {
        console.debug("[hybrid] device classify failed", err);
    }
    if (isAiLogicConfigured) {
        try {
            // NOTE: cloudClassifyAttributes is typed to return ClassifiedAttributes
            return { attributes: await cloudClassifyAttributes(imageDataUrl, textContext), path: "cloud" };
        } catch (err) {
            console.debug("[hybrid] cloud classify failed", err);
        }
    }
    return { attributes: await stubClassifyAttributes(imageDataUrl, textContext), path: "stub" };
}

/* -------- Public facade -------- */
export interface AnalyzeOutput {
    keyPoints: string[];
    language: string;
    translatedContext?: string;
    attributes: ClassifiedAttributes;
    path: EnginePath; // aggregated best path used across stages
}

export async function analyzeProduct(product: ExtractedProduct): Promise<AnalyzeOutput> {
    const textContext =
        `${product.title}\n\n${product.description ?? ""}\n\n${product.returnsText ?? ""}`.trim();

    const lang = await tryDetect(textContext);
    const needsTranslation = lang.language && lang.language !== "en" && lang.language !== "und";

    let translatedContext: string | undefined;
    let summarizeText = textContext;

    if (needsTranslation) {
        const t = await tryTranslate(textContext, lang.language, "en");
        translatedContext = t.translated;
        summarizeText = t.translated;
    }

    const cls = await tryClassify(product.images?.[0], textContext);
    const sum = await trySummarize(summarizeText);

    const used: EnginePath[] = [lang.path, cls.path, sum.path];
    const path: EnginePath = used.includes("device")
        ? "device"
        : used.includes("cloud")
            ? "cloud"
            : "stub";

    return {
        keyPoints: sum.bullets,
        language: lang.language,
        translatedContext,
        attributes: cls.attributes,
        path
    };
}
