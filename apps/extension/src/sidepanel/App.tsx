/**
 * Outfnd — Side Panel App (white/off-white palette)
 * Adds: image-selection loading state; spinners/skeletons in ImagePicker; disables
 * clipping/analyze/save while selection is processing.
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
    cloudSelectProductImages,
    type RenderLookInput
} from "../cloud/aiLogic";
import { isAiLogicConfigured } from "../config/env";
import { composeLooks, type ComposeResult } from "../ai/composer";
import { loadMannequin, type MannequinKind } from "../assets/mannequinLoader";
import { aiLogicUrl } from "../config/env";
import { ImagePicker, type Buckets } from "./components/ImagePicker";

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

/** Image-selection pipeline status (LLM + heuristics). */
type ImgSelState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done" }
    | { status: "error"; error: string };

export function App() {
    const [clip, setClip] = React.useState<ClipState>({ status: "idle" });
    const [analyze, setAnalyze] = React.useState<AnalyzeState>({ status: "idle" });
    const [garmentHints, setGarmentHints] = React.useState<RenderHints | null>(null);
    const [save, setSave] = React.useState<SaveState>({ status: "idle" });
    const [compose, setCompose] = React.useState<ComposeState>({ status: "idle" });
    const [wardrobeCount, setWardrobeCount] = React.useState<number>(0);
    const [showSettings, setShowSettings] = React.useState(false);

    // Mannequin selector
    const [mannequin, setMannequin] = React.useState<MannequinKind>("female");

    // Image selection buckets + chosen set for the currently clipped product
    const [imgBuckets, setImgBuckets] = React.useState<Buckets>({ confident: [], semiConfident: [], notConfident: [] });
    const [chosen, setChosen] = React.useState<Set<string>>(new Set());
    const [imgSel, setImgSel] = React.useState<ImgSelState>({ status: "idle" });

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
        setImgBuckets({ confident: [], semiConfident: [], notConfident: [] });
        setChosen(new Set());
        setImgSel({ status: "idle" });

        setClip({ status: "loading" });
        const res = await requestClip();
        if (res.ok && res.product) {
            setClip({ status: "done", product: res.product });

            // Start selection (show loading UI in picker)
            setImgSel({ status: "loading" });
            const anchors = res.product.images.slice(0, 2);
            const candidates = Array.from(new Set(res.product.images));
            if (isAiLogicConfigured) {
                try {
                    const sel = await cloudSelectProductImages(
                        anchors,
                        candidates,
                        res.product.title,
                        [res.product.description, res.product.returnsText].filter(Boolean).join("\n\n")
                    );
                    console.debug("[Outfnd] selectProductImages:debug", sel.debug);
                    setImgBuckets(sel.groups);
                    setChosen(new Set(sel.groups.confident)); // default to confident
                    setImgSel({ status: "done" });
                } catch (e) {
                    console.debug("[Outfnd] selectProductImages failed", e);
                    // Fallback to simple default, but show an error message
                    const conf = candidates.slice(0, 3);
                    setImgBuckets({ confident: conf, semiConfident: candidates.slice(3, 6), notConfident: candidates.slice(6) });
                    setChosen(new Set(conf));
                    setImgSel({ status: "error", error: "Smart grouping failed; using simple fallback." });
                }
            } else {
                // No cloud — still present a deterministic layout
                const conf = candidates.slice(0, 3);
                setImgBuckets({ confident: conf, semiConfident: candidates.slice(3, 6), notConfident: candidates.slice(6) });
                setChosen(new Set(conf));
                setImgSel({ status: "done" });
            }
        } else {
            setClip({ status: "error", error: res.error || "Unknown error" });
            setImgSel({ status: "idle" });
        }
    };

    const onToggleImage = (url: string) => {
        setChosen((prev) => {
            const next = new Set(prev);
            if (next.has(url)) next.delete(url);
            else next.add(url);
            return next;
        });
    };
    const onSelectFirst = (n: number) => {
        const ordered = [...imgBuckets.confident, ...imgBuckets.semiConfident, ...imgBuckets.notConfident].slice(0, n);
        setChosen(new Set(ordered));
    };
    const onClear = () => setChosen(new Set());

    const onAnalyze = async () => {
        if (clip.status !== "done") return;
        setAnalyze({ status: "loading" });
        setGarmentHints(null);
        try {
            const result = await analyzeProduct(clip.product);
            setAnalyze({ status: "done", result });

            if (isAiLogicConfigured) {
                try {
                    const text = [clip.product.description, clip.product.returnsText]
                        .filter(Boolean)
                        .join("\n\n");
                    const hints = await cloudDescribeGarment({
                        title: clip.product.title,
                        text,
                        imageUrls: Array.from(chosen)
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
            const selectedImages = Array.from(chosen);
            const item = await addItemFromAnalysis(
                clip.product,
                analyze.result.attributes,
                analyze.result.language,
                garmentHints ?? undefined,
                selectedImages
            );
            setSave({ status: "done", item });
            const arr = await listWardrobeItems();
            setWardrobeCount(arr.length);

            const settings = await loadSettings();
            if (settings.enableFirebaseSync) {
                try { await syncWardrobeItemToFirestore(item); } catch { /* noop */ }
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

        // Mark all looks as loading first
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
                    const imgs = item?.selectedImages && item.selectedImages.length ? item.selectedImages : item?.images ?? [];
                    return {
                        title: item ? item.title : it.itemId,
                        role: it.role,
                        imageUrls: imgs.slice(0, 4),
                        hintBullets: item?.renderHints?.bullets
                    };
                })
            };

            console.debug("[Outfnd] renderLook:request\n", JSON.stringify({
                lookId: look.id,
                mannequinKind: mannequin,
                mannequinDataUrlPrefix: mannequinDataUrl.slice(0, 10),
                items: input.items.map((x) => ({
                    role: x.role,
                    title: x.title,
                    imageCount: x.imageUrls?.length ?? (x.imageUrl ? 1 : 0),
                })),
                aiLogicUrl
            }, null, 2));

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
            console.debug("[Outfnd] renderLook:error\n", JSON.stringify({ lookId: look.id, error: String(err) }, null, 2));
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

    const selectedCount = chosen.size;

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
                    disabled={clip.status === "loading" || imgSel.status === "loading"}
                    aria-busy={clip.status === "loading" || imgSel.status === "loading"}
                    title={imgSel.status === "loading" ? "Grouping images…" : undefined}
                >
                    {clip.status === "loading" ? "Clipping…" : imgSel.status === "loading" ? "Sorting images…" : "Clip current page"}
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

                        {/* Image Picker (three buckets) */}
                        <ImagePicker
                            buckets={imgBuckets}
                            selected={chosen}
                            onToggle={onToggleImage}
                            onSelectFirst={onSelectFirst}
                            onClear={onClear}
                            loading={imgSel.status === "loading"}
                            error={imgSel.status === "error" ? imgSel.error : undefined}
                        />
                        <div className="small" style={{ marginTop: 4 }}>{selectedCount} selected</div>

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
                                disabled={analyze.status === "loading" || imgSel.status === "loading"}
                                aria-busy={analyze.status === "loading"}
                                title={imgSel.status === "loading" ? "Please wait for image grouping to finish" : undefined}
                            >
                                {analyze.status === "loading" ? "Analyzing…" : "Analyze on-device"}
                            </button>

                            <button
                                className="btn secondary"
                                onClick={onSave}
                                disabled={imgSel.status === "loading" || !selectedCount || analyze.status !== "done" || save.status === "saving"}
                                aria-busy={save.status === "saving"}
                                title={
                                    imgSel.status === "loading"
                                        ? "Please wait for image grouping to finish"
                                        : analyze.status !== "done"
                                            ? "Analyze first to get attributes"
                                            : selectedCount === 0
                                                ? "Select at least one image"
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
                        Clip, Analyze, Save, Compose — now with **per‑bucket loading** for smarter image selection.
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
                                        const thumb = item?.selectedImages && item.selectedImages[0] ? item.selectedImages[0] : item?.images?.[0];
                                        return (
                                            <li key={`${l.id}_${idx}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                <strong>{it.role}</strong> — {name}
                                                {thumb && <img src={thumb} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)" }} />}
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
