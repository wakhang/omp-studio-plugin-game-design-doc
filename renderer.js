// 게임 기획서 viewer: full view + right dock panel. HTML comes pre-rendered (escaped) from main.js.

const VIEW_ID = 'gdd'
const ID_PREFIX = 'gdd-h-'

let viewers = new Set()
let pending = null

const TEMPLATE = `
<aside class="gdd-side">
  <input class="gdd-filter" type="search" placeholder="문서 찾기…">
  <ul class="gdd-list"></ul>
  <div class="gdd-label">목차</div>
  <ul class="gdd-toc"></ul>
</aside>
<section class="gdd-main">
  <header class="gdd-bar">
    <select class="gdd-select" title="문서 선택"></select>
    <div class="gdd-heading"><div class="gdd-title"></div><div class="gdd-meta"></div></div>
    <div class="gdd-actions">
      <button type="button" data-act="browser" title="모든 문서를 HTML로 내보내고 브라우저에서 엽니다">브라우저로 열기</button>
      <button type="button" data-act="folder" title="기획서 폴더 열기">폴더</button>
      <button type="button" data-act="refresh" title="새로고침">↻</button>
    </div>
  </header>
  <article class="gdd-doc"></article>
</section>`

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const errText = (e) => String((e && e.message) || e)
const fmtTime = (ms) => new Date(ms).toLocaleString('sv-SE').slice(0, 16)
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  return fmtTime(ms).slice(0, 10)
}

export function activate(ctx) {
  viewers = new Set()
  pending = null
  const viewSlotId = `${ctx.pluginId}.view.${VIEW_ID}`
  const openView = () => ctx.ui.openView(viewSlotId)

  ctx.registerView({ id: VIEW_ID, title: '게임 기획서', icon: '📘', mount: (el) => mountViewer(ctx, el, false) })
  ctx.registerPanel({ id: 'gdd.panel', title: '기획서', location: 'right', mount: (el) => mountViewer(ctx, el, true) })
  ctx.registerCommand({ id: 'gdd.open', title: '게임 기획서 열기', run: openView })

  ctx.channel.on('gdd.show', (p) => {
    const target = { doc: (p && p.doc) || null, section: (p && p.section) || null }
    const full = [...viewers].filter((v) => !v.compact)
    if (full.length) for (const v of full) v.show(target)
    else {
      pending = target
      openView()
    }
  })
}

export function deactivate() {
  viewers = new Set()
  pending = null
}

function mountViewer(ctx, el, compact) {
  const root = document.createElement('div')
  root.className = 'gdd-root' + (compact ? ' gdd-compact' : '')
  root.innerHTML = TEMPLATE
  el.replaceChildren(root)
  const $ = (sel) => root.querySelector(sel)
  const listEl = $('.gdd-list')
  const tocEl = $('.gdd-toc')
  const docEl = $('.gdd-doc')
  const selectEl = $('.gdd-select')
  const filterEl = $('.gdd-filter')
  const titleEl = $('.gdd-title')
  const metaEl = $('.gdd-meta')

  let docs = []
  let dir = ''
  let current = null
  let toc = []
  let disposed = false
  let seq = 0
  let refreshTimer = null

  const scrollToId = (id) => {
    const target = docEl.querySelector('#' + CSS.escape(id))
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const scrollToSection = (section) => {
    const q = String(section).split('>').pop().trim().replace(/^#+\s*/, '').toLowerCase()
    const hit = toc.find((t) => t.text.trim().toLowerCase() === q) || toc.find((t) => t.text.toLowerCase().includes(q))
    if (hit) scrollToId(hit.id)
  }

  const renderList = () => {
    const q = filterEl.value.trim().toLowerCase()
    listEl.replaceChildren(
      ...docs
        .filter((d) => !q || d.title.toLowerCase().includes(q) || d.id.toLowerCase().includes(q))
        .map((d) => {
          const li = document.createElement('li')
          li.className = 'gdd-item' + (d.id === current ? ' active' : '')
          li.title = `${d.id}.md`
          const t = document.createElement('div')
          t.className = 'gdd-item-title'
          t.textContent = d.title
          const s = document.createElement('div')
          s.className = 'gdd-item-sub'
          s.textContent = `${d.id} · ${ago(d.updated)}`
          li.append(t, s)
          li.addEventListener('click', () => select(d.id))
          return li
        })
    )
    selectEl.replaceChildren(
      ...docs.map((d) => {
        const o = document.createElement('option')
        o.value = d.id
        o.textContent = d.title
        o.selected = d.id === current
        return o
      })
    )
  }

  const renderEmpty = () => {
    titleEl.textContent = '게임 기획서'
    metaEl.textContent = dir
    tocEl.replaceChildren()
    const box = document.createElement('div')
    box.className = 'gdd-empty'
    const h = document.createElement('h2')
    h.textContent = '아직 기획서가 없습니다'
    const p = document.createElement('p')
    p.textContent = '아무 세션에서나 에이전트에게 "게임 기획서 만들어줘"처럼 요청하면 gdd_* 도구로 문서를 만들고, 여기서 바로 볼 수 있습니다.'
    const p2 = document.createElement('p')
    p2.className = 'gdd-dir'
    p2.textContent = `저장 폴더: ${dir}`
    box.append(h, p, p2)
    docEl.replaceChildren(box)
  }

  const loadDoc = async (opts = {}) => {
    const my = ++seq
    if (!current) {
      renderEmpty()
      return
    }
    let doc
    try {
      doc = await ctx.channel.invoke('gdd.get', { id: current })
    } catch (e) {
      if (!disposed && my === seq) docEl.textContent = '불러오기 실패: ' + errText(e)
      return
    }
    if (disposed || my !== seq) return
    const scroll = docEl.scrollTop
    titleEl.textContent = doc.title
    metaEl.textContent = `${doc.id}.md · ${doc.lines}줄 · 수정 ${fmtTime(doc.updated)}`
    docEl.innerHTML = doc.html
    toc = doc.toc
    tocEl.replaceChildren(
      ...toc
        .filter((t) => t.level >= 2 && t.level <= 3)
        .map((t) => {
          const li = document.createElement('li')
          li.className = `gdd-toc-l${t.level}`
          li.textContent = t.text
          li.addEventListener('click', () => scrollToId(t.id))
          return li
        })
    )
    if (opts.section) requestAnimationFrame(() => scrollToSection(opts.section))
    else docEl.scrollTop = opts.keepScroll ? scroll : 0
  }

  const refresh = async (opts = {}) => {
    let res
    try {
      res = await ctx.channel.invoke('gdd.list')
    } catch (e) {
      if (!disposed) docEl.textContent = '목록을 불러오지 못했습니다: ' + errText(e)
      return
    }
    if (disposed) return
    docs = res.docs
    dir = res.dir
    if (!current || !docs.some((d) => d.id === current)) {
      const last = await ctx.storage.get('lastDoc')
      current = docs.some((d) => d.id === last) ? last : docs[0] ? docs[0].id : null
    }
    renderList()
    await loadDoc(opts)
  }

  const select = async (id, section) => {
    if (!docs.some((d) => d.id === id)) {
      ctx.ui.toast('warning', `문서를 찾을 수 없습니다: ${id}`)
      return
    }
    current = id
    ctx.storage.set('lastDoc', id)
    renderList()
    await loadDoc({ section })
  }

  const viewer = {
    compact,
    async show(target) {
      await refresh({ keepScroll: true })
      if (target.doc) await select(target.doc, target.section)
      else if (target.section) scrollToSection(target.section)
    }
  }
  viewers.add(viewer)

  filterEl.addEventListener('input', renderList)
  selectEl.addEventListener('change', () => select(selectEl.value))
  root.querySelector('.gdd-actions').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button')
    if (!btn) return
    try {
      if (btn.dataset.act === 'refresh') await refresh({ keepScroll: true })
      else if (btn.dataset.act === 'folder') await ctx.channel.invoke('gdd.openFolder')
      else if (btn.dataset.act === 'browser') {
        btn.disabled = true
        await ctx.channel.invoke('gdd.export', { id: current })
      }
    } catch (e) {
      ctx.ui.toast('error', errText(e))
    } finally {
      btn.disabled = false
    }
  })
  docEl.addEventListener('click', (ev) => {
    const a = ev.target.closest('a')
    if (!a) return
    ev.preventDefault()
    const href = a.getAttribute('href') || ''
    if (href.startsWith('#')) scrollToId(safeDecode(href.slice(1)))
    else if (/^gdd:\/\//i.test(href)) {
      const [rawId, hash] = href.replace(/^gdd:\/\//i, '').split('#')
      const id = safeDecode(rawId).replace(/\/+$/, '').replace(/\.md$/i, '')
      select(id).then(() => {
        if (hash) scrollToId(ID_PREFIX + safeDecode(hash))
      })
    } else ctx.channel.invoke('gdd.openExternal', { url: href }).catch((e) => ctx.ui.toast('error', errText(e)))
  })

  const changedSub = ctx.channel.on('gdd.changed', () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => refresh({ keepScroll: true }), 100)
  })

  if (!compact && pending) {
    const target = pending
    pending = null
    viewer.show(target)
  } else refresh()

  return () => {
    disposed = true
    clearTimeout(refreshTimer)
    changedSub.dispose()
    viewers.delete(viewer)
    el.replaceChildren()
  }
}
