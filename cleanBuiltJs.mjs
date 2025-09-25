import { promises as fs } from "node:fs";
import { join, extname, basename } from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "lib"]);
const extsTS = new Set([".ts", ".tsx"]);

async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            if (!IGNORED_DIRS.has(e.name)) await walk(p);
            continue;
        }
        if (extname(p) === ".js") {
            const base = basename(p, ".js");
            const tsCandidate = [".ts", ".tsx"].map((x) => join(dir, base + x));
            const exists = await Promise.all(tsCandidate.map(async (f) => {
                try { await fs.access(f); return true; } catch { return false; }
            }));
            if (exists.some(Boolean)) {
                await fs.unlink(p);
                console.log("deleted", p);
            }
        }
        if (extname(p) === ".js.map") {
            const js = p.replace(/\.map$/, "");
            try { await fs.access(js); } catch { continue; }
            const base = basename(js, ".js");
            const tsCandidate = [".ts", ".tsx"].map((x) => join(dir, base + x));
            const exists = await Promise.all(tsCandidate.map(async (f) => {
                try { await fs.access(f); return true; } catch { return false; }
            }));
            if (exists.some(Boolean)) {
                await fs.unlink(p);
                console.log("deleted", p);
            }
        }
    }
}

await walk(process.cwd());
