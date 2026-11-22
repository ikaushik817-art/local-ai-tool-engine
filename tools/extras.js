import { promises as fs } from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import { config } from "../config.js";

const MAX_FILE_BYTES = 200 * 1024;
const MAX_PAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_TEXT_CHARS = 8000;

const trimText = (text) =>
    text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n... (cut off, ${text.length - MAX_TEXT_CHARS} more characters)` : text;

// ---------- read_file ----------

// Files the model should never see, even inside the allowed folder.
export const SECRET_PATH = /(^|[\\/])(\.env(\..*)?|\.git|\.ssh|\.aws|node_modules|id_rsa[^\\/]*|[^\\/]*\.(pem|key|pfx|p12))([\\/]|$)/i;

// Finds a file or folder inside the allowed folder, safely. Files the assistant saved live in ai-output,
// so a plain name like "test.txt" is looked for there too.
export async function locate(requested) {
    if (typeof requested !== "string" || !requested.trim()) throw new Error("A file or folder path is required.");

    const root = await fs.realpath(path.resolve(config.filesDir));
    const clean = requested.trim().replace(/^~[\\/]/, "");

    let real;
    try {
        real = await fs.realpath(path.resolve(root, clean));
    } catch {
        try {
            real = await fs.realpath(path.resolve(root, "ai-output", clean));
        } catch {
            throw new Error(`Couldn't find "${requested}" inside ${root}.`);
        }
    }

    const rel = path.relative(root, real).split(path.sep).join("/"); // same look on Windows and elsewhere
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`"${requested}" is outside the allowed folder (${root}). Set AI_FILES_DIR to change it.`);
    }
    if (SECRET_PATH.test(rel)) throw new Error("That file looks like a secret or system file, so it's blocked.");
    return { root, real, rel };
}

// PDFs need a small reader library, installed on purpose: npm install pdf-parse@1.1.1
const MAX_PDF_BYTES = 10 * 1024 * 1024;
let pdfParser = null; // tests put a fake one here
export const setPdfParser = (fn) => { pdfParser = fn; };

async function pdfText(real, stat) {
    if (stat.size > MAX_PDF_BYTES) throw new Error("That PDF is bigger than 10 MB.");
    let parse = pdfParser;
    if (!parse) {
        try {
            const module = await import("pdf-parse/lib/pdf-parse.js").catch(() => import("pdf-parse"));
            parse = module.default ?? module;
        } catch {
            throw new Error("To read PDFs, install the PDF reader once: npm install pdf-parse@1.1.1");
        }
    }
    let data;
    try { data = await parse(await fs.readFile(real)); } catch { throw new Error("I couldn't read that PDF. It may be damaged or protected with a password."); }
    const text = String(data?.text ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new Error("That PDF has no text I can read. It may be a scan (pictures of pages), which needs OCR.");
    return text;
}

async function readRaw(real, stat) {
    if (path.extname(real).toLowerCase() === ".pdf") return pdfText(real, stat);
    const handle = await fs.open(real, "r");
    try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
        await handle.read(buffer, 0, buffer.length, 0);
        if (buffer.subarray(0, 8000).includes(0)) throw new Error("That looks like a binary file (PDF, image, etc.). Only text files are supported.");
        return buffer.toString("utf8");
    } finally {
        await handle.close();
    }
}

export async function readFile({ path: requested } = {}) {
    const { real, rel } = await locate(requested);

    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
        const entries = await fs.readdir(real, { withFileTypes: true });
        const names = entries
            .filter((e) => !SECRET_PATH.test(e.name))
            .slice(0, 100)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { folder: rel || ".", items: names };
    }

    return { file: rel, size: stat.size, content: trimText(await readRaw(real, stat)) };
}

// The whole text of a file (up to 200 KB), for tools that need exact numbers about it.
export async function readFileText(requested) {
    const { real, rel } = await locate(requested);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) throw new Error(`"${requested}" is a folder, not a file.`);
    return { file: rel, text: await readRaw(real, stat) };
}

// Everything in a folder at once, one short line per file. Handy for "which file has the biggest number".
export async function readFiles({ folder = "ai-output" } = {}) {
    const { real, rel } = await locate(String(folder || "ai-output"));
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error(`"${folder}" is a file. Use read_file for a single file.`);

    const lines = [];
    let skipped = 0;
    for (const entry of (await fs.readdir(real, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }))) {
        if (!entry.isFile() || SECRET_PATH.test(entry.name)) continue;
        if (lines.length >= 30) { skipped++; continue; }
        try {
            const text = await readRaw(path.join(real, entry.name), await fs.stat(path.join(real, entry.name)));
            lines.push(`${entry.name}: ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`);
        } catch { skipped++; } // binary or unreadable
    }
    if (lines.length === 0) return `No text files in ${rel || "."}.`;
    return `${lines.length} file${lines.length === 1 ? "" : "s"} in ${rel || "."}${skipped ? ` (${skipped} skipped)` : ""}:\n${lines.join("\n")}`;
}

// ---------- read_webpage ----------

function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split(".").map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    const v6 = ip.toLowerCase();
    if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
    return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

async function assertPublicUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { throw new Error(`"${raw}" isn't a valid URL.`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https links are supported.");

    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error("Local and private network addresses are blocked.");
    const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
        throw new Error(`Couldn't find the website "${host}".`);
    });
    if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Local and private network addresses are blocked.");
    return url;
}

// Remembers the answer for a while, and gives callers who ask at the same moment the same answer (one request, not two).
export function memoize(produce, { ttlMs = 600000, max = 50 } = {}) {
    const memo = new Map();
    return (key, ...args) => {
        const hit = memo.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value.then(structuredClone);
        const value = produce(...args);
        memo.set(key, { at: Date.now(), value });
        if (memo.size > max) memo.delete(memo.keys().next().value);
        value.catch(() => memo.get(key)?.value === value && memo.delete(key)); // only answers that worked are kept
        return value.then(structuredClone);
    };
}

const pageMemo = memoize((url) => fetchWebpage({ url }));
export const readWebpage = ({ url } = {}) => (typeof url === "string" && url.trim() ? pageMemo(url.trim(), url) : fetchWebpage({ url }));

async function fetchWebpage({ url } = {}) {
    if (typeof url !== "string" || !url.trim()) throw new Error("A URL is required.");

    let current = await assertPublicUrl(url.trim());
    let response;
    for (let hop = 0; hop <= 3; hop++) {
        try {
            response = await fetch(current, {
                redirect: "manual",
                headers: { "User-Agent": "Mozilla/5.0 (compatible; LocalAITool/1.0)", Accept: "text/html,text/plain,application/json" },
                signal: AbortSignal.timeout(10000)
            });
        } catch (error) {
            throw new Error(error?.name === "TimeoutError" ? "The page took too long to load." : "Couldn't open that page. Check the link and your internet.");
        }
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
            current = await assertPublicUrl(new URL(response.headers.get("location"), current).href); // re-check every redirect
            continue;
        }
        break;
    }
    if (response.status >= 300 && response.status < 400) throw new Error("Too many redirects.");
    if (!response.ok) throw new Error(`The page returned an error (${response.status}).`);

    const type = response.headers.get("content-type") || "";
    if (!/text\/|json|xml/i.test(type)) throw new Error(`Can't read this kind of content (${type || "unknown"}).`);

    // Read at most MAX_PAGE_BYTES so a huge page can't eat memory.
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
        chunks.push(chunk);
        total += chunk.length;
        if (total > MAX_PAGE_BYTES) break;
    }
    const raw = Buffer.concat(chunks).toString("utf8");

    if (!/html/i.test(type)) return { url: current.href, content: trimText(raw) };

    const $ = cheerio.load(raw);
    $("script, style, noscript, nav, footer, header, aside, form, svg, iframe").remove();
    $("p, div, li, h1, h2, h3, h4, h5, h6, tr, td, th, br, section, pre").append(" "); // keep words apart
    const title = $("title").first().text().trim();
    const root = $("main, article").first().length ? $("main, article").first() : $("body");
    const text = root.text().replace(/\s+/g, " ").trim();
    if (!text) throw new Error("The page has no readable text (it may need JavaScript).");
    return { url: current.href, title, content: trimText(text) };
}
