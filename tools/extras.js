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

export async function readFile({ path: requested } = {}) {
    if (typeof requested !== "string" || !requested.trim()) throw new Error("A file or folder path is required.");

    const root = await fs.realpath(path.resolve(config.filesDir));
    const target = path.resolve(root, requested.trim().replace(/^~[\\/]/, ""));

    let real;
    try {
        real = await fs.realpath(target);
    } catch {
        throw new Error(`Couldn't find "${requested}" inside ${root}.`);
    }

    const rel = path.relative(root, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`"${requested}" is outside the allowed folder (${root}). Set AI_FILES_DIR to change it.`);
    }
    if (SECRET_PATH.test(rel)) throw new Error("That file looks like a secret or system file, so it's blocked.");

    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
        const entries = await fs.readdir(real, { withFileTypes: true });
        const names = entries
            .filter((e) => !SECRET_PATH.test(e.name))
            .slice(0, 100)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { folder: rel || ".", items: names };
    }

    const handle = await fs.open(real, "r");
    try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
        await handle.read(buffer, 0, buffer.length, 0);
        if (buffer.subarray(0, 8000).includes(0)) throw new Error("That looks like a binary file (PDF, image, etc.). Only text files are supported.");
        const text = trimText(buffer.toString("utf8"));
        return { file: rel, size: stat.size, content: text };
    } finally {
        await handle.close();
    }
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

export async function readWebpage({ url } = {}) {
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
