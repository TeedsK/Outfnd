/**
 * ImagePicker — three buckets UI (confident / semi / not)
 * Now supports loading placeholders per bucket and an optional error hint.
 * Labels updated to: More images (confident) / Similar clothing (semi‑confident) / Other found images (not‑confident)
 */
import React from "react";

export type Buckets = {
    confident: string[];
    semiConfident: string[];
    notConfident: string[];
};

export function ImagePicker({
    buckets,
    selected,
    onToggle,
    onSelectFirst,
    onClear,
    loading = false,
    error
}: {
    buckets: Buckets;
    selected: Set<string>;
    onToggle: (url: string) => void;
    onSelectFirst: (n: number) => void;
    onClear: () => void;
    loading?: boolean;
    error?: string;
}) {
    return (
        <div className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <strong>
                    Select images for AI (angles/close-ups)
                    {loading && <span style={{ marginLeft: 8, verticalAlign: "middle" }} className="spinner tiny" aria-label="Selecting images…" />}
                </strong>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn secondary" onClick={() => onSelectFirst(6)} disabled={loading}>Select first 6</button>
                    <button className="btn secondary" onClick={onClear} disabled={loading}>Clear</button>
                </div>
            </div>

            {error && <div className="small" style={{ color: "#b45309", marginBottom: 6 }}>{error}</div>}

            <Bucket
                title={`More images (confident)${loading ? "" : ` (${buckets.confident.length})`}`}
                urls={buckets.confident}
                selected={selected}
                onToggle={onToggle}
                loading={loading}
            />
            <Bucket
                title={`Similar clothing (semi‑confident)${loading ? "" : ` (${buckets.semiConfident.length})`}`}
                urls={buckets.semiConfident}
                selected={selected}
                onToggle={onToggle}
                loading={loading}
            />
            <Bucket
                title={`Other found images (not‑confident)${loading ? "" : ` (${buckets.notConfident.length})`}`}
                urls={buckets.notConfident}
                selected={selected}
                onToggle={onToggle}
                loading={loading}
            />
        </div>
    );
}

function Bucket({
    title,
    urls,
    selected,
    onToggle,
    loading
}: {
    title: string;
    urls: string[];
    selected: Set<string>;
    onToggle: (url: string) => void;
    loading: boolean;
}) {
    return (
        <div style={{ marginBottom: 8 }}>
            <div className="small" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                <span>{title}</span>
                {loading && <span className="spinner tiny" aria-hidden="true" />}
            </div>
            <div className="ip-grid">
                {loading
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <div key={`skel-${i}`} className="ip-thumb ip-skel" aria-busy="true">
                            <div className="spinner tiny" />
                        </div>
                    ))
                    : urls.map((u) => {
                        const isSel = selected.has(u);
                        return (
                            <button
                                key={u}
                                className={`ip-thumb ${isSel ? "sel" : ""}`}
                                onClick={() => onToggle(u)}
                                title={u}
                                aria-pressed={isSel}
                            >
                                <img src={u} alt="" />
                                {isSel && <span className="ip-check">✓</span>}
                            </button>
                        );
                    })}
            </div>
        </div>
    );
}
