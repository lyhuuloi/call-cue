import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { loadKb, jevRequest, decideMatch, mockMatch, createServer, parseArgs, friendly } from "../server.mjs";

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
  assert.deepEqual(kb.ai, { match: true, draft: true, mock: true });
  const m = JSON.parse((await req(port, { method: "POST", path: "/api/match", body: { latest: "do you enforce mfa", recent: "" } })).body);
  assert.equal(m.id, "mfa");
  assert.equal((await req(port, { method: "POST", path: "/api/match", body: { latest: "  " } })).status, 400);
  assert.equal((await req(port, { method: "POST", path: "/api/match", body: "{not json" })).status, 400);
  assert.match(JSON.parse((await req(port, { method: "POST", path: "/api/draft", body: { question: "What if a laptop is stolen?" } })).body).text, /mock draft/);
  assert.match(JSON.parse((await req(port, { method: "POST", path: "/api/summary", body: { transcript: "[10:00:00] hi" } })).body).text, /mock summary/);
}));

test("server: AI off without keys", () => {
  const saved = [process.env.TYPESAFE_API_KEY, process.env.ANTHROPIC_API_KEY];
  delete process.env.TYPESAFE_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  return withServer({}, async (port) => {
    const kb = JSON.parse((await req(port, { path: "/api/kb" })).body);
    assert.deepEqual(kb.ai, { match: false, draft: false, mock: false });
    assert.equal((await req(port, { method: "POST", path: "/api/match", body: { latest: "x" } })).status, 409);
    assert.equal((await req(port, { method: "POST", path: "/api/draft", body: { question: "x" } })).status, 409);
  }).finally(() => {
    if (saved[0] !== undefined) process.env.TYPESAFE_API_KEY = saved[0];
    if (saved[1] !== undefined) process.env.ANTHROPIC_API_KEY = saved[1];
  });
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
