#!/usr/bin/env node
// call-cue local server: serves the page and the knowledge base, and (only when you
// configure keys) runs the AI helpers. Listens on 127.0.0.1 only. API keys stay here,
// never in the page.
//
//   call-cue [init] [--kb my-kb.json] [--port 8765] [--demo] [--mock-ai] [--open] [--no-open]
//
// AI is optional. One key switches it on; keys can live in a .env file in the folder
// you start call-cue from:
//   ANTHROPIC_API_KEY  Claude            OPENAI_API_KEY    ChatGPT (OpenAI)
//   DEEPSEEK_API_KEY   DeepSeek          OPENCODE_API_KEY  OpenCode
//   CALL_CUE_AI_BASE_URL + CALL_CUE_AI_MODEL (+ CALL_CUE_AI_KEY)  any OpenAI-compatible endpoint
//   CALL_CUE_AI        pick one when several keys are set (claude|openai|deepseek|opencode|custom)
//   CALL_CUE_AI_MODEL  override the model
//   TYPESAFE_API_KEY   optional: Jev picks the card instead (https://docs.typesafe.ai)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import "./public/import.js"; // card helpers shared with the page (sets globalThis.CallCueImport)

const Import = globalThis.CallCueImport;

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { kb: null, port: 8765, mockAi: false, open: false, openDemo: false, init: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kb") o.kb = path.resolve(argv[++i]);
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--mock-ai") o.mockAi = true;
    else if (a === "init" && i === 0) o.init = true;
    else if (a === "--open") o.open = true;
    else if (a === "--no-open") o.noOpen = true;
    else if (a === "--open-demo") { o.open = true; o.openDemo = true; }
    else if (a === "--demo") { o.mockAi = true; o.open = true; o.openDemo = true; }
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error("Unknown option: " + a);
  }
  return o;
}

// Your own knowledge base in the current folder wins over the bundled example.
export const LOCAL_KB = "call-cue-kb.json";
export const EXAMPLE_KB = path.join(HERE, "kb", "example.json");
export function resolveKb(opts, cwd = process.cwd()) {
  if (opts.kb) return opts.kb;
  const mine = path.join(cwd, LOCAL_KB);
  return fs.existsSync(mine) ? mine : EXAMPLE_KB;
}

// KEY=value lines from a .env file; variables already set in the environment win.
export function loadEnvFile(file, env = process.env) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return 0; }
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const v = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (v && env[m[1]] === undefined) { env[m[1]] = v; n++; }
  }
  return n;
}

const ENV_TEMPLATE = `# call-cue: AI is optional. Remove the # in front of ONE line and paste your key.
# Keys stay on this machine; keep this file out of git.
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
#DEEPSEEK_API_KEY=
#OPENCODE_API_KEY=

# Any other OpenAI-compatible endpoint (Ollama, OpenRouter, LM Studio, ...):
#CALL_CUE_AI_BASE_URL=http://127.0.0.1:11434/v1
#CALL_CUE_AI_MODEL=
#CALL_CUE_AI_KEY=
`;
export function init(cwd = process.cwd()) {
  const made = [];
  const kb = path.join(cwd, LOCAL_KB), env = path.join(cwd, ".env");
  if (!fs.existsSync(kb)) { fs.copyFileSync(EXAMPLE_KB, kb); made.push(LOCAL_KB); }
  if (!fs.existsSync(env)) { fs.writeFileSync(env, ENV_TEMPLATE, { mode: 0o600 }); made.push(".env"); }
  return made;
}

// ---------- knowledge base ----------
export function checkKb(kb, label) {
  if (!kb || !Array.isArray(kb.cards) || !kb.cards.length) throw new Error(label + ": needs a non-empty \"cards\" array");
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
  return kb;
}
export function loadKb(file) {
  const kb = checkKb(JSON.parse(fs.readFileSync(file, "utf8")), file);
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
export const STOP = new Set("the and for you your with what how who does have any are this that data customer customers".split(" "));
export const stems = (s, min) => new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= min && !STOP.has(w)).map((w) => w.replace(/s$/, "")));
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

// ---------- AI: one chat model drafts, summarises and (without Jev) picks the card ----------
export const PROVIDERS = {
  claude: { label: "Claude", keyVar: "ANTHROPIC_API_KEY", model: "claude-opus-5-5" },
  openai: { label: "ChatGPT", keyVar: "OPENAI_API_KEY", base: "https://api.openai.com/v1", model: "gpt-6-luna", tokens: "max_completion_tokens" },
  deepseek: { label: "DeepSeek", keyVar: "DEEPSEEK_API_KEY", base: "https://api.deepseek.com", model: "deepseek-flash" },
  opencode: { label: "OpenCode", keyVar: "OPENCODE_API_KEY", base: "https://opencode.ai/inference/openai/v1", model: "deepseek-v4.1-flash" },
  custom: { label: "custom endpoint", keyVar: "CALL_CUE_AI_KEY" },
};

// Which chat model to use: CALL_CUE_AI if set, else the first provider that has a key.
export function pickProvider(env = process.env) {
  const want = (env.CALL_CUE_AI || "").trim().toLowerCase();
  if (want && !PROVIDERS[want]) throw new Error(`CALL_CUE_AI="${want}" is not one of: ${Object.keys(PROVIDERS).join(", ")}`);
  const make = (id) => {
    const p = PROVIDERS[id];
    const base = id === "custom" ? (env.CALL_CUE_AI_BASE_URL || "").replace(/\/+$/, "") : p.base;
    const model = env.CALL_CUE_AI_MODEL || (id === "claude" && env.CALL_CUE_CLAUDE_MODEL) || p.model;
    return { id, label: p.label, base, model, tokens: p.tokens || "max_tokens", apiKey: env[p.keyVar] || "" };
  };
  const ready = (id) => (id === "custom" ? !!(env.CALL_CUE_AI_BASE_URL && env.CALL_CUE_AI_MODEL) : !!env[PROVIDERS[id].keyVar]);
  if (want) {
    if (!ready(want)) throw new Error(want === "custom" ? "CALL_CUE_AI=custom needs CALL_CUE_AI_BASE_URL and CALL_CUE_AI_MODEL" : `CALL_CUE_AI=${want} needs ${PROVIDERS[want].keyVar}`);
    return make(want);
  }
  const id = Object.keys(PROVIDERS).find(ready);
  return id ? make(id) : null;
}

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

async function claudeText(p, instruction, context, userText, maxTokens) {
  const client = await claude();
  const msg = await client.beta.messages.create({
    model: p.model,
    max_tokens: maxTokens,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: instruction },
      { type: "text", text: context, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userText }],
  });
  if (msg.stop_reason === "refusal") throw new Error("The model declined this request.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// ChatGPT, DeepSeek, OpenCode and any other endpoint that speaks OpenAI chat completions.
async function openaiText(p, instruction, context, userText, maxTokens) {
  const headers = { "Content-Type": "application/json" };
  if (p.apiKey) headers.Authorization = "Bearer " + p.apiKey;
  const r = await fetch(p.base + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: p.model,
      [p.tokens]: maxTokens,
      messages: [{ role: "system", content: instruction + "\n\n" + context }, { role: "user", content: userText }],
    }),
    signal: AbortSignal.timeout(maxTokens > 2000 ? 90000 : 25000),
  });
  if (!r.ok) throw Object.assign(new Error(p.label + " " + r.status + ": " + (await r.text()).slice(0, 300)), { status: r.status });
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error(p.label + " returned no text (model " + p.model + ")");
  return text.trim();
}

export const chatText = (p, ...a) => (p.id === "claude" ? claudeText(p, ...a) : openaiText(p, ...a));

const MATCH_INSTRUCTION = `You match one sentence heard on a live call to a prepared answer card.
Reply with JSON only, nothing else: {"id":"<card id, or none>","confidence":<number from 0 to 1>}
Use "none" for small talk, an acknowledgement, or anything that no card answers.`;

export function parseLlmMatch(text, kb, threshold = 0.5) {
  let o = null;
  try { o = JSON.parse((/\{[\s\S]*\}/.exec(text) || [])[0]); } catch { /* not JSON */ }
  const best = o && typeof o.id === "string" && kb.cards.some((c) => c.id === o.id) ? o.id : null;
  const confidence = Math.max(0, Math.min(1, Number(o?.confidence) || 0));
  const none = !!o && o.id === "none";
  return { id: best && confidence >= threshold ? best : null, best, confidence, covered: best ? confidence : none ? 0.1 : null, probabilities: {} };
}

async function llmMatch(p, kb, latest, recent) {
  const cards = "# Cards\n" + kb.cards.map((c) => `${c.id}: ${c.title}${c.keywords ? " (about: " + c.keywords + ")" : ""}`).join("\n");
  const text = await chatText(p, MATCH_INSTRUCTION, cards, (recent ? "Earlier context: " + recent + "\n\n" : "") + "Latest sentence: " + latest, 300);
  return { ...parseLlmMatch(text, kb, Number(process.env.CALL_CUE_MATCH_THRESHOLD || 0.5)), model: p.model };
}

const DRAFT_INSTRUCTION = `You help a person answer questions live on a call. They will read your words aloud.
Use only the knowledge base below. Write 1 to 3 short spoken sentences, first person plural ("we").
Never promise dates, certifications or anything the knowledge base does not state.
If the knowledge base does not cover the question, reply with a polite holding line that offers to confirm in writing.
Output only the sentences, no preamble.`;

const IMPORT_INSTRUCTION = `You turn a document into answer cards for a person who takes live calls. Each card answers one question a caller could ask.
Use only what the document states. Never invent facts, numbers, dates or promises. Skip navigation, legal boilerplate and anything that answers no question.
Write in the language of the document.`;
const IMPORT_FORMAT = `Reply with JSON only, no other text, in this shape:
{"cards":[{"title":"the question, as a caller would ask it","topic":"one or two words","status":"info","say":["1 to 3 short sentences to read aloud, first person plural"],"facts":["short supporting fact", "..."],"keywords":"8 to 12 lowercase words a caller would use when asking this"}]}
Rules: one card per distinct question; at most 40 cards; "status" is "ok" when the document says it is in place, "gap" when it says it is missing or not offered, "ask" when it says to confirm first, otherwise "info"; "facts" may be empty.`;

const SUMMARY_INSTRUCTION = `Summarise a call transcript for the person who took the call.
Return plain text with three short sections: "Asked", "Answered", "Follow-ups" (who owes what, with any dates said on the call).
Base it only on the transcript; mark anything you are unsure of with (?). Use the knowledge base only to recognise topics.`;

// ---------- HTTP ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

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
  const cwd = opts.cwd || process.cwd();
  let kbFile = resolveKb(opts, cwd);
  let kb = loadKb(kbFile);
  const chat = opts.mockAi ? null : pickProvider();
  const jev = !opts.mockAi && !!process.env.TYPESAFE_API_KEY;
  const ai = {
    match: opts.mockAi || jev || !!chat,
    draft: opts.mockAi || !!chat,
    mock: !!opts.mockAi,
    matchBy: opts.mockAi ? "mock" : jev ? "Jev" : chat ? chat.label : "",
    draftBy: opts.mockAi ? "mock" : chat ? chat.label : "",
    model: chat ? chat.model : "",
  };
  const NO_KEY = "AI is off: add one key (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY or OPENCODE_API_KEY) and restart";
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
      if (req.method === "GET" && url.pathname === "/api/kb") return send(res, 200, { ...kb, ai, source: kbFile === EXAMPLE_KB ? "example" : "file", file: path.basename(kbFile === EXAMPLE_KB ? LOCAL_KB : kbFile) });
      if (req.method === "POST" && url.pathname === "/api/match") {
        if (!ai.match) return send(res, 409, { error: NO_KEY });
        const b = await readJson(req);
        const latest = String(b.latest || "").slice(0, 600), recent = String(b.recent || "").slice(0, 2000);
        if (!latest.trim()) return send(res, 400, { error: "latest is empty" });
        return send(res, 200, ai.mock ? mockMatch(kb, latest) : jev ? await jevMatch(kb, latest, recent) : await llmMatch(chat, kb, latest, recent));
      }
      if (req.method === "POST" && url.pathname === "/api/draft") {
        if (!ai.draft) return send(res, 409, { error: NO_KEY });
        const b = await readJson(req);
        const q = String(b.question || "").slice(0, 1000);
        if (!q.trim()) return send(res, 400, { error: "question is empty" });
        if (ai.mock) return send(res, 200, { text: "(mock draft) " + (kb.fallback || "Let me check that and confirm in writing.") });
        return send(res, 200, { text: await chatText(chat, DRAFT_INSTRUCTION, kbForPrompt(kb), "Question just asked on the call:\n" + q + (b.recent ? "\n\nEarlier context:\n" + String(b.recent).slice(0, 2000) : ""), 1024) });
      }
      if (req.method === "POST" && url.pathname === "/api/summary") {
        if (!ai.draft) return send(res, 409, { error: NO_KEY });
        const b = await readJson(req, 2_000_000);
        const t = String(b.transcript || "").slice(-400_000);
        if (!t.trim()) return send(res, 400, { error: "transcript is empty" });
        if (ai.mock) return send(res, 200, { text: "(mock summary)\nAsked: " + t.split("\n").filter(Boolean).length + " lines\nAnswered: -\nFollow-ups: -" });
        return send(res, 200, { text: await chatText(chat, SUMMARY_INSTRUCTION, kbForPrompt(kb), "Transcript:\n" + t, 4000) });
      }
      // A document's text -> cards, written by the chat model. The page shows them for review.
      if (req.method === "POST" && url.pathname === "/api/import") {
        if (!chat) return send(res, 409, { error: NO_KEY });
        const b = await readJson(req, 400_000);
        const text = String(b.text || "").slice(0, 60_000);
        if (!text.trim()) return send(res, 400, { error: "text is empty" });
        return send(res, 200, { text: await chatText(chat, IMPORT_INSTRUCTION, IMPORT_FORMAT, "Document:\n" + text, 8000) });
      }
      // Save reviewed cards into the knowledge base file. The bundled example is never
      // written: with it, the cards go to a new call-cue-kb.json in the start folder.
      if (req.method === "POST" && url.pathname === "/api/kb/cards") {
        const b = await readJson(req, 2_000_000);
        const mode = b.mode === "replace" ? "replace" : "add";
        const fresh = kbFile === EXAMPLE_KB;
        const target = fresh ? path.join(cwd, LOCAL_KB) : kbFile;
        if (fresh && fs.existsSync(target)) return send(res, 409, { error: LOCAL_KB + " already exists in this folder; restart call-cue to use it" });
        let next;
        try {
          const raw = JSON.parse(fs.readFileSync(kbFile, "utf8"));
          const cards = Import.finishCards(b.cards, mode === "add" ? raw.cards.map((c) => c.id) : []);
          if (!cards.length) return send(res, 400, { error: "no card with a title and an answer" });
          next = Import.mergeKb(raw, { mode, cards, title: String(b.title || "").trim().slice(0, 120), fresh });
          checkKb(structuredClone(next), "knowledge base");
        } catch (e) { return send(res, 400, { error: e.message }); }
        if (fs.existsSync(target)) fs.copyFileSync(target, target + ".bak");
        const tmp = target + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
        fs.renameSync(tmp, target);
        kbFile = target; kb = loadKb(target);
        return send(res, 200, { ok: true, file: target, cards: kb.cards.length });
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
  return { server, kb, ai, kbFile, current: () => ({ kb, kbFile }) };
}

export function friendly(e) {
  const s = e.status ?? Number((/^(?:TypeSafe )?(\d{3})\b/.exec(e.message) || [])[1]);
  if (s === 404) return "the AI service did not find that model or address; check CALL_CUE_AI_MODEL";
  if (s === 401 || s === 403) return "the AI service rejected the API key; check it and restart the server";
  if (s === 429) return "the AI service is rate limiting; try again shortly";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "the AI service timed out";
  return e.message.slice(0, 300);
}

function openBrowser(u) {
  const cmd = process.platform === "darwin" ? ["open", [u]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", u]] : ["xdg-open", [u]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch { /* print the URL instead */ }
}

// Resolve symlinks: npx and global installs start us through node_modules/.bin/call-cue.
const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message + "\nTry: call-cue --help"); process.exit(2); }
  if (opts.help) {
    console.log(`call-cue: live answer cards for calls

  call-cue --demo            play a sample call (no keys, no microphone)
  call-cue init              create ${LOCAL_KB} and .env in this folder
  call-cue                   start; uses ./${LOCAL_KB} when it exists
  call-cue --kb file.json    start with another knowledge base

Options: --port 8765   --no-open   --mock-ai
AI (optional): put ONE key in .env: ANTHROPIC_API_KEY, OPENAI_API_KEY,
DEEPSEEK_API_KEY or OPENCODE_API_KEY. See the README for other endpoints.`);
    process.exit(0);
  }
  if (opts.init) {
    const made = init();
    console.log(made.length ? "Created: " + made.join(", ") : `${LOCAL_KB} and .env already exist; nothing changed.`);
    console.log(`Next: start call-cue from this folder and press "Add from a document" in the page (or edit ${LOCAL_KB} by hand).`);
    process.exit(0);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) { console.error("--port needs a number from 1 to 65535"); process.exit(2); }
  loadEnvFile(path.join(process.cwd(), ".env"));
  let made;
  try { made = createServer(opts); } catch (e) { console.error("call-cue could not start: " + e.message); process.exit(2); }
  const { server, kb, ai, kbFile } = made;
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${opts.port} is busy (is call-cue already running?). Try --port ${opts.port + 10}.` : String(e));
    process.exit(1);
  });
  server.listen(opts.port, "127.0.0.1", () => {
    const u = `http://127.0.0.1:${opts.port}/` + (opts.openDemo ? "?demo" : "");
    console.log(`call-cue: ${u}`);
    console.log(`  knowledge base: ${kbFile} (${kb.cards.length} cards)${kbFile === EXAMPLE_KB ? "  <- the example; run \"call-cue init\" for your own" : ""}`);
    console.log(ai.mock ? "  AI: mock (nothing leaves this machine)"
      : ai.draft || ai.match ? `  AI: ${[...new Set([ai.matchBy, ai.draftBy].filter(Boolean))].join(" + ")}${ai.model ? " (" + ai.model + ")" : ""}, off until you press AI in the page`
      : "  AI: off (optional; add one key to .env, see --help)");
    if (!opts.noOpen) openBrowser(u);
  });
}
