// Figures for the research update, drawn as static SVG and HTML for takumi-pdf.
// Visual language: Opulent landing tokens (ink, 56% / 40% ink, hairlines, one blue accent a figure)
// with evilcharts' idioms (hatched "buffer" bars for bounds, gradient-fade bars, dot-grid backgrounds).

export const INK = "rgb(25,25,25)";
export const ink = (a) => `rgba(25,25,25,${a})`;
export const BLUE = "rgb(49,124,255)";
export const blue = (a) => `rgba(49,124,255,${a})`;
export const LINE = "rgba(0,0,0,0.08)";
export const LINE2 = "rgba(0,0,0,0.06)";
export const PAGE = "rgb(252,252,252)";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (n) => Math.round(n * 10) / 10;

function text(x, y, s, o = {}) {
  const fam = o.mono ? "Geist Mono" : "NB";
  const attrs = [
    `x="${r1(x)}"`, `y="${r1(y)}"`, `font-family="${fam}"`, `font-size="${o.size ?? 10}"`,
    `fill="${o.fill ?? INK}"`, `text-anchor="${o.anchor ?? "start"}"`,
  ];
  if (o.weight) attrs.push(`font-weight="${o.weight}"`);
  if (o.ls) attrs.push(`letter-spacing="${o.ls}"`);
  return `<text ${attrs.join(" ")}>${esc(s)}</text>`;
}
const line = (x1, y1, x2, y2, stroke = LINE, w = 1, extra = "") =>
  `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${stroke}" stroke-width="${w}" ${extra}/>`;
const rect = (x, y, w, h, fill, extra = "") =>
  `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(0, w))}" height="${r1(h)}" fill="${fill}" ${extra}/>`;

// Diagonal hatching drawn as explicit segments clipped to the box, so no pattern seams appear in PDF viewers.
function hatch(x, y, w, h, { step = 4.5, color = INK, width = 1, opacity = 0.9, tint = ink(0.05) } = {}) {
  let out = tint ? rect(x, y, w, h, tint) : "";
  for (let c = step / 2; c < w + h; c += step) {
    const u1 = Math.max(0, c - h), v1 = c - u1;
    const u2 = Math.min(w, c), v2 = c - u2;
    out += line(x + u1, y + v1, x + u2, y + v2, color, width, `stroke-opacity="${opacity}"`);
  }
  return out;
}

// evilcharts' dots background, as the landing page's graph paper.
const dotsDef = (id, pitch = 10, r = 0.65, fill = "rgba(0,0,0,0.14)") =>
  `<pattern id="${id}" x="0" y="0" width="${pitch}" height="${pitch}" patternUnits="userSpaceOnUse"><circle cx="${pitch / 2}" cy="${pitch / 2}" r="${r}" fill="${fill}"/></pattern>`;

// evilcharts' gradient bar: solid at the value end, fading toward the baseline.
const fadeDef = (id, color, from, to, vertical = true) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}"><stop offset="0" stop-color="${color}" stop-opacity="${from}"/><stop offset="1" stop-color="${color}" stop-opacity="${to}"/></linearGradient>`;

const svg = (w, h, body, defs = "") =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>`;

function bracket(x1, x2, y, color = BLUE, tick = 5, down = false) {
  const d = down ? tick : -tick;
  return line(x1, y, x2, y, color, 1.4) + line(x1, y, x1, y + d, color, 1.4) + line(x2, y, x2, y + d, color, 1.4);
}

// Small HTML legend swatches (the fonts carry no square glyph, so swatches are drawn).
export function swatch(kind) {
  if (kind === "hatch") return `<svg width="14" height="10" viewBox="0 0 14 10">${hatch(0, 0, 14, 10, { step: 3.5, width: 0.9 })}</svg>`;
  if (kind === "dots") return `<svg width="14" height="10" viewBox="0 0 14 10"><defs>${dotsDef("sw", 3.5, 0.55, "rgba(0,0,0,0.5)")}</defs>${rect(0, 0, 14, 10, ink(0.05))}${rect(0, 0, 14, 10, "url(#sw)")}</svg>`;
  if (kind === "hollow") return `<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.8" fill="${PAGE}" stroke="${ink(0.45)}" stroke-width="1.3"/></svg>`;
  if (kind === "dot") return `<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4.2" fill="${INK}"/></svg>`;
  return `<svg width="14" height="10" viewBox="0 0 14 10">${rect(0, 0, 14, 10, kind)}</svg>`;
}

// Figure 1a: held-out completion with GLM-5.3, with a zoom onto the top of the scale.
export function resultsCompletion(d) {
  const W = 330, H = 232;
  const X0 = 74, X1 = 262, x = (v) => X0 + ((X1 - X0) * v) / 100;
  const opu = d.glm53.opulentCompletion, hv = r1(opu - d.glm53.minMargin);
  let b = rect(X0, 6, X1 - X0, 104, "url(#dA)");
  for (const t of [0, 25, 50, 75, 100]) b += line(x(t), 6, x(t), 110, LINE) + text(x(t), 124, t, { mono: true, size: 8, fill: ink(0.4), anchor: "middle" });
  // Opulent bar
  b += rect(X0, 22, x(opu) - X0, 24, "url(#fOpu)", 'rx="2.5"');
  b += text(10, 38, "Opulent", { size: 10.5 });
  b += text(x(opu) + 7, 39, `${opu.toFixed(1)}%`, { size: 13 });
  // Harvey bar drawn at its upper bound, as an evilcharts buffer bar
  b += hatch(X0, 70, x(hv) - X0, 24, { step: 4.5, width: 0.9, opacity: 0.55 });
  b += line(x(hv), 66, x(hv), 98, ink(0.55), 1, 'stroke-dasharray="2 2"');
  b += text(10, 86, "Harvey LAB", { size: 10.5, fill: ink(0.56) });
  b += text(x(hv) - 5, 62, `at most ${hv.toFixed(1)}%`, { size: 9.5, fill: ink(0.56), anchor: "end" });
  // zoom trapezoid onto 80 to 100
  const zx = (v) => 10 + ((W - 20) * (v - 80)) / 20;
  b += `<path d="M ${x(80)} 130 L ${x(100)} 130 L ${W - 10} 150 L 10 150 Z" fill="${ink(0.035)}"/>` + line(x(80), 130, 10, 150, ink(0.18));
  b += rect(10, 150, W - 20, 64, "url(#dA)");
  for (const t of [80, 85, 90, 95, 100]) b += line(zx(t), 150, zx(t), 214, LINE) + text(zx(t), 226, t, { mono: true, size: 8, fill: ink(0.4), anchor: "middle" });
  b += rect(10, 158, zx(opu) - 10, 12, "url(#fOpuH)", 'rx="2"');
  b += hatch(10, 176, zx(hv) - 10, 12, { step: 4, width: 0.9, opacity: 0.55 });
  b += line(zx(hv), 172, zx(hv), 192, ink(0.55), 1, 'stroke-dasharray="2 2"');
  b += bracket(zx(hv), zx(opu), 200, BLUE, 5);
  b += text((zx(hv) + zx(opu)) / 2, 211, `at least ${d.glm53.minMargin} points`, { size: 9, fill: BLUE, anchor: "middle", mono: true });
  const defs = dotsDef("dA", 10) + fadeDef("fOpu", INK, 0.62, 1, false) + fadeDef("fOpuH", INK, 0.62, 1, false);
  return svg(W, H, b, defs);
}

// Figure 1b: the earlier DeepSeek run, as dumbbells on a 0.60 to 1.00 scale.
export function resultsEarlier(d) {
  const W = 206, H = 232, X0 = 10, X1 = 196, x = (v) => X0 + ((X1 - X0) * (v - 0.6)) / 0.4;
  let b = rect(X0, 6, X1 - X0, 190, "url(#dB)");
  for (const t of [0.6, 0.7, 0.8, 0.9, 1.0]) b += line(x(t), 6, x(t), 196, LINE) + text(x(t), 210, t.toFixed(1), { mono: true, size: 8, fill: ink(0.4), anchor: "middle" });
  const rows = [["Semantic quality", d.deepseek250.semantic, 58], ["Accuracy and grounding", d.deepseek250.accuracy, 140]];
  for (const [label, v, y] of rows) {
    b += text(X0 + 2, y - 26, label, { size: 10 });
    b += line(x(v.harvey), y, x(v.opulent), y, ink(0.3), 2);
    b += `<circle cx="${r1(x(v.harvey))}" cy="${y}" r="4.6" fill="${PAGE}" stroke="${ink(0.45)}" stroke-width="1.4"/>`;
    b += `<circle cx="${r1(x(v.opulent))}" cy="${y}" r="4.8" fill="${INK}"/>`;
    b += text(x(v.harvey) - 8, y + 3.5, v.harvey.toFixed(3), { mono: true, size: 8.5, fill: ink(0.5), anchor: "end" });
    b += text(x(v.opulent) + 8, y + 3.5, v.opulent.toFixed(3), { mono: true, size: 8.5 });
  }
  return svg(W, H, b, dotsDef("dB", 10));
}

// Figure 2: the corpus by work, duotone bars (all passages / passages tied to a statutory article).
export function corpus(d) {
  const works = d.corpus.works;
  const W = 560, rowH = 31, top = 8, H = top + works.length * rowH + 26;
  const L = 212, R = 488, max = 2100, x = (v) => L + ((R - L) * v) / max;
  let b = rect(L, 0, R - L, top + works.length * rowH, "url(#dC)");
  for (const t of [0, 500, 1000, 1500, 2000]) b += line(x(t), 0, x(t), top + works.length * rowH, LINE) + text(x(t), H - 8, t.toLocaleString("en-US"), { mono: true, size: 8, fill: ink(0.4), anchor: "middle" });
  works.forEach((w, i) => {
    const y = top + i * rowH;
    const own = !!w.own;
    b += text(0, y + 11, w.label, { size: 10, fill: own ? BLUE : INK });
    b += text(0, y + 23, w.sub, { size: 8.5, fill: own ? blue(0.8) : ink(0.5) });
    b += rect(L, y + 6, x(w.chunks) - L, 14, own ? "url(#fOwn)" : "url(#fAll)", 'rx="2"');
    if (w.articleTagged > 0) b += rect(L, y + 6, Math.max(1.5, x(w.articleTagged) - L), 14, INK, 'rx="2"');
    b += text(x(w.chunks) + 6, y + 17, w.chunks.toLocaleString("en-US"), { mono: true, size: 9, fill: own ? BLUE : INK });
    b += line(0, y + rowH - 0.5, R, y + rowH - 0.5, LINE2);
  });
  const defs = dotsDef("dC", 10) + fadeDef("fAll", INK, 0.14, 0.26, false) + fadeDef("fOwn", BLUE, 0.55, 1, false);
  return svg(W, H, b, defs);
}

// Figure 3: the two evaluations as bars of parts (landing "funnel of parts" layout).
export function evals(d) {
  const W = 560, H = 214, G = 3;
  let b = "";
  // Development set, 50 questions by kind
  const kinds = d.devSet.kinds, total = d.devSet.questions;
  const shades = [null, 0.9, 0.76, 0.64, 0.54, 0.44, 0.35, 0.27, 0.2];
  let cx = 0;
  const unit = (W - G * (kinds.length - 1)) / total;
  b += text(0, 10, `DEVELOPMENT SET  ·  ${total} QUESTIONS  ·  ${d.devSet.criteria} CRITERIA`, { mono: true, size: 8, fill: ink(0.45), ls: 0.6 });
  kinds.forEach((k, i) => {
    const w = k.n * unit;
    if (i === 0) b += rect(cx, 30, w, 26, ink(0.05), 'rx="2"') + rect(cx, 30, w, 26, "url(#dE)", 'rx="2"');
    else b += rect(cx, 30, w, 26, ink(shades[i]), 'rx="2"');
    b += text(cx + 1, 25, k.n, { mono: true, size: 8, fill: ink(0.55) });
    if (w > 44) b += text(cx + 1, 69, k.kind, { size: 9 });
    cx += w + G;
  });
  // swatch legend for the small parts
  let lx = 0;
  const small = kinds.filter((k) => k.n * unit <= 44);
  b += text(0, 86, "", { size: 8 });
  small.forEach((k) => {
    const i = kinds.indexOf(k);
    b += rect(lx, 78, 8, 8, ink(shades[i]), 'rx="1.5"') + text(lx + 12, 85.5, k.kind, { size: 8.5, fill: ink(0.56) });
    lx += 16 + k.kind.length * 4.6 + 10;
  });
  // Work-product suite, 15 tasks sized by criteria; development tasks first, then the held-out twelve
  const tasks = [...d.workProduct.tasks.filter((t) => t.dev), ...d.workProduct.tasks.filter((t) => !t.dev)];
  const crit = tasks.reduce((s, t) => s + t.criteria, 0);
  const u2 = (W - G * (tasks.length - 1)) / crit;
  b += line(0, 100, W, 100, LINE);
  b += text(0, 117, `WORK-PRODUCT SUITE  ·  ${tasks.length} TASKS  ·  ${crit} CRITERIA`, { mono: true, size: 8, fill: ink(0.45), ls: 0.6 });
  cx = 0;
  let hoStart = null, hoEnd = 0, hoCrit = 0;
  tasks.forEach((t) => {
    const w = t.criteria * u2;
    if (t.dev) b += hatch(cx, 150, w, 30, { step: 4, width: 0.8, opacity: 0.45 });
    else {
      if (hoStart === null) hoStart = cx;
      hoEnd = cx + w; hoCrit += t.criteria;
      b += rect(cx, 150, w, 30, "url(#fTask)", 'rx="2"');
    }
    b += text(cx + w / 2, 169, t.criteria, { mono: true, size: 8.5, fill: t.dev ? ink(0.7) : "#fff", anchor: "middle" });
    b += text(cx + w / 2, 194, t.n, { mono: true, size: 8, fill: ink(0.45), anchor: "middle" });
    cx += w + G;
  });
  b += bracket(hoStart, hoEnd, 142, BLUE, 5, true);
  b += text(hoEnd, 136, `HELD OUT  ·  12 TASKS  ·  ${hoCrit} CRITERIA`, { mono: true, size: 8, fill: BLUE, anchor: "end", ls: 0.6 });
  b += text(0, 136, "DEVELOPMENT", { mono: true, size: 8, fill: ink(0.45), ls: 0.6 });
  b += text(0, 209, "Task number under each block; criteria inside it.", { size: 8.5, fill: ink(0.5) });
  const defs = dotsDef("dE", 4, 0.7, "rgba(0,0,0,0.42)") + fadeDef("fTask", INK, 1, 0.72, true);
  return svg(W, H, b, defs);
}

// Figure 4: retrieval modes on the 50-question development set (evilcharts gradient bars).
export function retrieval(d) {
  const W = 560, H = 236, top = 14, base = 170, max = 50, y = (v) => base - ((base - top) * v) / max;
  const modes = d.retrieval.modes, groupW = (W - 22) / modes.length;
  const metrics = [["ev1", "fR1"], ["ev5", "fR2"], ["doc5", "fR3"]];
  let b = rect(22, top, W - 22, base - top, "url(#dR)");
  for (const t of [0, 10, 20, 30, 40, 50]) b += line(22, y(t), W, y(t), LINE) + text(0, y(t) + 3, t, { mono: true, size: 7.5, fill: ink(0.35) });
  modes.forEach((m, gi) => {
    const gx = 22 + gi * groupW + 18, bw = 30, gap = 8;
    metrics.forEach(([k, grad], mi) => {
      const bx = gx + mi * (bw + gap);
      b += rect(bx, y(m[k]), bw, base - y(m[k]), `url(#${grad})`, 'rx="2"');
      b += text(bx + bw / 2, y(m[k]) - 4, m[k], { mono: true, size: 8.5, anchor: "middle" });
    });
    const last = gi === modes.length - 1;
    b += text(gx, base + 18, m.mode, { size: 10, fill: INK });
    b += text(gx, base + 32, `MRR ${m.mrr.toFixed(3).replace(/^0/, "")}`, { mono: true, size: 8.5, fill: last ? BLUE : ink(0.5) });
    b += text(gx, base + 45, `p50 ${m.p50}`, { mono: true, size: 8, fill: ink(0.4) });
  });
  b += line(22, base, W, base, ink(0.35));
  const defs = dotsDef("dR", 10) + fadeDef("fR1", INK, 1, 0.55) + fadeDef("fR2", INK, 0.55, 0.22) + fadeDef("fR3", INK, 0.2, 0.07);
  return svg(W, H, b, defs);
}

// Figure 5a: judge output tokens on a log scale.
export function judge(d) {
  const W = 348, H = 150, L = 8, R = 338;
  const lx = (v) => L + ((R - L) * (Math.log10(v) - 1)) / 4; // 10 to 100,000
  let b = rect(L, 18, R - L, 100, "url(#dJ)");
  for (const t of [10, 100, 1000, 10000, 100000]) b += line(lx(t), 18, lx(t), 118, LINE) + text(lx(t), 132, t.toLocaleString("en-US"), { mono: true, size: 7.5, fill: ink(0.4), anchor: t === 10 ? "start" : t === 100000 ? "end" : "middle" });
  const j = d.judge;
  b += text(L, 12, "High-reasoning judge, one answer", { size: 9.5 });
  b += hatch(L, 22, lx(j.reasoningSmokeTokens) - L, 20, { step: 4.5, width: 0.9, opacity: 0.6 });
  b += line(lx(j.reasoningBudget), 16, lx(j.reasoningBudget), 50, ink(0.6), 1, 'stroke-dasharray="2 2"');
  b += text(lx(j.reasoningBudget) + 4, 30, "budget", { mono: true, size: 7.5, fill: ink(0.55) });
  b += text(lx(j.reasoningBudget) + 4, 40, "16,000", { mono: true, size: 7.5, fill: ink(0.55) });
  b += text(lx(j.reasoningSmokeTokens) - 4, 56, `${j.reasoningSmokeTokens.toLocaleString("en-US")} tokens, verdict truncated`, { size: 8.5, fill: ink(0.56), anchor: "end" });
  b += text(L, 76, "Jev, per graded attempt", { size: 9.5, fill: BLUE });
  b += rect(L, 82, lx(j.jevPerAttempt) - L, 20, "url(#fJ)", 'rx="2"');
  b += text(lx(j.jevPerAttempt) + 6, 96, `about ${j.jevPerAttempt} tokens`, { size: 9.5, fill: BLUE });
  b += text(L, 146, "Output tokens per judgment, log scale", { size: 8.5, fill: ink(0.5) });
  const defs = dotsDef("dJ", 10) + fadeDef("fJ", BLUE, 0.55, 1, false);
  return svg(W, H, b, defs);
}

// Figure 5b: the shape of a Jev verdict (illustrative, no numbers).
export function jevShape() {
  const W = 160, H = 118;
  const hs = [0.06, 0.2, 0.9, 0.28];
  let b = line(10, 92, 150, 92, ink(0.3));
  hs.forEach((h, i) => {
    const x = 18 + i * 34;
    b += rect(x, 92 - h * 74, 22, h * 74, i === 2 ? INK : ink(0.18), 'rx="2"');
    b += text(x + 11, 106, i, { mono: true, size: 8.5, fill: ink(0.5), anchor: "middle" });
  });
  b += text(80, 117, "Level on the 0 to 3 scale", { size: 8, fill: ink(0.5), anchor: "middle" });
  return svg(W, H, b);
}

// Figure 6: development-set criteria pass by answering mode.
export function harness(d) {
  const W = 560, rowH = 34, top = 6, modes = d.devModes.modes, H = top + modes.length * rowH + 22;
  const L = 172, R = 470, x = (v) => L + ((R - L) * v) / 100;
  let b = rect(L, 0, R - L, top + modes.length * rowH, "url(#dH)");
  for (const t of [0, 25, 50, 75, 100]) b += line(x(t), 0, x(t), top + modes.length * rowH, LINE) + text(x(t), H - 6, t, { mono: true, size: 8, fill: ink(0.4), anchor: "middle" });
  modes.forEach((m, i) => {
    const y = top + i * rowH;
    const first = i === 2, last = i === 3;
    b += text(0, y + 19, m.mode, { size: 10, fill: last || first ? INK : ink(0.56) });
    if (first) b += hatch(L, y + 8, x(m.pass) - L, 16, { step: 4.5, width: 0.9, opacity: 0.55 });
    else b += rect(L, y + 8, x(m.pass) - L, 16, last ? "url(#fH)" : ink(0.16), 'rx="2"');
    b += text(x(m.pass) + 6, y + 20, `${m.pass.toFixed(1)}%`, { mono: true, size: 9, fill: last || first ? INK : ink(0.56) });
  });
  const yF = top + 2 * rowH + 16, yL = top + 3 * rowH + 16, xa = x(93.8) + 46;
  b += `<path d="M ${r1(x(73.0) + 40)} ${yF} L ${r1(xa)} ${yF} L ${r1(xa)} ${yL - 6}" fill="none" stroke="${BLUE}" stroke-width="1.3"/>`;
  b += `<path d="M ${r1(xa - 3.5)} ${yL - 9} L ${r1(xa)} ${yL - 3} L ${r1(xa + 3.5)} ${yL - 9}" fill="none" stroke="${BLUE}" stroke-width="1.3"/>`;
  b += text(xa + 6, (yF + yL) / 2 + 3, "+20.8 pts", { mono: true, size: 9, fill: BLUE });
  const defs = dotsDef("dH", 10) + fadeDef("fH", INK, 0.62, 1, false);
  return svg(W, H, b, defs);
}
