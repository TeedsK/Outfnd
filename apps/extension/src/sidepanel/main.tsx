/**
 * Sidepanel entrypoint — mounts <App/> and pulls in the sidepanel styles.
 * If #root is missing (very rare), we create it to avoid a blank panel.
 */
import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function mount() {
    let el = document.getElementById("root");
    if (!el) {
        el = document.createElement("div");
        el.id = "root";
        document.body.appendChild(el);
    }
    createRoot(el).render(
        <StrictMode>
            <App />
        </StrictMode>
    );
}

mount();
console.log("[Outfnd] side panel mounted");
