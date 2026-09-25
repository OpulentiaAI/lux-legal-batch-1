// data-grid: a live CSV/TSV table pane. Reads its file through the host's FilesControl,
// re-reads on every engine `changes` event touching the path (pipeline writes land
// in-place, no remount), sorts on header click, filters on a text row, and publishes
// the clicked row to the tree-scoped selection channel.

import { defineProjection } from '@arsumbris/au-host-sdk'
import type { MountFn, ProjectionModule } from '@arsumbris/au-host-sdk'
import { subscribeChanges } from '@arsumbris/au-host-sdk/engine-reads'

interface GridConfig {
  file?: string
  title?: string
}

function parseDelimited(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (!lines.length) return { header: [], rows: [] }
  const delim = lines[0].includes('\t') ? '\t' : ','
  const split = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
        } else cur += ch
      } else if (ch === '"') inQ = true
      else if (ch === delim) { out.push(cur); cur = '' } else cur += ch
    }
    out.push(cur)
    return out
  }
  const [head, ...rest] = lines
  return { header: split(head), rows: rest.map(split) }
}

const CSS = `
.dg { display:flex; flex-direction:column; height:100%; font-family:var(--au-font-sans,system-ui); color:var(--au-ink-1,#e6e6e6); }
.dg-toolbar { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--au-line,#262626); }
.dg-title { font-size:var(--au-t-sm,13px); font-weight:600; }
.dg-file { font-size:var(--au-t-xs,11px); color:var(--au-ink-3,#8a8a8a); font-family:var(--au-font-mono,monospace); }
.dg-filter { margin-left:auto; background:var(--au-surface-2,#161616); border:1px solid var(--au-line,#262626); border-radius:6px; color:inherit; font-size:var(--au-t-xs,11px); padding:4px 8px; width:180px; outline:none; }
.dg-filter:focus { border-color:var(--au-accent,#4f7fff); }
.dg-scroll { flex:1; overflow:auto; }
.dg table { border-collapse:collapse; width:100%; font-size:var(--au-t-xs,11px); }
.dg th { position:sticky; top:0; z-index:1; background:var(--au-surface-2,#161616); color:var(--au-ink-3,#8a8a8a); text-align:left; font-weight:600; padding:7px 10px; border-bottom:1px solid var(--au-line,#262626); white-space:nowrap; cursor:pointer; user-select:none; }
.dg th:hover { color:var(--au-ink-1,#e6e6e6); }
.dg td { padding:5px 10px; border-bottom:1px solid var(--au-line-faint,#1d1d1d); white-space:nowrap; max-width:280px; overflow:hidden; text-overflow:ellipsis; color:var(--au-ink-2,#c8c8c8); }
.dg tbody tr:hover td { background:var(--au-surface-hover,#1a1a1a); }
.dg tbody tr.dg-sel td { background:color-mix(in srgb, var(--au-accent,#4f7fff) 14%, transparent); }
.dg-foot { display:flex; gap:12px; padding:6px 10px; border-top:1px solid var(--au-line,#262626); font-size:var(--au-t-xs,11px); color:var(--au-ink-3,#8a8a8a); }
.dg-live { color:var(--au-ok,#3ecf8e); }
.dg-empty { padding:24px; color:var(--au-ink-3,#8a8a8a); font-size:var(--au-t-sm,13px); }
`

const mount: MountFn = (container, host) => {
  const root = document.createElement('div')
  root.className = 'dg-host'
  root.style.height = '100%'
  const styleEl = document.createElement('style')
  styleEl.textContent = CSS
  root.appendChild(styleEl)
  const body = document.createElement('div')
  root.appendChild(body)
  container.appendChild(root)

  let alive = true
  let path = (host.config as GridConfig | undefined)?.file ?? ''
  let sortCol = -1
  let sortAsc = true
  let filter = ''
  let selRow = -1
  let data: { header: string[]; rows: string[][] } = { header: [], rows: [] }
  let lastError = ''
  let lastRefresh = ''
  let lastContent = ''

  async function load(): Promise<void> {
    if (!path) { lastError = ''; data = { header: [], rows: [] }; render(); return }
    const r = await host.files.read(path)
    if (!alive) return
    if (!r.ok) {
      if (r.error !== lastError) { lastError = r.error ?? `cannot read ${path}`; data = { header: [], rows: [] }; render() }
      return
    }
    const content = r.content ?? ''
    if (content === lastContent && !lastError) return // unchanged — no repaint
    lastError = ''
    lastContent = content
    data = parseDelimited(content)
    lastRefresh = new Date().toLocaleTimeString()
    render()
  }

  function visibleRows(): string[][] {
    const q = filter.trim().toLowerCase()
    let rows = data.rows
    if (q) rows = rows.filter((r) => r.some((c) => c.toLowerCase().includes(q)))
    if (sortCol >= 0) {
      const idx = sortCol
      const num = rows.every((r) => (r[idx] ?? '') !== '' && !Number.isNaN(Number((r[idx] ?? '').replace(/[$,]/g, ''))))
      rows = [...rows].sort((a, b) => {
        const av = a[idx] ?? ''
        const bv = b[idx] ?? ''
        if (num) return (Number(av.replace(/[$,]/g, '')) - Number(bv.replace(/[$,]/g, ''))) * (sortAsc ? 1 : -1)
        return av.localeCompare(bv) * (sortAsc ? 1 : -1)
      })
    }
    return rows
  }

  function render(): void {
    if (!alive) return
    body.replaceChildren()
    const wrap = document.createElement('div')
    wrap.className = 'dg'

    const bar = document.createElement('div')
    bar.className = 'dg-toolbar'
    const title = document.createElement('span')
    title.className = 'dg-title'
    title.textContent = (host.config as GridConfig | undefined)?.title || path.split('/').pop() || 'data-grid'
    const file = document.createElement('span')
    file.className = 'dg-file'
    file.textContent = path
    const inp = document.createElement('input')
    inp.className = 'dg-filter'
    inp.placeholder = 'Filter rows…'
    inp.value = filter
    inp.addEventListener('input', () => { filter = inp.value; render() })
    bar.append(title, file, inp)

    const scroll = document.createElement('div')
    scroll.className = 'dg-scroll'
    if (lastError) {
      const e = document.createElement('div')
      e.className = 'dg-empty'
      e.textContent = lastError
      scroll.appendChild(e)
    } else if (!data.header.length) {
      const e = document.createElement('div')
      e.className = 'dg-empty'
      e.textContent = path ? `${path}: empty` : 'no file configured — set the `file` field'
      scroll.appendChild(e)
    } else {
      const table = document.createElement('table')
      const thead = document.createElement('thead')
      const htr = document.createElement('tr')
      data.header.forEach((h, i) => {
        const th = document.createElement('th')
        th.textContent = h + (sortCol === i ? (sortAsc ? ' ↑' : ' ↓') : '')
        th.addEventListener('click', () => {
          if (sortCol === i) sortAsc = !sortAsc
          else { sortCol = i; sortAsc = true }
          render()
        })
        htr.appendChild(th)
      })
      thead.appendChild(htr)
      const tbody = document.createElement('tbody')
      visibleRows().forEach((r, ri) => {
        const tr = document.createElement('tr')
        if (ri === selRow) tr.className = 'dg-sel'
        r.forEach((c) => {
          const td = document.createElement('td')
          td.textContent = c
          td.title = c
          tr.appendChild(td)
        })
        tr.addEventListener('click', () => {
          selRow = ri
          host.selection?.publish({ type: 'rows', file: path, row: r })
          render()
        })
        tbody.appendChild(tr)
      })
      table.append(thead, tbody)
      scroll.appendChild(table)
    }

    const foot = document.createElement('div')
    foot.className = 'dg-foot'
    const count = document.createElement('span')
    const shown = visibleRows().length
    count.textContent = `${shown.toLocaleString()} row${shown === 1 ? '' : 's'}${filter ? ` (of ${data.rows.length.toLocaleString()})` : ''}`
    const live = document.createElement('span')
    live.className = 'dg-live'
    live.textContent = lastRefresh ? `● live — refreshed ${lastRefresh}` : ''
    foot.append(count, live)

    wrap.append(bar, scroll, foot)
    body.appendChild(wrap)
    if (document.activeElement !== inp && (body.querySelector('.dg-filter') as HTMLInputElement | null) !== document.activeElement) {
      // keep focus if the user was typing in the filter
    }
  }

  // Realtime: plain data files don't bump the knowledge base on modify (the engine's
  // `changes` channel deltas the file SET — adds/removes/typed content — not CSV bytes),
  // so the grid polls its file through the engine-backed files.read and repaints only
  // when the content actually changed. The changes subscription still fires the
  // instant the file is created/replaced (set delta), so new pipeline outputs land fast.
  const POLL_MS = 1200
  const poll = setInterval(() => { void load() }, POLL_MS)
  const unsubscribe = subscribeChanges(host.engine, (event) => {
    if (!alive || !path) return
    const hint = (event as { scopeHint?: { modified?: string[]; added?: string[]; removed?: string[] } }).scopeHint
    if (!hint) { void load(); return }
    const touched = [...(hint.modified ?? []), ...(hint.added ?? [])]
    if (touched.some((p) => p === path || p.endsWith('/' + path) || path.endsWith('/' + p))) void load()
  })

  const offConfig = host.onOwnConfigChange?.((cfg) => {
    const next = (cfg as GridConfig | undefined)?.file ?? ''
    if (next === path) return
    path = next
    selRow = -1
    void load()
  })

  void load()

  return () => {
    alive = false
    clearInterval(poll)
    unsubscribe()
    offConfig?.()
    container.replaceChildren()
  }
}

export default defineProjection<ProjectionModule>({ mount })
