/* ============================================================
   Admin Dashboard — Akshardham Associates · Smart Buyer Network
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const api = async (url, opts) => {
  const res = await fetch(url, opts)
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) { location.href = '/login.html'; throw new Error('auth') }
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}
let _dt
const debounce = fn => { clearTimeout(_dt); _dt = setTimeout(fn, 350) }
const fmtDate = iso => { try { return new Date((iso || '').replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) } catch { return iso } }

function toast(msg, kind = 'ok') {
  let wrap = $('#toast-wrap')
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap) }
  const t = document.createElement('div')
  t.className = `toast ${kind}`
  t.innerHTML = `<i class="fas ${kind === 'ok' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i><span>${msg}</span>`
  wrap.appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350) }, 4200)
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  location.href = '/login.html'
}

/* ---------- boot ---------- */
let ME = null
;(async () => {
  const { user } = await api('/api/auth/me').catch(() => ({}))
  if (!user) { location.href = '/login.html'; return }
  if (user.huddle_only) { location.href = '/huddle.html'; return }
  ME = user
  $('#user-chip').innerHTML = `<i class="fas fa-user-shield text-brand-500"></i>${esc(user.name)} <span class="text-[10px] uppercase tracking-wider text-brand-500">(${user.role})</span>`
  loadOverview(); loadRequirements(); loadStock(); loadMatches(); loadFeedback(); loadNewsAdmin()
})()

/* ---------- news feed manager ---------- */
async function loadNewsAdmin() {
  let items = []
  try { items = (await api('/api/admin/news')).items || [] } catch { return }
  const box = $('#news-admin-list'); if (!box) return
  box.innerHTML = items.length ? items.map(n => `
    <div class="glass-panel rounded-2xl p-4 flex gap-3 items-start">
      <div class="w-16 h-12 rounded-lg overflow-hidden bg-brand-50 flex-shrink-0 grid place-items-center">
        ${n.image_url ? `<img src="${esc(n.image_url)}" class="w-full h-full object-cover" onerror="this.style.display='none'">` : '<i class="fas fa-newspaper text-brand-200"></i>'}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="badge badge-blue">${esc(n.city)}</span>
          ${n.status === 'draft' ? '<span class="badge badge-yellow">Draft</span>' : '<span class="badge badge-green">Live</span>'}
        </div>
        <b class="text-slate-800 block mt-1">${esc(n.title)}</b>
        ${n.body ? `<div class="text-xs text-slate-500 mt-0.5">${esc(n.body.slice(0, 120))}</div>` : ''}
        ${n.expert_comment ? `<div class="text-xs text-amber-700 mt-1"><i class="fas fa-user-tie mr-1"></i>${esc(n.expert_comment.slice(0, 100))}</div>` : ''}
      </div>
      <button onclick="deleteNewsItem(${n.id})" class="btn-depth bg-red-50 text-red-600 border border-red-200 text-xs font-bold px-3 py-2 rounded-xl flex-shrink-0"><i class="fas fa-trash"></i></button>
    </div>`).join('') : '<div class="glass-panel rounded-2xl p-8 text-center text-slate-400">Abhi koi news nahi. Upar form se jodein.</div>'
}
$('#form-news').addEventListener('submit', async e => {
  e.preventDefault()
  const form = e.target, msg = $('#news-msg'), btn = form.querySelector('button')
  const body = Object.fromEntries(new FormData(form).entries())
  btn.disabled = true
  try {
    await api('/api/admin/news', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    msg.className = 'text-center text-sm font-medium rounded-xl p-3 bg-emerald-50 text-emerald-700 border border-emerald-200'
    msg.textContent = '✓ News joD di — homepage par dikhegi'
    msg.classList.remove('hidden'); form.reset(); loadNewsAdmin()
    setTimeout(() => msg.classList.add('hidden'), 3000)
  } catch (err) {
    msg.className = 'text-center text-sm font-medium rounded-xl p-3 bg-red-50 text-red-600 border border-red-200'
    msg.textContent = err.message; msg.classList.remove('hidden')
  } finally { btn.disabled = false }
})
async function deleteNewsItem(id) {
  if (!confirm('Ye news delete karein?')) return
  await api('/api/admin/news/' + id, { method: 'DELETE' })
  toast('News deleted'); loadNewsAdmin()
}

/* ---------- sidebar nav ---------- */
const sidebar = $('#sidebar')
$('#menu-btn')?.addEventListener('click', () => sidebar.classList.toggle('-translate-x-full'))
$$('.side-link[data-view]').forEach(link => link.addEventListener('click', () => {
  $$('.side-link[data-view]').forEach(l => l.classList.remove('active'))
  link.classList.add('active')
  $$('.view').forEach(v => v.classList.add('hidden'))
  $('#view-' + link.dataset.view).classList.remove('hidden')
  sidebar.classList.add('-translate-x-full')
}))

/* ---------- overview ---------- */
let chartSource = null, chart7d = null
async function loadOverview() {
  const a = await api('/api/admin/analytics')
  const cards = [
    ['Active Listings', (a.stock_by_status.find(x => x.status === 'active') || {}).n || 0, 'fa-building', 'text-brand-500 bg-brand-50'],
    ['Pending Review', (a.stock_by_status.find(x => x.status === 'pending') || {}).n || 0, 'fa-hourglass-half', 'text-amber-500 bg-amber-50'],
    ['Total Requirements', a.req_by_status.reduce((s, x) => s + x.n, 0), 'fa-clipboard-list', 'text-emerald-500 bg-emerald-50'],
    ['Total Matches', 0, 'fa-link', 'text-gold-500 bg-gold-100'],
  ]
  const matchCount = (await api('/api/admin/matches')).items.length
  cards[3][1] = matchCount
  $('#ov-cards').innerHTML = cards.map(([label, n, icon, cls]) => `
    <div class="glass-panel rounded-2xl p-5 flex items-center gap-4">
      <span class="w-12 h-12 rounded-xl ${cls} grid place-items-center text-xl"><i class="fas ${icon}"></i></span>
      <div><div class="font-head font-extrabold text-2xl text-brand-900 leading-none">${n}</div><div class="text-xs text-slate-500 mt-1 font-medium">${label}</div></div>
    </div>`).join('')

  // nav badges
  $('#nav-req-count').textContent = (a.req_by_status.find(x => x.status === 'new') || {}).n || ''
  $('#nav-pending-count').textContent = (a.stock_by_status.find(x => x.status === 'pending') || {}).n || ''

  const srcLabels = { direct: 'Direct Website', realtor: 'Realtor', agent: 'Existing Agent', new_agent: 'New Agent/Retailer' }
  chartSource?.destroy()
  chartSource = new Chart($('#chart-source'), {
    type: 'doughnut',
    data: {
      labels: a.stock_by_source.map(x => srcLabels[x.source_type] || x.source_type),
      datasets: [{ data: a.stock_by_source.map(x => x.n), backgroundColor: ['#E86B1C', '#F7B32B', '#10b981', '#a78bfa'], borderWidth: 3, borderColor: '#fff' }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } }, cutout: '62%' }
  })
  chart7d?.destroy()
  chart7d = new Chart($('#chart-7d'), {
    type: 'bar',
    data: {
      labels: a.last7.map(x => x.d.slice(5)),
      datasets: [
        { label: 'Self (Website)', data: a.last7.map(x => x.self), backgroundColor: '#E86B1C', borderRadius: 6 },
        { label: 'Telecaller', data: a.last7.map(x => x.telecaller), backgroundColor: '#F7B32B', borderRadius: 6 },
      ]
    },
    options: { maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } } }
  })
  $('#top-leads').innerHTML = a.top_leads.map((s, i) => `
    <tr><td class="font-bold text-brand-300">${i + 1}</td><td><b>${esc(s.location)}</b>${s.colony ? ' · ' + esc(s.colony) : ''}</td><td>${s.rate_lakh ? '₹' + s.rate_lakh + 'L' : '—'}</td>
    <td><span class="badge ${s.lead_count >= 4 ? 'badge-red' : s.lead_count >= 2 ? 'badge-yellow' : 'badge-gray'}">${s.lead_count} buyers</span></td></tr>`).join('')
}

/* ---------- requirements ---------- */
const reqStatusBadge = s => ({ new: 'badge-blue', contacted: 'badge-yellow', matched: 'badge-green', closed: 'badge-gray' }[s] || 'badge-gray')
const srcBadge = s => s === 'telecaller' ? '<span class="badge badge-purple"><i class="fas fa-headset mr-1"></i>Telecaller</span>' : '<span class="badge badge-blue"><i class="fas fa-globe mr-1"></i>Self (Website)</span>'

async function loadRequirements() {
  const params = new URLSearchParams()
  if ($('#rq-status').value) params.set('status', $('#rq-status').value)
  if ($('#rq-q').value) params.set('q', $('#rq-q').value)
  const { items } = await api('/api/admin/requirements?' + params)
  $('#req-list').innerHTML = items.length ? items.map(r => `
    <div class="glass-panel rounded-2xl p-4 sm:p-5 flex flex-wrap items-center gap-4">
      <div class="flex-1 min-w-[220px]">
        <div class="flex flex-wrap items-center gap-2">
          <b class="font-head text-brand-900">${esc(r.name)}</b>
          <a href="tel:${esc(r.mobile)}" class="text-sm text-brand-600 font-semibold"><i class="fas fa-phone text-xs mr-1"></i>${esc(r.mobile)}</a>
          ${srcBadge(r.source_type)}
          <span class="badge ${reqStatusBadge(r.status)}">${r.status.toUpperCase()}</span>
        </div>
        <div class="text-sm text-slate-500 mt-1.5">
          <i class="fas fa-location-dot text-brand-400 mr-1"></i>${esc(r.location)}
          <span class="mx-1.5 text-slate-300">|</span><i class="fas fa-indian-rupee-sign text-brand-400 mr-1"></i>${r.budget_min_lakh ?? '?'}–${r.budget_max_lakh ?? '?'} Lakh
          <span class="mx-1.5 text-slate-300">|</span><i class="fas fa-house text-brand-400 mr-1"></i>${esc(r.type)}
          ${r.timeline ? `<span class="mx-1.5 text-slate-300">|</span><i class="fas fa-clock text-brand-400 mr-1"></i>${esc(r.timeline)}` : ''}
        </div>
        ${r.notes ? `<div class="text-xs text-slate-400 mt-1"><i class="fas fa-note-sticky mr-1"></i>${esc(r.notes)}</div>` : ''}
        <div class="text-[11px] text-slate-400 mt-1.5">${fmtDate(r.created_at)}${r.telecaller_name ? ' · by ' + esc(r.telecaller_name) : ''} · #REQ-${r.id}</div>
      </div>
      <div class="flex items-center gap-2">
        <select onchange="setReqStatus(${r.id}, this.value)" class="filter-input !py-1.5 text-xs">
          ${['new', 'contacted', 'matched', 'closed'].map(s => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button onclick="openMatchDrawer(${r.id})" class="btn-depth bg-gradient-to-r from-brand-600 to-brand-500 text-white text-sm font-semibold px-4 py-2 rounded-xl shadow">
          <i class="fas fa-link mr-1"></i>Match &amp; Send
        </button>
      </div>
    </div>`).join('') : '<div class="glass-panel rounded-2xl p-10 text-center text-slate-400">No requirements found.</div>'
}

async function setReqStatus(id, status) {
  await api(`/api/admin/requirements/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
  toast('Status updated'); loadRequirements()
}

/* ---------- stock ---------- */
const stockBadge = s => ({ pending: 'badge-yellow', active: 'badge-green', sold: 'badge-gray' }[s])
const stockSrc = r => ({ direct: '<span class="badge badge-blue">Direct Website</span>', realtor: '<span class="badge badge-purple">Realtor</span>', agent: '<span class="badge badge-green">Agent</span>', new_agent: '<span class="badge badge-yellow">New Agent</span>' }[r.source_type] || '')

let STOCK = {}
async function loadStock() {
  const params = new URLSearchParams()
  if ($('#st-status').value) params.set('status', $('#st-status').value)
  if ($('#st-q').value) params.set('q', $('#st-q').value)
  const { items } = await api('/api/admin/stock?' + params)
  STOCK = Object.fromEntries(items.map(s => [s.id, s]))
  $('#stock-list').innerHTML = items.length ? items.map(s => `
    <div class="glass-panel rounded-2xl p-4 sm:p-5 flex flex-wrap gap-4">
      <div class="w-24 h-20 rounded-xl overflow-hidden bg-brand-50 flex-shrink-0 grid place-items-center">
        ${s.photos[0] ? `<img src="${esc(typeof s.photos[0] === 'string' ? s.photos[0] : s.photos[0].url)}" class="w-full h-full object-cover">` : '<i class="fas fa-house text-brand-200 text-2xl"></i>'}
      </div>
      <div class="flex-1 min-w-[240px]">
        <div class="flex flex-wrap items-center gap-2">
          <b class="font-head text-brand-900">${esc(s.type)} — ${esc(s.colony || s.location)}</b>
          <span class="badge ${stockBadge(s.status)}">${s.status.toUpperCase()}</span>
          ${stockSrc(s)}${s.source_name ? `<span class="text-xs text-slate-500">· ${esc(s.source_name)}</span>` : ''}
          <span class="badge ${s.lead_count >= 4 ? 'badge-red' : s.lead_count ? 'badge-yellow' : 'badge-gray'}"><i class="fas fa-fire mr-1"></i>${s.lead_count} leads</span>
          ${s.property_kind === 'zameen' ? '<span class="badge badge-green"><i class="fas fa-mountain-sun mr-1"></i>ज़मीन</span>' : ''}
          ${!s.is_public ? '<span class="badge badge-gray"><i class="fas fa-eye-slash mr-1"></i>Private</span>' : ''}
          ${s.convert_status === 'convert' ? `<span class="badge badge-green"><i class="fas fa-circle-check mr-1"></i>Convert${s.convert_date ? ' · ' + esc(s.convert_date) : ''}</span>` : s.convert_status === 'non_convert' ? `<span class="badge badge-red"><i class="fas fa-circle-xmark mr-1"></i>Non-convert${s.convert_date ? ' · ' + esc(s.convert_date) : ''}</span>` : ''}
          ${s.executive_name ? `<span class="badge badge-blue"><i class="fas fa-user-tie mr-1"></i>${esc(s.executive_name)}</span>` : ''}
        </div>
        <div class="text-sm text-slate-500 mt-1.5">
          <i class="fas fa-user text-brand-400 mr-1"></i>${esc(s.seller_name)} · <a class="text-brand-600 font-semibold" href="tel:${esc(s.mobile)}">${esc(s.mobile)}</a>
          <span class="mx-1.5 text-slate-300">|</span>${s.property_kind === 'zameen' ? (s.rakba ? 'रकबा ' + esc(s.rakba) : 'रकबा —') : (s.size_sqyd ? s.size_sqyd + ' sq ft' : 'size —')} · ${s.rate_lakh ? '₹' + s.rate_lakh + ' L' : 'rate on request'}
        </div>
        ${s.property_kind === 'zameen' && (s.khasra_no || s.khata_no) ? `<div class="text-xs text-slate-400 mt-0.5">${s.khasra_no ? 'खसरा ' + esc(s.khasra_no) : ''}${s.khasra_no && s.khata_no ? ' · ' : ''}${s.khata_no ? 'खाता ' + esc(s.khata_no) : ''}</div>` : ''}
        ${s.description ? `<div class="text-xs text-slate-400 mt-1">${esc(s.description)}</div>` : ''}
        ${s.photos.length > 1 ? `<div class="flex gap-1.5 mt-2">${s.photos.map(p => `<img src="${esc(typeof p === 'string' ? p : p.url)}" title="${esc(p.label || '')}" class="w-12 h-9 object-cover rounded-md border border-slate-200">`).join('')}</div>` : ''}
        <div class="text-[11px] text-slate-400 mt-1.5">${fmtDate(s.created_at)} · #STK-${s.id}</div>
      </div>
      <div class="flex sm:flex-col gap-2">
        <button onclick="openEditStock(${s.id})" class="btn-depth bg-brand-50 text-brand-700 border border-brand-200 text-xs font-bold px-3.5 py-2 rounded-xl"><i class="fas fa-pen mr-1"></i>Edit</button>
        ${s.status === 'pending' ? `<button onclick="setStockStatus(${s.id},'active')" class="btn-depth bg-emerald-500 text-white text-xs font-bold px-3.5 py-2 rounded-xl"><i class="fas fa-check mr-1"></i>Activate</button>` : ''}
        ${s.status === 'active' ? `<button onclick="setStockStatus(${s.id},'sold')" class="btn-depth bg-slate-500 text-white text-xs font-bold px-3.5 py-2 rounded-xl"><i class="fas fa-handshake mr-1"></i>Mark Sold</button>` : ''}
        ${s.status === 'sold' ? `<button onclick="setStockStatus(${s.id},'active')" class="btn-depth bg-brand-500 text-white text-xs font-bold px-3.5 py-2 rounded-xl"><i class="fas fa-rotate-left mr-1"></i>Re-activate</button>` : ''}
        <button onclick="deleteStock(${s.id}, '${esc((s.type || '') + ' — ' + (s.colony || s.location || '')).replace(/'/g, "\\'")}')" class="btn-depth bg-red-50 text-red-600 border border-red-200 text-xs font-bold px-3.5 py-2 rounded-xl"><i class="fas fa-trash mr-1"></i>Delete</button>
      </div>
    </div>`).join('') : '<div class="glass-panel rounded-2xl p-10 text-center text-slate-400">No stock found.</div>'
}

async function setStockStatus(id, status) {
  await api(`/api/admin/stock/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
  toast(status === 'active' ? 'Listing is now Active — visible in the browse grid' : 'Status updated')
  loadStock(); loadOverview()
}

async function deleteStock(id, label) {
  if (!confirm(`Pakka delete karein?\n\n"${label}"\n\nYe listing aur iske match records hamesha ke liye hat jayenge. Ye wapas nahi aayega.`)) return
  await api(`/api/admin/stock/${id}`, { method: 'DELETE' })
  toast('Listing permanently deleted')
  loadStock(); loadOverview()
}

/* ---------- edit listing ---------- */
let EDIT_ID = null
function openEditStock(id) {
  const s = STOCK[id]; if (!s) return
  EDIT_ID = id
  const f = $('#form-edit')
  $('#edit-id').textContent = `#STK-${id}`
  for (const k of ['seller_name', 'mobile', 'location', 'colony', 'size_sqyd', 'rate_lakh', 'rent_monthly', 'type', 'description', 'executive_name', 'khasra_no', 'khata_no', 'rakba']) f[k].value = s[k] ?? ''
  f.convert_status.value = s.convert_status || 'pending'
  f.convert_date.value = s.convert_date || ''
  editConvertChanged(true)
  f.property_kind.value = s.property_kind === 'zameen' ? 'zameen' : 'plot'
  editKindChanged()
  f.txn.value = s.txn === 'rent' ? 'rent' : 'sale'
  editToggleRent()
  f.is_public.checked = !!s.is_public
  renderEditPhotos(s.photos)
  $('#edit-photo-input').value = ''; $('#edit-photo-status').textContent = ''
  $('#edit-modal').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}
function renderEditPhotos(photos) {
  const box = $('#edit-photos'); if (!box) return
  const arr = (photos || []).map(p => typeof p === 'string' ? p : p.url).filter(Boolean)
  box.innerHTML = arr.length
    ? arr.map(u => `<div class="relative"><img src="${u}" class="w-16 h-16 object-cover rounded-lg border border-slate-200"><button type="button" title="Remove" onclick="removeEditPhoto('${u}')" class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs leading-none grid place-items-center">&times;</button></div>`).join('')
    : '<span class="text-xs text-slate-400">No photos yet — add when they arrive.</span>'
}
async function uploadEditPhotos(files) {
  if (!files || !files.length || !EDIT_ID) return
  const fd = new FormData(); for (const f of files) fd.append('photos', f)
  $('#edit-photo-status').textContent = 'Uploading…'
  try {
    const r = await api(`/api/admin/stock/${EDIT_ID}/photos`, { method: 'POST', body: fd })
    if (STOCK[EDIT_ID]) STOCK[EDIT_ID].photos = r.photos
    renderEditPhotos(r.photos)
    $('#edit-photo-input').value = ''
    $('#edit-photo-status').textContent = r.added ? `${r.added} added ✓` : ''
    toast('Photos added'); loadStock()
  } catch (err) { $('#edit-photo-status').textContent = ''; toast(err.message, 'err') }
}
async function removeEditPhoto(url) {
  if (!EDIT_ID) return
  try {
    const r = await api(`/api/admin/stock/${EDIT_ID}/photos`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    if (STOCK[EDIT_ID]) STOCK[EDIT_ID].photos = r.photos
    renderEditPhotos(r.photos); loadStock()
  } catch (err) { toast(err.message, 'err') }
}
function agentToggleRent(){ const r = document.getElementById('agent-txn').value === 'rent'; document.getElementById('agent-rent-price').classList.toggle('hidden', !r); document.getElementById('agent-sale-price').classList.toggle('hidden', r); }
function editToggleRent(){ const r = document.getElementById('edit-txn').value === 'rent'; document.getElementById('edit-rent-price').classList.toggle('hidden', !r); document.getElementById('edit-sale-price').classList.toggle('hidden', r); }
function editConvertChanged(keep){
  const v = document.getElementById('edit-convert').value, wrap = document.getElementById('edit-convert-date-wrap'), inp = wrap.querySelector('input')
  const show = v !== 'pending'
  wrap.classList.toggle('hidden', !show)
  if (show && !inp.value && !keep) inp.value = new Date().toISOString().slice(0,10)
  if (!show) inp.value = ''
}
function editKindChanged(){
  const zameen = document.getElementById('edit-kind').value === 'zameen'
  document.getElementById('edit-zameen-fields').classList.toggle('hidden', !zameen)
  document.getElementById('edit-size-wrap').classList.toggle('hidden', zameen)
  document.getElementById('edit-type-wrap').classList.toggle('hidden', zameen)
}
function closeEdit() { $('#edit-modal').classList.add('hidden'); document.body.style.overflow = ''; EDIT_ID = null }
$('#form-edit').addEventListener('submit', async e => {
  e.preventDefault()
  const f = e.target
  const body = {
    seller_name: f.seller_name.value, mobile: f.mobile.value, location: f.location.value,
    colony: f.colony.value, size_sqyd: f.size_sqyd.value, rate_lakh: f.rate_lakh.value,
    description: f.description.value, is_public: f.is_public.checked,
    txn: f.txn.value, rent_monthly: f.txn.value === 'rent' ? f.rent_monthly.value : null,
    executive_name: f.executive_name.value, convert_status: f.convert_status.value,
    convert_date: f.convert_status.value === 'pending' ? null : f.convert_date.value,
    property_kind: f.property_kind.value,
    khasra_no: f.khasra_no.value, khata_no: f.khata_no.value, rakba: f.rakba.value,
    type: f.property_kind.value === 'zameen' ? 'Agricultural Land' : f.type.value,
  }
  try {
    await api(`/api/admin/stock/${EDIT_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    toast('Listing updated'); closeEdit(); loadStock(); loadOverview()
  } catch (err) { toast(err.message, 'err') }
})

/* ---------- match drawer ---------- */
let DRAWER_REQ = null
const selected = new Set()

async function openMatchDrawer(reqId) {
  selected.clear()
  $('#match-drawer').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
  $('#drawer-suggest').innerHTML = '<div class="text-center text-slate-400 py-8"><i class="fas fa-circle-notch fa-spin mr-2"></i>Finding matching stock…</div>'
  try {
    const { items, mode } = await api(`/api/admin/requirements/${reqId}/suggest`)
    const reqs = await api('/api/admin/requirements')
    DRAWER_REQ = reqs.items.find(r => r.id === reqId)
    $('#drawer-req').innerHTML = `
      <b class="text-brand-900">${esc(DRAWER_REQ.name)}</b> · ${esc(DRAWER_REQ.mobile)}<br>
      <span class="text-slate-500">${esc(DRAWER_REQ.type)} in <b>${esc(DRAWER_REQ.location)}</b> · Budget ₹${DRAWER_REQ.budget_min_lakh ?? '?'}–${DRAWER_REQ.budget_max_lakh ?? '?'}L ${DRAWER_REQ.timeline ? '· ' + esc(DRAWER_REQ.timeline) : ''}</span>`
    const modeNote = mode === 'ai'
      ? '<div class="text-xs text-brand-600 font-semibold mb-2"><i class="fas fa-wand-magic-sparkles mr-1"></i>AI match — nearby areas & Hindi spellings bhi consider kiye</div>'
      : (items.length ? '<div class="text-xs text-slate-400 mb-2">Basic match (location/budget/type)</div>' : '')
    $('#drawer-suggest').innerHTML = items.length ? modeNote + items.map(s => `
      <label class="flex gap-3 items-start glass-panel rounded-2xl p-3.5 cursor-pointer hover:border-brand-300 transition ${selected.has(s.id) ? 'ring-2 ring-brand-500' : ''}">
        <input type="checkbox" value="${s.id}" onchange="toggleSel(${s.id}, this.checked, this.closest('label'))" class="mt-1.5 accent-brand-600 w-4 h-4">
        <div class="w-16 h-12 rounded-lg overflow-hidden bg-brand-50 flex-shrink-0 grid place-items-center">
          ${s.photos[0] ? `<img src="${esc(typeof s.photos[0] === 'string' ? s.photos[0] : s.photos[0].url)}" class="w-full h-full object-cover">` : '<i class="fas fa-house text-brand-200"></i>'}
        </div>
        <div class="flex-1 text-sm">
          <b class="text-brand-900">${esc(s.type)} — ${esc(s.colony || s.location)}</b>
          <div class="text-slate-500 text-xs mt-0.5">${s.size_sqyd ? s.size_sqyd + ' sq ft · ' : ''}${s.rate_lakh ? '₹' + s.rate_lakh + 'L' : 'rate on request'} · seller: ${esc(s.seller_name)}</div>
          ${s._reason ? `<div class="text-emerald-600 text-xs mt-1"><i class="fas fa-circle-check mr-1"></i>${esc(s._reason)}</div>` : ''}
        </div>
        ${s.match_count > 0 ? `<span class="badge badge-gray">${s.match_count}x sent</span>` : ''}
      </label>`).join('') : '<div class="text-center text-slate-400 py-8">Is requirement ke liye koi matching active stock nahi mila.<br>Stock tab me jaakar listing Activate karein.</div>'
    $('#wa-link').classList.add('hidden')
    updateSendCount()
  } catch (e) { toast(e.message, 'err'); closeDrawer() }
}
function toggleSel(id, on, label) { on ? selected.add(id) : selected.delete(id); label.classList.toggle('ring-2', on); label.classList.toggle('ring-brand-500', on); updateSendCount() }
function updateSendCount() { $('#send-count').textContent = selected.size }
function closeDrawer() { $('#match-drawer').classList.add('hidden'); document.body.style.overflow = '' }

async function sendMatches() {
  if (!selected.size) return toast('Select at least one stock first', 'err')
  const res = await api('/api/admin/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requirement_id: DRAWER_REQ.id, stock_ids: [...selected] }) })
  toast(res.notified ? `${res.added} match(es) recorded — buyer auto-notified on WhatsApp ✅` : `${res.added} match(es) recorded — lead count updated!`)
  // WhatsApp share link
  const lines = [`*Akshardham Associates — Smart Buyer Network*`, `Hello ${DRAWER_REQ.name} ji, here are the options matching your requirement (${DRAWER_REQ.type}, ${DRAWER_REQ.location}):`, '']
  const stocks = (await api('/api/admin/stock')).items.filter(s => selected.has(s.id))
  stocks.forEach((s, i) => {
    let line = `${i + 1}. ${s.type} — ${s.colony || s.location}${s.size_sqyd ? ', ' + s.size_sqyd + ' sq ft' : ''}${s.rate_lakh ? ', ₹' + s.rate_lakh + ' Lakh' : ''}`
    // Option A: link to the public detail page (has all photos + map). Only works for public+active listings.
    if (s.is_public && s.status === 'active') line += `\n   Photos & details: ${location.origin}/property/${s.id}`
    lines.push(line)
  })
  lines.push('', 'Reply or call us to schedule a site visit.')
  const wa = `https://wa.me/91${DRAWER_REQ.mobile}?text=${encodeURIComponent(lines.join('\n'))}`
  const waBox = $('#wa-link')
  waBox.classList.remove('hidden')
  waBox.innerHTML = `<a href="${wa}" target="_blank" class="btn-depth flex items-center justify-center gap-2 w-full bg-[#25D366] text-white font-bold py-3 rounded-2xl text-sm"><i class="fab fa-whatsapp text-lg"></i>Send to Buyer on WhatsApp</a>`
  loadRequirements(); loadMatches(); loadOverview()
}

/* ---------- matches history ---------- */
async function loadMatches() {
  const { items } = await api('/api/admin/matches')
  $('#match-list').innerHTML = items.length ? items.map(m => `
    <tr>
      <td><b>${esc(m.buyer_name)}</b><br><a class="text-brand-600 text-xs" href="tel:${esc(m.buyer_mobile)}">${esc(m.buyer_mobile)}</a></td>
      <td>${esc(m.req_location)}</td>
      <td>${esc(m.stock_type)} — ${esc(m.colony || m.stock_location)}${m.rate_lakh ? ' · ₹' + m.rate_lakh + 'L' : ''}</td>
      <td class="text-xs text-slate-500">${esc(m.matched_by || '—')}</td>
      <td class="text-xs text-slate-400">${fmtDate(m.matched_at)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="text-center text-slate-400 py-8">No matches yet.</td></tr>'
}

/* ---------- field feedback ---------- */
const FB_REASON_LABEL = {
  no_need: 'अभी जरूरत नहीं', future: 'Future में जरूरत', not_understood: 'योजना समझ नहीं आई',
  reg_doubt: 'Registration doubt', must_buy: 'खरीदना पड़ेगा (doubt)', trust: 'Trust नहीं बना',
  no_clarity: 'Offer clarity नहीं', no_interest: 'जरूरत महसूस नहीं', no_time: 'समय नहीं था', other: 'अन्य',
}
const FB_TRUST_LABEL = { no: 'नहीं', little: 'थोड़ा', yes: 'हाँ' }
const FB_UNDERSTAND_LABEL = { full: 'पूरा समझा', partial: 'थोड़ा समझा', none: 'समझ नहीं आया' }
let chartReasons = null
async function loadFeedback() {
  const d = await api('/api/admin/feedback')
  const cards = [
    ['Total Feedback', d.total, 'fa-comment-dots', 'text-brand-500 bg-brand-50'],
    ['Trust Issues (हाँ)', d.trust_counts.yes, 'fa-shield-halved', 'text-red-500 bg-red-50'],
    ['समझ नहीं आया', d.understanding_counts.none, 'fa-circle-question', 'text-amber-500 bg-amber-50'],
    ['With Voice Note', d.items.filter(f => f.voice_url).length, 'fa-microphone', 'text-emerald-500 bg-emerald-50'],
  ]
  $('#fb-cards').innerHTML = cards.map(([label, n, icon, cls]) => `
    <div class="glass-panel rounded-2xl p-5 flex items-center gap-4">
      <span class="w-12 h-12 rounded-xl ${cls} grid place-items-center text-xl"><i class="fas ${icon}"></i></span>
      <div><div class="font-head font-extrabold text-2xl text-brand-900 leading-none">${n}</div><div class="text-xs text-slate-500 mt-1 font-medium">${label}</div></div>
    </div>`).join('')

  const sorted = Object.entries(d.reason_counts).sort((a, b) => b[1] - a[1])
  chartReasons?.destroy()
  chartReasons = new Chart($('#chart-reasons'), {
    type: 'bar',
    data: {
      labels: sorted.map(([k]) => FB_REASON_LABEL[k] || k),
      datasets: [{ data: sorted.map(([, n]) => n), backgroundColor: '#E86B1C', borderRadius: 6 }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  })

  $('#fb-list').innerHTML = d.items.length ? d.items.map(f => `
    <div class="glass-panel rounded-2xl p-4">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <b class="text-brand-900">${esc(f.name || 'अज्ञात')}</b>
        ${f.mobile ? `<a class="text-brand-600 text-xs" href="tel:${esc(f.mobile)}">${esc(f.mobile)}</a>` : ''}
        ${f.location ? `<span class="text-xs text-slate-500"><i class="fas fa-location-dot mr-1"></i>${esc(f.location)}</span>` : ''}
        <span class="ml-auto text-[11px] text-slate-400">${fmtDate(f.created_at)}${f.field_team ? ' · ' + esc(f.field_team) : ''}${f.visit_id ? ' · ' + esc(f.visit_id) : ''}</span>
      </div>
      <div class="flex flex-wrap gap-1.5 mt-2">
        ${f.understanding ? `<span class="text-[11px] rounded-full px-2 py-0.5 bg-amber-50 text-amber-700">समझ: ${FB_UNDERSTAND_LABEL[f.understanding]}</span>` : ''}
        ${f.trust ? `<span class="text-[11px] rounded-full px-2 py-0.5 bg-red-50 text-red-600">Trust: ${FB_TRUST_LABEL[f.trust]}</span>` : ''}
        ${f.reasons.map(r => `<span class="text-[11px] rounded-full px-2 py-0.5 bg-brand-50 text-brand-700">${esc(FB_REASON_LABEL[r] || r)}</span>`).join('')}
      </div>
      ${f.trust_detail ? `<p class="text-xs text-slate-600 mt-2"><i class="fas fa-triangle-exclamation text-red-400 mr-1"></i>${esc(f.trust_detail)}</p>` : ''}
      ${f.improve ? `<p class="text-sm text-slate-700 mt-2 bg-brand-50/60 rounded-lg p-2.5"><i class="fas fa-lightbulb text-gold-500 mr-1"></i>${esc(f.improve)}</p>` : ''}
      ${f.voice_url ? `<audio class="mt-2 w-full h-9" controls src="${esc(f.voice_url)}"></audio>` : ''}
    </div>`).join('') : '<div class="text-center text-slate-400 py-8">अभी कोई feedback नहीं आया।</div>'
}

/* ---------- agent add form ---------- */
$('#form-agent').addEventListener('submit', async e => {
  e.preventDefault()
  const body = Object.fromEntries(new FormData(e.target).entries())
  try {
    const r = await api('/api/agent/stock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    toast(`Stock #STK-${r.id} added (Pending Review)`)
    e.target.reset()
    loadStock(); loadOverview()
  } catch (err) { toast(err.message, 'err') }
})
