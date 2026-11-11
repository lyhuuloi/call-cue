// call-cue page. Everything here runs in the browser; the only network calls go to the
// local server (127.0.0.1), and AI calls happen only after you switch ✨ AI on.
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LABEL = { ok: "✅ In place", gap: "⚠️ Gap", ask: "❓ Confirm", info: "💬 Script" };
let KB = null, byId = {}, RX = {};
let filt = "all";

// ---------- cards ----------
function hl(html, terms) {
  if (!terms.length) return html;
  const re = new RegExp("(" + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  return html.split(/(<[^>]+>)/).map((p) => (p.startsWith("<") ? p : p.replace(re, "<mark>$1</mark>"))).join("");
}
function cardHTML(c) {
  return `<div class="meta"><span class="pill ${esc(c.status)}">${LABEL[c.status] || esc(c.status)}</span><span class="tag">${esc(c.topic)}</span></div>
    <h2>${esc(c.title)}</h2>
    <div class="say">${c.say.map((s) => "<p>🗣️ " + esc(s) + "</p>").join("")}</div>
    ${c.facts.length ? "<ul class='facts'>" + c.facts.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : ""}
    ${c.note ? `<div class="vn">💡 ${esc(c.note)}</div>` : ""}`;
}
function render() {
  const q = $("q");
  const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0; $("grid").innerHTML = "";
  for (const c of KB.cards) {
    if (filt !== "all" && c.status !== filt) continue;
    const hay = [c.title, c.topic, c.say.join(" "), c.facts.join(" "), c.note, c.keywords].join(" ").toLowerCase();
    if (terms.length && !terms.every((t) => hay.includes(t))) continue;
    shown++;
    const el = document.createElement("article"); el.className = "card";
    el.innerHTML = hl(cardHTML(c), terms.map(esc));
    $("grid").appendChild(el);
  }
  $("empty").style.display = shown ? "none" : "block";
}

// ---------- keyword matcher (offline, instant) ----------
const norm = (s) => " " + String(s).toLowerCase().replace(/-/g, " ").replace(/[^a-z0-9. ]+/g, " ").replace(/\.(?=\s|$)/g, " ").replace(/\s+/g, " ").trim() + " ";
function compileTriggers() {
  RX = {};
  for (const c of KB.cards) RX[c.id] = c.triggers.map(([p, w]) => {
    const stem = p.endsWith("*"); const b = (stem ? p.slice(0, -1) : p).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { p, w, re: new RegExp(" " + b + (stem ? "[a-z0-9]*" : "") + " ") };
  });
}
function rank(text, recent) {
  const t = norm(text), r = norm(recent || "");
  const out = [];
  for (const id in RX) {
    let s = 0;
    for (const x of RX[id]) if (x.re.test(t)) s += x.w * (x.re.test(r) ? 1.5 : 1);
    if (s > 0) out.push({ id, s });
  }
  return out.sort((a, b) => b.s - a.s);
}

// ---------- live captions → card ----------
const WINDOW_MS = 25000, SHOW_MIN = 2.5;
let finals = [], interim = "", cur = null, curBy = "", pinned = false, listening = false, rec = null, allowCloud = false;
const windowText = () => { const now = Date.now(); return finals.filter((f) => now - f.t <= WINDOW_MS).map((f) => f.x).join(" ") + " " + interim; };
const recentText = (n = 14) => windowText().trim().split(/\s+/).slice(-n).join(" ");
function altsHTML(list) {
  return (list || []).filter((a) => a.id !== cur && byId[a.id]).slice(0, 3).map((a) => `<button class="btn" data-id="${esc(a.id)}">↪ ${esc(byId[a.id].title.slice(0, 58))}</button>`).join("");
}
function showCard(id, alts, by) {
  const c = byId[id]; if (!c) return;
  cur = id; curBy = by || "";
  $("sugg").innerHTML = cardHTML(c);
  if (by) $("sugg").querySelector(".meta").insertAdjacentHTML("beforeend", `<span id="aiBadge">${esc(by)}</span>`);
  $("alts").innerHTML = altsHTML(alts);
}
function update() {
  const now = Date.now();
  const ft = finals.filter((f) => now - f.t <= WINDOW_MS).map((f) => f.x).join(" ").trim().split(/\s+/).slice(-30).join(" ");
  $("heard").innerHTML = "👂 " + (ft || interim ? "<b>" + esc(ft) + "</b> <i>" + esc(interim) + "</i>" : "<i>waiting for someone to speak…</i>");
  trNoteInterim(interim);
  if (!cur) $("sugg").innerHTML = '<p class="wait">🔎 The answer card <b>appears here by itself</b> when they ask about something in your knowledge base. No typing needed.</p>';
  if (pinned) return;
  const rk = rank(windowText(), recentText());
  // The newest sentence wins: a fresh question switches the card even when older talk scores higher.
  const lf = finals[finals.length - 1];
  const lastS = interim.trim().split(/\s+/).length >= 4 ? interim : lf && now - lf.t <= WINDOW_MS ? lf.x : "";
  const rl = lastS ? rank(lastS, lastS) : [];
  if (rl.length && rl[0].s >= SHOW_MIN) {
    const alts = rl.concat(rk).filter((a, i, arr) => arr.findIndex((b) => b.id === a.id) === i);
    if (rl[0].id !== cur) showCard(rl[0].id, alts); else $("alts").innerHTML = altsHTML(alts);
    return;
  }
  if (!rk.length || rk[0].s < SHOW_MIN) return;
  const curScore = (rk.find((r) => r.id === cur) || { s: 0 }).s;
  // An AI pick stands until the keywords find a clearly newer topic.
  if (rk[0].id !== cur && rk[0].s > curScore + (curBy ? 2 : 0.5)) showCard(rk[0].id, rk);
  else if (rk[0].id === cur) $("alts").innerHTML = altsHTML(rk);
}
const stamp = () => new Date().toTimeString().slice(0, 8);
function addFinal(x) {
  x = x.trim(); if (!x) return;
  finals.push({ t: Date.now(), x }); if (finals.length > 400) finals.shift();
  trFinal(x); txAppend(`[${stamp()}] ${x}`);
  aiOnFinal(x);
}
function status(s) { $("status").textContent = s; }
// One entry point for every caption source: speech recognition, the Live Captions relay, the demo.
window.__feed = (x, fin) => { $("live").classList.add("show"); if (fin) { interim = ""; addFinal(x); } else interim = x; update(); };

// ---------- speech recognition in the browser ----------
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);
let srcKind = "", srcStream = null, srcTrack = null;
async function pickTab() {
  if (!navigator.mediaDevices?.getDisplayMedia) { status("❌ This browser cannot share tab audio."); return null; }
  let s;
  try { s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { suppressLocalAudioPlayback: false }, systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include", preferCurrentTab: false }); }
  catch (e) { status("⏸ No tab picked (" + e.name + ")."); return null; }
  if (!s.getAudioTracks()[0]) { s.getTracks().forEach((t) => t.stop()); status("⚠️ No audio: pick the call tab and tick 'Also share tab audio', then try again."); return null; }
  return s;
}
async function startListen(kind) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { status("❌ No speech recognition in this browser. Use Google Chrome."); return; }
  kind = kind || srcKind || "tab";
  if (kind === "tab" && !(srcTrack && srcTrack.readyState === "live")) {
    const s = await pickTab(); if (!s) return;
    srcStream = s; srcTrack = s.getAudioTracks()[0];
    srcTrack.addEventListener("ended", () => { if (listening && srcKind === "tab") { stopListen(); status("⏸ Tab sharing stopped. Press 🖥️ to listen again."); } });
  }
  srcKind = kind;
  const lang = $("lang").value; let local = false;
  if (typeof SR.available === "function") {
    try {
      let a = await SR.available({ langs: [lang], processLocally: true });
      if (a === "downloadable" || a === "downloading") {
        status("⬇️ Downloading the on-device speech model (once)…");
        const ok = await withTimeout(SR.install({ langs: [lang], processLocally: true }), 90000);
        a = ok === true ? "available" : a;
      }
      local = a === "available";
    } catch { local = false; }
  }
  if (!local && !allowCloud) { status("⚠️ No on-device speech model for " + lang + ". Try English (US), or press ☁️ to allow cloud recognition."); $("cloud").style.display = ""; return; }
  rec = new SR(); rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  if (local) rec.processLocally = true;
  rec.onresult = (e) => {
    interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) addFinal(r[0].transcript); else interim += r[0].transcript; }
    update();
  };
  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { listening = false; status("❌ Permission blocked (" + e.error + "). Allow it from the lock icon next to the address, then retry."); setBtn(); return; }
    if (e.error === "language-not-supported" && local) { listening = false; status("⚠️ " + lang + " is not on this device. Pick English (US) or press ☁️."); $("cloud").style.display = ""; setBtn(); return; }
    status("⚠️ Recognition error: " + e.error + " (retrying)");
  };
  const go = () => (srcKind === "tab" ? rec.start(srcTrack) : rec.start());
  rec.onend = () => { if (listening) setTimeout(() => { try { go(); } catch {} }, 300); };
  listening = true; setBtn(); $("live").classList.add("show"); update();
  try { go(); status("🔴 Listening to the " + (srcKind === "tab" ? "call tab" : "mic") + " (" + (local ? "🔒 on device" : "☁️ cloud") + ", " + lang + ")"); }
  catch (e) { listening = false; setBtn(); status("⚠️ Could not start (" + e.name + ": " + e.message + ")" + (srcKind === "tab" ? ". This Chrome may not support tab audio yet; use 🎙️." : "")); }
}
function stopListen() {
  listening = false; try { rec && rec.stop(); } catch {}
  if (srcStream) { srcStream.getTracks().forEach((t) => t.stop()); srcStream = null; srcTrack = null; }
  status("⏸ Stopped. What you heard stays below."); setBtn();
}
function setBtn() {
  const b = $("listen"), m = $("listenMic");
  b.textContent = listening && srcKind === "tab" ? "⏹ Stop" : "🖥️ Listen to call tab"; b.className = listening && srcKind === "tab" ? "btn on" : listening ? "btn" : "btn primary";
  m.textContent = listening && srcKind === "mic" ? "⏹ Stop" : "🎙️ Mic"; m.className = listening && srcKind === "mic" ? "btn on" : "btn";
}

// ---------- transcript ----------
const TX_KEY = "call-cue-transcript";
function txAppend(line) {
  const log = $("log"); log.textContent += line + "\n"; log.scrollTop = log.scrollHeight;
  try { localStorage.setItem(TX_KEY, log.textContent.slice(-500000)); } catch {}
}

// ---------- on-device translation (Chrome Translator API) ----------
let trApi = null, trOn = false, trFinals = [], trInterim = "", trChain = Promise.resolve(), trPending = null, trBusy = false, trLastSrc = "";
function renderTr() {
  if (!trOn) { $("heardTr").innerHTML = ""; return; }
  const ft = trFinals.slice(-2).join(" ");
  $("heardTr").innerHTML = "🌐 " + (ft || trInterim ? "<b>" + esc(ft) + "</b> <i>" + esc(trInterim) + "</i>" : "<i>waiting for a sentence…</i>");
}
function trFinal(x) {
  if (!trOn || !trApi) return;
  trInterim = ""; trPending = null;
  trChain = trChain.then(() => trApi.translate(x)).then((v) => {
    trFinals.push(v); if (trFinals.length > 60) trFinals.shift();
    txAppend(`           ↳ ${v}`); renderTr();
  }).catch(() => {});
}
function trNoteInterim(t) { if (trOn && t !== trLastSrc) { trLastSrc = t; trPending = t; } }
setInterval(() => {
  if (!trOn || !trApi || trBusy || trPending === null) return;
  const t = trPending; trPending = null;
  if (!t.trim()) { trInterim = ""; renderTr(); return; }
  trBusy = true;
  trApi.translate(t).then((v) => { trInterim = v; renderTr(); }).catch(() => {}).finally(() => { trBusy = false; });
}, 700);
async function toggleTr() {
  const b = $("tr"), target = KB.translateTo || "vi";
  if (trOn) { trOn = false; b.className = "btn"; b.textContent = "🌐 Translate"; renderTr(); return; }
  if (!("Translator" in self)) { status("⚠️ This browser has no on-device translator. Use a recent Google Chrome."); return; }
  const o = { sourceLanguage: "en", targetLanguage: target };
  let a = "unavailable"; try { a = await withTimeout(Translator.availability(o), 8000); } catch {}
  if (a === "timeout" || a === "unavailable") { status("⚠️ Chrome on this device cannot translate en → " + target + "."); return; }
  status(a === "available" ? "⏳ Starting translation…" : "⬇️ Downloading the en → " + target + " language pack (once, on device)…");
  try { trApi = trApi || (await Translator.create({ ...o, monitor(m) { m.addEventListener("downloadprogress", (e) => status("⬇️ Downloading… " + Math.round((e.loaded || 0) * 100) + "%")); } })); }
  catch (e) { status("⚠️ Could not start translation (" + e.name + "). Press 🌐 again."); return; }
  trOn = true; b.className = "btn on"; b.textContent = "🌐 Translating (press to stop)";
  $("live").classList.add("show");
  status("🌐 Translating en → " + target + " on this device; no text leaves the machine.");
  renderTr();
  for (const f of finals.slice(-2)) trFinal(f.x);
}

// ---------- AI helpers (opt-in; text only, via the local server) ----------
let aiOn = false, aiSeq = 0, aiInflight = 0;
const AI_MIN_WORDS = 4;
function aiSending(d) { aiInflight += d; $("aiSending").classList.toggle("on", aiInflight > 0); }
async function api(path, body) {
  aiSending(1);
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d;
  } finally { aiSending(-1); }
}
async function aiOnFinal(sentence) {
  if (!aiOn || !KB.ai.match || sentence.split(/\s+/).length < AI_MIN_WORDS) return;
  const seq = ++aiSeq;
  let m;
  try { m = await api("/api/match", { latest: sentence, recent: recentText(60) }); }
  catch (e) { status("⚠️ AI match failed (" + e.message + "); keyword matching continues."); return; }
  if (seq !== aiSeq || pinned) return; // a newer sentence already arrived
  if (m.id) {
    $("draft").innerHTML = "";
    showCard(m.id, rank(windowText(), recentText()), "✨ AI " + Math.round(m.confidence * 100) + "%");
  } else if (KB.ai.draft && m.covered !== null && m.covered < 0.5 && /\?\s*$|^(what|how|who|when|where|why|do|does|did|is|are|can|could|would|will|have|has)\b/i.test(sentence.trim())) {
    try {
      const d = await api("/api/draft", { question: sentence, recent: recentText(60) });
      if (seq !== aiSeq) return;
      $("draft").innerHTML = `<div class="draft"><b>✍️ AI draft, not approved:</b> no card covers “${esc(sentence)}”.<p>🗣️ ${esc(d.text)}</p></div>`;
    } catch (e) { status("⚠️ AI draft failed (" + e.message + ")."); }
  }
}
function toggleAi() {
  aiOn = !aiOn;
  const b = $("ai"); b.setAttribute("aria-pressed", String(aiOn));
  b.textContent = aiOn ? "✨ AI on" : "✨ AI off";
  status(aiOn ? "✨ AI on: each finished sentence (text, not audio) goes to " + [KB.ai.match && "the matching model", KB.ai.draft && "the drafting model"].filter(Boolean).join(" and ") + (KB.ai.mock ? " (mock, nothing leaves this machine)." : ".") : "AI off: nothing leaves this machine.");
  try { localStorage.setItem("call-cue-ai", aiOn ? "1" : "0"); } catch {}
}

// ---------- external caption feed (Windows Live Captions relay) ----------
const FEED_URL = "http://127.0.0.1:8766/live.json";
let feedState = "", feedLastCap = "", feedEmitted = [], feedEverOn = false;
const sentKey = (s) => norm(s).trim();
function similar(a, b) { const A = new Set(a.split(" ")), B = new Set(b.split(" ")); let n = 0; A.forEach((w) => { if (B.has(w)) n++; }); return n / Math.max(1, A.size, B.size); }
function feedCaption(cap) {
  cap = String(cap || "").replace(/\s+/g, " ").trim();
  if (cap === feedLastCap) return; feedLastCap = cap;
  const parts = cap ? cap.split(/(?<=[.?!])\s+/) : [];
  const tail = parts.length && !/[.?!]$/.test(parts[parts.length - 1]) ? parts.pop() : "";
  for (const p of parts) {
    const k = sentKey(p); if (k.split(" ").length < 2) continue;
    if (feedEmitted.some((e) => e === k || similar(e, k) >= 0.7)) continue;
    feedEmitted.push(k); if (feedEmitted.length > 15) feedEmitted.shift();
    window.__feed(p, true);
  }
  window.__feed(tail, false);
}
const FEED_MSG = {
  ok: "🟢 Receiving Windows Live Captions (on device). Cards switch by themselves.",
  no_live_captions: "⚠️ The relay is running but Live Captions is off. Press Win + Ctrl + L.",
  no_text_element: "⚠️ Live Captions is open but no text yet. Wait for speech, or toggle Live Captions (Win + Ctrl + L).",
  reconnecting: "⏳ Reconnecting to Live Captions…",
  not_windows: "ℹ️ The relay is running, but this is not Windows.",
  stale: "⚠️ Lost the Live Captions relay (window closed?). Start it again.",
};
function setFeedState(st) {
  if (st === feedState) return; feedState = st;
  if (st === "none" || (st === "stale" && !feedEverOn)) return;
  const on = st === "ok";
  if (on) { feedEverOn = true; $("live").classList.add("show"); update(); }
  $("feedBadge").style.display = on ? "" : "none";
  ["listen", "listenMic", "lang"].forEach((id) => { $(id).style.display = on && !listening ? "none" : ""; });
  if (!listening) status(FEED_MSG[st] || "ℹ️ Caption relay: " + st);
}
async function pollFeed() {
  let wait = 400;
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(FEED_URL + "?t=" + Date.now(), { cache: "no-store", signal: ctl.signal }); clearTimeout(tm);
    if (!r.ok) { setFeedState(feedEverOn ? "stale" : "none"); wait = 3000; }
    else {
      const d = await r.json();
      if (Date.now() / 1000 - (d.ts || 0) > 10) { setFeedState("stale"); wait = 2000; }
      else { setFeedState(d.status || "ok"); if (d.status === "ok" && !listening) feedCaption(d.caption); }
    }
  } catch { setFeedState(feedEverOn ? "stale" : "none"); wait = feedEverOn ? 3000 : 10000; }
  nextPoll(wait);
}
// Chrome slows timers in hidden tabs; a worker's timer is not slowed, so it paces the poll.
let tickWorker = null;
function nextPoll(ms) { if (tickWorker) tickWorker.postMessage(ms); else setTimeout(pollFeed, ms); }

// ---------- demo: plays the knowledge base's sample lines word by word ----------
async function playDemo() {
  const lines = KB.demo || [];
  if (!lines.length) { status("ℹ️ This knowledge base has no demo lines."); return; }
  listening = true; srcKind = "demo";
  $("listen").className = "btn on"; $("listen").textContent = "▶️ Demo call";
  $("live").classList.add("show"); update();
  status("▶️ Playing the demo call from the knowledge base.");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const line of lines) {
    const w = line.split(" ");
    for (let i = 1; i <= w.length; i++) { window.__feed(w.slice(0, i).join(" "), false); await sleep(260); }
    window.__feed(line, true);
    await sleep(3200);
  }
  listening = false; srcKind = ""; setBtn();
  status("⏹ Demo finished.");
}

// ---------- boot ----------
async function boot() {
  try { KB = await (await fetch("/api/kb", { cache: "no-store" })).json(); }
  catch { document.body.innerHTML = "<p style='padding:20px'>Could not load the knowledge base. Start the page with <code>node server.mjs</code> and open http://127.0.0.1:8765/</p>"; return; }
  byId = Object.fromEntries(KB.cards.map((c) => [c.id, c]));
  compileTriggers();
  document.title = (KB.title || "call-cue") + " · call-cue";
  $("kbTitle").textContent = KB.title || "call-cue";
  $("kbSub").textContent = KB.subtitle || "";
  if (KB.captionLang) $("lang").value = KB.captionLang;
  $("stats").innerHTML = (KB.stats || []).map((s) => `<div class="num ${s.tone === "gap" ? "r" : "g"}"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("");
  $("lifelines").innerHTML = (KB.lifelines || []).map((x) => "<li>“" + esc(x) + "”</li>").join("");
  $("dontSay").innerHTML = (KB.dontSay || []).map((x) => "<li>" + esc(x) + "</li>").join("");
  $("empty").textContent = "No card matches. Lifeline: “" + (KB.fallback || "Let me check that and confirm in writing.") + "”";
  $("tr").textContent = "🌐 Translate → " + (KB.translateTo || "vi");
  if (KB.ai.match || KB.ai.draft) {
    $("ai").style.display = "";
    try { if (localStorage.getItem("call-cue-ai") === "1") toggleAi(); } catch {}
  }
  if (KB.ai.draft) $("sumBtn").style.display = "";
  try { const v = localStorage.getItem(TX_KEY); if (v) $("log").textContent = v; } catch {}
  $("log").textContent.split("\n").slice(-15).forEach((l) => { const m = l.match(/^\[\d\d:\d\d:\d\d\] (.*)$/); if (m) feedEmitted.push(sentKey(m[1])); });

  $("listen").addEventListener("click", () => { if (listening) { const was = srcKind; stopListen(); if (was === "tab") return; } startListen("tab"); });
  $("listenMic").addEventListener("click", () => { if (listening) { const was = srcKind; stopListen(); if (was === "mic") return; } startListen("mic"); });
  $("lang").addEventListener("change", () => { if (listening) { const k = srcKind; listening = false; try { rec.stop(); } catch {} startListen(k); } });
  $("cloud").addEventListener("click", () => { allowCloud = true; $("cloud").style.display = "none"; startListen(srcKind || "tab"); });
  $("pin").addEventListener("click", () => { pinned = !pinned; $("pin").setAttribute("aria-pressed", String(pinned)); if (!pinned) update(); });
  $("alts").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (!b) return; pinned = true; $("pin").setAttribute("aria-pressed", "true"); showCard(b.dataset.id, rank(windowText(), recentText())); });
  $("tr").addEventListener("click", toggleTr);
  $("ai").addEventListener("click", toggleAi);
  $("q").addEventListener("input", render);
  document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    filt = b.dataset.f; document.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false")); render();
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("q")) { e.preventDefault(); $("q").focus(); $("q").select(); }
    if (e.key === "Escape") { $("q").value = ""; render(); }
  });
  $("copyAll").addEventListener("click", async () => {
    const t = $("log").textContent.trim();
    try { await navigator.clipboard.writeText(t); status("📋 Copied the transcript (" + t.split("\n").filter(Boolean).length + " lines)."); }
    catch (e) { status("⚠️ Copy failed: " + e.message); }
  });
  $("saveTxt").addEventListener("click", () => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([$("log").textContent], { type: "text/plain;charset=utf-8" }));
    a.download = "call-transcript-" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "") + ".txt";
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $("sumBtn").addEventListener("click", async () => {
    const t = $("log").textContent.trim(); if (!t) { status("ℹ️ The transcript is empty."); return; }
    if (!confirm("Send the whole transcript text to the AI to write a summary?")) return;
    $("summary").textContent = "⏳ Summarising…";
    try { $("summary").textContent = (await api("/api/summary", { transcript: t })).text; }
    catch (e) { $("summary").textContent = "⚠️ " + e.message; }
  });
  $("newSess").addEventListener("click", () => {
    if (!confirm("Clear the transcript on this page and start a new session?")) return;
    $("log").textContent = ""; $("summary").textContent = ""; $("draft").innerHTML = "";
    try { localStorage.removeItem(TX_KEY); } catch {}
    finals.length = 0; interim = ""; trFinals = []; trInterim = ""; feedEmitted = []; feedLastCap = ""; cur = null; update(); renderTr();
    status("🧹 New session.");
  });
  render();

  try {
    tickWorker = new Worker(URL.createObjectURL(new Blob(["onmessage=e=>setTimeout(()=>postMessage(0),e.data)"], { type: "text/javascript" })));
    tickWorker.onmessage = () => pollFeed();
    tickWorker.onerror = () => { tickWorker = null; setTimeout(pollFeed, 400); };
  } catch { tickWorker = null; }
  // The Live Captions relay only exists on Windows; ?feed forces polling elsewhere.
  if (/Windows/.test(navigator.userAgent) || new URLSearchParams(location.search).has("feed")) pollFeed();
  if (new URLSearchParams(location.search).has("demo")) playDemo();
}
boot();
