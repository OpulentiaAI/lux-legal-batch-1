// Builds the research update PDF from article.md and data.json with takumi-pdf.
// Usage: node build.mjs [out.pdf]
// Fonts come from the Opulent design materials repo (NB International Pro, Geist Mono); set OPULENT_FONTS to override.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PdfRenderer } from "takumi-pdf";
import * as C from "./charts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = process.env.OPULENT_FONTS
  ?? path.resolve(HERE, "../../../opulent-slide-materials/regiment-partnership-deck/preview-app/public/fonts");
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "opulent-research-update-francois-bernard.pdf"));

const data = JSON.parse(await readFile(path.join(HERE, "data.json"), "utf8"));
const md = await readFile(path.join(HERE, "article.md"), "utf8");
const MARK = await readFile(path.join(HERE, "opulent-mark.svg"), "utf8");

// Page geometry (CSS px at 96 dpi). Takumi places header and footer bands 20px inside the page edge,
// so the bands are sized to meet the content box exactly and the rails run unbroken from band to band.
const PAGE_W = 793.7, PAGE_H = 1122.5, RAIL = 48, MT = 92, MB = 80, INSET = 20;
const HEAD_H = MT - INSET, FOOT_H = MB - INSET, RAIL_R = 744;

const { INK, ink, BLUE, LINE, PAGE } = C;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

const css = `
.doc { display: flex; flex-direction: column; padding: 0 44px; font-family: NB; color: ${INK}; }
.row { display: flex; flex-direction: row; }
.lab { width: 104px; flex-shrink: 0; margin-right: 24px; font-family: 'Geist Mono'; font-size: 8.5px; letter-spacing: 0.06em; color: ${ink(0.4)}; }
.col { display: flex; flex-direction: column; width: 481px; }
.p { font-size: 12.8px; line-height: 20.5px; color: ${ink(0.9)}; margin: 0 0 12px 0; }
.lead { font-size: 17px; line-height: 26px; font-weight: 300; color: ${INK}; letter-spacing: -0.005em; }
.h2wrap { display: flex; flex-direction: column; margin-top: 26px; }
.rule { position: relative; display: flex; height: 1px; margin: 0 -44px; background: ${LINE}; }
.sq { position: absolute; top: -4px; width: 8px; height: 8px; border: 1px solid ${ink(0.22)}; background: ${PAGE}; }
.h2 { font-size: 24px; line-height: 30px; font-weight: 300; letter-spacing: -0.015em; margin: 0; }
.h2 .grey { color: ${ink(0.4)}; }
.h3 { font-size: 14px; line-height: 20px; font-weight: 500; margin: 6px 0 6px 0; }
h1 { margin: 0; font-weight: 300; }
.li { display: flex; flex-direction: row; margin: 0 0 8px 0; }
.num { width: 22px; flex-shrink: 0; font-family: 'Geist Mono'; font-size: 10px; line-height: 20.5px; color: ${ink(0.45)}; }
.fig { display: flex; flex-direction: column; padding: 8px 0 20px 0; break-inside: avoid; }
.card { position: relative; display: flex; flex-direction: column; background: #fff; border-radius: 10px; padding: 18px 24px 16px 24px; break-inside: avoid;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.04), 0 6px 20px rgba(0,0,0,0.045); }
.handle { position: absolute; width: 6px; height: 6px; border: 1px solid ${ink(0.2)}; background: ${PAGE}; }
.fighead { display: flex; flex-direction: row; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.figtitle { font-size: 13px; line-height: 18px; font-weight: 500; }
.mono { font-family: 'Geist Mono'; font-size: 8px; letter-spacing: 0.08em; color: ${ink(0.42)}; }
.legend { display: flex; flex-direction: row; flex-wrap: wrap; margin-top: 10px; }
.lg { display: flex; flex-direction: row; align-items: center; margin-right: 16px; font-size: 9.5px; color: ${ink(0.6)}; }
.lg svg { margin-right: 6px; }
.cap { font-size: 10.5px; line-height: 16px; color: ${ink(0.62)}; margin-top: 10px; }
.src { font-family: 'Geist Mono'; font-size: 7.5px; letter-spacing: 0.07em; color: ${ink(0.4)}; margin-top: 6px; }
.pill { font-family: 'Geist Mono'; font-size: 7.5px; letter-spacing: 0.06em; color: ${ink(0.55)}; border: 1px solid ${ink(0.14)}; border-radius: 9px; padding: 2px 7px; }
table { width: 100%; border-collapse: collapse; }
th { font-family: 'Geist Mono'; font-size: 7.5px; letter-spacing: 0.07em; font-weight: 400; color: ${ink(0.45)}; text-align: left; padding: 0 8px 7px 0; border-bottom: 1px solid ${ink(0.2)}; }
td { font-size: 10.5px; line-height: 15px; color: ${ink(0.9)}; padding: 7px 8px 7px 0; border-bottom: 1px solid ${LINE}; vertical-align: top; }
td.m { font-family: 'Geist Mono'; font-size: 9.5px; }
tr.total td { border-bottom: none; border-top: 1px solid ${ink(0.2)}; font-weight: 500; }
`;

// ---------- page frame ----------
const sqAt = (x, y, s = 8) => `<div style="position:absolute;left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;border:1px solid ${ink(0.22)};background:${PAGE}"></div>`;
const vrail = (x, h) => `<div style="position:absolute;left:${x}px;top:0;width:1px;height:${h}px;background:${LINE}"></div>`;
const hline = (y) => `<div style="position:absolute;left:0;top:${y}px;width:${PAGE_W}px;height:1px;background:${LINE}"></div>`;
const markSvg = (h) => MARK.replace("<svg ", `<svg height="${h}" width="${(h * 21) / 24}" `).replace(/fill="#000"/g, `fill="${INK}"`);

const header = `<div style="position:relative;display:flex;width:${PAGE_W}px;height:${HEAD_H}px">
  ${vrail(RAIL, HEAD_H)}${vrail(RAIL_R, HEAD_H)}${hline(36)}${sqAt(RAIL + 0.5, 36.5)}${sqAt(RAIL_R + 0.5, 36.5)}
  <div style="position:absolute;left:${RAIL + 16}px;top:10px;display:flex;flex-direction:row;align-items:center">
    ${markSvg(13)}<span style="margin-left:7px;font-family:NB;font-size:11px;color:${INK}">Opulent AI</span></div>
  <div style="position:absolute;right:${PAGE_W - RAIL_R + 16}px;top:13px;font-family:'Geist Mono';font-size:7.5px;letter-spacing:0.08em;color:${ink(0.42)}">RESEARCH UPDATE  ·  30 SEPTEMBER 2026</div>
</div>`;
const footer = `<div style="position:relative;display:flex;width:${PAGE_W}px;height:${FOOT_H}px">
  ${vrail(RAIL, FOOT_H)}${vrail(RAIL_R, FOOT_H)}${hline(16)}${sqAt(RAIL + 0.5, 16.5)}${sqAt(RAIL_R + 0.5, 16.5)}
  <div style="position:absolute;left:${RAIL + 16}px;top:27px;font-family:'Geist Mono';font-size:7.5px;letter-spacing:0.08em;color:${ink(0.42)}">PREPARED FOR FRANÇOIS BERNARD</div>
  <div style="position:absolute;left:0;top:27px;width:${PAGE_W}px;display:flex;justify-content:center;font-family:'Geist Mono';font-size:7.5px;letter-spacing:0.08em;color:${ink(0.42)}">OPULENT AI RESEARCH</div>
  <div style="position:absolute;right:${PAGE_W - RAIL_R + 16}px;top:27px;font-family:'Geist Mono';font-size:7.5px;letter-spacing:0.08em;color:${INK}">[ <span class="pageNumber decimal-leading-zero"></span> ]</div>
</div>`;
const rails = `<div style="position:fixed;left:0;top:0;width:1px;height:100%;background:${LINE}"></div><div style="position:fixed;right:0;top:0;width:1px;height:100%;background:${LINE}"></div>`;

// ---------- blocks ----------
const sectionRule = `<div class="rule"><div class="sq" style="left:-4px"></div><div class="sq" style="right:-5px"></div></div>`;
const para = (s) => `<div class="row"><div class="lab"></div><div class="col"><p class="p">${inline(s)}</p></div></div>`;
const list = (items) => `<div class="row"><div class="lab"></div><div class="col" style="margin-bottom:6px">${items.map((it, i) =>
  `<div class="li"><div class="num">${String(i + 1).padStart(2, "0")}</div><p class="p" style="margin:0;width:459px">${inline(it)}</p></div>`).join("")}</div></div>`;
const h2 = (title, idx) => `<div class="h2wrap">${sectionRule}<div class="row" style="margin:22px 0 14px 0;align-items:baseline">
  <div class="lab">[ ${String(idx).padStart(2, "0")} ]</div><div class="col"><h2 class="h2">${inline(title)}</h2></div></div></div>`;
const h3 = (title, idx) => `<div class="row" style="margin-top:8px;align-items:baseline"><div class="lab">${idx}</div><div class="col"><h3 class="h3">${inline(title)}</h3></div></div></div>`;

const handles = ["left:-4px;top:-4px", "right:-4px;top:-4px", "left:-4px;bottom:-4px", "right:-4px;bottom:-4px"]
  .map((p) => `<div class="handle" style="${p}"></div>`).join("");
const legend = (items) => `<div class="legend">${items.map(([k, label]) => `<div class="lg">${C.swatch(k)}<span>${esc(label)}</span></div>`).join("")}</div>`;
const panelLabel = (s, color) => `<div class="mono" style="margin-bottom:6px${color ? `;color:${color}` : ""}">${esc(s)}</div>`;

let figN = 0, tabN = 0;
function figure({ title, body, legendItems, caption, source, pill }) {
  figN += 1;
  return `<div class="fig"><div class="card">${handles}
    <div class="fighead"><div class="figtitle">${esc(title)}</div><div class="mono">${pill ? `<span class="pill">${esc(pill)}</span>` : `FIGURE ${figN}`}</div></div>
    ${body}${legendItems ? legend(legendItems) : ""}</div>
    <div class="cap"><b style="font-weight:500;color:${INK}">Figure ${figN}.</b> ${inline(caption)}</div>
    <div class="src">SOURCE  ·  ${esc(source.toUpperCase())}</div></div>`;
}
function table({ title, head, rows, total, source, widths }) {
  tabN += 1;
  const cols = widths ? `<colgroup>${widths.map((w) => `<col style="width:${w}">`).join("")}</colgroup>` : "";
  const tr = (r, cls = "") => `<tr class="${cls}">${r.map((c, i) => `<td class="${typeof c === "object" ? c.cls : ""}">${inline(typeof c === "object" ? c.v : c)}</td>`).join("")}</tr>`;
  return `<div class="fig"><div class="row" style="margin-bottom:10px;align-items:baseline"><div class="lab">TABLE ${tabN}</div><div class="figtitle">${esc(title)}</div></div>
    <table>${cols}<thead><tr>${head.map((h) => `<th>${esc(h.toUpperCase())}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => tr(r)).join("")}${total ? tr(total, "total") : ""}</tbody></table>
    <div class="src" style="margin-top:8px">SOURCE  ·  ${esc(source.toUpperCase())}</div></div>`;
}

const FIGURES = {
  results: () => figure({
    title: "Held-out completion, and the earlier paired run",
    body: `<div class="row">
      <div style="display:flex;flex-direction:column;width:330px">${panelLabel("GLM-5.3 IN BOTH HARNESSES  ·  COMPLETION, %")}${C.resultsCompletion(data)}</div>
      <div style="width:1px;background:${LINE};margin:0 12px"></div>
      <div style="display:flex;flex-direction:column;width:206px">${panelLabel("DEEPSEEK V4.1 FLASH  ·  250 STEPS")}${C.resultsEarlier(data)}</div></div>`,
    legendItems: [[C.INK, "Opulent, naive harness"], ["hatch", "Harvey LAB harness, at its upper bound"], ["dot", "Opulent"], ["hollow", "Harvey LAB"]],
    caption: "Left: completion on the twelve held-out work products, with GLM-5.3 answering in both harnesses. Harvey's bar is drawn at its upper bound, 9.9 points below Opulent, and the lower scale zooms in on 80 to 100. Right: the earlier 250-step run on the same tasks with DeepSeek V4.1 Flash, as trimmed means of Jev scores normalized to 0 to 1.",
    source: "GLM-5.3 run, team-reported, artifacts pending commit  ·  eval/RLM-V5-COMPARISON-REPORT.md",
  }),
  corpus: () => figure({
    title: "Your nine works, as the agent sees them",
    body: C.corpus(data),
    legendItems: [[C.ink(0.2), "Passages"], [C.INK, "Passages tied to a statutory article"], [BLUE, "Your monograph"]],
    caption: "Passages per work, 8,809 in all. The darker segment marks the 1,814 passages tagged with a statutory article, concentrated in the 1915 law and the annotated code of listed companies. Works are credited by the names on their files.",
    source: "corpus/index/documents.csv  ·  corpus/index/chunks.jsonl",
  }),
  evals: () => figure({
    title: "Two evaluations built from the corpus",
    body: C.evals(data),
    legendItems: [["dots", "Largest kind"], ["hatch", "Development task"], [C.INK, "Held-out task"]],
    caption: "Top: the fifty development questions by kind, graded against 178 criteria. Bottom: the fifteen work-product tasks, each block sized by its criteria. The three development tasks are used for smoke tests and judge calibration; the twelve held-out tasks carry 83 of the 101 criteria.",
    source: "eval/gold.json  ·  eval/complex-v1/manifest.json  ·  eval/complex-v1/RUN-PLAN.md",
  }),
  retrieval: () => figure({
    title: "Retrieval on the development set",
    body: C.retrieval(data),
    legendItems: [[C.INK, "Right passage ranked first"], [C.ink(0.4), "Right passage in the top five"], [C.ink(0.14), "Right work in the top five"]],
    caption: "Questions out of 50 for each retrieval mode, with mean reciprocal rank (MRR) and median latency (p50). Hybrid search with reranking leads on every quality measure, at the cost of about three quarters of a second of latency over keyword search.",
    source: "README.md  ·  eval/results.json",
  }),
  judge: () => figure({
    title: "A System 1 judge beside the reasoning judges",
    body: `<div class="row">
      <div style="display:flex;flex-direction:column;width:348px">${panelLabel("OUTPUT TOKENS PER JUDGMENT")}${C.judge(data)}</div>
      <div style="width:1px;background:${LINE};margin:0 18px"></div>
      <div style="display:flex;flex-direction:column;width:160px"><div class="row" style="justify-content:space-between;margin-bottom:6px"><div class="mono">A JEV VERDICT</div><span class="pill">EXAMPLE</span></div>
        ${C.jevShape()}<div style="font-size:9.5px;line-height:14px;color:${ink(0.6)};margin-top:8px">A score, with a probability for each level, so every verdict says how sure it is.</div></div></div>`,
    caption: "Left: output tokens per judgment, on a log scale. The reasoning judge's figure is one smoke test on a single answer, which exhausted its 16,000-token budget; Jev's is the mean over the 24 attempts of the 250-step run (1,224 tokens in all). Right: the shape of a Jev verdict, drawn for illustration without values.",
    source: "eval/README.md  ·  eval/RLM-V5-COMPARISON-REPORT.md",
  }),
  harness: () => figure({
    title: "One harness rule, twenty points",
    body: C.harness(data),
    legendItems: [["hatch", "Agent before the rule"], [C.INK, "Agent after the rule"], [C.ink(0.16), "Other answering modes"]],
    caption: "Share of the 178 development criteria passed by each answering mode. In its first run the agent pinned filters that matched nothing and concluded the evidence was insufficient. After one rule was added to the harness, to retry such a search without its filter, it passed 93.8 percent of criteria, above the fixed pipelines, and degraded runs fell from 18 to zero.",
    source: "README.md  ·  eval/compose-agent-baseline.json  ·  eval/compose-agent.json",
  }),
  setup: () => {
    const rows = [
      ["Agent loop", "LAB's own loop, adapter and prompts", "A control plane with records and approvals"],
      ["Tools", "Six: bash, read, write, edit, glob, grep", "Opulent's surface, 97 tools in the catalog"],
      ["Corpus access", "Exported passages, read as files", "Search, passage and inventory tools over MCP"],
      ["Sandboxes", "E2B, in place of its Podman backend", "E2B, one sandbox per agent"],
      ["Delegation", "A single agent", "Sub-agents from a persistent Python session"],
    ];
    const cell = (s, strong) => `<div style="flex:1;padding:7px 14px 7px 0;font-size:10.5px;line-height:15px;color:${strong ? INK : ink(0.75)}">${esc(s)}</div>`;
    const body = `<div style="display:flex;flex-direction:column">
      <div class="row" style="border-bottom:1px solid ${ink(0.2)};padding-bottom:7px">
        <div style="width:110px" class="mono"></div><div style="flex:1" class="mono">[ A ]  HARVEY LAB HARNESS</div><div style="flex:1;color:${INK}" class="mono">[ B ]  OPULENT, NAIVE HARNESS</div></div>
      ${rows.map(([k, a, b]) => `<div class="row" style="border-bottom:1px solid ${LINE}"><div style="width:110px;padding:7px 0;font-size:10.5px;line-height:15px;color:${ink(0.5)}">${esc(k)}</div>${cell(a)}${cell(b, true)}</div>`).join("")}
      <div class="row" style="margin-top:12px;align-items:center;background:${ink(0.035)};border-radius:6px;padding:9px 12px">
        <div class="mono" style="width:98px;color:${BLUE}">HELD EQUAL</div>
        <div style="font-size:10.5px;line-height:15px;color:${INK}">The model, the task files, the 8,809 passages, the step and token budgets, and the evidence rules</div></div></div>`;
    return figure({
      title: "The two harnesses, on the same terms",
      body,
      caption: "What differs between the two arms, and what is held equal. We compare configured systems, so retrieval, prompts and tools differ along with the harness. The Harvey arm is Harvey's public LAB harness at a pinned commit.",
      source: "eval/HARVEY-COMPARISON.md  ·  runtime/README.md  ·  eval/complex-v1/RUN-PLAN.md",
    });
  },
};

const TABLES = {
  heldout: () => {
    const ho = data.workProduct.tasks.filter((t) => !t.dev);
    return table({
      title: "The twelve held-out work products",
      head: ["Task", "Work product", "Criteria"],
      widths: ["12%", "76%", "12%"],
      rows: ho.map((t) => [{ v: t.n, cls: "m" }, t.title, { v: String(t.criteria), cls: "m" }]),
      total: ["", "Held-out set", { v: String(ho.reduce((s, t) => s + t.criteria, 0)), cls: "m" }],
      source: "eval/complex-v1/manifest.json",
    });
  },
  retrieval: () => table({
    title: "Retrieval modes on the development set",
    head: ["Mode", "Evidence @1", "Evidence @5", "Document @5", "MRR", "p50"],
    widths: ["30%", "14%", "14%", "15%", "12%", "15%"],
    rows: data.retrieval.modes.map((m) => [m.mode, ...[m.ev1, m.ev5, m.doc5].map((v) => ({ v: `${v} / 50`, cls: "m" })), { v: m.mrr.toFixed(3), cls: "m" }, { v: m.p50, cls: "m" }]),
    source: "README.md  ·  eval/results.json",
  }),
  runs: () => table({
    title: "The principal paired runs, Opulent against Harvey's LAB harness",
    head: ["Run", "Evaluation", "Answering model", "Opulent", "Harvey LAB"],
    widths: ["17%", "20%", "17%", "23%", "23%"],
    rows: data.runs.rows.map((r) => [r.run, r.set, r.model, r.opulent, r.harvey]),
    source: data.runs.source.replace(/, /g, "  ·  "),
  }),
};

// ---------- markdown to blocks ----------
function parse(src) {
  const lines = src.split("\n");
  const blocks = [];
  let buf = [], items = null;
  const flush = () => {
    if (buf.length) blocks.push({ t: "p", s: buf.join(" ") });
    if (items) blocks.push({ t: "ol", items });
    buf = []; items = null;
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if (!l.trim()) { flush(); continue; }
    if ((m = l.match(/^(#{1,3}) (.*)$/))) { flush(); blocks.push({ t: `h${m[1].length}`, s: m[2] }); continue; }
    if ((m = l.match(/^\[\[(figure|table):(\w+)\]\]$/))) { flush(); blocks.push({ t: m[1], k: m[2] }); continue; }
    if ((m = l.match(/^\d+\. (.*)$/))) { if (buf.length) { blocks.push({ t: "p", s: buf.join(" ") }); buf = []; } (items ??= []).push(m[1]); continue; }
    if (items) items[items.length - 1] += " " + l.trim(); else buf.push(l.trim());
  }
  flush();
  return blocks;
}

function cover(title, meta, lead) {
  const [grey, inkTitle] = title.split(": ");
  const cells = [
    { label: "HELD-OUT COMPLETION", pre: "", num: `${data.glm53.opulentCompletion}%`, cap: "GLM-5.3, naive Opulent harness" },
    { label: "LEAD OVER HARVEY LAB", pre: "at least", num: `${data.glm53.minMargin}`, unit: "pts", cap: "On every metric we report" },
    { label: "YOUR NINE WORKS", pre: "", num: data.corpus.totalChunks.toLocaleString("en-US"), cap: "Cited passages, each traceable", accent: true },
    { label: "HELD-OUT TASKS", pre: "", num: "12", cap: "Client work products, graded on source text" },
  ];
  const cw = 609.7 / 4;
  const band = `<div style="position:relative;display:flex;flex-direction:column;margin:34px 0 8px 0">
    ${sectionRule}
    <div class="row" style="position:relative">
      ${cells.map((c, i) => `<div style="display:flex;flex-direction:column;width:${cw}px;padding:18px ${i === 3 ? 0 : 14}px 20px ${i === 0 ? 0 : 16}px;${i ? `border-left:1px solid ${C.LINE2}` : ""}">
        <div class="mono" style="${c.accent ? `color:${BLUE}` : ""}">${esc(c.label)}</div>
        <div class="row" style="align-items:baseline;margin-top:14px">${c.pre ? `<span style="font-size:11px;color:${ink(0.42)};margin-right:5px">${c.pre}</span>` : ""}<span style="font-size:40px;line-height:42px;font-weight:300;letter-spacing:-0.035em">${esc(c.num)}</span>${c.unit ? `<span style="font-size:14px;color:${ink(0.56)};margin-left:4px">${c.unit}</span>` : ""}</div>
        <div style="font-size:10.5px;line-height:15px;color:${ink(0.56)};margin-top:8px">${esc(c.cap)}</div></div>`).join("")}
      ${[1, 2, 3].map((i) => `<div class="sq" style="left:${cw * i - 4.5}px;top:-5px"></div>`).join("")}
    </div>
    <div class="rule">${[0, 1, 2, 3, 4].map((i) => `<div class="sq" style="left:${i === 0 ? -4 : i === 4 ? 44 + 609.7 + 44 - 5 : 44 + cw * i - 4.5}px"></div>`).join("")}</div></div>`;
  const dotField = `<svg width="610" height="92" viewBox="0 0 610 92"><defs><pattern id="cv" width="13" height="13" patternUnits="userSpaceOnUse"><circle cx="6.5" cy="6.5" r="0.75" fill="rgba(0,0,0,0.16)"/></pattern></defs><rect width="610" height="92" fill="url(#cv)"/>
    <rect x="468" y="12" width="142" height="80" fill="${PAGE}"/><text x="610" y="30" font-family="Geist Mono" font-size="8" letter-spacing="0.6" fill="${ink(0.42)}" text-anchor="end">9 WORKS  ·  8,809 PASSAGES</text>
    <text x="610" y="44" font-family="Geist Mono" font-size="8" letter-spacing="0.6" fill="${ink(0.42)}" text-anchor="end">15 TASKS  ·  101 CRITERIA</text></svg>`;
  return `<div style="display:flex;flex-direction:column;margin-top:26px">
    <div class="row" style="justify-content:space-between"><div class="mono">[ RESEARCH UPDATE ]</div><div class="mono">LUXEMBOURG COMPANY LAW  ·  BATCH 1</div></div>
    <div style="display:flex;height:92px;margin-top:18px">${dotField}</div>
    <h1 style="display:flex;flex-direction:column;margin-top:30px;font-size:46px;line-height:49px;font-weight:300;letter-spacing:-0.03em">
      <span style="color:${ink(0.4)}">${esc(grey)}:&#160;</span><span style="width:560px">${esc(inkTitle)}</span></h1>
    <div class="row" style="margin-top:28px"><div class="lab" style="padding-top:6px">SUMMARY</div><div class="col"><p class="lead" style="margin:0">${inline(lead)}</p></div></div>
    <div class="row" style="margin-top:18px"><div class="lab"></div><div class="col"><div class="mono" style="font-size:8px;line-height:13px">${esc(meta.toUpperCase().replace(/ · /g, "  ·  "))}</div></div></div>
    ${band}</div>`;
}

// Units are the paginator's atoms: text splits across pages, headings keep with what follows,
// floats (figures and tables) never split and may be deferred to the top of the next page.
function units(blocks) {
  const out = [];
  let h2i = 0, h3i = 0, i = 0;
  const title = blocks[i++].s, meta = blocks[i++].s, lead = blocks[i++].s;
  out.push({ kind: "block", html: () => cover(title, meta, lead) + `<div style="height:22px"></div>` });
  for (; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t === "h2") {
      h2i += 1; h3i = 0;
      const n = h2i;
      out.push({ kind: "heading", level: 2, html: () => h2(b.s, n) });
    } else if (b.t === "h3") {
      h3i += 1;
      const idx = `${String(h2i).padStart(2, "0")}.${h3i}`;
      out.push({ kind: "heading", level: 3, html: () => h3(b.s, idx) });
    } else if (b.t === "p") out.push({ kind: "text", html: () => para(b.s) });
    else if (b.t === "ol") out.push({ kind: "text", html: () => list(b.items) });
    else if (b.t === "figure") out.push({ kind: "float", html: () => FIGURES[b.k]() });
    else if (b.t === "table") out.push({ kind: "float", html: () => TABLES[b.k]() });
    else throw new Error(`unknown block ${b.t}`);
  }
  return out;
}

const CONTENT_H = PAGE_H - MT - MB, LINE_H = 20.5, MIN_LINES = 3, DEFER_MIN = 110;

// Simulates the pages from measured heights and returns the units in reading order, with deferred
// floats moved to the top of the next page and forced breaks where a heading would be stranded.
function paginate(us) {
  const order = [];
  let y = 0, deferred = [];
  const place = (u) => { order.push(u); y += u.h; };
  // A float that does not fit is pushed to the next page by break-inside: avoid.
  const placeFloat = (u) => { if (y + u.h > CONTENT_H) y = 0; place(u); };
  const flush = (force) => {
    while (deferred.length) {
      const f = deferred[0];
      if (y + f.h <= CONTENT_H || force || f.waited >= 2) { deferred.shift(); placeFloat(f); continue; }
      break;
    }
  };
  for (let k = 0; k < us.length; k++) {
    const u = us[k];
    flush(u.kind === "heading" && u.level === 2);
    if (u.kind === "heading" && u.level === 2 && u.page) { if (order.length) { u.breakBefore = true; y = 0; } place(u); continue; }
    if (u.kind === "float") {
      if (!deferred.length && y + u.h <= CONTENT_H) { place(u); continue; }
      const textAhead = us.slice(k + 1, k + 4).some((n) => n.kind === "text");
      if (CONTENT_H - y >= DEFER_MIN && textAhead) { u.waited = 0; deferred.push(u); continue; }
      placeFloat(u); continue;
    }
    if (u.kind === "heading") {
      const next = us[k + 1];
      const need = u.h + (next && next.kind === "text" ? Math.min(next.h, MIN_LINES * LINE_H) : next ? next.h : 0);
      if (y > 0 && y + need > CONTENT_H) { u.breakBefore = true; y = 0; }
      place(u); continue;
    }
    // text and the cover flow, continuing on the following pages
    order.push(u);
    let rest = u.h;
    while (y + rest > CONTENT_H) {
      const fit = Math.floor((CONTENT_H - y) / LINE_H) * LINE_H;
      rest -= fit >= 2 * LINE_H ? fit : 0;
      y = 0;
    }
    y += rest;
    for (const f of deferred) f.waited += 1;
  }
  flush(true);
  return order;
}

const blocks = parse(md);

const font = async (file, name, weight) => ({ name, weight, data: await readFile(path.join(FONT_DIR, file)) });
const fonts = [
  await font("nb-international-pro-light.woff2", "NB", 300),
  await font("nb-international-pro-regular.woff2", "NB", 400),
  await font("nb-international-pro-medium.woff2", "NB", 500),
  await font("geist-mono-variable.woff2", "Geist Mono", 400),
];

const renderer = new PdfRenderer();
const us = units(blocks);
for (const u of us) {
  const size = await renderer.measure(`<div class="doc" style="width:${PAGE_W - 2 * RAIL}px">${u.html()}</div>`, { size: "a4", css, fonts });
  u.h = size.height;
}
figN = 0; tabN = 0; // number figures in their final reading order
const ordered = paginate(us);
const body = `${rails}<div class="doc">${ordered.map((u) => {
  const html = u.html();
  return u.breakBefore ? `<div style="display:flex;flex-direction:column;break-before:page">${html}</div>` : html;
}).join("")}</div>`;
if (process.env.DEBUG_PAGES) console.log(ordered.map((u) => `${u.kind}${u.breakBefore ? " [break]" : ""} ${Math.round(u.h)}`).join("\n"));

const pdf = await renderer.render(body, {
  size: "a4",
  margin: { top: MT, bottom: MB, left: RAIL, right: RAIL },
  header,
  footer,
  fonts,
  css,
  backgroundColor: PAGE,
  outline: true,
  lang: "en",
  metadata: {
    title: "Research update: Opulent on Luxembourg company law",
    description: "Opulent AI research update prepared for François Bernard",
    authors: ["Opulent AI Research"],
    creator: "takumi-pdf",
    creationDate: "2026-09-30",
  },
});
await writeFile(OUT, pdf);
console.log(`wrote ${OUT} (${(pdf.length / 1024).toFixed(0)} KB, ${figN} figures, ${tabN} tables)`);
