import { defineProjection as e } from "@arsumbris/au-host-sdk";
import { subscribeChanges as t } from "@arsumbris/au-host-sdk/engine-reads";
//#region src/index.ts
function n(e) {
	let t = e.split(/\r?\n/).filter((e) => e.trim().length > 0);
	if (!t.length) return {
		header: [],
		rows: []
	};
	let n = t[0].includes("	") ? "	" : ",", r = (e) => {
		let t = [], r = "", i = !1;
		for (let a = 0; a < e.length; a++) {
			let o = e[a];
			i ? o === "\"" ? e[a + 1] === "\"" ? (r += "\"", a++) : i = !1 : r += o : o === "\"" ? i = !0 : o === n ? (t.push(r), r = "") : r += o;
		}
		return t.push(r), t;
	}, [i, ...a] = t;
	return {
		header: r(i),
		rows: a.map(r)
	};
}
var r = "\n.dg { display:flex; flex-direction:column; height:100%; font-family:var(--au-font-sans,system-ui); color:var(--au-ink-1,#e6e6e6); }\n.dg-toolbar { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--au-line,#262626); }\n.dg-title { font-size:var(--au-t-sm,13px); font-weight:600; }\n.dg-file { font-size:var(--au-t-xs,11px); color:var(--au-ink-3,#8a8a8a); font-family:var(--au-font-mono,monospace); }\n.dg-filter { margin-left:auto; background:var(--au-surface-2,#161616); border:1px solid var(--au-line,#262626); border-radius:6px; color:inherit; font-size:var(--au-t-xs,11px); padding:4px 8px; width:180px; outline:none; }\n.dg-filter:focus { border-color:var(--au-accent,#4f7fff); }\n.dg-scroll { flex:1; overflow:auto; }\n.dg table { border-collapse:collapse; width:100%; font-size:var(--au-t-xs,11px); }\n.dg th { position:sticky; top:0; z-index:1; background:var(--au-surface-2,#161616); color:var(--au-ink-3,#8a8a8a); text-align:left; font-weight:600; padding:7px 10px; border-bottom:1px solid var(--au-line,#262626); white-space:nowrap; cursor:pointer; user-select:none; }\n.dg th:hover { color:var(--au-ink-1,#e6e6e6); }\n.dg td { padding:5px 10px; border-bottom:1px solid var(--au-line-faint,#1d1d1d); white-space:nowrap; max-width:280px; overflow:hidden; text-overflow:ellipsis; color:var(--au-ink-2,#c8c8c8); }\n.dg tbody tr:hover td { background:var(--au-surface-hover,#1a1a1a); }\n.dg tbody tr.dg-sel td { background:color-mix(in srgb, var(--au-accent,#4f7fff) 14%, transparent); }\n.dg-foot { display:flex; gap:12px; padding:6px 10px; border-top:1px solid var(--au-line,#262626); font-size:var(--au-t-xs,11px); color:var(--au-ink-3,#8a8a8a); }\n.dg-live { color:var(--au-ok,#3ecf8e); }\n.dg-empty { padding:24px; color:var(--au-ink-3,#8a8a8a); font-size:var(--au-t-sm,13px); }\n", i = e({ mount: (e, i) => {
	let a = document.createElement("div");
	a.className = "dg-host", a.style.height = "100%";
	let o = document.createElement("style");
	o.textContent = r, a.appendChild(o);
	let s = document.createElement("div");
	a.appendChild(s), e.appendChild(a);
	let c = !0, l = i.config?.file ?? "", u = -1, d = !0, f = "", p = -1, m = {
		header: [],
		rows: []
	}, h = "", g = "", _ = "";
	async function v() {
		if (!l) {
			h = "", m = {
				header: [],
				rows: []
			}, b();
			return;
		}
		let e = await i.files.read(l);
		if (!c) return;
		if (!e.ok) {
			e.error !== h && (h = e.error ?? `cannot read ${l}`, m = {
				header: [],
				rows: []
			}, b());
			return;
		}
		let t = e.content ?? "";
		t === _ && !h || (h = "", _ = t, m = n(t), g = (/* @__PURE__ */ new Date()).toLocaleTimeString(), b());
	}
	function y() {
		let e = f.trim().toLowerCase(), t = m.rows;
		if (e && (t = t.filter((t) => t.some((t) => t.toLowerCase().includes(e)))), u >= 0) {
			let e = u, n = t.every((t) => (t[e] ?? "") !== "" && !Number.isNaN(Number((t[e] ?? "").replace(/[$,]/g, ""))));
			t = [...t].sort((t, r) => {
				let i = t[e] ?? "", a = r[e] ?? "";
				return n ? (Number(i.replace(/[$,]/g, "")) - Number(a.replace(/[$,]/g, ""))) * (d ? 1 : -1) : i.localeCompare(a) * (d ? 1 : -1);
			});
		}
		return t;
	}
	function b() {
		if (!c) return;
		s.replaceChildren();
		let e = document.createElement("div");
		e.className = "dg";
		let t = document.createElement("div");
		t.className = "dg-toolbar";
		let n = document.createElement("span");
		n.className = "dg-title", n.textContent = i.config?.title || l.split("/").pop() || "data-grid";
		let r = document.createElement("span");
		r.className = "dg-file", r.textContent = l;
		let a = document.createElement("input");
		a.className = "dg-filter", a.placeholder = "Filter rows…", a.value = f, a.addEventListener("input", () => {
			f = a.value, b();
		}), t.append(n, r, a);
		let o = document.createElement("div");
		if (o.className = "dg-scroll", h) {
			let e = document.createElement("div");
			e.className = "dg-empty", e.textContent = h, o.appendChild(e);
		} else if (m.header.length) {
			let e = document.createElement("table"), t = document.createElement("thead"), n = document.createElement("tr");
			m.header.forEach((e, t) => {
				let r = document.createElement("th");
				r.textContent = e + (u === t ? d ? " ↑" : " ↓" : ""), r.addEventListener("click", () => {
					u === t ? d = !d : (u = t, d = !0), b();
				}), n.appendChild(r);
			}), t.appendChild(n);
			let r = document.createElement("tbody");
			y().forEach((e, t) => {
				let n = document.createElement("tr");
				t === p && (n.className = "dg-sel"), e.forEach((e) => {
					let t = document.createElement("td");
					t.textContent = e, t.title = e, n.appendChild(t);
				}), n.addEventListener("click", () => {
					p = t, i.selection?.publish({
						type: "rows",
						file: l,
						row: e
					}), b();
				}), r.appendChild(n);
			}), e.append(t, r), o.appendChild(e);
		} else {
			let e = document.createElement("div");
			e.className = "dg-empty", e.textContent = l ? `${l}: empty` : "no file configured — set the `file` field", o.appendChild(e);
		}
		let _ = document.createElement("div");
		_.className = "dg-foot";
		let v = document.createElement("span"), x = y().length;
		v.textContent = `${x.toLocaleString()} row${x === 1 ? "" : "s"}${f ? ` (of ${m.rows.length.toLocaleString()})` : ""}`;
		let S = document.createElement("span");
		S.className = "dg-live", S.textContent = g ? `● live — refreshed ${g}` : "", _.append(v, S), e.append(t, o, _), s.appendChild(e), document.activeElement !== a && (s.querySelector(".dg-filter"), document.activeElement);
	}
	let x = setInterval(() => {
		v();
	}, 1200), S = t(i.engine, (e) => {
		if (!c || !l) return;
		let t = e.scopeHint;
		if (!t) {
			v();
			return;
		}
		[...t.modified ?? [], ...t.added ?? []].some((e) => e === l || e.endsWith("/" + l) || l.endsWith("/" + e)) && v();
	}), C = i.onOwnConfigChange?.((e) => {
		let t = e?.file ?? "";
		t !== l && (l = t, p = -1, v());
	});
	return v(), () => {
		c = !1, clearInterval(x), S(), C?.(), e.replaceChildren();
	};
} });
//#endregion
export { i as default };
