/**
 * Outfnd — Side Panel App (white/off-white palette)
 * Now shows a spinner while Gemini renders, retries failed tiles, emits
 * structured debug logs, and sends richer garment hints to the cloud
 * so Nano Banana can place clothes on the mannequin more reliably.
 */
import React from "react";
import { requestClip } from "./api/bridge";
import type { ExtractedProduct } from "@outfnd/shared/clip";
import type { Outfit, WardrobeItem, RenderHints } from "@outfnd/shared/types";
import { analyzeProduct, type AnalyzeOutput } from "../ai/hybrid";
import { addItemFromAnalysis, listWardrobeItems, indexById } from "../storage/wardrobe";
import { SettingsPanel } from "./Settings";
import { syncWardrobeItemToFirestore } from "../cloud/firebase";
import { loadSettings } from "../settings/store";
import {
    cloudDescribeGarment,
    cloudRenderLookPreview,
    type RenderLookInput
} from "../cloud/aiLogic";
import { isAiLogicConfigured } from "../config/env";
import { composeLooks, type ComposeResult } from "../ai/composer";
import { loadMannequin, type MannequinKind } from "../assets/mannequinLoader";
import { aiLogicUrl } from "../config/env";

type ClipState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; product: ExtractedProduct }
    | { status: "error"; error: string };

type AnalyzeState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; result: AnalyzeOutput }
    | { status: "error"; error: string };

type SaveState =
    | { status: "idle" }
    | { status: "saving" }
    | { status: "done"; item: WardrobeItem }
    | { status: "error"; error: string };

type ComposeState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; looks: Outfit[]; path: ComposeResult["path"] }
    | { status: "error"; error: string };

/** Per-look render status */
type LookPreview =
    | { status: "loading" }
    | { status: "done"; url: string }
    | { status: "error"; error: string };

export function App() {
    const [clip, setClip] = React.useState<ClipState>({ status: "idle" });
    const [analyze, setAnalyze] = React.useState<AnalyzeState>({ status: "idle" });
    const [garmentHints, setGarmentHints] = React.useState<RenderHints | null>(null);
    const [save, setSave] = React.useState<SaveState>({ status: "idle" });
    const [compose, setCompose] = React.useState<ComposeState>({ status: "idle" });
    const [wardrobeCount, setWardrobeCount] = React.useState<number>(0);
    const [showSettings, setShowSettings] = React.useState(false);

    // Mannequin selector (default 'female')
    const [mannequin, setMannequin] = React.useState<MannequinKind>("female");

    // Per-look preview map
    const [previewMap, setPreviewMap] = React.useState<Record<string, LookPreview>>({});
    const [previewNote, setPreviewNote] = React.useState<string>("");

    React.useEffect(() => {
        listWardrobeItems().then((arr) => setWardrobeCount(arr.length));
    }, []);

    const onClip = async () => {
        setAnalyze({ status: "idle" });
        setSave({ status: "idle" });
        setCompose({ status: "idle" });
        setPreviewMap({});
        setPreviewNote("");
        setGarmentHints(null);
        setClip({ status: "loading" });
        const res = await requestClip();
        if (res.ok && res.product) setClip({ status: "done", product: res.product });
        else setClip({ status: "error", error: res.error || "Unknown error" });
    };

    const onAnalyze = async () => {
        if (clip.status !== "done") return;
        setAnalyze({ status: "loading" });
        setGarmentHints(null);
        try {
            const result = await analyzeProduct(clip.product);
            setAnalyze({ status: "done", result });

            // Cloud garment description → richer mannequin guidance
            if (isAiLogicConfigured) {
                try {
                    const text = [clip.product.description, clip.product.returnsText]
                        .filter(Boolean)
                        .join("\n\n");
                    const img = clip.product.images?.[0];
                    const hints = await cloudDescribeGarment({
                        title: clip.product.title,
                        text,
                        imageUrls: img ? [img] : []
                    });
                    setGarmentHints(hints);
                    const rec = hints.mannequinRecommendation;
                    if (rec === "female" || rec === "male") setMannequin(rec);
                } catch (err) {
                    console.debug("[Outfnd] describeGarment failed", err);
                }
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setAnalyze({ status: "error", error: msg });
        }
    };

    const onSave = async () => {
        if (clip.status !== "done" || analyze.status !== "done") return;
        setSave({ status: "saving" });
        try {
            const item = await addItemFromAnalysis(
                clip.product,
                analyze.result.attributes,
                analyze.result.language,
                garmentHints ?? undefined
            );
            setSave({ status: "done", item });
            const arr = await listWardrobeItems();
            setWardrobeCount(arr.length);

            const settings = await loadSettings();
            if (settings.enableFirebaseSync) {
                try {
                    await syncWardrobeItemToFirestore(item);
                } catch {
                    /* noop */
                }
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setSave({ status: "error", error: msg });
        }
    };

    const onCompose = async () => {
        setCompose({ status: "loading" });
        setPreviewMap({});
        setPreviewNote("");
        try {
            const arr = await listWardrobeItems();
            const createdFromItemId = save.status === "done" ? save.item.id : undefined;
            const { looks, path } = await composeLooks(arr, createdFromItemId);
            setCompose({ status: "done", looks, path });

            if (!looks.length) return;
            if (isAiLogicConfigured) void renderLookPreviews(looks, arr);
            else setPreviewNote("Cloud image previews are disabled (no AI Logic URL configured).");
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setCompose({ status: "error", error: msg });
        }
    };

    async function renderLookPreviews(looks: Outfit[], all: WardrobeItem[]) {
        const byId = indexById(all);
        setPreviewNote("Rendering previews…");

        let mannequinDataUrl = "";
        try {
            mannequinDataUrl = await loadMannequin(mannequin);
        } catch (err) {
            console.debug("[Outfnd] failed to load mannequin PNG", err);
            setPreviewNote("Could not load mannequin image.");
            return;
        }

        // Mark all looks as loading first (to trigger spinners)
        setPreviewMap((m) => {
            const next = { ...m };
            for (const l of looks) next[l.id] = { status: "loading" };
            return next;
        });

        // Concurrency
        const slots = 2;
        let i = 0;
        const workers = Array.from({ length: Math.min(slots, looks.length) }, async () => {
            while (i < looks.length) {
                const look = looks[i++];
                await renderOneLook(look, byId, mannequinDataUrl);
            }
        });

        await Promise.all(workers);
        setPreviewNote("");
    }

    async function renderOneLook(
        look: Outfit,
        byId: Record<string, WardrobeItem>,
        mannequinDataUrl: string
    ) {
        try {
            const input: RenderLookInput = {
                mannequinDataUrl,
                items: look.items.map((it) => {
                    const item = byId[it.itemId];
                    return {
                        title: item ? item.title : it.itemId,
                        role: it.role,
                        imageUrl: item?.images?.[0],
                        // Provide both the legacy bullets and the richer hints
                        hintBullets: item?.renderHints?.bullets,
                        hints: item?.renderHints
                    };
                })
            };

            // Debug (no huge base64)
            console.debug("[Outfnd] renderLook:request", {
                lookId: look.id,
                mannequinKind: mannequin,
                mannequinDataUrlPrefix: mannequinDataUrl.slice(0, 30),
                items: input.items.map((x) => ({
                    role: x.role,
                    title: x.title,
                    hasImage: Boolean(x.imageUrl),
                    hintBulletsCount: x.hintBullets?.length ?? 0,
                    hasRichHints: Boolean(x.hints && Object.values(x.hints).some(Boolean))
                })),
                aiLogicUrl
            });

            const dataUrl = await cloudRenderLookPreview(input);

            console.debug("[Outfnd] renderLook:response", {
                lookId: look.id,
                hasDataUrl: Boolean(dataUrl),
                dataUrlPrefix: dataUrl?.slice(0, 30)
            });

            if (!dataUrl || !/^data:image\//.test(dataUrl)) {
                throw new Error("Empty or invalid data URL returned by aiLogic renderLook");
            }

            setPreviewMap((m) => ({ ...m, [look.id]: { status: "done", url: dataUrl } }));
        } catch (err) {
            console.debug("[Outfnd] renderLook:error", { lookId: look.id, error: String(err) });
            setPreviewMap((m) => ({ ...m, [look.id]: { status: "error", error: String(err) } }));
        }
    }

    async function retryLook(look: Outfit) {
        const arr = await listWardrobeItems();
        const byId = indexById(arr);
        setPreviewMap((m) => ({ ...m, [look.id]: { status: "loading" } }));
        try {
            const mannequinDataUrl = await loadMannequin(mannequin);
            await renderOneLook(look, byId, mannequinDataUrl);
        } catch (err) {
            setPreviewMap((m) => ({ ...m, [look.id]: { status: "error", error: String(err) } }));
        }
    }

    const headerBadge =
        clip.status === "loading"
            ? "Scanning…"
            : clip.status === "done"
                ? `Source: ${clip.product.source}`
                : "On-device (ready)";

    const analyzePathBadge =
        analyze.status === "done"
            ? analyze.result.path === "device"
                ? "On-device"
                : analyze.result.path === "cloud"
                    ? "Cloud fallback"
                    : "Fallback"
            : analyze.status === "loading"
                ? "Analyzing…"
                : undefined;

    const canSave = analyze.status === "done" && save.status !== "done";
    const canCompose = save.status === "done" || wardrobeCount > 0;

    return (
        <div className="panel">
            <header className="header">
                <span className="logo">👗</span>
                <h1>Outfnd</h1>
                <div className="badges">
                    <span className="badge">{headerBadge}</span>
                    {analyzePathBadge && <span className="badge small">{analyzePathBadge}</span>}
                    <div className="badge small" title="Choose mannequin">
                        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            Mannequin:
                            <select
                                value={mannequin}
                                onChange={(e) => setMannequin(e.target.value as MannequinKind)}
                                style={{
                                    border: "1px solid var(--border)",
                                    borderRadius: 6,
                                    padding: "2px 6px",
                                    background: "#fff"
                                }}
                            >
                                <option value="female">Female</option>
                                <option value="male">Male</option>
                            </select>
                        </label>
                    </div>
                    <button
                        className="btn secondary"
                        onClick={() => setShowSettings((v) => !v)}
                        title="Settings"
                        aria-label="Settings"
                        style={{ padding: "4px 8px", lineHeight: 1 }}
                    >
                        ⚙️
                    </button>
                </div>
            </header>

            {showSettings && (
                <section className="section">
                    <SettingsPanel />
                </section>
            )}

            <section className="section">
                <button
                    className="btn"
                    onClick={onClip}
                    disabled={clip.status === "loading"}
                    aria-busy={clip.status === "loading"}
                >
                    {clip.status === "loading" ? "Clipping…" : "Clip current page"}
                </button>

                {clip.status === "error" && (
                    <p className="error" role="alert">
                        {clip.error}
                    </p>
                )}

                {clip.status === "done" && (
                    <div className="card">
                        <h2 className="title">{clip.product.title}</h2>
                        <dl className="kv">
                            <div>
                                <dt>Retailer</dt>
                                <dd>{clip.product.retailer || "—"}</dd>
                            </div>
                            <div>
                                <dt>Price</dt>
                                <dd>
                                    {clip.product.price ?? "—"} {clip.product.currency || ""}
                                </dd>
                            </div>
                            <div>
                                <dt>URL</dt>
                                <dd>
                                    <a href={clip.product.url} target="_blank" rel="noreferrer noopener">
                                        {new URL(clip.product.url).hostname}
                                    </a>
                                </dd>
                            </div>
                        </dl>

                        {clip.product.images?.length > 0 && (
                            <figure className="thumbs">
                                {clip.product.images.slice(0, 3).map((src: string, i: number) => (
                                    <img key={i} src={src} alt="" />
                                ))}
                            </figure>
                        )}

                        {clip.product.description && (
                            <>
                                <h3>Description</h3>
                                <p className="muted">{clip.product.description}</p>
                            </>
                        )}

                        {clip.product.returnsText && (
                            <>
                                <h3>Returns (raw)</h3>
                                <p className="muted">{clip.product.returnsText}</p>
                            </>
                        )}

                        <div className="actionsRow" style={{ alignItems: "center" }}>
                            <button
                                className="btn secondary"
                                onClick={onAnalyze}
                                disabled={analyze.status === "loading"}
                                aria-busy={analyze.status === "loading"}
                            >
                                {analyze.status === "loading" ? "Analyzing…" : "Analyze on-device"}
                            </button>

                            <button
                                className="btn secondary"
                                onClick={onSave}
                                disabled={!canSave || save.status === "saving"}
                                aria-busy={save.status === "saving"}
                                title={
                                    analyze.status !== "done"
                                        ? "Analyze first to get attributes"
                                        : "Save this item to your wardrobe"
                                }
                            >
                                {save.status === "saving" ? "Saving…" : save.status === "done" ? "Saved ✓" : "Save to wardrobe"}
                            </button>

                            <button
                                className="btn secondary"
                                onClick={onCompose}
                                disabled={!canCompose || compose.status === "loading"}
                                aria-busy={compose.status === "loading"}
                                title={!canCompose ? "Save at least one item to compose looks" : "Compose three looks"}
                            >
                                {compose.status === "loading" ? "Composing…" : "Compose 3 looks"}
                            </button>
                        </div>

                        {analyze.status === "error" && (
                            <p className="error" role="alert">
                                {analyze.error}
                            </p>
                        )}

                        {analyze.status === "done" && (
                            <>
                                <h3>Key points (fit • care • returns)</h3>
                                <ul className="bullets">
                                    {analyze.result.keyPoints.map((b, i) => (
                                        <li key={i}>{b}</li>
                                    ))}
                                </ul>

                                <h3>Attributes</h3>
                                <div className="tags">
                                    <span className="tag">{analyze.result.attributes.category}</span>
                                    {analyze.result.attributes.colors.map((c, i) => (
                                        <span className="tag" key={`c-${i}`}>
                                            {c}
                                        </span>
                                    ))}
                                    {analyze.result.attributes.styleTags.map((t, i) => (
                                        <span className="tag" key={`t-${i}`}>
                                            {t}
                                        </span>
                                    ))}
                                </div>

                                <div className="metaRow">
                                    <span className="small">
                                        Detected language: <strong>{analyze.result.language}</strong>
                                    </span>
                                    {analyze.result.translatedContext && (
                                        <details className="translated">
                                            <summary>Show translated context</summary>
                                            <pre>{analyze.result.translatedContext}</pre>
                                        </details>
                                    )}
                                </div>
                            </>
                        )}

                        {compose.status === "error" && (
                            <p className="error" role="alert">
                                {compose.error}
                            </p>
                        )}

                        {compose.status === "done" && (
                            <>
                                <h3>
                                    Composed looks{" "}
                                    {compose.path === "cloud" ? (
                                        <span className="badge small">Cloud</span>
                                    ) : compose.path === "device" ? (
                                        <span className="badge small">On-device</span>
                                    ) : (
                                        <span className="badge small">Fallback</span>
                                    )}
                                </h3>
                                {previewNote && <div className="small" style={{ marginBottom: 6 }}>{previewNote}</div>}
                                <LooksList looks={compose.looks} previewMap={previewMap} onRetry={retryLook} />
                            </>
                        )}
                    </div>
                )}

                {clip.status === "idle" && (
                    <p className="lede">
                        Clip, Analyze, Save, Compose — with **male/female mannequin** previews powered by Gemini.
                    </p>
                )}
            </section>
        </div>
    );
}

function LooksList({
    looks,
    previewMap,
    onRetry
}: {
    looks: Outfit[];
    previewMap: Record<string, LookPreview>;
    onRetry: (look: Outfit) => void;
}) {
    const [items, setItems] = React.useState<Record<string, WardrobeItem>>({});
    React.useEffect(() => {
        listWardrobeItems().then((arr) => setItems(indexById(arr)));
    }, []);
    if (!looks.length) return <p className="muted">No looks yet.</p>;

    return (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {looks.map((l) => {
                const pv = previewMap[l.id];
                return (
                    <div key={l.id} className="card">
                        <div className="lookRow">
                            <div className="lookImg" aria-busy={pv?.status === "loading"}>
                                {pv?.status === "done" && pv.url && <img src={pv.url} alt={`${l.occasion} preview`} />}
                                {pv?.status === "loading" && <div className="spinner" aria-label="Loading preview" />}
                                {(!pv || pv.status === "error") && (
                                    <div className="placeholder" style={{ textAlign: "center" }}>
                                        {pv?.status === "error" ? "Preview failed" : "Preview unavailable"}
                                        <div style={{ marginTop: 6 }}>
                                            <button className="btn secondary" onClick={() => onRetry(l)}>Retry</button>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="lookMeta">
                                <strong style={{ textTransform: "capitalize" }}>{l.occasion}</strong>
                                <ul className="bullets">
                                    {l.items.map((it, idx) => {
                                        const item = items[it.itemId];
                                        const name = item ? item.title : it.itemId;
                                        return (
                                            <li key={`${l.id}_${idx}`}>
                                                <strong>{it.role}</strong> — {name}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
