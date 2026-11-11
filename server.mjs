#!/usr/bin/env node
// call-cue local server: serves the page and the knowledge base, and (only when you
// configure keys) runs the AI helpers. Listens on 127.0.0.1 only. API keys stay here,
// never in the page.
//
//   node server.mjs [--kb kb/example.json] [--port 8765] [--mock-ai] [--open] [--open-demo]
//
// Environment:
//   TYPESAFE_API_KEY   enables AI card matching with Jev (https://docs.typesafe.ai)
//   ANTHROPIC_API_KEY  enables AI drafts and post-call summaries with Claude
//   CALL_CUE_JEV_MODEL     default jev-latest
//   CALL_CUE_CLAUDE_MODEL  default claude-opus-5-5
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { kb: path.join(HERE, "kb", "example.json"), port: 8765, mockAi: false, open: false, openDemo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kb") o.kb = path.resolve(argv[++i]);
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--mock-ai") o.mockAi = true;
    else if (a === "--open") o.open = true;
    else if (a === "--open-demo") { o.open = true; o.openDemo = true; }
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error("Unknown option: " + a);
  }
  return o;
}

// ---------- knowledge base ----------
export function loadKb(file) {
  const kb = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(kb.cards) || !kb.cards.length) throw new Error(file + ": needs a non-empty \"cards\" array");
  const ids = new Set();
  for (const c of kb.cards) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(c.id || "")) throw new Error("card id must be 1-40 letters, digits, - or _: " + JSON.stringify(c.id));
    if (c.id === "none") throw new Error("card id \"none\" is reserved");
    if (ids.has(c.id)) throw new Error("duplicate card id: " + c.id);
    ids.add(c.id);
    if (!c.title || !Array.isArray(c.say) || !c.say.length) throw new Error("card " + c.id + " needs a title and a non-empty say[]");
    c.facts ||= []; c.triggers ||= []; c.keywords ||= ""; c.note ||= ""; c.topic ||= ""; c.status ||= "info";
  }
  if (kb.cards.length > 254) throw new Error("at most 254 cards (Jev choice takes 255 options including \"none\")");
  // Optional long-form docs for AI drafts: kb.docsFile points at a markdown/text file next to the KB.
  if (kb.docsFile) kb.docs = (kb.docs ? kb.docs + "\n\n" : "") + fs.readFileSync(path.resolve(path.dirname(file), kb.docsFile), "utf8");
  return kb;
}

// ---------- AI: Jev picks the card ----------
const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export function jevRequest(kb, latest, recent, model = "jev-latest") {
  const criteria = {};
  for (const c of kb.cards) criteria[c.id] = c.title + (c.keywords ? " (about: " + c.keywords + ")" : "");
  criteria.none = "Small talk, an acknowledgement, or a question that none of the other cards answers";
  return {
    model,
    state: {
      latest_sentence: latest,
      recent_conversation: recent,
      answer_cards: kb.cards.map((c) => c.title),
    },
    questions: {
      card: {
        type: "choice",
        instructions: "On a live call the other party just said `latest_sentence` (earlier context: `recent_conversation`). Which prepared answer card responds to what they are asking or raising in `latest_sentence`?",
        criteria,
      },
      covered: {
        type: "noul",
        instructions: "Would one of `answer_cards` be a fitting reply to what was said in `latest_sentence`?",
      },
    },
  };
}

export function decideMatch(answers, threshold = 0.5) {
  const ch = answers?.card, cov = answers?.covered;
  const id = ch?.choice && ch.choice !== "none" ? ch.choice : null;
  const covered = typeof cov?.noul === "number" ? cov.noul : null;
  const ok = !!id && (ch.confidence ?? 0) >= threshold && (covered === null || covered >= 0.5);
  return { id: ok ? id : null, best: id, confidence: ch?.confidence ?? 0, covered, probabilities: ch?.probabilities || {} };
}

async function jevMatch(kb, latest, recent) {
  const r = await fetch(JEV_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.TYPESAFE_API_KEY },
    body: JSON.stringify(jevRequest(kb, latest, recent, process.env.CALL_CUE_JEV_MODEL || "jev-latest")),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("TypeSafe " + r.status + ": " + (await r.text()).slice(0, 300));
  const d = await r.json();
  return { ...decideMatch(d.answers, Number(process.env.CALL_CUE_MATCH_THRESHOLD || 0.5)), model: d.model };
}

// Offline stand-in for tests and demos: overlap between the sentence and each card's
// keywords, ignoring common words, with a crude plural strip ("logs" -> "log").
const STOP = new Set("the and for you your with what how who does have any are this that data customer customers".split(" "));
const stems = (s, min) => new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= min && !STOP.has(w)).map((w) => w.replace(/s$/, "")));
export function mockMatch(kb, latest) {
  const words = stems(latest, 2);
  let best = null, bestScore = 0;
  for (const c of kb.cards) {
    let s = 0; for (const w of stems(c.keywords, 2)) if (words.has(w)) s++;
    if (s > bestScore) { best = c.id; bestScore = s; }
  }
  const confidence = best ? Math.min(0.95, 0.4 + 0.2 * bestScore) : 0.9;
  return { id: bestScore >= 1 && confidence >= 0.5 ? best : null, best, confidence, covered: bestScore ? 0.8 : 0.1, probabilities: {}, model: "mock" };
}

// ---------- AI: Claude drafts and summarises ----------
let anthropic = null;
async function claude() {
  if (anthropic) return anthropic;
  let mod;
  try { mod = await import("@anthropic-ai/sdk"); }
  catch { throw new Error("Run `npm install` to enable Claude (package @anthropic-ai/sdk)."); }
  anthropic = new mod.default();
  return anthropic;
}

function kbForPrompt(kb) {
  const cards = kb.cards.map((c) => `## ${c.title}\nApproved answer: ${c.say.join(" ")}\nFacts: ${c.facts.join(" ") || "-"}`).join("\n\n");
  return `# Knowledge base: ${kb.title || ""}\n\n${cards}\n\n# Background notes\n${kb.docs || "(none)"}\n\n# Never say\n${(kb.dontSay || []).join("\n")}`;
}

async function claudeText(kb, instruction, userText, maxTokens) {
  const client = await claude();
  const msg = await client.beta.messages.create({
    model: process.env.CALL_CUE_CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: maxTokens,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: instruction },
      { type: "text", text: kbForPrompt(kb), cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userText }],
  });
  if (msg.stop_reason === "refusal") throw new Error("The model declined this request.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

const DRAFT_INSTRUCTION = `You help a person answer questions live on a call. They will read your words aloud.
Use only the knowledge base below. Write 1 to 3 short spoken sentences, first person plural ("we").
Never promise dates, certifications or anything the knowledge base does not state.
If the knowledge base does not cover the question, reply with a polite holding line that offers to confirm in writing.
Output only the sentences, no preamble.`;

const SUMMARY_INSTRUCTION = `Summarise a call transcript for the person who took the call.
Return plain text with three short sections: "Asked", "Answered", "Follow-ups" (who owes what, with any dates said on the call).
Base it only on the transcript; mark anything you are unsure of with (?). Use the knowledge base only to recognise topics.`;

// ---------- HTTP ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

function send(res, code, body, type = "application/json; charset=utf-8") {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, { "Content-Type": type, "Content-Length": b.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(b);
}

function readJson(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("body too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(Object.assign(new Error("invalid JSON"), { code: 400 })); } });
    req.on("error", reject);
  });
}

export function createServer(opts) {
  const kb = loadKb(opts.kb);
  const ai = {
    match: opts.mockAi || !!process.env.TYPESAFE_API_KEY,
    draft: opts.mockAi || !!process.env.ANTHROPIC_API_KEY,
    mock: !!opts.mockAi,
  };
  const pub = path.join(HERE, "public");

  const server = http.createServer(async (req, res) => {
    // Only this machine may talk to the server: reject other Host names (DNS rebinding)
    // and cross-site browser requests (another web page spending your API keys).
    const port = server.address().port;
    const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!okHosts.has(req.headers.host || "")) return send(res, 421, { error: "wrong host" });
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && !okHosts.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "cross-origin request refused" });

    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/kb") return send(res, 200, { ...kb, ai });
      if (req.method === "POST" && url.pathname === "/api/match") {
        if (!ai.match) return send(res, 409, { error: "AI matching is off: set TYPESAFE_API_KEY" });
        const b = await readJson(req);
        const latest = String(b.latest || "").slice(0, 600), recent = String(b.recent || "").slice(0, 2000);
        if (!latest.trim()) return send(res, 400, { error: "latest is empty" });
        return send(res, 200, ai.mock ? mockMatch(kb, latest) : await jevMatch(kb, latest, recent));
      }
      if (req.method === "POST" && url.pathname === "/api/draft") {
        if (!ai.draft) return send(res, 409, { error: "AI drafts are off: set ANTHROPIC_API_KEY" });
        const b = await readJson(req);
        const q = String(b.question || "").slice(0, 1000);
        if (!q.trim()) return send(res, 400, { error: "question is empty" });
        if (ai.mock) return send(res, 200, { text: "(mock draft) " + (kb.fallback || "Let me check that and confirm in writing.") });
        return send(res, 200, { text: await claudeText(kb, DRAFT_INSTRUCTION, "Question just asked on the call:\n" + q + (b.recent ? "\n\nEarlier context:\n" + String(b.recent).slice(0, 2000) : ""), 1024) });
      }
      if (req.method === "POST" && url.pathname === "/api/summary") {
        if (!ai.draft) return send(res, 409, { error: "AI summaries are off: set ANTHROPIC_API_KEY" });
        const b = await readJson(req, 2_000_000);
        const t = String(b.transcript || "").slice(-400_000);
        if (!t.trim()) return send(res, 400, { error: "transcript is empty" });
        if (ai.mock) return send(res, 200, { text: "(mock summary)\nAsked: " + t.split("\n").filter(Boolean).length + " lines\nAnswered: -\nFollow-ups: -" });
        return send(res, 200, { text: await claudeText(kb, SUMMARY_INSTRUCTION, "Transcript:\n" + t, 4000) });
      }
      if (req.method === "GET") {
        const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const file = path.resolve(pub, rel);
        if (!file.startsWith(pub + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: "not found" });
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
      }
      return send(res, 405, { error: "method not allowed" });
    } catch (e) {
      const code = e.code === 413 || e.code === 400 ? e.code : 502;
      if (code === 502) console.error("[call-cue]", e.message);
      return send(res, code, { error: friendly(e) });
    }
  });
  return { server, kb, ai };
}

export function friendly(e) {
  const s = e.status ?? Number((/^(?:TypeSafe )?(\d{3})\b/.exec(e.message) || [])[1]);
  if (s === 401 || s === 403) return "the AI service rejected the API key; check it and restart the server";
  if (s === 429) return "the AI service is rate limiting; try again shortly";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "the AI service timed out";
  return e.message.slice(0, 300);
}

function openBrowser(u) {
  const cmd = process.platform === "darwin" ? ["open", [u]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", u]] : ["xdg-open", [u]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch { /* print the URL instead */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node server.mjs [--kb file.json] [--port 8765] [--mock-ai] [--open] [--open-demo]");
    process.exit(0);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) { console.error("--port needs a number from 1 to 65535"); process.exit(2); }
  const { server, kb, ai } = createServer(opts);
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${opts.port} is busy (is call-cue already running?). Try --port ${opts.port + 10}.` : String(e));
    process.exit(1);
  });
  server.listen(opts.port, "127.0.0.1", () => {
    const u = `http://127.0.0.1:${opts.port}/` + (opts.openDemo ? "?demo" : "");
    console.log(`call-cue: ${u}`);
    console.log(`  knowledge base: ${opts.kb} (${kb.cards.length} cards)`);
    console.log(`  AI matching (Jev): ${ai.match ? (ai.mock ? "mock" : "available, off until you switch it on in the page") : "off (no TYPESAFE_API_KEY)"}`);
    console.log(`  AI drafts (Claude): ${ai.draft ? (ai.mock ? "mock" : "available, off until you switch it on in the page") : "off (no ANTHROPIC_API_KEY)"}`);
    if (opts.open) openBrowser(u);
  });
}
