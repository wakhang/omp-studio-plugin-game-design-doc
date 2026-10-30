// Game Design Docs — shared Markdown design-doc library.
// Every agent session gets the gdd_* host tools (+ the gdd:// URI scheme); humans read the
// rendered HTML in the "게임 기획서" view / right panel, or open a standalone HTML export.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')
const { pathToFileURL } = require('url')

const DEFAULT_DIR = path.join(os.homedir(), 'Documents', 'GameDesignDocs')
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const HISTORY_KEEP = 30

let state = null

exports.activate = async (ctx) => {
  const md = await import(pathToFileURL(path.join(ctx.pluginDir, 'md.mjs')).href + '?v=' + Date.now())
  let electron = null
  try {
    electron = require('electron')
  } catch {
    electron = null
  }

  state = { watcher: null, timer: null, settingsSub: null }
  const locks = new Map()

  // ---------- storage ----------
  const docsDir = () => {
    const v = ctx.settings.get().docsDir
    return path.resolve(typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_DIR)
  }
  const ensureDir = async () => {
    const dir = docsDir()
    await fsp.mkdir(dir, { recursive: true })
    return dir
  }
  const normId = (raw) => {
    const id = String(raw ?? '')
      .trim()
      .replace(/^gdd:\/\//i, '')
      .replace(/\/+$/, '')
      .replace(/\.md$/i, '')
    if (!ID_RE.test(id) || id.endsWith('.') || id.includes('..') || RESERVED.test(id)) {
      throw new Error(
        `Invalid doc id "${raw}". Use letters (Korean ok), digits, "_", "-", "." without spaces, max 80 chars (e.g. "02-combat"). Ids sort the table of contents.`
      )
    }
    return id
  }
  const fileOf = (dir, id) => path.join(dir, id + '.md')
  const lf = (s) => String(s ?? '').replace(/\r\n?/g, '\n')

  const readDoc = async (id) => {
    const dir = await ensureDir()
    try {
      return lf(await fsp.readFile(fileOf(dir, id), 'utf8'))
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new Error(`Document not found: "${id}". Call gdd_list to see existing ids.`)
      throw e
    }
  }
  const exists = async (id) => {
    try {
      await fsp.access(fileOf(await ensureDir(), id))
      return true
    } catch {
      return false
    }
  }

  const backup = async (dir, id, text) => {
    const hdir = path.join(dir, '.history', id)
    await fsp.mkdir(hdir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fsp.writeFile(path.join(hdir, stamp + '.md'), text, 'utf8')
    const files = (await fsp.readdir(hdir)).filter((f) => f.endsWith('.md')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) await fsp.unlink(path.join(hdir, f)).catch(() => {})
  }

  const writeDoc = async (id, text) => {
    const dir = await ensureDir()
    const file = fileOf(dir, id)
    const body = lf(text).replace(/\s*$/, '\n')
    let old = null
    try {
      old = lf(await fsp.readFile(file, 'utf8'))
    } catch {
      old = null
    }
    if (old === body) return { changed: false, created: false, text: body }
    if (old !== null) await backup(dir, id, old)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, body, 'utf8')
    try {
      await fsp.rename(tmp, file)
    } catch {
      await fsp.writeFile(file, body, 'utf8')
      await fsp.unlink(tmp).catch(() => {})
    }
    notify()
    return { changed: true, created: old === null, text: body }
  }

  // Serialize read-modify-write per document (several agents may edit at once).
  const withLock = (id, fn) => {
    const key = id.toLowerCase()
    const prev = locks.get(key) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => {},
      () => {}
    )
    locks.set(key, tail)
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }

  const listDocs = async () => {
    const dir = await ensureDir()
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const docs = []
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
      const id = e.name.slice(0, -3)
      if (!ID_RE.test(id)) continue
      const file = path.join(dir, e.name)
      const [raw, st] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)])
      const text = lf(raw)
      docs.push({ id, title: md.titleOf(text, id), updated: st.mtimeMs, lines: text.replace(/\n$/, '').split('\n').length, outline: md.outline(text) })
    }
    docs.sort((a, b) => a.id.localeCompare(b.id, 'ko', { numeric: true }))
    return { dir, docs }
  }

  // ---------- sections ----------
  // query: "heading" or "parent > child" (exact text first, then substring).
  const resolveSection = (text, query) => {
    const lines = text.split('\n')
    const heads = md.outline(text)
    const parts = String(query)
      .split('>')
      .map((p) => p.trim().replace(/^#+\s*/, '').toLowerCase())
      .filter(Boolean)
    if (!parts.length) throw new Error('section must not be empty')
    let range = { start: -1, end: lines.length, level: 0 }
    let parent = null
    for (let k = 0; k < parts.length; k++) {
      const q = parts[k]
      const inRange = heads.filter((h) => h.line - 1 > range.start && h.line - 1 < range.end && h.level > range.level)
      let hits = inRange.filter((h) => h.text.trim().toLowerCase() === q)
      if (!hits.length) hits = inRange.filter((h) => h.text.toLowerCase().includes(q))
      if (hits.length > 1) {
        throw new Error(
          `Section "${query}" is ambiguous: ${hits.map((h) => `"${h.text}" (line ${h.line})`).join(', ')}. Use the exact heading or "parent > child".`
        )
      }
      if (!hits.length) {
        return { lines, heads, found: null, parent: k === parts.length - 1 ? parent : null, missing: k === parts.length - 1 ? query.split('>').pop().trim() : null }
      }
      const h = hits[0]
      const next = heads.find((o) => o.line > h.line && o.level <= h.level)
      range = { start: h.line - 1, end: next ? next.line - 1 : lines.length, level: h.level, heading: h.text }
      parent = range
    }
    return { lines, heads, found: range, parent: null, missing: null }
  }

  const trimBlank = (arr) => {
    let a = 0
    let b = arr.length
    while (a < b && !arr[a].trim()) a++
    while (b > a && !arr[b - 1].trim()) b--
    return arr.slice(a, b)
  }

  // ---------- change notification ----------
  const notify = () => {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => ctx.channel.emit('gdd.changed', {}), 150)
  }
  const startWatch = async () => {
    if (state.watcher) {
      state.watcher.close()
      state.watcher = null
    }
    try {
      const dir = await ensureDir()
      state.watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (!name || String(name).toLowerCase().endsWith('.md')) notify()
      })
      state.watcher.on('error', () => {})
    } catch (e) {
      ctx.log('watch failed:', e && e.message)
    }
  }
  await startWatch()
  state.settingsSub = ctx.settings.onChange(() => {
    startWatch().then(notify)
  })

  // ---------- HTML export ----------
  const gddLinkToFile = (u) => {
    const [rawId, hash] = u.replace(/^gdd:\/\//i, '').split('#')
    const id = md.safeDecode(rawId).replace(/\/+$/, '').replace(/\.md$/i, '')
    return encodeURIComponent(id) + '.html' + (hash ? '#' + md.ID_PREFIX + md.safeDecode(hash) : '')
  }
  const exportAll = async (focusId) => {
    const { dir, docs } = await listDocs()
    const outDir = path.join(dir, '.export')
    await fsp.mkdir(outDir, { recursive: true })
    const stamp = new Date().toLocaleString('sv-SE')
    for (const d of docs) {
      const r = md.renderMarkdown(await readDoc(d.id), { rewriteLink: gddLinkToFile })
      await fsp.writeFile(path.join(outDir, d.id + '.html'), exportPage(md.escapeHtml, d, docs, r, stamp), 'utf8')
    }
    return path.join(outDir, (focusId && docs.some((d) => d.id === focusId) ? focusId : docs[0] ? docs[0].id : '') + '.html')
  }

  // ---------- renderer channel ----------
  ctx.channel.handle('gdd.list', async () => {
    const { dir, docs } = await listDocs()
    return { dir, docs: docs.map(({ outline, ...d }) => d) }
  })
  ctx.channel.handle('gdd.get', async (p) => {
    const id = normId(p && p.id)
    const text = await readDoc(id)
    const st = await fsp.stat(fileOf(docsDir(), id))
    const r = md.renderMarkdown(text)
    return { id, title: md.titleOf(text, id), html: r.html, toc: r.toc, updated: st.mtimeMs, lines: text.replace(/\n$/, '').split('\n').length }
  })
  ctx.channel.handle('gdd.export', async (p) => {
    const file = await exportAll(p && p.id ? normId(p.id) : null)
    if (!electron) throw new Error('electron shell unavailable')
    const err = await electron.shell.openPath(file)
    if (err) throw new Error(err)
    return file
  })
  ctx.channel.handle('gdd.openFolder', async () => {
    const dir = await ensureDir()
    if (!electron) throw new Error('electron shell unavailable')
    const err = await electron.shell.openPath(dir)
    if (err) throw new Error(err)
    return dir
  })
  ctx.channel.handle('gdd.openExternal', async (p) => {
    const url = String((p && p.url) || '')
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error('blocked url: ' + url)
    if (electron) await electron.shell.openExternal(url)
  })

  // ---------- host tools (visible to every agent session) ----------
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const tool = (definition, fn) =>
    ctx.registerHostTool({
      definition,
      async execute(args) {
        try {
          return ok(await fn(args || {}))
        } catch (e) {
          return { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true }
        }
      }
    })
  const outlineText = (text) =>
    md
      .outline(text)
      .map((h) => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}  (line ${h.line})`)
      .join('\n')
  const savedMsg = (id, r) =>
    `${r.created ? 'Created' : r.changed ? 'Updated' : 'No change to'} ${id}.md (${r.text.split('\n').length - 1} lines). Outline:\n${outlineText(r.text)}`
  const DOC = { type: 'string', description: 'Document id = file name without .md, e.g. "02-combat".' }

  tool(
    {
      name: 'gdd_list',
      label: 'GDD: list docs',
      description:
        'List the game design documents (GDD) in the shared design-doc library that the user reads in the "게임 기획서" viewer. Returns id, title, last update, and optionally each outline. Call first whenever the task involves game design, specs, balance or planning docs.',
      parameters: {
        type: 'object',
        properties: { outline: { type: 'boolean', description: 'Include every heading with line numbers.' } },
        additionalProperties: false
      }
    },
    async (a) => {
      const { dir, docs } = await listDocs()
      if (!docs.length) return `Library: ${dir}\nNo documents yet. Create one with gdd_write (e.g. id "00-overview").`
      const rows = docs.map((d) => {
        const head = `- ${d.id} — "${d.title}" — ${d.lines} lines — updated ${new Date(d.updated).toLocaleString('sv-SE')}`
        return a.outline ? `${head}\n${d.outline.map((h) => `    ${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text} (line ${h.line})`).join('\n')}` : head
      })
      return `Library: ${dir} (${docs.length} docs)\n${rows.join('\n')}\nLink between docs with [text](gdd://<id>#<heading>).`
    }
  )

  tool(
    {
      name: 'gdd_read',
      label: 'GDD: read',
      description: 'Read a design document (Markdown), whole or one section. Section = heading text or "Parent > Child" path; includes its subsections.',
      parameters: {
        type: 'object',
        properties: {
          doc: DOC,
          section: { type: 'string', description: 'Optional heading text or "Parent > Child".' },
          lineNumbers: { type: 'boolean', description: 'Prefix each line with its number.' }
        },
        required: ['doc'],
        additionalProperties: false
      }
    },
    async (a) => {
      const id = normId(a.doc)
      const text = await readDoc(id)
      let lines = text.replace(/\n$/, '').split('\n')
      let first = 1
      if (a.section) {
        const r = resolveSection(text, a.section)
        if (!r.found) throw new Error(`Section not found: "${a.section}". Outline:\n${outlineText(text)}`)
        lines = r.lines.slice(r.found.start, r.found.end)
        first = r.found.start + 1
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
      }
      const body = a.lineNumbers ? lines.map((l, k) => `${first + k}\t${l}`).join('\n') : lines.join('\n')
      return `[${id}] "${md.titleOf(text, id)}" lines ${first}-${first + lines.length - 1} of ${text.split('\n').length - 1}\n\n${body}`
    }
  )

  tool(
    {
      name: 'gdd_write',
      label: 'GDD: write doc',
      description:
        'Create a design document or replace its whole content. Markdown: first "# " heading is the title; tables, lists, task lists ([ ]/[x]), code fences, > quotes supported; link docs with [text](gdd://<id>#<heading>). For partial changes prefer gdd_update_section or gdd_edit. The previous version is backed up automatically.',
      parameters: {
        type: 'object',
        properties: { doc: DOC, content: { type: 'string', description: 'Full Markdown content.' } },
        required: ['doc', 'content'],
        additionalProperties: false
      }
    },
    async (a) => {
      const id = normId(a.doc)
      if (typeof a.content !== 'string') throw new Error('content must be a string')
      return withLock(id, async () => savedMsg(id, await writeDoc(id, a.content)))
    }
  )

  tool(
    {
      name: 'gdd_update_section',
      label: 'GDD: update section',
      description:
        'Replace, append to, or prepend to one section of a design document. The section body is everything under the heading up to the next heading of the same or higher level (subsections included); the heading line itself is kept. Missing section: created at the end of the document (or at the end of the parent when using "Parent > New").',
      parameters: {
        type: 'object',
        properties: {
          doc: DOC,
          section: { type: 'string', description: 'Heading text or "Parent > Child".' },
          content: { type: 'string', description: 'Markdown body WITHOUT the section heading line.' },
          mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'Default replace.' },
          level: { type: 'integer', minimum: 1, maximum: 6, description: 'Heading level when the section is created (default 2, or parent+1).' }
        },
        required: ['doc', 'section', 'content'],
        additionalProperties: false
      }
    },
    async (a) => {
      const id = normId(a.doc)
      if (typeof a.content !== 'string') throw new Error('content must be a string')
      return withLock(id, async () => {
        const text = await readDoc(id)
        const r = resolveSection(text, a.section)
        const bodyLines = trimBlank(lf(a.content).split('\n'))
        const lines = r.lines
        let action
        if (r.found) {
          const { start, end } = r.found
          const existing = trimBlank(lines.slice(start + 1, end))
          const mode = a.mode || 'replace'
          const next =
            mode === 'append'
              ? [...existing, ...(existing.length && bodyLines.length ? [''] : []), ...bodyLines]
              : mode === 'prepend'
                ? [...bodyLines, ...(existing.length && bodyLines.length ? [''] : []), ...existing]
                : bodyLines
          const block = [lines[start], ...(next.length ? ['', ...next] : []), ...(end < lines.length ? [''] : [])]
          lines.splice(start, end - start, ...block)
          action = `${mode} section "${r.found.heading}"`
        } else {
          if (!r.missing) throw new Error(`Parent section not found for "${a.section}". Outline:\n${outlineText(text)}`)
          const level = a.level || (r.parent ? Math.min(6, r.parent.level + 1) : 2)
          const at = r.parent ? r.parent.end : lines.length
          const before = trimBlank(lines.slice(0, at))
          const after = lines.slice(at)
          const block = [`${'#'.repeat(level)} ${r.missing}`, ...(bodyLines.length ? ['', ...bodyLines] : [])]
          lines.splice(0, lines.length, ...before, '', ...block, ...(trimBlank(after).length ? ['', ...after] : []))
          action = `created section "${r.missing}"`
        }
        return `${action}. ${savedMsg(id, await writeDoc(id, lines.join('\n')))}`
      })
    }
  )

  tool(
    {
      name: 'gdd_edit',
      label: 'GDD: edit text',
      description:
        'Exact find/replace edits on a design document, applied in order and atomically (all or nothing). Each find must match exactly once, or exactly `count` times. Good for tweaking numbers in balance tables or single sentences.',
      parameters: {
        type: 'object',
        properties: {
          doc: DOC,
          edits: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                find: { type: 'string', description: 'Exact existing text (copy from gdd_read).' },
                replace: { type: 'string' },
                count: { type: 'integer', minimum: 1, description: 'Expected number of matches; all are replaced.' }
              },
              required: ['find', 'replace'],
              additionalProperties: false
            }
          }
        },
        required: ['doc', 'edits'],
        additionalProperties: false
      }
    },
    async (a) => {
      const id = normId(a.doc)
      if (!Array.isArray(a.edits) || !a.edits.length) throw new Error('edits must be a non-empty array')
      return withLock(id, async () => {
        let text = await readDoc(id)
        a.edits.forEach((e, k) => {
          const find = lf(e && e.find)
          if (!find) throw new Error(`edits[${k}].find is empty`)
          const n = text.split(find).length - 1
          const want = e.count || 1
          if (n !== want) {
            throw new Error(
              `edits[${k}]: "${find.slice(0, 80)}" matched ${n} times, expected ${want}. No changes were written. ${n ? 'Add more context or set count.' : 'Re-read the doc with gdd_read.'}`
            )
          }
          text = text.split(find).join(lf(e.replace))
        })
        return savedMsg(id, await writeDoc(id, text))
      })
    }
  )

  tool(
    {
      name: 'gdd_search',
      label: 'GDD: search',
      description: 'Case-insensitive text search across all design documents (or one). Returns doc:line: text with the enclosing heading.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, doc: { type: 'string', description: 'Optional doc id to limit the search.' } },
        required: ['query'],
        additionalProperties: false
      }
    },
    async (a) => {
      const q = String(a.query || '').toLowerCase()
      if (!q) throw new Error('query is empty')
      const { docs } = await listDocs()
      const only = a.doc ? normId(a.doc) : null
      const hits = []
      for (const d of docs) {
        if (only && d.id !== only) continue
        const lines = (await readDoc(d.id)).split('\n')
        lines.forEach((l, k) => {
          if (!l.toLowerCase().includes(q)) return
          const h = d.outline.filter((o) => o.line <= k + 1).pop()
          hits.push(`${d.id}:${k + 1}${h ? ` [${h.text}]` : ''}: ${l.trim().slice(0, 200)}`)
        })
      }
      if (!hits.length) return `No matches for "${a.query}".`
      return `${hits.length} matches${hits.length > 200 ? ' (first 200)' : ''}:\n${hits.slice(0, 200).join('\n')}`
    }
  )

  tool(
    {
      name: 'gdd_delete',
      label: 'GDD: delete doc',
      description: 'Delete a design document. A backup is kept in the library .history folder. Only when the user asked for it.',
      parameters: { type: 'object', properties: { doc: DOC }, required: ['doc'], additionalProperties: false }
    },
    async (a) => {
      const id = normId(a.doc)
      return withLock(id, async () => {
        const text = await readDoc(id)
        const dir = await ensureDir()
        await backup(dir, id, text)
        await fsp.unlink(fileOf(dir, id))
        notify()
        return `Deleted ${id}.md (backup in ${path.join(dir, '.history', id)}).`
      })
    }
  )

  tool(
    {
      name: 'gdd_show',
      label: 'GDD: show to user',
      description: 'Open the design-doc viewer in the app for the user, optionally at a document and section (e.g. after you changed it).',
      parameters: {
        type: 'object',
        properties: { doc: { type: 'string', description: 'Optional doc id.' }, section: { type: 'string', description: 'Optional heading text.' } },
        additionalProperties: false
      }
    },
    async (a) => {
      const id = a.doc ? normId(a.doc) : null
      if (id && !(await exists(id))) throw new Error(`Document not found: "${id}".`)
      ctx.channel.emit('gdd.show', { doc: id, section: a.section || null })
      return `Shown${id ? ` ${id}` : ''}${a.section ? ` > ${a.section}` : ''} in the 게임 기획서 viewer.`
    }
  )

  ctx.registerHostUriScheme({
    scheme: 'gdd',
    description: 'Game design documents (Markdown). gdd:// lists docs, gdd://<id> reads/writes a whole doc.',
    writable: true,
    async read(uri) {
      const rest = uri.replace(/^gdd:\/\//i, '').split('#')[0].replace(/\/+$/, '')
      if (!rest) {
        const { dir, docs } = await listDocs()
        return `# Game design docs (${dir})\n\n${docs.map((d) => `- gdd://${d.id} — ${d.title}`).join('\n') || '(none)'}\n`
      }
      return readDoc(normId(md.safeDecode(rest)))
    },
    async write(uri, content) {
      const id = normId(md.safeDecode(uri.replace(/^gdd:\/\//i, '').split('#')[0]))
      await withLock(id, () => writeDoc(id, content))
    }
  })

  ctx.log(`game design docs ready at ${docsDir()}`)
}

exports.deactivate = () => {
  if (!state) return
  clearTimeout(state.timer)
  if (state.watcher) state.watcher.close()
  if (state.settingsSub) state.settingsSub.dispose()
  state = null
}

function exportPage(esc, doc, docs, r, stamp) {
  const nav = docs
    .map((d) => `<li${d.id === doc.id ? ' class="on"' : ''}><a href="${esc(encodeURIComponent(d.id))}.html">${esc(d.title)}</a></li>`)
    .join('')
  const toc = r.toc
    .filter((t) => t.level >= 2 && t.level <= 3)
    .map((t) => `<li class="l${t.level}"><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`)
    .join('')
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)} — 게임 기획서</title>
<style>
:root{--bg:#fff;--bg2:#f6f7f9;--fg:#1a1c22;--muted:#5b606d;--line:#e1e2e7;--accent:#4555d4;--code:#f3f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#111216;--bg2:#16171b;--fg:#e4e6eb;--muted:#9a9fab;--line:#282a31;--accent:#8b9dff;--code:#0c0d10}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 'Pretendard Variable',Pretendard,'Segoe UI','Malgun Gothic',system-ui,sans-serif;display:grid;grid-template-columns:260px 1fr;min-height:100vh}
nav{background:var(--bg2);border-right:1px solid var(--line);padding:20px 14px;position:sticky;top:0;height:100vh;overflow:auto}
nav h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:16px 6px 6px}nav ul{list-style:none;margin:0;padding:0}
nav a{display:block;padding:4px 8px;border-radius:6px;color:var(--fg);text-decoration:none}nav a:hover{background:var(--line)}nav li.on>a{background:var(--accent);color:#fff}
nav li.l3 a{padding-left:22px;font-size:13px;color:var(--muted)}
main{max-width:920px;padding:40px 48px 80px}footer{color:var(--muted);font-size:12px;margin-top:48px}
@media print{body{display:block}nav{display:none}main{max-width:none;padding:0}}
${DOC_CSS('main')}
</style></head><body>
<nav><h2>문서</h2><ul>${nav}</ul>${toc ? `<h2>목차</h2><ul>${toc}</ul>` : ''}</nav>
<main>${r.html}<footer>${esc(doc.id)}.md · 내보낸 시각 ${esc(stamp)}</footer></main>
</body></html>
`
}

function DOC_CSS(s) {
  return `${s} h1,${s} h2,${s} h3,${s} h4{line-height:1.3;margin:1.6em 0 .6em}${s} h1{font-size:2em;margin-top:0;padding-bottom:.3em;border-bottom:1px solid var(--line)}
${s} h2{font-size:1.45em;padding-bottom:.2em;border-bottom:1px solid var(--line)}${s} h3{font-size:1.2em}
${s} a{color:var(--accent)}${s} code{font-family:'JetBrains Mono',D2Coding,Consolas,monospace;font-size:.88em;background:var(--code);padding:.1em .35em;border-radius:4px}
${s} pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}${s} pre code{background:none;padding:0}
${s} blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid var(--accent);color:var(--muted);background:var(--bg2);border-radius:0 6px 6px 0}
${s} .gdd-table{overflow-x:auto;margin:1em 0}${s} table{border-collapse:collapse;min-width:50%}${s} th,${s} td{border:1px solid var(--line);padding:6px 12px}
${s} th{background:var(--bg2);font-weight:600}${s} tbody tr:nth-child(even){background:var(--bg2)}${s} .al-right{text-align:right}${s} .al-center{text-align:center}${s} .al-left{text-align:left}
${s} hr{border:0;border-top:1px solid var(--line);margin:2em 0}${s} li.gdd-task-item{list-style:none;margin-left:-1.2em}${s} .gdd-task.done{color:var(--accent)}`
}
