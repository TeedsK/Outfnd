import React from "react";

export function MiniThumb({
    src,
    extraCount = 0,
    alt = ""
}: {
    src?: string;
    extraCount?: number;
    alt?: string;
}) {
    if (!src) {
        return <div className="miniThumb placeholder" aria-label="No image" />;
    }
    return (
        <div className="miniThumb">
            <img src={src} alt={alt} />
            {extraCount > 0 && <span className="miniBadge">+{extraCount}</span>}
        </div>
    );
}
