import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { loadKb, jevRequest, decideMatch, mockMatch, createServer, parseArgs, friendly, pickProvider, parseLlmMatch, loadEnvFile, init, resolveKb, LOCAL_KB, EXAMPLE_KB } from "../server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB = path.join(HERE, "..", "kb", "example.json");

function tmpKb(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "call-cue-")), "kb.json");
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
const card = (id) => ({ id, title: "T " + id, say: ["S"] });

test("example knowledge base loads", () => {
  const kb = loadKb(KB);
  assert.ok(kb.cards.length >= 5);
  for (const c of kb.cards) assert.ok(Array.isArray(c.triggers));
});

test("loadKb rejects bad ids, reserved, duplicates, missing say", () => {
  assert.throws(() => loadKb(tmpKb({ cards: [card("bad id")] })), /card id/);
  assert.throws(() => loadKb(tmpKb({ cards: [card("none")] })), /reserved/);
  assert.throws(() => loadKb(tmpKb({ cards: [card("a"), card("a")] })), /duplicate/);
  assert.throws(() => loadKb(tmpKb({ cards: [{ id: "a", title: "x", say: [] }] })), /say/);
  assert.throws(() => loadKb(tmpKb({ cards: [] })), /non-empty/);
  assert.throws(() => loadKb(tmpKb({ cards: Array.from({ length: 255 }, (_, i) => card("c" + i)) })), /254/);
});

test("jevRequest asks one choice (with none) and one noul", () => {
  const kb = loadKb(KB);
  const r = jevRequest(kb, "Do you use MFA?", "earlier");
  assert.equal(r.model, "jev-latest");
  assert.equal(r.questions.card.type, "choice");
  assert.deepEqual(Object.keys(r.questions.card.criteria), [...kb.cards.map((c) => c.id), "none"]);
  assert.equal(r.questions.covered.type, "noul");
  assert.equal(r.state.latest_sentence, "Do you use MFA?");
  assert.match(r.questions.card.instructions, /`latest_sentence`/);
});

test("decideMatch thresholds", () => {
  assert.equal(decideMatch({ card: { choice: "mfa", confidence: 0.9 }, covered: { noul: 0.8 } }).id, "mfa");
  assert.equal(decideMatch({ card: { choice: "mfa", confidence: 0.3 }, covered: { noul: 0.8 } }).id, null);
  assert.equal(decideMatch({ card: { choice: "mfa", confidence: 0.9 }, covered: { noul: 0.2 } }).id, null);
  assert.equal(decideMatch({ card: { choice: "none", confidence: 0.9 } }).id, null);
  assert.equal(decideMatch({ card: { choice: "mfa", confidence: 0.6 } }, 0.7).id, null);
  assert.equal(decideMatch(undefined).id, null);
});

test("mockMatch picks by word overlap", () => {
  const kb = loadKb(KB);
  assert.equal(mockMatch(kb, "do you enforce mfa").id, "mfa");
  assert.equal(mockMatch(kb, "zzz qqq").id, null);
});

test("parseArgs", () => {
  const o = parseArgs(["--port", "9000", "--mock-ai", "--open-demo"]);
  assert.equal(o.port, 9000); assert.ok(o.mockAi && o.open && o.openDemo);
  const d = parseArgs(["--demo"]); assert.ok(d.mockAi && d.open && d.openDemo);
  assert.throws(() => parseArgs(["--nope"]), /Unknown/);
  assert.ok(parseArgs(["init"]).init); assert.ok(parseArgs(["--no-open"]).noOpen); assert.equal(parseArgs([]).kb, null);
});

function req(port, { method = "GET", path: p = "/", host, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host || `127.0.0.1:${port}` };
    if (origin) headers.Origin = origin;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

async function withServer(opts, fn) {
  const { server } = createServer({ kb: KB, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server.address().port); } finally { server.close(); }
}

test("server: host and origin guards", () => withServer({ mockAi: true }, async (port) => {
  assert.equal((await req(port, { host: "evil.example:" + port })).status, 421);
  assert.equal((await req(port, { method: "POST", path: "/api/match", origin: "https://evil.example", body: { latest: "mfa" } })).status, 403);
  assert.equal((await req(port, { method: "POST", path: "/api/match", origin: `http://localhost:${port}`, body: { latest: "do you enforce mfa" } })).status, 200);
}));

test("server: kb, match, draft, summary with mock AI", () => withServer({ mockAi: true }, async (port) => {
  const kb = JSON.parse((await req(port, { path: "/api/kb" })).body);
  assert.deepEqual(kb.ai, { match: true, draft: true, mock: true, matchBy: "mock", draftBy: "mock", model: "" });
  const m = JSON.parse((await req(port, { method: "POST", path: "/api/match", body: { latest: "do you enforce mfa", recent: "" } })).body);
  assert.equal(m.id, "mfa");
  assert.equal((await req(port, { method: "POST", path: "/api/match", body: { latest: "  " } })).status, 400);
  assert.equal((await req(port, { method: "POST", path: "/api/match", body: "{not json" })).status, 400);
  assert.match(JSON.parse((await req(port, { method: "POST", path: "/api/draft", body: { question: "What if a laptop is stolen?" } })).body).text, /mock draft/);
  assert.match(JSON.parse((await req(port, { method: "POST", path: "/api/summary", body: { transcript: "[10:00:00] hi" } })).body).text, /mock summary/);
}));

const AI_VARS = ["TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENCODE_API_KEY", "CALL_CUE_AI", "CALL_CUE_AI_KEY", "CALL_CUE_AI_BASE_URL", "CALL_CUE_AI_MODEL", "CALL_CUE_CLAUDE_MODEL"];
// Runs fn with only the given AI variables set, then restores the environment.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(AI_VARS.map((k) => [k, process.env[k]]));
  for (const k of AI_VARS) delete process.env[k];
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally { for (const k of AI_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("server: AI off without keys", () => withEnv({}, () => withServer({}, async (port) => {
  const kb = JSON.parse((await req(port, { path: "/api/kb" })).body);
  assert.deepEqual(kb.ai, { match: false, draft: false, mock: false, matchBy: "", draftBy: "", model: "" });
  const r = await req(port, { method: "POST", path: "/api/match", body: { latest: "x" } });
  assert.equal(r.status, 409); assert.match(r.body, /DEEPSEEK_API_KEY/);
  assert.equal((await req(port, { method: "POST", path: "/api/draft", body: { question: "x" } })).status, 409);
})));

test("pickProvider: first key wins, CALL_CUE_AI and the model can be chosen", () => {
  assert.equal(pickProvider({}), null);
  assert.deepEqual([pickProvider({ ANTHROPIC_API_KEY: "k" }).id, pickProvider({ OPENAI_API_KEY: "k" }).id, pickProvider({ DEEPSEEK_API_KEY: "k" }).id, pickProvider({ OPENCODE_API_KEY: "k" }).id], ["claude", "openai", "deepseek", "opencode"]);
  assert.equal(pickProvider({ ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" }).id, "claude");
  const d = pickProvider({ ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d", CALL_CUE_AI: "DeepSeek", CALL_CUE_AI_MODEL: "m1" });
  assert.deepEqual([d.id, d.apiKey, d.model, d.base, d.tokens], ["deepseek", "d", "m1", "https://api.deepseek.com", "max_tokens"]);
  assert.equal(pickProvider({ OPENAI_API_KEY: "k" }).tokens, "max_completion_tokens");
  assert.equal(pickProvider({ ANTHROPIC_API_KEY: "a", CALL_CUE_CLAUDE_MODEL: "claude-x" }).model, "claude-x");
  const c = pickProvider({ CALL_CUE_AI_BASE_URL: "http://127.0.0.1:11434/v1/", CALL_CUE_AI_MODEL: "llama" });
  assert.deepEqual([c.id, c.base, c.model, c.apiKey], ["custom", "http://127.0.0.1:11434/v1", "llama", ""]);
  assert.throws(() => pickProvider({ CALL_CUE_AI: "openai" }), /needs OPENAI_API_KEY/);
  assert.throws(() => pickProvider({ CALL_CUE_AI: "custom" }), /CALL_CUE_AI_BASE_URL/);
  assert.throws(() => pickProvider({ CALL_CUE_AI: "nope" }), /not one of/);
});

test("parseLlmMatch reads JSON out of a chatty reply and checks the id", () => {
  const kb = loadKb(KB), id = kb.cards[1].id;
  assert.deepEqual(parseLlmMatch('Sure!\n```json\n{"id":"' + id + '","confidence":0.9}\n```', kb), { id, best: id, confidence: 0.9, covered: 0.9, probabilities: {} });
  assert.equal(parseLlmMatch('{"id":"' + id + '","confidence":0.2}', kb).id, null);
  assert.deepEqual(parseLlmMatch('{"id":"none","confidence":0.95}', kb), { id: null, best: null, confidence: 0.95, covered: 0.1, probabilities: {} });
  assert.equal(parseLlmMatch('{"id":"made-up","confidence":1}', kb).best, null);
  assert.equal(parseLlmMatch("I cannot help", kb).covered, null);
});

// A stand-in for any OpenAI-compatible service (ChatGPT, DeepSeek, OpenCode, Ollama...).
async function withFakeChat(reply, fn) {
  const seen = [];
  const s = http.createServer((q, r) => {
    let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => {
      seen.push({ url: q.url, auth: q.headers.authorization, body: JSON.parse(b) });
      const out = reply(seen[seen.length - 1]);
      r.writeHead(out.status || 200, { "Content-Type": "application/json" });
      r.end(JSON.stringify(out.status ? { error: "nope" } : { choices: [{ message: { role: "assistant", content: out.text } }] }));
    });
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  try { return await fn("http://127.0.0.1:" + s.address().port + "/v1", seen); } finally { s.close(); }
}

test("server: an OpenAI-compatible provider matches, drafts and summarises", () => {
  const id = loadKb(KB).cards[1].id;
  const reply = (q) => ({ text: /JSON only/.test(q.body.messages[0].content) ? `{"id":"${id}","confidence":0.8}` : "We will confirm in writing." });
  return withFakeChat(reply, (base, seen) => withEnv({ CALL_CUE_AI_BASE_URL: base, CALL_CUE_AI_MODEL: "test-model", CALL_CUE_AI_KEY: "k-test" }, () => withServer({}, async (port) => {
    const kb = JSON.parse((await req(port, { path: "/api/kb" })).body);
    assert.deepEqual(kb.ai, { match: true, draft: true, mock: false, matchBy: "custom endpoint", draftBy: "custom endpoint", model: "test-model" });
    const m = JSON.parse((await req(port, { method: "POST", path: "/api/match", body: { latest: "Do you enforce MFA for staff?" } })).body);
    assert.deepEqual([m.id, m.confidence, m.model], [id, 0.8, "test-model"]);
    assert.equal(JSON.parse((await req(port, { method: "POST", path: "/api/draft", body: { question: "What about laptops?" } })).body).text, "We will confirm in writing.");
    assert.equal(JSON.parse((await req(port, { method: "POST", path: "/api/summary", body: { transcript: "[10:00:00] hi" } })).body).text, "We will confirm in writing.");
    assert.deepEqual([seen[0].url, seen[0].auth, seen[0].body.model, seen[0].body.max_tokens], ["/v1/chat/completions", "Bearer k-test", "test-model", 300]);
    assert.match(seen[1].body.messages[0].content, /Knowledge base/);
  })));
});

test("server: a rejected key gives a plain message", () => withFakeChat(() => ({ status: 401 }), (base) => withEnv({ CALL_CUE_AI_BASE_URL: base, CALL_CUE_AI_MODEL: "m" }, () => withServer({}, async (port) => {
  const r = await req(port, { method: "POST", path: "/api/draft", body: { question: "What about laptops?" } });
  assert.equal(r.status, 502); assert.match(r.body, /rejected the API key/); assert.doesNotMatch(r.body, /nope/);
}))));

test("loadEnvFile: sets missing variables only, ignores comments", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "call-cue-")), ".env");
  fs.writeFileSync(f, '# note\n#OPENAI_API_KEY=off\nDEEPSEEK_API_KEY = "abc"\nexport CALL_CUE_AI=deepseek\nEMPTY=\nKEEP=new\n');
  const env = { KEEP: "old" };
  assert.equal(loadEnvFile(f, env), 2);
  assert.deepEqual(env, { KEEP: "old", DEEPSEEK_API_KEY: "abc", CALL_CUE_AI: "deepseek" });
  assert.equal(loadEnvFile(path.join(os.tmpdir(), "call-cue-none", ".env"), env), 0);
});

test("init creates a knowledge base and .env once; the local one is then used", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "call-cue-"));
  assert.equal(resolveKb({ kb: null }, dir), EXAMPLE_KB);
  assert.deepEqual(init(dir), [LOCAL_KB, ".env"]);
  assert.deepEqual(init(dir), []);
  assert.equal(resolveKb({ kb: null }, dir), path.join(dir, LOCAL_KB));
  assert.equal(resolveKb({ kb: "/x.json" }, dir), "/x.json");
  assert.ok(loadKb(path.join(dir, LOCAL_KB)).cards.length);
  assert.equal(loadEnvFile(path.join(dir, ".env"), {}), 0);
});

test("server: static files stay inside public/", () => withServer({}, async (port) => {
  const home = await req(port, { path: "/" });
  assert.equal(home.status, 200); assert.match(home.body, /<script src="app.js">/);
  assert.equal((await req(port, { path: "/app.js" })).status, 200);
  assert.equal((await req(port, { path: "/../server.mjs" })).status, 404);
  assert.equal((await req(port, { path: "/%2e%2e/server.mjs" })).status, 404);
  assert.equal((await req(port, { path: "/..%2fkb%2fexample.json" })).status, 404);
}));

test("friendly errors hide raw API bodies", () => {
  assert.match(friendly(Object.assign(new Error('401 {"type":"error"}'), { status: 401 })), /rejected the API key/);
  assert.match(friendly(new Error("TypeSafe 401: nope")), /rejected the API key/);
  assert.match(friendly(new Error("TypeSafe 429: slow down")), /rate limiting/);
  assert.match(friendly(Object.assign(new Error("x"), { name: "TimeoutError" })), /timed out/);
  assert.equal(friendly(new Error("something else")), "something else");
});

// ---------- cards from a document ----------
import "../public/import.js";
const Import = globalThis.CallCueImport;
const FAQ = `# Acme help

## Shipping

How long does delivery take?
Standard delivery takes 3 to 5 business days. Express takes 1 to 2 days.
- Tracking is emailed when the parcel leaves.

Q: Do you offer refunds?
A: Yes, within 30 days of delivery for misprints or damage.

## Returns policy
Items can be returned within 30 days. Contact support first.`;

test("import: headings, questions and Q/A lines become cards", () => {
  const cards = Import.finishCards(Import.textToCards(FAQ));
  assert.deepEqual(cards.map((c) => c.title), ["How long does delivery take?", "Do you offer refunds?", "Returns policy"]);
  assert.equal(cards[0].topic, "Shipping");
  assert.match(cards[0].say[0], /3 to 5 business days/);
  assert.deepEqual(cards[0].facts, ["Tracking is emailed when the parcel leaves."]);
  assert.equal(cards[1].say[0], "Yes, within 30 days of delivery for misprints or damage.");
  for (const c of cards) { assert.match(c.id, /^[a-z0-9_-]{1,40}$/); assert.ok(c.triggers.length); }
});

test("import: generated triggers bring the right card up in the page matcher", () => {
  const cards = Import.finishCards(Import.textToCards(FAQ));
  // Same scoring as public/app.js: prefix match on "*", show at 2.5.
  const norm = (s) => " " + s.toLowerCase().replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  const best = (q) => cards.map((c) => ({ id: c.id, s: c.triggers.reduce((n, [p, w]) => n + (new RegExp(" " + (p.endsWith("*") ? p.slice(0, -1) + "[a-z0-9]*" : p) + " ").test(norm(q)) ? w : 0), 0) })).sort((a, b) => b.s - a.s)[0];
  const refund = best("can I get a refund for this order");
  assert.equal(refund.id, cards[1].id); assert.ok(refund.s >= 2.5);
  const ship = best("when will my delivery arrive");
  assert.equal(ship.id, cards[0].id); assert.ok(ship.s >= 2.5);
});

test("import: plain paragraphs still give cards; CSV rows are question and answer", () => {
  const cards = Import.finishCards(Import.textToCards("Our office is open Monday to Friday from nine to five Eastern time.\n\nPayment is due thirty days after the invoice date and we accept cards."));
  assert.equal(cards.length, 2);
  const csv = Import.csvToText('question,answer\n"Do you, ship abroad?",Yes\nWhat is the fee?,"None, ""ever"""');
  assert.equal(csv, 'Q: Do you, ship abroad?\nA: Yes\n\nQ: What is the fee?\nA: None, "ever"');
  assert.equal(Import.textToCards(csv).length, 2);
});

test("import: finishCards drops unusable cards and keeps ids unique and valid", () => {
  const cards = Import.finishCards([{ title: "A?", say: "one" }, { title: "A?", say: ["two"], status: "bogus", triggers: [["x", 2], "bad", [3]] }, { title: "no answer" }, null, { id: "none", title: "None", say: ["x"] }], ["a"]);
  assert.equal(cards.length, 3);
  assert.equal(new Set(cards.map((c) => c.id)).size, 3);
  assert.ok(!cards.some((c) => c.id === "a" || c.id === "none"));
  assert.equal(cards[1].status, "info");
  assert.deepEqual(cards[1].triggers, [["x", 2]]);
});

test("import: AI output is read with code fences, as a bare list, and when cut off", () => {
  assert.equal(Import.parseAiCards('Here you go:\n```json\n{"cards":[{"title":"a","say":["b"]}]}\n```').length, 1);
  assert.equal(Import.parseAiCards('[{"title":"a","say":["b"]},{"title":"c","say":["d"]}]').length, 2);
  assert.equal(Import.parseAiCards('{"cards":[{"title":"a","say":["b"]},{"title":"c","say":["d').length, 1);
  assert.deepEqual(Import.parseAiCards("sorry, I cannot"), []);
});

test("import: long text is split at paragraph breaks", () => {
  const parts = Import.chunkText(Array.from({ length: 50 }, (_, i) => "Paragraph " + i + " " + "x".repeat(900)).join("\n\n"), 10000);
  assert.ok(parts.length >= 5 && parts.every((p) => p.length <= 10000));
});

async function post(port, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function withSrv(opts, fn) {
  const made = createServer({ port: 0, ...opts });
  await new Promise((r) => made.server.listen(0, "127.0.0.1", r));
  try { return await fn(made.server.address().port, made); } finally { await new Promise((r) => made.server.close(r)); }
}

test("POST /api/kb/cards adds to your file and keeps a .bak copy", async () => {
  const file = tmpKb({ title: "Mine", dontSay: ["never"], cards: [card("one")] });
  await withSrv({ kb: file, mockAi: true }, async (port, made) => {
    const r = await post(port, "/api/kb/cards", { mode: "add", cards: [{ id: "one", title: "Second question?", say: ["Second answer."] }] });
    assert.equal(r.status, 200); assert.equal(r.body.cards, 2);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.cards.length, 2); assert.equal(saved.title, "Mine"); assert.deepEqual(saved.dontSay, ["never"]);
    assert.notEqual(saved.cards[1].id, "one");
    assert.ok(saved.cards[1].triggers.length);
    assert.equal(JSON.parse(fs.readFileSync(file + ".bak", "utf8")).cards.length, 1);
    assert.equal(made.current().kb.cards.length, 2);
    const kb = await (await fetch(`http://127.0.0.1:${port}/api/kb`)).json();
    assert.equal(kb.cards.length, 2); assert.equal(kb.source, "file");
    const bad = await post(port, "/api/kb/cards", { mode: "add", cards: [{ title: "no answer" }] });
    assert.equal(bad.status, 400);
  });
});

test("POST /api/kb/cards never writes the bundled example: it starts call-cue-kb.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "call-cue-"));
  const before = fs.readFileSync(EXAMPLE_KB, "utf8");
  await withSrv({ cwd: dir, mockAi: true }, async (port, made) => {
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/kb`)).json()).source, "example");
    const r = await post(port, "/api/kb/cards", { mode: "replace", title: "Acme help", cards: [{ title: "Do you ship abroad?", say: ["Yes, to 40 countries."] }] });
    assert.equal(r.status, 200);
    const mine = JSON.parse(fs.readFileSync(path.join(dir, "call-cue-kb.json"), "utf8"));
    assert.equal(mine.title, "Acme help"); assert.equal(mine.cards.length, 1);
    assert.equal(mine.demo, undefined); assert.deepEqual(mine.stats, []);
    assert.equal(fs.readFileSync(EXAMPLE_KB, "utf8"), before);
    assert.equal(made.current().kbFile, path.join(dir, "call-cue-kb.json"));
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/kb`)).json()).source, "file");
  });
});

test("POST /api/import asks the chat model for cards; without a key it says so", async () => {
  const file = tmpKb({ cards: [card("one")] });
  await withSrv({ kb: file, mockAi: true }, async (port) => {
    assert.equal((await post(port, "/api/import", { text: "anything" })).status, 409);
  });
  await withFakeChat(() => ({ text: '{"cards":[{"title":"Do you ship abroad?","say":["Yes."],"keywords":"ship abroad international"}]}' }), async (base, seen) => {
    await withEnv({ CALL_CUE_AI: "custom", CALL_CUE_AI_BASE_URL: base, CALL_CUE_AI_MODEL: "m" }, async () => {
      await withSrv({ kb: file }, async (port) => {
        const r = await post(port, "/api/import", { text: "We ship to 40 countries." });
        assert.equal(r.status, 200);
        assert.equal(Import.finishCards(Import.parseAiCards(r.body.text)).length, 1);
        assert.match(JSON.stringify(seen), /We ship to 40 countries/);
        assert.equal((await post(port, "/api/import", { text: " " })).status, 400);
      });
    });
  });
});

test("CHANGELOG.md has an entry for the version in package.json", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const v = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.ok(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").includes("## " + v), "add a \"## " + v + "\" section to CHANGELOG.md");
});
