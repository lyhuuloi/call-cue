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
