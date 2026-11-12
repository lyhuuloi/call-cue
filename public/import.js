// call-cue: turn a document into answer cards. Everything here runs in the browser (the
// local server and the tests load the same file); nothing in it talks to the network.
"use strict";
(() => {
const STOPWORDS = new Set(("a an the and or but if then so of to in on at by for with from into about as is are was were be been being " +
  "do does did have has had can could will would should may might must shall not no yes we you your our us they them their it its " +
  "this that these those there here what which who whom when where why how any all each some more most other than too very just " +
  "also only own same such both few per via etc get got use used using make made need needs").split(" "));
const STATUS = new Set(["ok", "gap", "ask", "info"]);
const str = (v) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim() : "");
const words = (s) => (String(s).toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
const uniq = (a) => [...new Set(a)];
const sentences = (s) => String(s).split(/(?<=[.?!])\s+(?=[A-Z0-9"“(])/).map((x) => x.trim()).filter(Boolean);
const tidy = (l) => l.replace(/^\s*(?:[-*•–]\s+|\d{1,3}[.)]\s+)/, "").replace(/\*\*|__/g, "").trim();

// ---------- text -> sections -> cards (no AI) ----------
// A section starts at a markdown heading, a "Q:" line, or a short line ending in "?".
function sections(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = []; let cur = null, topic = "";
  const start = (title, heading) => { if (cur && cur.heading && !cur.body.length) { topic = cur.title; out.pop(); } cur = { title, topic, heading, body: [] }; out.push(cur); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim(); let m;
    if ((m = /^#{1,6}\s+(.+?)\s*#*$/.exec(l))) { start(tidy(m[1]), true); continue; }
    if ((m = /^\*\*(.{3,120}?)\*\*:?$/.exec(l))) { start(tidy(m[1]), true); continue; }
    if ((m = /^(?:q|question)\s*(?::|\.\s)\s*(.+)$/i.exec(l))) { start(tidy(m[1]), false); continue; }
    if (cur && (m = /^(?:a|answer)\s*(?::|\.\s)\s*(.*)$/i.exec(l))) { if (m[1]) cur.body.push(m[1]); continue; }
    const t = tidy(l);
    if (/\?$/.test(t) && t.length <= 160 && t.split(/\s+/).length >= 2) { start(t, false); continue; }
    // A short line standing alone, without end punctuation, is a heading too (Word files
    // and PDFs often carry no heading marks). Not right after a question: that is its answer.
    const alone = l && !(lines[i - 1] || "").trim() && !(lines[i + 1] || "").trim();
    if (alone && t === l && l.length <= 60 && l.split(/\s+/).length <= 7 && /^[A-Z0-9]/.test(l) && !/[.?!:;,]$/.test(l) && (!cur || cur.body.length || cur.heading)) { start(l, true); continue; }
    if (cur && l) cur.body.push(l);
  }
  return out.filter((s) => s.body.length);
}
// Fallback when the text has no headings or questions: one card per paragraph.
function paragraphs(text) {
  return String(text).replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 40).map((p) => {
    const lines = p.split("\n"), first = sentences(lines.join(" "))[0] || lines[0];
    const short = lines.length > 1 && lines[0].length <= 90 && !/[.!]$/.test(lines[0]);
    return { title: tidy(short ? lines[0] : first).slice(0, 110), topic: "", body: short ? lines.slice(1) : [p] };
  }).filter((s) => s.body.join(" ").trim());
}
function sayAndFacts(body) {
  const facts = [], prose = [];
  for (const l of body) (/^\s*(?:[-*•–]\s+|\d{1,3}[.)]\s+)/.test(l) ? facts : prose).push(tidy(l));
  const ss = sentences(prose.join(" "));
  let say = "", i = 0;
  for (; i < ss.length && i < 3; i++) { if (say && say.length + ss[i].length > 320) break; say += (say ? " " : "") + ss[i]; }
  if (!say && facts.length) say = facts.shift();
  return { say: say ? [say.slice(0, 600)] : [], facts: ss.slice(i).concat(facts).map((f) => f.slice(0, 220)).slice(0, 6) };
}
const keywordsFor = (title, body) => uniq(words(title).concat(words(body))).slice(0, 12).join(" ");
function textToCards(text) {
  let secs = sections(text);
  if (!secs.length) secs = paragraphs(text);
  return secs.map((s) => {
    const { say, facts } = sayAndFacts(s.body);
    return { title: s.title, topic: s.topic.slice(0, 28), status: "info", say, facts, keywords: keywordsFor(s.title, say.join(" ")) };
  });
}

// ---------- triggers for the offline keyword matcher ----------
// A word that only one card's title has is enough by itself (weight 3); shared title
// words need a second hit (2); other keywords only add (1). The page shows a card at 2.5.
const stemOf = (w) => (w.length >= 5 ? w.replace(/(?:ies|es|s)$/, "") + "*" : w);
function buildTriggers(cards) {
  const df = {};
  for (const c of cards) for (const w of uniq(words(c.title))) df[w] = (df[w] || 0) + 1;
  for (const c of cards) {
    if (Array.isArray(c.triggers) && c.triggers.length) continue;
    const tw = uniq(words(c.title)), seen = new Set(), t = [];
    const add = (w, weight) => { const p = stemOf(w); if (!seen.has(p)) { seen.add(p); t.push([p, weight]); } };
    for (const w of tw) add(w, df[w] === 1 ? 3 : 2);
    for (const w of words(c.keywords).slice(0, 10)) add(w, 1);
    c.triggers = t.slice(0, 16);
  }
  return cards;
}
const validTriggers = (t) => (Array.isArray(t) ? t.filter((x) => Array.isArray(x) && typeof x[0] === "string" && x[0].trim() && Number.isFinite(Number(x[1]))).map((x) => [x[0].toLowerCase().trim().slice(0, 60), Number(x[1])]).slice(0, 24) : []);

// ---------- any card-shaped input -> cards the knowledge base accepts ----------
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => !STOPWORDS.has(w)).slice(0, 4).join("-").slice(0, 34);
function finishCards(raw, taken = []) {
  const ids = new Set(taken); ids.add("none");
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== "object") continue;
    const title = str(r.title).slice(0, 160);
    const say = (Array.isArray(r.say) ? r.say : [r.say]).map(str).filter(Boolean).map((s) => s.slice(0, 600)).slice(0, 4);
    if (!title || !say.length) continue;
    const base = (/^[a-z0-9_-]{1,34}$/i.test(r.id || "") ? r.id : slug(title)) || "card";
    let id = base, n = 2; while (ids.has(id)) id = base + "-" + n++;
    ids.add(id);
    const facts = (Array.isArray(r.facts) ? r.facts : []).map(str).filter(Boolean).map((f) => f.slice(0, 300)).slice(0, 8);
    const keywords = (Array.isArray(r.keywords) ? r.keywords.map(str).join(" ") : str(r.keywords)).toLowerCase().slice(0, 300) || keywordsFor(title, say.join(" "));
    out.push({ id, status: STATUS.has(r.status) ? r.status : "info", topic: str(r.topic).slice(0, 30), title, say, facts, note: str(r.note).slice(0, 300), keywords, triggers: validTriggers(r.triggers) });
  }
  return buildTriggers(out);
}

// The model was asked for {"cards":[...]}; accept an array too, and a reply cut off mid-card.
function parseAiCards(text) {
  const t = String(text).replace(/```(?:json)?/gi, "");
  const a = t.search(/[[{]/); if (a < 0) return [];
  const body = t.slice(a);
  const pick = (o) => (Array.isArray(o) ? o : Array.isArray(o?.cards) ? o.cards : []);
  try { return pick(JSON.parse(body.slice(0, Math.max(body.lastIndexOf("}"), body.lastIndexOf("]")) + 1))); } catch { /* try a repair */ }
  for (let end = body.lastIndexOf("}"); end > 0; end = body.lastIndexOf("}", end - 1)) {
    for (const tail of ["]}", "]"]) { try { return pick(JSON.parse(body.slice(0, end + 1) + tail)); } catch { /* shorter */ } }
  }
  return [];
}

function chunkText(text, max = 20000) {
  const out = []; let cur = "";
  for (const p of String(text).split(/\n\s*\n/)) {
    if (cur && cur.length + p.length + 2 > max) { out.push(cur); cur = ""; }
    if (p.length > max) { for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max)); continue; }
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// add: keep everything, append the cards. replace: keep the settings, swap the cards.
// fresh: the current knowledge base is the bundled example, so drop its fictional extras.
function mergeKb(current, { mode, cards, title, fresh }) {
  const base = {}; for (const k in current) if (!["ai", "source", "file"].includes(k)) base[k] = current[k];
  if (mode !== "replace") return { ...base, cards: (base.cards || []).concat(cards) };
  if (!fresh) return { ...base, ...(title ? { title } : {}), cards };
  return { title: title || "My knowledge base", subtitle: "", captionLang: base.captionLang || "en-US", translateTo: base.translateTo || "vi",
    fallback: base.fallback || "Let me check that and confirm in writing.", cards, lifelines: base.lifelines || [], dontSay: [], stats: [] };
}

// ---------- files -> text (browser only) ----------
function csvRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === "," || ch === "\t" || ch === ";") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
// First column = question, second = answer; a header row naming them is skipped.
function csvToText(text) {
  const rows = csvRows(text);
  if (rows.length && /^(q|question|title|topic)s?$/i.test(rows[0][0].trim())) rows.shift();
  return rows.filter((r) => r.length >= 2 && r[0].trim() && r[1].trim()).map((r) => "Q: " + r[0].trim().replace(/\s+/g, " ") + "\nA: " + r.slice(1).map((c) => c.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ")).join("\n\n");
}
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,nav,footer,header,svg").forEach((n) => n.remove());
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|LI|TR|BR|UL|OL|TABLE|DT|DD|BLOCKQUOTE|H[1-6]|SUMMARY|DETAILS)$/;
  let out = "";
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { out += c.nodeValue.replace(/\s+/g, " "); continue; }
      if (c.nodeType !== 1) continue;
      const b = BLOCK.test(c.tagName);
      if (b) out += "\n";
      if (/^H[1-6]$/.test(c.tagName) || c.tagName === "SUMMARY" || c.tagName === "DT") out += "# ";
      if (c.tagName === "LI") out += "- ";
      walk(c);
      if (b) out += "\n";
    }
  })(doc.body);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function unzipEntry(buf, name) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), td = new TextDecoder();
  let e = buf.byteLength - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("this is not a .docx file");
  let p = dv.getUint32(e + 16, true);
  for (let i = dv.getUint16(e + 10, true); i > 0 && dv.getUint32(p, true) === 0x02014b50; i--) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    if (td.decode(u8.subarray(p + 46, p + 46 + nl)) === name) {
      const from = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), data = u8.subarray(from, from + size);
      if (method === 0) return td.decode(data);
      if (method !== 8) throw new Error("this .docx uses a compression call-cue cannot read");
      return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error("this is not a Word .docx file");
}
async function docxToText(buf) {
  const xml = new DOMParser().parseFromString(await unzipEntry(buf, "word/document.xml"), "application/xml");
  const lines = [];
  for (const p of xml.getElementsByTagName("w:p")) {
    let t = "";
    for (const n of p.getElementsByTagName("*")) {
      if (n.tagName === "w:t") t += n.textContent; else if (n.tagName === "w:tab") t += " "; else if (n.tagName === "w:br") t += "\n";
    }
    t = t.trim();
    const style = p.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val") || "";
    if (!t) { lines.push(""); continue; }
    lines.push(/^(heading|title)/i.test(style) ? "# " + t : p.getElementsByTagName("w:numPr").length ? "- " + t : t, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// pdf.js (vendored in ./vendor, Apache-2.0) reads the PDF in this browser. Lines set in
// clearly larger type than the body become headings.
let pdfjs = null;
async function pdfToText(buf) {
  if (!pdfjs) {
    pdfjs = await import(new URL("vendor/pdf.min.mjs", document.baseURI).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", document.baseURI).href;
  }
  const task = pdfjs.getDocument({ data: buf }), pdf = await task.promise;
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    let text = "", h = 0, y = null;
    const flush = () => { if (text.trim()) lines.push({ text: text.replace(/\s+/g, " ").trim(), h }); text = ""; h = 0; };
    for (const it of tc.items) {
      if (typeof it.str !== "string") continue;
      const iy = it.transform ? it.transform[5] : null;
      if (y !== null && iy !== null && Math.abs(iy - y) > Math.max(2, (it.height || 10) * 0.6) && text) flush();
      text += it.str; if (it.str.trim()) { h = Math.max(h, it.height || 0); y = iy; }
      if (it.hasEOL) flush();
    }
    flush();
  }
  try { await task.destroy(); } catch { /* already released */ }
  if (!lines.length) throw new Error("this PDF has no text layer (a scan?). Paste the text instead");
  const hs = lines.map((l) => l.h).filter(Boolean).sort((a, b) => a - b), body = hs[Math.floor(hs.length / 2)] || 0;
  let out = "", prevHead = 0;
  for (const l of lines) {
    const head = body > 0 && l.h >= body * 1.15 && l.text.length <= 120 ? l.h : 0;
    // Two heading lines of the same size are one wrapped heading.
    out += head ? (prevHead && Math.abs(prevHead - head) < 0.5 ? " " + l.text : "\n\n# " + l.text) : (prevHead ? "\n" : /^[-•*–]\s|^\d{1,3}[.)]\s/.test(l.text) || /[.?!:]$/.test(out) ? "\n" : " ") + l.text;
    prevHead = head;
  }
  return out.trim();
}
// -> { name, text } or { name, cards } (a call-cue JSON file already holds cards).
async function readFile(file) {
  const name = file.name, ext = (/\.([a-z0-9]+)$/i.exec(name) || [, ""])[1].toLowerCase();
  if (file.size > 30_000_000) throw new Error("larger than 30 MB");
  if (ext === "pdf") return { name, text: await pdfToText(await file.arrayBuffer()) };
  if (ext === "docx") return { name, text: await docxToText(await file.arrayBuffer()) };
  if (ext === "doc" || ext === "pages" || ext === "odt" || ext === "rtf") throw new Error("save it as .docx or PDF first");
  const text = await file.text();
  if (ext === "json") {
    let o; try { o = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
    const cards = Array.isArray(o) ? o : o?.cards;
    if (!Array.isArray(cards)) throw new Error("no \"cards\" list in this JSON");
    return { name, cards };
  }
  if (ext === "csv" || ext === "tsv") return { name, text: csvToText(text) };
  if (ext === "html" || ext === "htm") return { name, text: htmlToText(text) };
  if (/\u0000/.test(text.slice(0, 2000))) throw new Error("not a text file; use PDF, .docx, text, Markdown, HTML or CSV");
  return { name, text };
}

globalThis.CallCueImport = { textToCards, buildTriggers, finishCards, parseAiCards, chunkText, mergeKb, csvToText, htmlToText, docxToText, pdfToText, readFile, words };
})();
