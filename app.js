/* ============================================================
   Akshardham Associates — Smart Buyer Network (landing page)
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const isDesktop = matchMedia('(min-width: 1024px)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches

/* ---------- toast ---------- */
function toast(msg, kind = 'ok') {
  let wrap = $('#toast-wrap')
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap) }
  const t = document.createElement('div')
  t.className = `toast ${kind}`
  t.innerHTML = `<i class="fas ${kind === 'ok' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i><span>${msg}</span>`
  wrap.appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350) }, 4200)
}

/* ---------- modals ---------- */
function openModal(which) {
  $('#modal-' + which).classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}
function closeModal(which) {
  $('#modal-' + which).classList.add('hidden')
  document.body.style.overflow = ''
}
$$('.modal-backdrop').forEach(m => m.addEventListener('click', e => { if (e.target === m) { m.classList.add('hidden'); document.body.style.overflow = '' } }))
addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach(m => { m.classList.add('hidden'); document.body.style.overflow = '' }) })

/* ---------- 3D tilt cards (desktop only) ---------- */
if (isDesktop) {
  $$('[data-tilt]').forEach(card => {
    card.insertAdjacentHTML('beforeend', '<span class="tilt-glare"></span>')
    let raf = null
    card.addEventListener('mousemove', e => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        const r = card.getBoundingClientRect()
        const px = (e.clientX - r.left) / r.width
        const py = (e.clientY - r.top) / r.height
        const rx = (0.5 - py) * 9
        const ry = (px - 0.5) * 11
        card.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-4px)`
        card.style.boxShadow = `${-ry * 2.2}px ${14 + rx * 1.5}px 44px rgba(34,21,7,.18)`
        card.style.setProperty('--gx', `${px * 100}%`)
        card.style.setProperty('--gy', `${py * 100}%`)
        raf = null
      })
    })
    card.addEventListener('mouseleave', () => {
      card.style.transition = 'transform .5s cubic-bezier(.22,1,.36,1), box-shadow .5s ease'
      card.style.transform = ''
      card.style.boxShadow = ''
      setTimeout(() => card.style.transition = '', 500)
    })
  })
}

/* ---------- parallax (desktop only) ---------- */
if (isDesktop) {
  const layers = $$('[data-parallax]')
  let ticking = false
  addEventListener('scroll', () => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(() => {
      const y = scrollY
      layers.forEach(el => { el.style.transform = `translateY(${y * parseFloat(el.dataset.parallax)}px)` })
      ticking = false
    })
  }, { passive: true })
}

/* ---------- reveal on scroll ---------- */
const revealIO = new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('revealed'); revealIO.unobserve(en.target) } })
}, { threshold: 0.12 })
$$('[data-reveal]').forEach(el => revealIO.observe(el))

/* ---------- animated counters ---------- */
function animateCount(el, target, dur = 1600) {
  const t0 = performance.now()
  const step = now => {
    const p = Math.min(1, (now - t0) / dur)
    const eased = 1 - Math.pow(1 - p, 3)
    el.textContent = Math.round(target * eased).toLocaleString('en-IN')
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
let statsDone = false
const statsIO = new IntersectionObserver(async entries => {
  if (!entries.some(e => e.isIntersecting) || statsDone) return
  statsDone = true
  statsIO.disconnect()
  try {
    const s = await (await fetch('/api/stats')).json()
    animateCount($('#stat-plots'), s.plots)
    animateCount($('#stat-buyers'), s.buyers)
    animateCount($('#stat-matches'), s.matches)
    animateCount($('#stat-locs'), s.locations)
  } catch {
    ;[['#stat-plots', 12], ['#stat-buyers', 350], ['#stat-matches', 210], ['#stat-locs', 14]].forEach(([id, v]) => animateCount($(id), v))
  }
}, { threshold: 0.3 })
statsIO.observe($('#stats-section'))

/* ---------- browse listings ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Photo lightbox — click a listing photo to open it full-size
function openPhoto(src) {
  const o = document.createElement('div')
  o.style.cssText = 'position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out'
  o.innerHTML = `<img src="${esc(src)}" alt="Property photo" style="max-width:95%;max-height:92%;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.55)"><span style="position:absolute;top:10px;right:22px;font-size:42px;color:#fff;line-height:1;font-family:sans-serif">&times;</span>`
  o.addEventListener('click', () => { o.remove(); document.body.style.overflow = '' })
  document.body.appendChild(o)
  document.body.style.overflow = 'hidden'
}

const WA_NUMBER = '919166064096'
const LISTINGS = {}           // id -> item cache (from browse)
let CURRENT_ITEMS = []        // latest browse result (for map view)
let MAP_VIEW = false
const photoUrl = p => typeof p === 'string' ? p : (p && p.url) || ''
const firstPhoto = it => (it.photos && it.photos.length) ? photoUrl(it.photos[0]) : null
const priceOf = it => it.txn === 'rent'
  ? (it.rent_monthly ? `₹${Number(it.rent_monthly).toLocaleString('en-IN')}/mo` : 'Rent on request')
  : (it.rate_lakh ? `₹${it.rate_lakh} L` : 'Price on Request')
// zameen → rakba (बीघा/बिस्वा), plot → sq ft
const isZameen = it => it.property_kind === 'zameen'
const sizeLabel = it => isZameen(it) ? (it.rakba ? 'रकबा ' + it.rakba : '—') : (it.size_sqyd ? it.size_sqyd + ' sq ft' : '—')
// small "For Rent" / "For Sale" pill
const txnPill = it => it.txn === 'rent'
  ? '<span style="background:#EEF2FF;color:#4338CA;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700">For Rent</span>'
  : '<span style="background:#FEF5EC;color:#B44E0E;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700">For Sale</span>'

function waFor(it) {
  const title = `${it.type} — ${it.colony || it.location}`
  const price = it.rate_lakh ? `₹${it.rate_lakh} Lakh` : 'Price on request'
  const link = `${location.origin}/#p=${it.id}`
  const text = `Namaste 🙏 mujhe ye property chahiye:\n${title}\n📍 ${it.location}${it.size_sqyd ? ' · ' + it.size_sqyd + ' sq ft' : ''} · ${price}\n${link}\n\nDetails bhej dijiye.`
  return `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(text)}`
}

/* ---------- shortlist (localStorage, no login) ---------- */
const SL_KEY = 'sbn_shortlist'
const getSL = () => { try { return JSON.parse(localStorage.getItem(SL_KEY) || '[]') } catch { return [] } }
const inSL = id => getSL().includes(Number(id))
function toggleShortlist(id, ev) {
  if (ev) ev.stopPropagation()
  id = Number(id)
  const s = getSL(); const i = s.indexOf(id)
  if (i >= 0) s.splice(i, 1); else { s.push(id); toast('Saved to shortlist ❤️') }
  localStorage.setItem(SL_KEY, JSON.stringify(s))
  updateShortlistUI()
}
function updateShortlistUI() {
  const n = getSL().length
  document.querySelectorAll('.sl-count').forEach(b => { b.textContent = n; b.style.display = n ? '' : 'none' })
  document.querySelectorAll('[data-heart]').forEach(h => {
    h.className = inSL(h.dataset.heart) ? 'fas fa-heart text-red-500' : 'far fa-heart'
  })
}
function openShortlist() {
  const ids = getSL()
  const items = ids.map(id => LISTINGS[id]).filter(Boolean)
  const grid = $('#browse-grid')
  document.getElementById('browse-section').scrollIntoView({ behavior: 'smooth' })
  if (!ids.length) { grid.innerHTML = `<div class="col-span-full text-center py-14 text-stone-500"><i class="fas fa-heart text-4xl text-brand-200"></i><p class="mt-3">No shortlisted properties yet. Tap the ❤️ on any listing.</p></div>`; return }
  grid.innerHTML = `<div class="col-span-full flex items-center justify-between"><b class="text-brand-900">❤️ Your Shortlist (${items.length})</b><button onclick="loadBrowse()" class="text-sm text-brand-600 font-semibold"><i class="fas fa-arrow-left mr-1"></i>Back to all</button></div>` + items.map(listingCard).join('')
  updateShortlistUI()
}

/* ---------- compare (up to 3) ---------- */
let COMPARE = []
function toggleCompare(id, ev) {
  if (ev) ev.stopPropagation()
  id = Number(id)
  const i = COMPARE.indexOf(id)
  if (i >= 0) COMPARE.splice(i, 1)
  else { if (COMPARE.length >= 3) { toast('Compare up to 3 at a time', 'err'); if (ev && ev.target) ev.target.checked = false; return } COMPARE.push(id) }
  updateCompareBar()
}
function updateCompareBar() {
  let bar = $('#compare-bar')
  if (!COMPARE.length) { if (bar) bar.remove(); return }
  if (!bar) { bar = document.createElement('div'); bar.id = 'compare-bar'; bar.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:60;background:#221507;color:#fff;border-radius:16px;padding:10px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 12px 30px rgba(0,0,0,.3)'; document.body.appendChild(bar) }
  bar.innerHTML = `<span style="font-size:14px">${COMPARE.length} selected</span>
    <button onclick="openCompare()" style="background:#E86B1C;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer">Compare</button>
    <button onclick="clearCompare()" style="background:transparent;color:#fff;border:none;cursor:pointer;font-size:18px">&times;</button>`
}
function clearCompare() { COMPARE = []; updateCompareBar(); document.querySelectorAll('.cmp-chk').forEach(c => c.checked = false) }
function openCompare() {
  const items = COMPARE.map(id => LISTINGS[id]).filter(Boolean)
  if (items.length < 2) return toast('Select at least 2 to compare', 'err')
  const rows = [
    ['Photo', it => firstPhoto(it) ? `<img src="${esc(firstPhoto(it))}" style="width:100%;height:90px;object-fit:cover;border-radius:8px">` : '—'],
    ['Type', it => esc(it.type)],
    ['Location', it => esc(it.colony || it.location) + '<br><span style="color:#999;font-size:12px">' + esc(it.location) + '</span>'],
    ['Price', it => it.rate_lakh ? '₹' + it.rate_lakh + ' L' : 'On request'],
    ['Size / रकबा', it => sizeLabel(it)],
    ['Sent to buyers', it => (it.lead_count ? it.lead_count + 5 : 0) + ''],
    ['Details', it => esc(it.description || '—')],
    ['', it => `<a href="${waFor(it)}" target="_blank" style="display:inline-block;background:#25D366;color:#fff;padding:7px 12px;border-radius:8px;font-weight:700;text-decoration:none"><i class="fab fa-whatsapp"></i> Enquire</a>`],
  ]
  const o = mkOverlay('compare-overlay')
  o.innerHTML = `<div style="background:#fff;border-radius:20px;max-width:820px;width:96%;max-height:92vh;overflow:auto;padding:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><h3 style="font-weight:800;color:#221507;font-size:18px">Compare Properties</h3><button onclick="this.closest('#compare-overlay').remove();document.body.style.overflow=''" style="border:none;background:#f1f1f1;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px">&times;</button></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:${120 + items.length * 180}px">
      ${rows.map(([label, fn]) => `<tr><td style="padding:9px;border:1px solid #eee;color:#8a7a66;font-size:13px;width:120px;font-weight:600">${label}</td>${items.map(it => `<td style="padding:9px;border:1px solid #eee;font-size:14px;vertical-align:top">${fn(it)}</td>`).join('')}</tr>`).join('')}
    </table></div>
  </div>`
}

/* ---------- overlay helper ---------- */
function mkOverlay(id) {
  let o = document.getElementById(id)
  if (o) o.remove()
  o = document.createElement('div'); o.id = id
  o.style.cssText = 'position:fixed;inset:0;z-index:1200;background:rgba(34,21,7,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px'
  o.addEventListener('click', e => { if (e.target === o) { o.remove(); document.body.style.overflow = '' } })
  document.body.appendChild(o); document.body.style.overflow = 'hidden'
  return o
}

/* ---------- property detail view (shareable link #p=ID) ---------- */
async function openDetail(id) {
  id = Number(id)
  let it = LISTINGS[id]
  if (!it) { try { const r = await fetch('/api/stock/' + id); if (!r.ok) throw 0; it = await r.json(); LISTINGS[id] = it } catch { toast('Property not found', 'err'); return } }
  history.replaceState(null, '', '#p=' + id)
  renderDetail(it)
}
function closeDetail() {
  const o = $('#detail-overlay'); if (o) o.remove()
  document.body.style.overflow = ''
  if (location.hash.startsWith('#p=')) history.replaceState(null, '', location.pathname + location.search)
}
// Share the branded /property/<id> link (shows a card preview on WhatsApp). Native share on mobile, copy on desktop.
async function shareProperty(id) {
  const it = LISTINGS[id] || {}
  const url = location.origin + '/property/' + id
  const text = `${it.type || 'Property'} — ${it.colony || it.location || ''}${it.rate_lakh ? ' · ₹' + it.rate_lakh + ' L' : ''}${it.size_sqyd ? ' · ' + it.size_sqyd + ' sq ft' : ''}\nAkshardham Associates`
  if (navigator.share) { try { await navigator.share({ title: 'Akshardham Associates', text, url }); return } catch (e) { if (e && e.name === 'AbortError') return } }
  try { await navigator.clipboard.writeText(url); toast('Link copy ho gaya — WhatsApp par paste karein ✅') }
  catch { prompt('Ye link copy karein:', url) }
}
// ---- detail page sections (A#9) ----
function factRow(label, val) {
  return `<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #f3ede3"><span style="color:#8a7a66;font-size:13px">${label}</span><span style="color:#221507;font-weight:600;font-size:13px;text-align:right">${val}</span></div>`
}
function factsHTML(it) {
  const ppsf = (it.rate_lakh && it.size_sqyd) ? '₹' + Math.round(it.rate_lakh * 100000 / it.size_sqyd).toLocaleString('en-IN') + ' /sq ft' : '—'
  let dt = '—'
  try { if (it.created_at) dt = new Date(it.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) } catch {}
  return `<div>
    <div style="font-size:13px;color:#8a7a66;font-weight:700;margin-bottom:4px"><i class="fas fa-circle-info" style="color:#E86B1C"></i> Facts &amp; Features</div>
    ${factRow('Listed for', it.txn === 'rent' ? 'Rent' : 'Sale')}
    ${factRow('Type', isZameen(it) ? 'Agricultural Land / ज़मीन' : esc(it.type || '—'))}
    ${factRow(isZameen(it) ? 'रकबा / Rakba' : 'Size', sizeLabel(it))}
    ${factRow(it.txn === 'rent' ? 'Monthly Rent' : 'Price', priceOf(it))}
    ${it.txn === 'rent' || isZameen(it) ? '' : factRow('Price / sq ft', ppsf)}
    ${factRow('Location', esc(it.location || '—'))}
    ${factRow(isZameen(it) ? 'गाँव / Village' : 'Colony / Area', esc(it.colony || '—'))}
    ${factRow('Verified', '<span style="color:#059669">Yes ✓</span>')}
    ${factRow('Interested buyers', it.lead_count > 0 ? (it.lead_count + 5) + ' buyers' : 'New listing')}
    ${factRow('Listed on', dt)}
  </div>`
}
function emiHTML(it) {
  if (!it.rate_lakh || it.txn === 'rent') return ''   // EMI only for sale listings
  const fld = (id, val, step) => `<label style="font-size:12px;color:#8a7a66">${id.label}<input id="${id.id}" type="number" value="${val}"${step ? ' step="' + step + '"' : ''} oninput="emiCalc()" style="width:100%;margin-top:3px;border:1px solid #e7e0d5;border-radius:8px;padding:7px 9px;font-size:14px"></label>`
  return `<div style="background:#FBF7F0;border:1px solid #f0e6d6;border-radius:14px;padding:14px">
    <div style="font-size:13px;color:#8a7a66;font-weight:700;margin-bottom:10px"><i class="fas fa-calculator" style="color:#E86B1C"></i> EMI / Affordability Calculator</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${fld({ id: 'emi-price', label: 'Price (₹ Lakh)' }, it.rate_lakh)}
      ${fld({ id: 'emi-down', label: 'Down payment (%)' }, 15)}
      ${fld({ id: 'emi-rate', label: 'Interest rate (%)' }, 8.5, '0.1')}
      ${fld({ id: 'emi-tenure', label: 'Tenure (years)' }, 20)}
    </div>
    <div id="emi-out" style="margin-top:12px;display:grid;gap:6px;font-size:14px;color:#57534e"></div>
  </div>`
}
function emiCalc() {
  const g = id => Number((document.getElementById(id) || {}).value) || 0
  const priceL = g('emi-price'), downPct = Math.min(100, Math.max(0, g('emi-down'))), rate = g('emi-rate'), years = g('emi-tenure')
  const total = priceL * 100000, down = total * downPct / 100, loan = total - down
  const r = rate / 12 / 100, n = years * 12
  let emi = 0
  if (loan > 0 && n > 0) emi = r > 0 ? loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1) : loan / n
  const fmt = x => '₹' + Math.round(x).toLocaleString('en-IN')
  const out = document.getElementById('emi-out'); if (!out) return
  out.innerHTML = `
    <div style="display:flex;justify-content:space-between"><span>Down payment</span><b>${fmt(down)}</b></div>
    <div style="display:flex;justify-content:space-between"><span>Loan amount</span><b>${fmt(loan)}</b></div>
    <div style="display:flex;justify-content:space-between;background:#E86B1C;color:#fff;padding:9px 12px;border-radius:10px;font-weight:700"><span>Monthly EMI</span><span>${fmt(emi)}/mo</span></div>
    <div style="font-size:11px;color:#a8a29e">*अनुमान मात्र — असली loan/EMI बैंक व eligibility पर निर्भर.</div>`
}
function nearbyHTML(it) {
  const q = encodeURIComponent([it.colony, it.location, 'India'].filter(Boolean).join(' '))
  const chip = (icon, label, term) => `<a href="https://www.google.com/maps/search/${encodeURIComponent(term)}+near+${q}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;background:#fff;border:1px solid #e7e0d5;border-radius:99px;padding:6px 12px;font-size:12px;color:#57534e;text-decoration:none"><i class="fas fa-${icon}" style="color:#E86B1C"></i>${label}</a>`
  return `<div style="margin-top:10px">
    <div style="font-size:12px;color:#8a7a66;margin-bottom:6px">आस-पास क्या है — देखें:</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${chip('school', 'Schools', 'schools')}${chip('hospital', 'Hospital', 'hospital')}${chip('cart-shopping', 'Market', 'market')}${chip('building-columns', 'Bank/ATM', 'bank ATM')}${chip('train', 'Bus/Rail', 'bus stand railway station')}
    </div>
  </div>`
}

function renderDetail(it) {
  const photos = (it.photos || []).map(photoUrl).filter(Boolean)
  const gallery = photos.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">${photos.map(p => `<img src="${esc(p)}" style="width:100%;height:130px;object-fit:cover;border-radius:10px;cursor:zoom-in" onclick="openPhoto('${esc(p)}')">`).join('')}</div>`
    : `<div style="height:150px;border-radius:12px;background:#FEF5EC;display:grid;place-items:center;color:#F9BE7A"><div style="text-align:center"><i class="fas fa-camera" style="font-size:28px"></i><div style="font-size:13px;margin-top:6px;color:#b3a68f">Photos coming soon</div></div></div>`
  const o = mkOverlay('detail-overlay')
  o.innerHTML = `<div style="background:#fff;border-radius:20px;max-width:760px;width:100%;max-height:94vh;overflow:auto">
    <div style="position:sticky;top:0;background:#fff;display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #f0e9dd;z-index:2">
      <b style="font-family:Poppins,sans-serif;font-weight:800;color:#221507;font-size:17px">${esc(it.type)} — ${esc(it.colony || it.location)}</b>
      <button onclick="closeDetail()" style="border:none;background:#f1f1f1;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px">&times;</button>
    </div>
    <div style="padding:20px;display:flex;flex-direction:column;gap:16px">
      ${gallery}
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        <span style="font-family:Poppins;font-weight:800;color:#D95F12;font-size:24px">${priceOf(it)}</span>
        ${txnPill(it)}
        ${(isZameen(it) ? it.rakba : it.size_sqyd) ? `<span style="background:#FEF5EC;color:#B44E0E;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600">${isZameen(it) ? esc(it.rakba) : it.size_sqyd + ' sq ft'}</span>` : ''}
        ${isZameen(it) ? '<span style="background:#ECFDF5;color:#047857;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600"><i class="fas fa-mountain-sun"></i> ज़मीन</span>' : ''}
        <span style="background:#ECFDF5;color:#059669;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600"><i class="fas fa-shield-halved"></i> Verified</span>
        ${it.lead_count > 0 ? `<span style="background:#FEF2F2;color:#DC2626;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600"><i class="fas fa-fire"></i> ${it.lead_count + 5} buyers</span>` : ''}
        <button data-heart="${it.id}" onclick="toggleShortlist(${it.id})" title="Shortlist" style="margin-left:auto;border:1px solid #eee;background:#fff;width:40px;height:40px;border-radius:12px;cursor:pointer;font-size:18px" class="${inSL(it.id) ? 'fas fa-heart' : 'far fa-heart'}"></button>
      </div>
      <div style="color:#57534e;font-size:14px"><i class="fas fa-location-dot" style="color:#F0973F"></i> ${esc(it.location)}${it.colony && it.colony !== it.location ? ' · ' + esc(it.colony) : ''}</div>
      ${it.description ? `<p style="color:#57534e;font-size:15px;line-height:1.6">${esc(it.description)}</p>` : ''}
      ${factsHTML(it)}
      ${emiHTML(it)}
      <div>
        <div style="font-size:13px;color:#8a7a66;font-weight:700;margin-bottom:6px"><i class="fas fa-map-location-dot" style="color:#E86B1C"></i> Location &amp; Neighbourhood</div>
        <div id="detail-map" style="height:260px;border-radius:12px;overflow:hidden;background:#f3ede3"></div>
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([it.colony, it.location, 'India'].filter(Boolean).join(', '))}" target="_blank" style="display:inline-block;margin-top:8px;font-size:13px;color:#D95F12;font-weight:600">Open in Google Maps <i class="fas fa-arrow-up-right-from-square"></i></a>
        ${nearbyHTML(it)}
      </div>
      <a href="https://wa.me/${WA_NUMBER}?text=${encodeURIComponent('नमस्ते, मुझे इस property की SITE VISIT चाहिए:\n' + it.type + ' — ' + (it.colony || it.location) + (it.rate_lakh ? ' (₹' + it.rate_lakh + 'L)' : '') + '\n' + location.origin + '/property/' + it.id)}" target="_blank" style="display:block;text-align:center;background:linear-gradient(135deg,#F7B32B,#F09A0A);color:#221507;padding:13px;border-radius:14px;font-weight:800;text-decoration:none"><i class="fas fa-calendar-check"></i> Schedule a Site Visit</a>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a href="tel:+${WA_NUMBER}" style="flex:1;min-width:140px;text-align:center;background:#E86B1C;color:#fff;padding:13px;border-radius:14px;font-weight:700;text-decoration:none"><i class="fas fa-phone"></i> Call Us</a>
        <a href="${waFor(it)}" target="_blank" style="flex:1;min-width:140px;text-align:center;background:#25D366;color:#fff;padding:13px;border-radius:14px;font-weight:700;text-decoration:none"><i class="fab fa-whatsapp"></i> WhatsApp Enquiry</a>
        <button onclick="closeDetail();openModal('buy')" style="flex:1;min-width:140px;background:#FEF5EC;color:#B44E0E;padding:13px;border-radius:14px;font-weight:700;border:none;cursor:pointer"><i class="fas fa-hand-pointer"></i> I Want This</button>
        <button onclick="shareProperty(${it.id})" title="Share" style="flex:0 0 auto;background:#221507;color:#fff;padding:13px 16px;border-radius:14px;font-weight:700;border:none;cursor:pointer"><i class="fas fa-share-nodes"></i></button>
      </div>
    </div>
  </div>`
  initDetailMap(it)
  emiCalc()
}
let _detailMap
async function initDetailMap(it) {
  const el = document.getElementById('detail-map')
  if (!el || typeof L === 'undefined') return
  if (_detailMap) { try { _detailMap.remove() } catch {} _detailMap = null }
  let lat = 24.6, lng = 75.9, zoom = 6, found = false   // default: around Kota region
  const { pt } = await geocode(it.location)
  if (pt) { lat = pt.lat; lng = pt.lng; zoom = 13; found = true }
  _detailMap = L.map(el).setView([lat, lng], zoom)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(_detailMap)
  if (found) L.marker([lat, lng]).addTo(_detailMap).bindPopup(esc(it.type + ' — ' + (it.colony || it.location))).openPopup()
  setTimeout(() => _detailMap.invalidateSize(), 250)
}

function listingCard(it) {
  LISTINGS[it.id] = it
  const photo = firstPhoto(it)
  return `
  <article class="tilt-card listing-card" data-tilt-late>
    <div class="listing-img-wrap" style="cursor:pointer" onclick="openDetail(${it.id})">
      ${photo ? `<img class="listing-img" src="${esc(photo)}" alt="${esc(it.type)} in ${esc(it.location)}" loading="lazy">` : `<div class="no-photo"><i class="fas fa-map"></i></div>`}
      <span class="listing-badge"><i class="fas fa-shield-halved mr-1"></i>Verified ${esc(it.type)}</span>
      ${it.lead_count > 0 ? `<span class="listing-leads"><i class="fas fa-fire mr-1"></i>Sent to ${it.lead_count + 5} buyers</span>` : ''}
      <button onclick="toggleShortlist(${it.id}, event)" title="Shortlist" style="position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:50%;border:none;background:rgba(255,255,255,.92);cursor:pointer;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.15)"><i data-heart="${it.id}" class="${inSL(it.id) ? 'fas fa-heart text-red-500' : 'far fa-heart'}"></i></button>
    </div>
    <div class="p-5">
      <div class="flex items-start justify-between gap-2 cursor-pointer" onclick="openDetail(${it.id})">
        <div>
          <h3 class="font-head font-bold text-brand-900">${esc(it.type)} — ${esc(it.colony || it.location)}</h3>
          <p class="text-xs text-stone-400 mt-0.5"><i class="fas fa-location-dot mr-1 text-brand-400"></i>${esc(it.location)}${it.colony && it.colony !== it.location ? ' · ' + esc(it.colony) : ''}</p>
          <div class="mt-1.5">${txnPill(it)}</div>
        </div>
        <div class="text-right"><div class="font-head font-extrabold text-brand-600 text-lg leading-none">${priceOf(it)}</div>${(isZameen(it) ? it.rakba : it.size_sqyd) ? `<div class="text-[11px] text-stone-400 mt-1">${isZameen(it) ? esc(it.rakba) : it.size_sqyd + ' sq ft'}</div>` : ''}</div>
      </div>
      <div class="flex gap-2 mt-4">
        <button onclick="openDetail(${it.id})" class="btn-depth flex-1 bg-brand-50 hover:bg-brand-100 text-brand-700 font-semibold text-sm py-2.5 rounded-xl transition"><i class="fas fa-eye mr-1.5"></i>View Details</button>
        <a href="${waFor(it)}" target="_blank" onclick="event.stopPropagation()" title="WhatsApp enquiry" class="btn-depth bg-[#25D366] text-white px-4 rounded-xl grid place-items-center"><i class="fab fa-whatsapp text-lg"></i></a>
      </div>
      <label class="flex items-center gap-1.5 mt-2.5 text-xs text-stone-500 cursor-pointer"><input type="checkbox" class="cmp-chk accent-brand-600" ${COMPARE.includes(it.id) ? 'checked' : ''} onclick="toggleCompare(${it.id}, event)"> Add to compare</label>
    </div>
  </article>`
}

async function loadFilters() {
  try {
    const f = await (await fetch('/api/filters')).json()
    f.locations.forEach(l => $('#f-location').insertAdjacentHTML('beforeend', `<option>${esc(l)}</option>`))
    f.types.forEach(t => $('#f-type').insertAdjacentHTML('beforeend', `<option>${esc(t)}</option>`))
  } catch { }
}

async function loadBrowse() {
  const grid = $('#browse-grid')
  grid.innerHTML = '<div class="col-span-full text-center text-stone-400 py-10"><i class="fas fa-circle-notch fa-spin mr-2"></i>Loading listings…</div>'
  const params = new URLSearchParams()
  const set = (id, key) => { const el = $(id); if (el && el.value) params.set(key, el.value) }
  set('#f-location', 'location'); set('#f-type', 'type'); set('#f-budget', 'max_budget')
  set('#f-minarea', 'min_area'); set('#f-maxarea', 'max_area'); set('#f-sort', 'sort'); set('#f-txn', 'txn')
  try {
    const { items } = await (await fetch('/api/stock/browse?' + params)).json()
    if (!items.length) {
      grid.innerHTML = `<div class="col-span-full text-center py-14">
        <i class="fas fa-map text-4xl text-brand-200"></i>
        <p class="text-stone-500 mt-3">No active listings for this filter yet.<br>Share your requirement — we'll find it for you.</p>
        <button onclick="openModal('buy')" class="btn-depth mt-4 bg-brand-600 text-white font-semibold px-6 py-2.5 rounded-xl text-sm">Open Requirement Form</button>
      </div>`
      return
    }
    CURRENT_ITEMS = items
    grid.innerHTML = items.map(listingCard).join('')
    updateShortlistUI()
    if (MAP_VIEW) showMapView()
  } catch {
    grid.innerHTML = '<div class="col-span-full text-center text-red-400 py-10">Could not load listings. Please refresh the page.</div>'
  }
}

/* ---------- map view (all properties on one map) ---------- */
const GEO_KEY = 'sbn_geocache'
const geoCache = () => { try { return JSON.parse(localStorage.getItem(GEO_KEY) || '{}') } catch { return {} } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function geocode(q) {
  const cache = geoCache()
  if (cache[q] !== undefined) return { pt: cache[q], cached: true }
  let pt = null
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q + ', India'))
    const d = await r.json()
    if (d && d[0]) pt = { lat: +d[0].lat, lng: +d[0].lon }
  } catch {}
  cache[q] = pt; try { localStorage.setItem(GEO_KEY, JSON.stringify(cache)) } catch {}
  return { pt, cached: false }
}
let _browseMap
function setView(map) {
  MAP_VIEW = map
  $('#browse-grid').style.display = map ? 'none' : ''
  $('#browse-map').style.display = map ? 'block' : 'none'
  const g = $('#view-grid-btn'), m = $('#view-map-btn')
  if (g && m) { g.classList.toggle('view-on', !map); m.classList.toggle('view-on', map) }
  if (map) showMapView()
}
async function showMapView() {
  const wrap = $('#browse-map')
  if (typeof L === 'undefined') { wrap.innerHTML = '<div class="text-center text-stone-400 py-10">Map could not load.</div>'; return }
  if (_browseMap) { try { _browseMap.remove() } catch {} _browseMap = null }
  wrap.innerHTML = '<div id="browse-map-canvas" style="height:100%"></div><div id="map-status" style="position:absolute;top:10px;left:10px;z-index:500;background:#fff;padding:6px 12px;border-radius:8px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.15)"></div>'
  _browseMap = L.map('browse-map-canvas').setView([25.18, 75.83], 11)   // Kota city (HQ) default
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(_browseMap)
  _browseMap.on('click', closeMapPanel)   // tap empty map area to close the details drawer
  const status = $('#map-status')
  const bounds = []
  let done = 0
  for (const it of CURRENT_ITEMS) {
    const q = it.location   // town/area name geocodes reliably; colony (road name) usually doesn't
    status.textContent = `📍 Locating properties… (${++done}/${CURRENT_ITEMS.length})`
    const { pt, cached } = await geocode(q)
    if (pt) {
      const lat = pt.lat + (Math.random() - 0.5) * 0.004, lng = pt.lng + (Math.random() - 0.5) * 0.004
      L.marker([lat, lng]).addTo(_browseMap)
        .bindTooltip(`${esc(it.type)} — ${esc(it.colony || it.location)}`)
        .on('click', () => openMapPanel(it))
      bounds.push([lat, lng])
    }
    if (!cached && pt !== null) await sleep(1100)   // respect Nominatim only on real API hits
  }
  status.textContent = bounds.length ? `📍 ${bounds.length} properties on map` : 'Location not found for these listings'
  if (bounds.length) _browseMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 })
  setTimeout(() => _browseMap.invalidateSize(), 200)
}

// Side panel: click a map pin → property details (photos + shortlist/compare/whatsapp) beside the map
function openMapPanel(it) {
  let p = document.getElementById('map-panel')
  if (!p) { p = document.createElement('div'); p.id = 'map-panel'; p.className = 'map-panel'; document.body.appendChild(p) }
  const photos = (it.photos || []).map(photoUrl).filter(Boolean)
  const imgs = photos.length
    ? photos.map(u => `<img src="${esc(u)}" onclick="openPhoto('${esc(u)}')" style="width:100%;height:150px;object-fit:cover;border-radius:10px;cursor:zoom-in">`).join('')
    : `<div style="height:120px;border-radius:10px;background:#FEF5EC;display:grid;place-items:center;color:#F9BE7A"><div style="text-align:center"><i class="fas fa-camera" style="font-size:24px"></i><div style="font-size:12px;margin-top:4px;color:#b3a68f">Photos coming soon</div></div></div>`
  const inCmp = COMPARE.includes(it.id)
  p.innerHTML = `
    <button class="mp-close" onclick="closeMapPanel()">&times;</button>
    <div class="mp-body">
      <div class="mp-gallery">${imgs}</div>
      <h3 style="font-family:Poppins,sans-serif;font-weight:800;color:#221507;font-size:16px;margin:0">${esc(it.type)} — ${esc(it.colony || it.location)}</h3>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-family:Poppins,sans-serif;font-weight:800;color:#D95F12;font-size:20px">${priceOf(it)}</span>
        ${txnPill(it)}
        ${(isZameen(it) ? it.rakba : it.size_sqyd) ? `<span style="background:#FEF5EC;color:#B44E0E;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600">${isZameen(it) ? esc(it.rakba) : it.size_sqyd + ' sq ft'}</span>` : ''}
        ${it.lead_count > 0 ? `<span style="background:#FEF2F2;color:#DC2626;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600"><i class="fas fa-fire"></i> ${it.lead_count + 5} buyers</span>` : ''}
      </div>
      <div style="color:#57534e;font-size:13px"><i class="fas fa-location-dot" style="color:#F0973F"></i> ${esc(it.location)}${it.colony && it.colony !== it.location ? ' · ' + esc(it.colony) : ''}</div>
      ${it.description ? `<p style="color:#57534e;font-size:13px;line-height:1.5;margin:0">${esc(it.description)}</p>` : ''}
      <div style="display:flex;gap:8px">
        <button onclick="toggleShortlist(${it.id})" style="flex:1;border:1px solid #eee;background:#fff;padding:9px;border-radius:10px;cursor:pointer;font-weight:600;font-size:13px;color:#DC2626"><i data-heart="${it.id}" class="${inSL(it.id) ? 'fas fa-heart' : 'far fa-heart'}"></i> Shortlist</button>
        <button onclick="toggleCompare(${it.id}); openMapPanel(LISTINGS[${it.id}])" style="flex:1;border:1px solid #eee;background:${inCmp ? '#FEF5EC' : '#fff'};padding:9px;border-radius:10px;cursor:pointer;font-weight:600;font-size:13px;color:#B44E0E"><i class="fas ${inCmp ? 'fa-check' : 'fa-plus'}"></i> Compare</button>
      </div>
      <div style="display:flex;gap:8px">
        <a href="${waFor(it)}" target="_blank" style="flex:1;text-align:center;background:#25D366;color:#fff;padding:10px;border-radius:10px;font-weight:700;text-decoration:none;font-size:13px"><i class="fab fa-whatsapp"></i> WhatsApp</a>
        <button onclick="closeMapPanel();openDetail(${it.id})" style="flex:1;background:#E86B1C;color:#fff;padding:10px;border-radius:10px;font-weight:700;border:none;cursor:pointer;font-size:13px">Full details</button>
      </div>
    </div>`
  p.classList.add('open')
  updateShortlistUI()
}
function closeMapPanel() { const p = document.getElementById('map-panel'); if (p) p.classList.remove('open') }

/* ---------- city selector + news feed (homepage front) ---------- */
const CITIES = ['Kota', 'Jhalawar', 'Khanpur']
// TODO: paste your real WhatsApp group invite links here (per city). Same link allowed for all.
const WA_GROUP = {
  Kota: 'https://chat.whatsapp.com/XXXXXXXXXXXXXXXX',
  Jhalawar: 'https://chat.whatsapp.com/XXXXXXXXXXXXXXXX',
  Khanpur: 'https://chat.whatsapp.com/XXXXXXXXXXXXXXXX',
}
let SELECTED_CITY = (() => { try { return localStorage.getItem('sbn_city') } catch { return null } })() || 'Kota'

function renderCitySelector() {
  const el = $('#city-selector'); if (!el) return
  el.innerHTML = CITIES.map(c => `<button onclick="setCity('${c}')" class="px-5 py-2 rounded-full text-sm font-bold transition ${c === SELECTED_CITY ? 'bg-brand-600 text-white shadow' : 'text-brand-700 hover:bg-brand-50'}">${c}</button>`).join('')
}
let _hasCurated = false, _hasAuto = false
function updateNewsEmpty() { const e = $('#news-empty'); if (e) e.classList.toggle('hidden', _hasCurated || _hasAuto) }
function setCity(city) {
  SELECTED_CITY = city
  try { localStorage.setItem('sbn_city', city) } catch {}
  renderCitySelector()
  const t = $('#news-city-title'); if (t) t.textContent = city
  const wc = $('#wa-group-city'); if (wc) wc.textContent = city
  const wg = $('#wa-group-link'); if (wg) wg.href = WA_GROUP[city] || WA_GROUP.Kota
  loadNews(city)
  const loc = $('#f-location')
  if (loc) { loc.value = [...loc.options].some(o => o.value === city) ? city : ''; loadBrowse() }
}
async function loadNews(city) {
  const feed = $('#news-feed'), wrap = $('#news-curated-wrap'); if (!feed) return
  try {
    const { items } = await (await fetch('/api/news?city=' + encodeURIComponent(city))).json()
    _hasCurated = !!(items && items.length)
    if (_hasCurated) { feed.innerHTML = items.map(newsCard).join(''); wrap.classList.remove('hidden') }
    else { feed.innerHTML = ''; wrap.classList.add('hidden') }
  } catch { _hasCurated = false; wrap.classList.add('hidden') }
  updateNewsEmpty()
  loadAutoNews(city)   // hybrid: fresh auto headlines
}
const newsSkeleton = n => Array(n).fill('<div class="bg-white rounded-2xl border border-brand-100 p-5 animate-pulse"><div class="flex items-center gap-2 mb-3"><div class="w-7 h-7 rounded-full bg-brand-50"></div><div class="h-3 w-24 bg-stone-100 rounded"></div></div><div class="h-4 w-full bg-stone-100 rounded mb-2"></div><div class="h-4 w-2/3 bg-stone-100 rounded"></div></div>').join('')
async function loadAutoNews(city) {
  const wrap = $('#news-auto-wrap'), box = $('#news-auto'); if (!box) return
  box.innerHTML = newsSkeleton(3); wrap.classList.remove('hidden'); _hasAuto = true; updateNewsEmpty()   // instant skeleton so it never looks empty
  try {
    const { items } = await (await fetch('/api/news/auto?city=' + encodeURIComponent(city))).json()
    _hasAuto = !!(items && items.length)
    if (_hasAuto) box.innerHTML = items.map(autoNewsCard).join('')
    else { box.innerHTML = ''; wrap.classList.add('hidden') }
  } catch { _hasAuto = false; box.innerHTML = ''; wrap.classList.add('hidden') }
  updateNewsEmpty()
}
function relTime(s) {
  if (!s) return ''
  const d = new Date(s); if (isNaN(d.getTime())) return ''
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + ' min ago'
  if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago'
  if (diff < 7 * 86400) return Math.floor(diff / 86400) + ' days ago'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
function autoNewsCard(n) {
  const rel = relTime(n.pubDate)
  return `<a href="${esc(n.link)}" target="_blank" rel="noopener" class="group block bg-white rounded-2xl border border-brand-100 p-5 hover:border-brand-300 hover:shadow-md transition">
    <div class="flex items-center gap-2 text-xs text-stone-400 mb-2.5">
      <span class="w-7 h-7 rounded-full bg-brand-50 grid place-items-center text-brand-400 flex-none"><i class="fas fa-newspaper text-[11px]"></i></span>
      <span class="font-semibold text-stone-600 truncate">${esc(n.source || 'News')}</span>${rel ? `<span class="flex-none text-stone-400">· ${rel}</span>` : ''}
    </div>
    <div class="text-[15px] font-semibold text-brand-900 leading-snug group-hover:text-brand-700 transition">${esc(n.title)}</div>
    <div class="text-xs text-brand-600 font-bold mt-3 inline-flex items-center gap-1">पूरा पढ़ें <i class="fas fa-arrow-right text-[10px] group-hover:translate-x-0.5 transition-transform"></i></div>
  </a>`
}
function newsCard(n) {
  const img = n.image_url
    ? `<img src="${esc(n.image_url)}" class="w-full h-44 object-cover" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'w-full h-44 grid place-items-center bg-gradient-to-br from-brand-50 to-brand-100',innerHTML:'<i class=\\'fas fa-newspaper text-3xl text-brand-300\\'></i>'}))">`
    : `<div class="w-full h-44 grid place-items-center bg-gradient-to-br from-brand-50 to-brand-100 text-brand-300"><i class="fas fa-newspaper text-3xl"></i></div>`
  return `<article class="bg-white rounded-2xl border border-brand-100 overflow-hidden shadow-sm hover:shadow-md transition flex flex-col">
    ${img}
    <div class="p-5 flex-1 flex flex-col">
      <h3 class="font-head font-bold text-brand-900 text-base leading-snug">${esc(n.title)}</h3>
      ${n.body ? `<p class="text-sm text-stone-500 mt-2 leading-relaxed">${esc(n.body)}</p>` : ''}
      ${n.source_url ? `<a href="${esc(n.source_url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 mt-2 text-sm text-brand-600 font-semibold">पूरा पढ़ें <i class="fas fa-arrow-up-right-from-square text-xs"></i></a>` : ''}
      ${n.expert_comment ? `<div class="mt-auto pt-4"><div class="bg-gradient-to-br from-gold-100 to-[#FDF6E3] border border-gold-400/40 rounded-xl p-3.5"><div class="text-xs font-bold text-brand-700 mb-1.5 flex items-center gap-1.5"><i class="fas fa-user-tie"></i>Expert Comment</div><p class="text-sm text-stone-700 leading-relaxed">${esc(n.expert_comment)}</p></div></div>` : ''}
    </div>
  </article>`
}

// init news/city immediately (parallel to listings)
renderCitySelector()
{ const t = $('#news-city-title'); if (t) t.textContent = SELECTED_CITY }
{ const wc = $('#wa-group-city'); if (wc) wc.textContent = SELECTED_CITY }
{ const wg = $('#wa-group-link'); if (wg) wg.href = WA_GROUP[SELECTED_CITY] || WA_GROUP.Kota }
loadNews(SELECTED_CITY)

loadFilters().then(() => {
  // default the location filter to the selected city (HQ Kota) when that option exists
  const loc = $('#f-location')
  if (loc && [...loc.options].some(o => o.value === SELECTED_CITY)) loc.value = SELECTED_CITY
}).then(loadBrowse).then(() => {
  updateShortlistUI()
  setView(true)   // browse opens on Map view by default
  const m = location.hash.match(/^#p=(\d+)/)
  if (m) openDetail(m[1])
})
addEventListener('hashchange', () => { const m = location.hash.match(/^#p=(\d+)/); if (m) openDetail(m[1]) })

/* ---------- buyer form ---------- */
$('#form-buy').addEventListener('submit', async e => {
  e.preventDefault()
  const form = e.target, msg = $('#buy-msg')
  const btn = form.querySelector('button[type=submit]')
  const body = Object.fromEntries(new FormData(form).entries())
  if (!/^\d{10}$/.test(body.mobile || '')) return toast('Mobile number must be 10 digits', 'err')
  btn.disabled = true; btn.querySelector('.submit-label').innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>Submitting…'
  try {
    const res = await fetch('/api/requirements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Something went wrong')
    msg.className = 'text-center text-sm font-medium rounded-xl p-3 bg-emerald-50 text-emerald-700 border border-emerald-200'
    msg.innerHTML = `<i class="fas fa-circle-check mr-1"></i>${esc(data.message)}<br><span class="text-xs font-normal">Reference ID: #REQ-${data.id} · <a href="/track.html" class="underline font-semibold">Track your requirement</a></span>`
    msg.classList.remove('hidden')
    form.reset()
    toast('Your requirement has been noted!')
    setTimeout(() => { closeModal('buy'); msg.classList.add('hidden') }, 3500)
  } catch (err) {
    msg.className = 'text-center text-sm font-medium rounded-xl p-3 bg-red-50 text-red-600 border border-red-200'
    msg.textContent = err.message
    msg.classList.remove('hidden')
  } finally {
    btn.disabled = false; btn.querySelector('.submit-label').innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Submit Requirement'
  }
})

