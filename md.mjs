// Minimal, safe Markdown -> HTML. Raw HTML is never passed through: every text run is escaped.
// Used by main.js (viewer payload + standalone HTML export).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c])
const esc = escapeHtml

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

export const ID_PREFIX = 'gdd-h-'

export function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const normalize = (src) => String(src ?? '').replace(/\r\n?/g, '\n')

/** Headings outside code fences: [{level, text, line (1-based)}] */
export function outline(src) {
  const lines = normalize(src).split('\n')
  const out = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(FENCE)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) fence = null
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    const h = lines[i].match(HEADING)
    if (h) out.push({ level: h[1].length, text: h[2], line: i + 1 })
  }
  return out
}

export function titleOf(src, fallback) {
  const h = outline(src).find((x) => x.level === 1)
  return h && h.text.trim() ? h.text.trim() : fallback
}

/**
 * @param {string} src markdown
 * @param {{rewriteLink?: (gddUrl: string) => string}} [opts]
 * @returns {{html: string, toc: Array<{level:number,text:string,id:string}>}}
 */
export function renderMarkdown(src, opts = {}) {
  const used = new Map()
  const slug = (text) => {
    const base =
      String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'section'
    const n = used.get(base) || 0
    used.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
  const cx = { toc: [], slug, opts }
  const html = blocks(normalize(src).replace(/\t/g, '    ').split('\n'), cx, true)
  return { html, toc: cx.toc }
}

function isTableStart(lines, i) {
  return (
    lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].includes('-') && TABLE_SEP.test(lines[i + 1])
  )
}

function startsBlock(lines, i) {
  const l = lines[i]
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || isTableStart(lines, i)
}

function cells(row) {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function blocks(lines, cx, topLevel) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    let m
    if ((m = line.match(FENCE))) {
      const fence = m[1]
      const lang = m[2]
      const buf = []
      i++
      while (i < lines.length) {
        const f = lines[i].match(FENCE)
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) break
        buf.push(lines[i])
        i++
      }
      i++
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    if ((m = line.match(HEADING))) {
      const level = m[1].length
      const id = ID_PREFIX + cx.slug(m[2])
      if (topLevel) cx.toc.push({ level, text: m[2], id })
      out.push(`<h${level} id="${esc(id)}">${inline(m[2], cx)}</h${level}>`)
      i++
      continue
    }
    if (HR.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const buf = []
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      out.push(`<blockquote>${blocks(buf, cx, false)}</blockquote>`)
      continue
    }
    if (isTableStart(lines, i)) {
      const head = cells(line)
      const aligns = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''
      )
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]))
      const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` class="al-${aligns[k]}"` : ''}>${inline(c ?? '', cx)}</${tag}>`
      out.push(
        `<div class="gdd-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      )
      continue
    }
    if (LIST.test(line)) {
      const r = list(lines, i, cx)
      out.push(r.html)
      i = r.next
      continue
    }
    const buf = [line.replace(/^\s+/, '')]
    i++
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) buf.push(lines[i++].replace(/^\s+/, ''))
    out.push(`<p>${inline(buf.join('\n'), cx)}</p>`)
  }
  return out.join('\n')
}

function list(lines, start, cx) {
  const first = lines[start].match(LIST)
  const base = first[1].length
  const ordered = /\d/.test(first[2])
  const items = []
  let i = start
  let cur = null
  let loose = false
  let sawBlank = false
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      sawBlank = true
      i++
      continue
    }
    const indent = line.match(/^\s*/)[0].length
    const m = line.match(LIST)
    if (m && indent >= base && indent < base + 2) {
      if (/\d/.test(m[2]) !== ordered) break
      if (sawBlank && cur) loose = true
      cur = { lines: [m[3]], contentIndent: m[0].length - m[3].length }
      items.push(cur)
      sawBlank = false
      i++
      continue
    }
    if (cur && indent >= base + 2) {
      if (sawBlank) cur.lines.push('')
      cur.lines.push(line.slice(Math.min(indent, cur.contentIndent)))
      sawBlank = false
      i++
      continue
    }
    if (cur && !sawBlank && !startsBlock(lines, i)) {
      cur.lines.push(line.trim())
      i++
      continue
    }
    break
  }
  const tag = ordered ? 'ol' : 'ul'
  const startNum = ordered ? parseInt(first[2], 10) : 1
  const body = items
    .map((it) => {
      let task = ''
      const t = it.lines[0].match(/^\[([ xX])\]\s+/)
      if (t) {
        it.lines[0] = it.lines[0].slice(t[0].length)
        task = t[1] === ' ' ? '<span class="gdd-task">☐</span> ' : '<span class="gdd-task done">☑</span> '
      }
      let inner = blocks(it.lines, cx, false)
      if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1')
      return `<li${task ? ' class="gdd-task-item"' : ''}>${task}${inner}</li>`
    })
    .join('')
  return { html: `<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>${body}</${tag}>`, next: i }
}

function linkHref(url, cx) {
  const u = String(url).trim()
  if (/^gdd:\/\//i.test(u)) return cx.opts.rewriteLink ? cx.opts.rewriteLink(u) : u
  if (/^(https?:|mailto:)/i.test(u)) return u
  if (u.startsWith('#')) return '#' + ID_PREFIX + safeDecode(u.slice(1))
  return null
}

function inline(src, cx) {
  const slots = []
  const keep = (html) => `\u0001${slots.push(html) - 1}\u0002`
  let s = String(src)
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${esc(code.trim())}</code>`))
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c) => keep(esc(c)))
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt, url) => {
    const href = linkHref(url, cx)
    return keep(href ? `<a class="gdd-img-link" href="${esc(href)}">🖼 ${esc(alt || url)}</a>` : esc(alt))
  })
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, text, url) => {
    const href = linkHref(url, cx)
    const inner = inline(text, cx)
    return keep(href ? `<a href="${esc(href)}">${inner}</a>` : inner)
  })
  s = s.replace(/<?((?:https?|gdd):\/\/[^\s<>"]*[^\s<>".,;:!?)\]'])>?/g, (_, url) => {
    const href = linkHref(url, cx)
    return keep(href ? `<a href="${esc(href)}">${esc(url)}</a>` : esc(url))
  })
  s = esc(s)
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\p{L}\p{N}])\*(?=\S)([^*]*?\S)\*(?![*\p{L}\p{N}])/gu, '$1<em>$2</em>')
    .replace(/(^|[^_\p{L}\p{N}])_(?=\S)([^_]*?\S)_(?![_\p{L}\p{N}])/gu, '$1<em>$2</em>')
    .replace(/ {2,}\n/g, '<br>\n')
  return s.replace(/\u0001(\d+)\u0002/g, (_, n) => slots[Number(n)])
}
