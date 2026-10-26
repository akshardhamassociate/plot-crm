import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { sign, verify } from 'hono/jwt'
import { getCookie, setCookie } from 'hono/cookie'

type Bindings = {
  DB: D1Database
  R2: R2Bucket
  ASSETS: Fetcher
  JWT_SECRET: string
  AISENSY_API_KEY?: string   // set → matches auto-notify the buyer on WhatsApp; unset → manual wa.me link
  AISENSY_CAMPAIGN?: string  // name of the approved AiSensy campaign/template
  SHEET_WEBHOOK_URL?: string // set → sell-form entries also appended to a Google Sheet (Apps Script web app); unset → skipped
  GEMINI_API_KEY?: string    // set → /api/extract reads property posts from screenshots (Gemini vision); unset → feature disabled
}

type JWTPayload = { uid: number; name: string; role: 'admin' | 'telecaller'; huddle_only?: number; exp: number }

const app = new Hono<{ Bindings: Bindings; Variables: { user: JWTPayload } }>()

app.use(logger())
app.use('/api/*', cors())

/* ---------------- helpers ---------------- */

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256
  )
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const clientIp = (c: any) => c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'

// Sliding-window rate limit backed by D1. FAIL-OPEN: if the table/query errors (e.g. migration
// not applied yet), the request is allowed — legit users never get blocked by an infra hiccup.
// ponytail: per-key counter, good enough for login brute-force + form spam. Turnstile if abuse grows.
async function rateLimit(env: Bindings, key: string, max: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  try {
    const row = await env.DB.prepare('SELECT count, reset_at FROM rate_limits WHERE k=?').bind(key).first<any>()
    if (!row || Number(row.reset_at) <= now) {
      await env.DB.prepare(
        'INSERT INTO rate_limits (k, count, reset_at) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET count=1, reset_at=excluded.reset_at'
      ).bind(key, now + windowSec).run()
      return true
    }
    if (row.count >= max) return false
    await env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE k=?').bind(key).run()
    return true
  } catch { return true }
}

async function authUser(c: any): Promise<JWTPayload | null> {
  const token = getCookie(c, 'sbn_token')
  if (!token) return null
  try {
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256')
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload as unknown as JWTPayload
  } catch { return null }
}

const requireAuth = async (c: any, next: any) => {
  const user = await authUser(c)
  if (!user) return c.json({ error: 'Login required' }, 401)
  c.set('user', user)
  await next()
}

const requireAdmin = async (c: any, next: any) => {
  const user = await authUser(c)
  if (!user) return c.json({ error: 'Login required' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Admin access only' }, 403)
  c.set('user', user)
  await next()
}

// CRM staff only (admin + telecaller). Huddle-only members are blocked from all CRM data.
const requireStaff = async (c: any, next: any) => {
  const user = await authUser(c)
  if (!user) return c.json({ error: 'Login required' }, 401)
  if (user.huddle_only) return c.json({ error: 'Huddle-only account — CRM access nahi hai' }, 403)
  c.set('user', user)
  await next()
}

// WhatsApp auto-notify via AiSensy (no-op & returns false unless AISENSY_API_KEY is set).
// ponytail: single provider (AiSensy, per the roadmap), plain fetch — no SDK. Needs their approved template.
async function notifyBuyerWhatsApp(env: Bindings, reqId: number, stockIds: number[]): Promise<boolean> {
  if (!env.AISENSY_API_KEY) return false
  const req = await env.DB.prepare('SELECT name, mobile, type, location FROM requirements WHERE id=?').bind(reqId).first<any>()
  if (!req) return false
  const ph = stockIds.map(() => '?').join(',')
  const { results } = await env.DB.prepare(
    `SELECT type, colony, location, size_sqyd, rate_lakh FROM stock WHERE id IN (${ph})`
  ).bind(...stockIds).all<any>()
  const summary = results.map((s: any, i: number) =>
    `${i + 1}. ${s.type} — ${s.colony || s.location}${s.size_sqyd ? ', ' + s.size_sqyd + ' gaj' : ''}${s.rate_lakh ? ', ₹' + s.rate_lakh + 'L' : ''}`
  ).join('\n') || `${req.type} in ${req.location}`
  const res = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: env.AISENSY_API_KEY,
      campaignName: env.AISENSY_CAMPAIGN || 'buyer_match',
      destination: '91' + req.mobile,
      userName: req.name,
      templateParams: [req.name, summary],
    }),
  })
  return res.ok
}

const fmtStock = (r: any) => ({
  ...r,
  photos: (() => { try { return JSON.parse(r.photos || '[]') } catch { return [] } })(),
  is_public: !!r.is_public,
})

/* ---------------- auth ---------------- */

app.post('/api/auth/login', async (c) => {
  const { phone, password } = await c.req.json().catch(() => ({})) as any
  if (!phone || !password) return c.json({ error: 'Both phone and password are required' }, 400)
  // brute-force guard: max 10 login attempts per IP per 10 min
  if (!(await rateLimit(c.env, `login:${clientIp(c)}`, 10, 600)))
    return c.json({ error: 'Bahut zyada login attempts. 10 minute baad dubara try karein.' }, 429)
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(String(phone).trim()).first<any>()
  if (!row) return c.json({ error: 'Incorrect phone or password' }, 401)
  const hash = await hashPassword(String(password), row.salt)
  if (hash !== row.password_hash) return c.json({ error: 'Incorrect phone or password' }, 401)
  if (row.active === 0) return c.json({ error: 'Aapka account band hai — sir se baat karein' }, 403)
  const payload: JWTPayload = {
    uid: row.id, name: row.name, role: row.role, huddle_only: row.huddle_only ? 1 : 0,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,   // 24h (was 7d) — smaller stolen/disabled-token window
  }
  const token = await sign(payload as any, c.env.JWT_SECRET, 'HS256')
  setCookie(c, 'sbn_token', token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 })
  return c.json({ ok: true, user: { id: row.id, name: row.name, role: row.role, huddle_only: row.huddle_only ? 1 : 0 } })
})

app.post('/api/auth/logout', (c) => {
  setCookie(c, 'sbn_token', '', { httpOnly: true, path: '/', maxAge: 0 })
  return c.json({ ok: true })
})

app.get('/api/auth/me', async (c) => {
  const user = await authUser(c)
  if (!user) return c.json({ user: null })
  return c.json({ user: { id: user.uid, name: user.name, role: user.role, huddle_only: user.huddle_only ? 1 : 0 } })
})

/* ---------------- public: stats, browse, forms ---------------- */

app.get('/api/stats', async (c) => {
  const db = c.env.DB
  const [stock, buyers, matches, locs] = await Promise.all([
    db.prepare("SELECT COUNT(*) n FROM stock WHERE status='active'").first<any>(),
    db.prepare('SELECT COUNT(*) n FROM requirements').first<any>(),
    db.prepare('SELECT COUNT(*) n FROM matches').first<any>(),
    db.prepare("SELECT COUNT(DISTINCT location) n FROM stock WHERE status='active'").first<any>(),
  ])
  return c.json({
    plots: (stock?.n || 0), buyers: (buyers?.n || 0) + 348, // +348 from the team's offline buyer base
    matches: (matches?.n || 0) + 210, locations: (locs?.n || 0) + 12,
  })
})

const STOCK_PUBLIC_COLS = "id, location, colony, size_sqyd, rate_lakh, type, txn, rent_monthly, photos, description, lead_count, created_at, property_kind, rakba"

app.get('/api/stock/browse', async (c) => {
  const { location = '', type = '', max_budget = '', q = '', min_area = '', max_area = '', sort = '', txn = '' } = c.req.query()
  let sql = `SELECT ${STOCK_PUBLIC_COLS} FROM stock WHERE status='active' AND is_public=1`
  const params: any[] = []
  if (txn === 'sale' || txn === 'rent') { sql += ' AND txn = ?'; params.push(txn) }
  if (location) { sql += ' AND location = ?'; params.push(location) }
  if (type) { sql += ' AND type = ?'; params.push(type) }
  if (max_budget) { sql += ' AND rate_lakh <= ?'; params.push(Number(max_budget)) }
  if (min_area) { sql += ' AND size_sqyd >= ?'; params.push(Number(min_area)) }
  if (max_area) { sql += ' AND size_sqyd <= ?'; params.push(Number(max_area)) }
  if (q) { sql += ' AND (location LIKE ? OR colony LIKE ?)'; params.push(`%${q}%`, `%${q}%`) }
  // sort: whitelist only (column names are not user-controlled)
  const order = ({ price_asc: 'rate_lakh ASC', price_desc: 'rate_lakh DESC', area_desc: 'size_sqyd DESC', newest: 'created_at DESC' } as any)[sort] || 'created_at DESC'
  sql += ` ORDER BY ${order} LIMIT 60`
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>()
  return c.json({ items: results.map(fmtStock) })
})

// Single property (for the detail page / shareable link)
app.get('/api/stock/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'))
  const r = await c.env.DB.prepare(
    `SELECT ${STOCK_PUBLIC_COLS} FROM stock WHERE id=? AND status='active' AND is_public=1`
  ).bind(id).first<any>()
  if (!r) return c.json({ error: 'Property not found' }, 404)
  return c.json(fmtStock(r))
})

// Shareable property link with Open Graph tags → WhatsApp/FB show a branded preview card.
// Humans are redirected to the interactive detail view (/#p=ID); crawlers read the og: tags.
app.get('/property/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'))
  const origin = new URL(c.req.url).origin
  const esc = (x: any) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const r = await c.env.DB.prepare(
    `SELECT ${STOCK_PUBLIC_COLS} FROM stock WHERE id=? AND status='active' AND is_public=1`
  ).bind(id).first<any>()
  if (!r) return c.html(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Akshardham Associates</title><script>location.replace('/')</script>`)
  const s = fmtStock(r)
  const p0 = (s.photos && s.photos[0]) ? (typeof s.photos[0] === 'string' ? s.photos[0] : s.photos[0].url) : ''
  const img = p0 ? (p0.startsWith('http') ? p0 : origin + p0) : origin + '/static/img/rural-hero.jpg'
  const price = s.txn === 'rent'
    ? (s.rent_monthly ? `₹${Number(s.rent_monthly).toLocaleString('en-IN')}/month` : 'Rent on request')
    : (s.rate_lakh ? `₹${s.rate_lakh} Lakh` : 'Price on request')
  const where = `${s.location}${s.colony && s.colony !== s.location ? ', ' + s.colony : ''}`
  const title = `${s.type} — ${s.colony || s.location} · ${price}`
  const desc = `${s.size_sqyd ? s.size_sqyd + ' sq ft · ' : ''}${where} · Akshardham Associates ☎ 9166064096 — verified listing. Tap for photos, map & full details.`
  const url = `${origin}/property/${id}`
  return c.html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Akshardham Associates</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Akshardham Associates — Smart Buyer Network">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<link rel="icon" type="image/png" href="/static/favicon.png">
<meta http-equiv="refresh" content="0;url=/#p=${id}">
<script>location.replace('/#p=${id}')</script>
</head><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#57534e;background:#FBF7F0">
<p>Opening <b>${esc(title)}</b> …</p>
<p><a href="/#p=${id}" style="color:#D95F12;font-weight:700">यहाँ क्लिक करें</a> अगर अपने-आप न खुले।</p>
</body></html>`)
})

app.get('/api/filters', async (c) => {
  const locs = await c.env.DB.prepare("SELECT DISTINCT location FROM stock WHERE status='active' AND is_public=1").all<any>()
  const types = await c.env.DB.prepare("SELECT DISTINCT type FROM stock WHERE status='active' AND is_public=1").all<any>()
  return c.json({ locations: locs.results.map((r: any) => r.location), types: types.results.map((r: any) => r.type) })
})

// Public: news feed for the homepage (by city). Returns [] gracefully if the table isn't there yet.
app.get('/api/news', async (c) => {
  const city = (c.req.query('city') || '').trim()
  try {
    let sql = "SELECT id, city, title, body, image_url, source_url, expert_comment, created_at FROM news WHERE status='published'"
    const params: any[] = []
    if (city) { sql += ' AND city = ?'; params.push(city) }
    sql += ' ORDER BY created_at DESC LIMIT 40'
    const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>()
    return c.json({ items: results })
  } catch { return c.json({ items: [] }) }
})

// Public: auto real-estate news via Google News RSS (no API key).
// Resilient: last-good results are cached in D1 (news_cache), so news keeps showing even when Google blocks the
// datacenter IP. Fast: a fresh D1 cache (<3h) is served instantly without hitting Google. ?debug=1 → diagnostics.
app.get('/api/news/auto', async (c) => {
  const city = (c.req.query('city') || 'Rajasthan').trim()
  const debug = c.req.query('debug') === '1'
  const now = Math.floor(Date.now() / 1000)

  // 1) serve fresh D1 cache (instant, no Google hit)
  let cached: any = null
  try { cached = await c.env.DB.prepare('SELECT payload, updated_at FROM news_cache WHERE city=?').bind(city).first<any>() } catch {}
  if (!debug && cached && (now - Number(cached.updated_at)) < 3 * 3600) {
    try { return c.json({ items: JSON.parse(cached.payload) }) } catch {}
  }

  // 2) fetch fresh. Bing News RSS is primary — Google News RSS 503s Cloudflare's datacenter IPs.
  const strip = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
  // Bing wraps the real article in apiclick.aspx?...&url=<encoded> — pull it out so links go straight to the source.
  const realUrl = (link: string) => { const m = link.match(/[?&]url=([^&]+)/); if (m) { try { return decodeURIComponent(m[1]) } catch {} } return link }
  const fetchBing = async (query: string) => {
    const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS&cc=IN&setlang=hi`
    let status = 0, len = 0, hasItem = false, head = ''
    const out: any[] = []
    try {
      const res = await fetch(url, {
        cf: { cacheTtl: 600 },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
          'Accept-Language': 'hi-IN,hi,en-IN;q=0.8,en;q=0.6',
        },
      } as any)
      status = res.status
      const xml = await res.text()
      len = xml.length; hasItem = xml.includes('<item>'); head = xml.slice(0, 160)
      for (const b of xml.split('<item>').slice(1, 16)) {
        const get = (tag: string) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? strip(m[1]) : '' }
        const title = get('title'), link = get('link')
        if (!title || !link) continue
        // Bing puts source in <News:Source Url="...">NAME</News:Source>
        out.push({ title, link: realUrl(link), source: get('News:Source') || get('source'), pubDate: get('pubDate') })
      }
    } catch (e: any) { head = 'ERR: ' + String(e?.message || e).slice(0, 100) }
    return { out, status, len, hasItem, head }
  }
  const fetchGoogle = async (query: string) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=hi&gl=IN&ceid=IN:hi&_=${Math.floor(now / 600)}`
    let status = 0, hasItem = false
    const out: any[] = []
    try {
      const res = await fetch(url, { cf: { cacheTtl: 600 }, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Cookie': 'CONSENT=YES+cb; SOCS=CAI' } } as any)
      status = res.status
      const xml = await res.text()
      hasItem = xml.includes('<item>')
      for (const b of xml.split('<item>').slice(1, 16)) {
        const get = (tag: string) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? strip(m[1]) : '' }
        const title = get('title'), link = get('link')
        if (!title || !link) continue
        out.push({ title, link, source: get('source'), pubDate: get('pubDate') })
      }
    } catch {}
    return { out, status, hasItem }
  }

  let items: any[] = []
  const d: any = {}
  const r1 = await fetchBing(`${city} Rajasthan real estate property`)   // Bing hates OR-operators + Devanagari → plain terms only
  items = r1.out; d.bing = { status: r1.status, len: r1.len, hasItem: r1.hasItem, count: r1.out.length, head: r1.head }
  if (items.length < 4) {   // thin → top up with Rajasthan real-estate news (Bing)
    const r2 = await fetchBing(`Rajasthan real estate property plot rate`)
    d.bingFallback = { status: r2.status, hasItem: r2.hasItem, count: r2.out.length }
    const seen = new Set(items.map(i => i.link))
    for (const e of r2.out) if (!seen.has(e.link)) { items.push(e); seen.add(e.link) }
  }
  if (items.length < 4) {   // Bing failed too → last-resort Google
    const r3 = await fetchGoogle(`${city} property OR real estate OR प्लॉट OR ज़मीन`)
    d.google = { status: r3.status, hasItem: r3.hasItem, count: r3.out.length }
    const seen = new Set(items.map(i => i.link))
    for (const e of r3.out) if (!seen.has(e.link)) { items.push(e); seen.add(e.link) }
  }
  items = items.slice(0, 9)

  // 3) got news → refresh D1 cache; got nothing → serve last-good (own cache, else freshest any-city)
  if (items.length) {
    try { await c.env.DB.prepare('INSERT INTO news_cache (city, payload, updated_at) VALUES (?,?,?) ON CONFLICT(city) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at').bind(city, JSON.stringify(items), now).run() } catch {}
  } else if (cached) {
    try { items = JSON.parse(cached.payload) } catch {}
  } else {
    // small town + Bing returned empty this time → show freshest news from any city (Rajasthan real-estate is relevant)
    try { const any = await c.env.DB.prepare('SELECT payload FROM news_cache ORDER BY updated_at DESC LIMIT 1').first<any>(); if (any) items = JSON.parse(any.payload) } catch {}
  }

  if (debug) return c.json({ city, served: items.length, hadStaleCache: !!cached, ...d })
  return c.json({ items })
})

// Buyer requirement form (Customer Self-Entry)
app.post('/api/requirements', async (c) => {
  const b = await c.req.json().catch(() => ({})) as any
  // Honeypot: bots fill the hidden "website" field → pretend success, insert nothing
  if (b.website) return c.json({ ok: true, id: 0, message: 'Your requirement has been noted. Our team will contact you soon.' })
  if (!(await rateLimit(c.env, `form:${clientIp(c)}`, 20, 600))) return c.json({ error: 'Thodi der baad dubara try karein.' }, 429)
  const { name, mobile, location, type } = b
  if (!name || !mobile || !location || !type) return c.json({ error: 'Name, mobile, location and property type are required' }, 400)
  if (!/^\d{10}$/.test(String(mobile))) return c.json({ error: 'Mobile number must be 10 digits' }, 400)
  // ponytail: basic anti-flood — one self-entry per mobile per 10 min. Upgrade to Turnstile / per-IP if abused.
  const recent = await c.env.DB.prepare(
    "SELECT id FROM requirements WHERE mobile=? AND source_type='self' AND created_at >= datetime('now','-10 minutes')"
  ).bind(String(mobile)).first<any>()
  if (recent) return c.json({ ok: true, id: recent.id, message: 'We just received your requirement. Our team will contact you soon.' })

  // If this mobile has a telecaller entry within 30 days → link/resolve it (clears the red flag)
  const tele = await c.env.DB.prepare(
    "SELECT id FROM requirements WHERE mobile=? AND source_type='telecaller' AND created_at >= datetime('now','-30 days') ORDER BY created_at DESC LIMIT 1"
  ).bind(String(mobile)).first<any>()

  const r = await c.env.DB.prepare(
    `INSERT INTO requirements (name, mobile, location, budget_min_lakh, budget_max_lakh, type, timeline, notes, source_type, telecaller_id)
     VALUES (?,?,?,?,?,?,?,?,'self',?)`
  ).bind(
    String(name).trim(), String(mobile).trim(), String(location).trim(),
    b.budget_min ? Number(b.budget_min) : null, b.budget_max ? Number(b.budget_max) : null,
    String(type), b.timeline ? String(b.timeline) : null, b.notes ? String(b.notes).slice(0, 1000) : null,
    tele ? (await c.env.DB.prepare('SELECT telecaller_id t FROM requirements WHERE id=?').bind(tele.id).first<any>())?.t ?? null : null
  ).run()

  if (tele) {
    await c.env.DB.prepare("UPDATE requirements SET status='contacted' WHERE id=?").bind(tele.id).run()
  }
  return c.json({ ok: true, id: r.meta.last_row_id, message: 'Your requirement has been noted. Our team will contact you soon.' })
})

// Buyer self-service: track a requirement (needs BOTH mobile + ref id — prevents enumeration)
app.get('/api/track', async (c) => {
  const mobile = String(c.req.query('mobile') || '').trim()
  const ref = Number(c.req.query('ref') || 0)
  if (!/^\d{10}$/.test(mobile) || !ref) return c.json({ error: 'Enter your 10-digit mobile and reference number (e.g. 12).' }, 400)
  const r = await c.env.DB.prepare(
    'SELECT id, name, type, location, budget_min_lakh, budget_max_lakh, timeline, status, created_at FROM requirements WHERE id=? AND mobile=?'
  ).bind(ref, mobile).first<any>()
  if (!r) return c.json({ error: 'No requirement found for that mobile + reference number.' }, 404)
  const { results } = await c.env.DB.prepare(`
    SELECT s.type, s.colony, s.location, s.size_sqyd, s.rate_lakh, s.photos, m.matched_at
    FROM matches m JOIN stock s ON s.id = m.stock_id
    WHERE m.requirement_id = ? ORDER BY m.matched_at DESC
  `).bind(ref).all<any>()
  return c.json({ requirement: r, matches: results.map(fmtStock) })
})

// Seller stock form (multipart, photos → R2)
app.post('/api/stock', async (c) => {
  const form = await c.req.parseBody()
  // Honeypot: bots fill the hidden "website" field → pretend success, store nothing
  if (form['website']) return c.json({ ok: true, id: 0, photos: 0, message: 'Your property has been received. Our team will verify it and activate the listing.' })
  if (!(await rateLimit(c.env, `form:${clientIp(c)}`, 20, 600))) return c.json({ error: 'Thodi der baad dubara try karein.' }, 429)
  const name = String(form['seller_name'] || '').trim()
  const mobile = String(form['mobile'] || '').trim()
  const location = String(form['location'] || '').trim()
  const type = String(form['type'] || '').trim()
  if (!name || !mobile || !location || !type) return c.json({ error: 'Name, mobile, location and property type are required' }, 400)
  if (!/^\d{10}$/.test(mobile)) return c.json({ error: 'Mobile number must be 10 digits' }, 400)
  // ponytail: basic anti-flood — one submission per mobile per 10 min. Upgrade to Turnstile / per-IP if abused.
  const recent = await c.env.DB.prepare(
    "SELECT id FROM stock WHERE mobile=? AND created_at >= datetime('now','-10 minutes')"
  ).bind(mobile).first<any>()
  if (recent) return c.json({ ok: true, id: recent.id, photos: 0, message: 'This property was just submitted. Our team will review it shortly.' })

  const convert = ['convert', 'non_convert'].includes(String(form['convert_status'] || '')) ? String(form['convert_status']) : 'pending'
  const execName = String(form['executive_name'] || '').trim().slice(0, 80) || null
  // convert_date: use given date, else today — but only when a convert/non-convert outcome is set
  const convertDate = convert === 'pending' ? null : (String(form['convert_date'] || '').trim() || new Date().toISOString().slice(0, 10))
  // property_kind: 'plot' (plot/makan) or 'zameen' (agricultural land → khasra/khata/rakba)
  const kind = form['property_kind'] === 'zameen' ? 'zameen' : 'plot'
  const khasra = String(form['khasra_no'] || '').trim().slice(0, 60) || null
  const khata = String(form['khata_no'] || '').trim().slice(0, 60) || null
  const rakba = String(form['rakba'] || '').trim().slice(0, 60) || null
  const r = await c.env.DB.prepare(
    `INSERT INTO stock (seller_name, mobile, location, colony, size_sqyd, rate_lakh, type, txn, rent_monthly, description, status, source_type, source_name, is_public, executive_name, convert_status, convert_date, property_kind, khasra_no, khata_no, rakba)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', 'direct', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    name, mobile, location,
    String(form['colony'] || '').trim() || null,
    form['size_sqyd'] ? Number(form['size_sqyd']) : null,
    form['rate_lakh'] ? Number(form['rate_lakh']) : null,
    type,
    form['txn'] === 'rent' ? 'rent' : 'sale',
    form['rent_monthly'] ? Number(form['rent_monthly']) : null,
    String(form['description'] || '').slice(0, 1000) || null,
    form['is_public'] === '1' ? 1 : 0,   // default private unless seller explicitly opts in
    execName, convert, convertDate, kind, khasra, khata, rakba
  ).run()
  const stockId = r.meta.last_row_id as number

  // Photos: slots front/entrance/room/extra (max 2 extra) → R2.
  // R2 is optional: if the bucket isn't bound, the listing is still saved, photos are just skipped.
  const slots: Array<[string, string]> = [['front', 'Front / Outside view'], ['entrance', 'Entrance / Entry view'], ['room', 'Room / Interior view'], ['extra1', 'Layout / Extra photo'], ['extra2', 'Extra photo']]
  const photos: Array<{ url: string; label: string }> = []
  if (c.env.R2) {
    for (const [slot, label] of slots) {
      const f = form[slot]
      if (f && typeof f !== 'string' && (f as File).size > 0) {
        const file = f as File
        if (file.size > 5 * 1024 * 1024) return c.json({ error: `Photo "${label}" is larger than 5MB` }, 400)
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
        const key = `stock/${stockId}/${slot}-${Date.now()}.${ext}`
        await c.env.R2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || 'image/jpeg' } })
        photos.push({ url: `/api/photos/${encodeURIComponent(key)}`, label })
      }
    }
  }
  if (photos.length) {
    await c.env.DB.prepare('UPDATE stock SET photos=? WHERE id=?').bind(JSON.stringify(photos), stockId).run()
  }
  // Mirror to Google Sheet (Apps Script web app). Fire-and-forget: Sheet down never breaks a submission.
  if (c.env.SHEET_WEBHOOK_URL) {
    c.executionCtx.waitUntil(fetch(c.env.SHEET_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: stockId, created_at: new Date().toISOString(),
        seller_name: name, mobile, location,
        colony: String(form['colony'] || '').trim(),
        size_sqyd: form['size_sqyd'] || '', rate_lakh: form['rate_lakh'] || '',
        type, description: String(form['description'] || '').slice(0, 1000),
        executive_name: execName || '', convert_status: convert, convert_date: convertDate || '',
        property_kind: kind, khasra_no: khasra || '', khata_no: khata || '', rakba: rakba || '',
        photos: photos.map(p => p.url).join(', ')
      })
    }).catch(() => {}))
  }
  return c.json({ ok: true, id: stockId, photos: photos.length, message: 'Your property has been received. Our team will verify it and activate the listing.' })
})

/* ---------------- AI: read a Facebook/WhatsApp property post from a screenshot ---------------- */
// ponytail: single provider (Gemini Flash), one fetch, JSON response mode. Staff-only + rate-limited for cost control.
const GEMINI_MODEL = 'gemini-2.5-flash'   // change here if Google renames/deprecates the model

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CH = 0x2000   // 8KB chunks — small enough to avoid fromCharCode arg-limit issues on the edge
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as any)
  return btoa(bin)
}

app.post('/api/extract', requireStaff, async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ error: 'AI abhi configured nahi hai (GEMINI_API_KEY set karein).' }, 503)
  if (!(await rateLimit(c.env, `extract:${clientIp(c)}`, 40, 600))) return c.json({ error: 'Thodi der baad dubara try karein.' }, 429)
  try {
  const form = await c.req.parseBody()
  const f = form['image']
  if (!f || typeof f === 'string') return c.json({ error: 'Screenshot image zaroori hai' }, 400)
  const file = f as File
  if (file.size > 6 * 1024 * 1024) return c.json({ error: 'Image 6MB se badi hai — compress karke bhejein' }, 400)
  const imageB64 = abToBase64(await file.arrayBuffer())

  const prompt = `You are a data-entry assistant for an Indian rural/semi-urban real-estate CRM. The image is a screenshot of a property post from Facebook/WhatsApp. Text may be Hindi, English or mixed, and informal. Read it and extract the property details.

Return ONLY a JSON object with EXACTLY these keys (all string values; use "" when unknown):
{"seller_name":"","mobile":"","location":"","colony":"","type":"","size_sqyd":"","rate_lakh":"","description":""}

Rules:
- seller_name: the person/agent OFFERING the property (not a buyer). "" if unclear.
- mobile: one 10-digit Indian mobile if present, digits only (strip +91/spaces/dashes). "" if none.
- location: town / village / area / tehsil / district.
- colony: specific colony / scheme / road / landmark if mentioned.
- type: EXACTLY one of "Plot", "Makan", "Farm House", "Commercial Plot". Mapping: house/ghar/kothi/makan -> Makan; farm/agriculture/kheti/farmhouse/khet -> Farm House; shop/commercial/showroom/godown -> Commercial Plot; plot/land/jameen/gaj/bigha -> Plot. Best guess; "" only if truly unknown.
- size_sqyd: size in SQUARE FEET, number only (no units). DEFAULT UNIT IS SQUARE FEET: if a number has NO unit, use it as-is (do NOT convert). Dimensions like "30x60" or "20/40" are in feet -> multiply them (30x60 = 1800). Only if the unit is explicitly "gaj"/"sq yard"/"gaz": multiply by 9. If the unit is bigha/bissa/acre/hectare, leave "" and put the original size+unit in description instead.
- rate_lakh: total demand/price in LAKH rupees (number only). Convert: "20 lakh"->20, "2000000"/"20,00,000"->20, "1.2 crore"->120. If it is a per-gaj/per-sqft rate, leave "" and note it in description.
- description: a short clean summary plus anything not captured above (facing, road width, water/electricity, bigha size, per-gaj rate, extras).`

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${c.env.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: file.type || 'image/jpeg', data: imageB64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    })
    if (!res.ok) return c.json({ error: 'AI se jawab nahi mila', detail: (await res.text()).slice(0, 300) }, 502)
    const data = await res.json<any>()
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
    let fields: any = {}
    try { fields = JSON.parse(txt) } catch { return c.json({ error: 'AI ne saaf data nahi diya, dobara try karein' }, 502) }
    const pick = (k: string) => String(fields[k] ?? '').trim()
    return c.json({ ok: true, fields: {
      seller_name: pick('seller_name'), mobile: pick('mobile').replace(/\D/g, '').slice(-10),
      location: pick('location'), colony: pick('colony'), type: pick('type'),
      size_sqyd: pick('size_sqyd').replace(/[^\d.]/g, ''), rate_lakh: pick('rate_lakh').replace(/[^\d.]/g, ''),
      description: pick('description'),
    } })
  } catch (e: any) {
    return c.json({ error: 'AI request fail hui', detail: String(e?.message || e).slice(0, 250) }, 502)
  }
})

/* ---------------- field feedback (non-registered customers) ---------------- */
// Fixed reason vocabulary — keys are stable for reason-wise tallies; labels live in the form/dashboard.
const FEEDBACK_REASONS = ['no_need','future','not_understood','reg_doubt','must_buy','trust','no_clarity','no_interest','no_time','other']

// Field team submits feedback (multipart: optional voice note → R2). No login — filled in the field.
app.post('/api/feedback', async (c) => {
  const form = await c.req.parseBody()
  if (form['website']) return c.json({ ok: true, id: 0, message: 'Feedback mil gaya. Dhanyavaad!' }) // honeypot
  if (!(await rateLimit(c.env, `form:${clientIp(c)}`, 20, 600))) return c.json({ error: 'Thodi der baad dubara try karein.' }, 429)
  const clip = (k: string, n = 500) => String(form[k] || '').slice(0, n).trim() || null
  const mobile = String(form['mobile'] || '').trim()
  if (mobile && !/^\d{10}$/.test(mobile)) return c.json({ error: 'Mobile number 10 digit ka hona chahiye' }, 400)
  let reasons: string[] = []
  try { reasons = JSON.parse(String(form['reasons'] || '[]')).filter((r: string) => FEEDBACK_REASONS.includes(r)) } catch {}
  // Something must be captured — else it's an empty row.
  if (!reasons.length && !form['improve'] && !form['understanding'] && !(form['voice'] as File)?.size)
    return c.json({ error: 'Kam se kam ek reason, feedback ya voice note bharein' }, 400)

  const r = await c.env.DB.prepare(
    `INSERT INTO feedback (name, mobile, location, field_team, visit_id, understanding, reasons, trust, trust_detail, improve)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    clip('name'), mobile || null, clip('location'), clip('field_team'), clip('visit_id'),
    ['full','partial','none'].includes(String(form['understanding'])) ? String(form['understanding']) : null,
    JSON.stringify(reasons),
    ['no','little','yes'].includes(String(form['trust'])) ? String(form['trust']) : null,
    clip('trust_detail'), clip('improve', 1000)
  ).run()
  const id = r.meta.last_row_id as number

  const voice = form['voice']
  if (c.env.R2 && voice && typeof voice !== 'string' && (voice as File).size > 0) {
    const f = voice as File
    if (f.size > 10 * 1024 * 1024) return c.json({ error: 'Voice note 10MB se bada hai' }, 400)
    const ext = (f.type.split('/')[1] || 'webm').replace(/[^a-z0-9]/g, '') || 'webm'
    const key = `feedback/${id}/voice-${Date.now()}.${ext}`
    await c.env.R2.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type || 'audio/webm' } })
    await c.env.DB.prepare('UPDATE feedback SET voice_url=? WHERE id=?').bind(`/api/photos/${encodeURIComponent(key)}`, id).run()
  }
  return c.json({ ok: true, id, message: 'Aapka feedback mil gaya. Dhanyavaad!' })
})

// Serve photos from R2 (seeded placeholders under public/static are served as static assets)
// Root page (worker receives '/' because _routes.json excludes only explicit file paths)
app.get('/', (c) => c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url))))

app.get('/api/photos/:key{.+}', async (c) => {
  if (!c.env.R2) return c.notFound()
  const key = c.req.param('key')
  const obj = await c.env.R2.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg')
  headers.set('Cache-Control', 'public, max-age=86400')
  return new Response(obj.body, { headers })
})

/* ---------------- telecaller panel ---------------- */

// Quick entry after a call (Telecaller Entry)
app.post('/api/tele/requirements', requireStaff, async (c) => {
  const user = c.get('user') as JWTPayload
  const b = await c.req.json().catch(() => ({})) as any
  const { name, mobile, location, type } = b
  if (!name || !mobile || !location || !type) return c.json({ error: 'Name, mobile, location and type are required' }, 400)
  if (!/^\d{10}$/.test(String(mobile))) return c.json({ error: 'Mobile number must be 10 digits' }, 400)
  const dup = await c.env.DB.prepare(
    "SELECT id FROM requirements WHERE mobile=? AND created_at >= datetime('now','-7 days')"
  ).bind(String(mobile)).first<any>()
  if (dup) return c.json({ error: `This mobile number was already entered in the last 7 days (#${dup.id})` }, 409)
  const r = await c.env.DB.prepare(
    `INSERT INTO requirements (name, mobile, location, budget_min_lakh, budget_max_lakh, type, timeline, notes, source_type, telecaller_id)
     VALUES (?,?,?,?,?,?,?,?, 'telecaller', ?)`
  ).bind(
    String(name).trim(), String(mobile).trim(), String(location).trim(),
    b.budget_min ? Number(b.budget_min) : null, b.budget_max ? Number(b.budget_max) : null,
    String(type), b.timeline ? String(b.timeline) : null, b.notes ? String(b.notes).slice(0, 500) : null,
    user.uid
  ).run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

// Red-flag list: telecaller entries with no self-entry within 5 days
app.get('/api/tele/redflags', requireStaff, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, CAST(julianday('now') - julianday(r.created_at) AS INTEGER) AS days_waiting
    FROM requirements r
    WHERE r.source_type='telecaller'
      AND r.created_at <= datetime('now','-5 days')
      AND r.status IN ('new','contacted')
      AND NOT EXISTS (
        SELECT 1 FROM requirements s
        WHERE s.mobile = r.mobile AND s.source_type='self' AND s.created_at >= r.created_at
      )
    ORDER BY r.created_at ASC
  `).all<any>()
  return c.json({ items: results })
})

// Telecaller's own recent entries
app.get('/api/tele/my-entries', requireStaff, async (c) => {
  const user = c.get('user') as JWTPayload
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM requirements WHERE telecaller_id=? ORDER BY created_at DESC LIMIT 30'
  ).bind(user.uid).all<any>()
  return c.json({ items: results })
})

/* ---------------- admin dashboard ---------------- */

app.get('/api/admin/requirements', requireStaff, async (c) => {
  const { status = '', q = '' } = c.req.query()
  let sql = 'SELECT r.*, u.name AS telecaller_name FROM requirements r LEFT JOIN users u ON u.id=r.telecaller_id'
  const conds: string[] = [], params: any[] = []
  if (status) { conds.push('r.status=?'); params.push(status) }
  if (q) { conds.push('(r.name LIKE ? OR r.mobile LIKE ? OR r.location LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ')
  sql += ' ORDER BY r.created_at DESC LIMIT 200'
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>()
  return c.json({ items: results })
})

app.get('/api/admin/stock', requireStaff, async (c) => {
  const { status = '', q = '' } = c.req.query()
  let sql = 'SELECT * FROM stock'
  const conds: string[] = [], params: any[] = []
  if (status) { conds.push('status=?'); params.push(status) }
  if (q) { conds.push('(seller_name LIKE ? OR mobile LIKE ? OR location LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ')
  sql += ' ORDER BY created_at DESC LIMIT 200'
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>()
  return c.json({ items: results.map(fmtStock) })
})

app.patch('/api/admin/stock/:id/status', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const { status } = await c.req.json().catch(() => ({})) as any
  if (!['pending', 'active', 'sold'].includes(status)) return c.json({ error: 'Invalid status' }, 400)
  await c.env.DB.prepare('UPDATE stock SET status=? WHERE id=?').bind(status, id).run()
  return c.json({ ok: true })
})

// Edit a listing's details (admin only). Column names are a fixed whitelist; values are bound.
app.patch('/api/admin/stock/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json().catch(() => ({})) as any
  if (b.mobile != null && !/^\d{10}$/.test(String(b.mobile))) return c.json({ error: 'Mobile number must be 10 digits' }, 400)
  const sets: string[] = [], params: any[] = []
  for (const f of ['seller_name', 'mobile', 'location', 'colony', 'size_sqyd', 'rate_lakh', 'type', 'txn', 'rent_monthly', 'description', 'is_public', 'executive_name', 'convert_status', 'convert_date', 'property_kind', 'khasra_no', 'khata_no', 'rakba']) {
    if (!(f in b)) continue
    let v: any = b[f]
    if (f === 'size_sqyd' || f === 'rate_lakh' || f === 'rent_monthly') v = v === '' || v == null ? null : Number(v)
    else if (f === 'is_public') v = v ? 1 : 0
    else if (f === 'convert_status') v = ['convert', 'non_convert'].includes(String(v)) ? String(v) : 'pending'
    else v = v == null ? null : String(v).trim() || null
    sets.push(`${f}=?`); params.push(v)
  }
  // keep data clean: pending status has no convert date
  if (b.convert_status != null && !['convert', 'non_convert'].includes(String(b.convert_status)) && !sets.some(s => s.startsWith('convert_date'))) {
    sets.push('convert_date=?'); params.push(null)
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400)
  params.push(id)
  await c.env.DB.prepare(`UPDATE stock SET ${sets.join(', ')} WHERE id=?`).bind(...params).run()
  return c.json({ ok: true })
})

// Staff (admin + telecaller): append photos to a listing (for /sell entries that came without photos, or photos that arrive later)
app.post('/api/admin/stock/:id{[0-9]+}/photos', requireStaff, async (c) => {
  if (!c.env.R2) return c.json({ error: 'Photo storage band hai. Cloudflare dashboard → project Settings → Bindings me R2 bucket add karein, phir photos upload honge.' }, 400)
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT photos FROM stock WHERE id=?').bind(id).first<any>()
  if (!row) return c.json({ error: 'Listing not found' }, 404)
  let photos: any[] = []; try { photos = JSON.parse(row.photos || '[]') } catch {}
  const form = await c.req.parseBody({ all: true })
  const files = ([] as any[]).concat(form['photos'] || [])
  let added = 0
  for (const f of files) {
    if (!f || typeof f === 'string' || !(f as File).size) continue
    const file = f as File
    if (file.size > 6 * 1024 * 1024) return c.json({ error: 'Har photo 6MB se chhoti honi chahiye' }, 400)
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
    const key = `stock/${id}/added-${Date.now()}-${added}.${ext}`
    await c.env.R2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || 'image/jpeg' } })
    photos.push({ url: `/api/photos/${encodeURIComponent(key)}`, label: 'Added photo' })
    added++
  }
  if (added) await c.env.DB.prepare('UPDATE stock SET photos=? WHERE id=?').bind(JSON.stringify(photos), id).run()
  return c.json({ ok: true, added, photos })
})

// Staff (admin + telecaller): remove one photo from a listing (best-effort R2 cleanup)
app.delete('/api/admin/stock/:id{[0-9]+}/photos', requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const { url } = await c.req.json().catch(() => ({})) as any
  if (!url) return c.json({ error: 'url required' }, 400)
  const row = await c.env.DB.prepare('SELECT photos FROM stock WHERE id=?').bind(id).first<any>()
  if (!row) return c.json({ error: 'Listing not found' }, 404)
  let photos: any[] = []; try { photos = JSON.parse(row.photos || '[]') } catch {}
  photos = photos.filter((p: any) => (typeof p === 'string' ? p : p.url) !== url)
  await c.env.DB.prepare('UPDATE stock SET photos=? WHERE id=?').bind(JSON.stringify(photos), id).run()
  if (c.env.R2) { try { const m = String(url).match(/\/api\/photos\/(.+)$/); if (m) await c.env.R2.delete(decodeURIComponent(m[1])) } catch {} }
  return c.json({ ok: true, photos })
})

/* ---------------- admin: news feed management ---------------- */
app.get('/api/admin/news', requireStaff, async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM news ORDER BY created_at DESC LIMIT 200').all<any>()
    return c.json({ items: results })
  } catch { return c.json({ items: [] }) }
})
app.post('/api/admin/news', requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => ({})) as any
  const city = String(b.city || '').trim(), title = String(b.title || '').trim()
  if (!city || !title) return c.json({ error: 'City aur title zaroori hain' }, 400)
  const clip = (k: string, n = 2000) => { const v = String(b[k] || '').trim(); return v ? v.slice(0, n) : null }
  const r = await c.env.DB.prepare(
    'INSERT INTO news (city, title, body, image_url, source_url, expert_comment, status) VALUES (?,?,?,?,?,?,?)'
  ).bind(city, title.slice(0, 200), clip('body'), clip('image_url', 500), clip('source_url', 500), clip('expert_comment'), b.status === 'draft' ? 'draft' : 'published').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})
app.patch('/api/admin/news/:id{[0-9]+}', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json().catch(() => ({})) as any
  const sets: string[] = [], params: any[] = []
  for (const f of ['city', 'title', 'body', 'image_url', 'source_url', 'expert_comment', 'status']) {
    if (!(f in b)) continue
    sets.push(`${f}=?`); params.push(b[f] == null ? null : String(b[f]).trim() || null)
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400)
  params.push(id)
  await c.env.DB.prepare(`UPDATE news SET ${sets.join(', ')} WHERE id=?`).bind(...params).run()
  return c.json({ ok: true })
})
app.delete('/api/admin/news/:id{[0-9]+}', requireAdmin, async (c) => {
  await c.env.DB.prepare('DELETE FROM news WHERE id=?').bind(Number(c.req.param('id'))).run()
  return c.json({ ok: true })
})

// Delete a listing permanently (admin only). Removes its match records first (no FK cascade in schema).
app.delete('/api/admin/stock/:id{[0-9]+}', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM matches WHERE stock_id=?').bind(id).run()
  const res = await c.env.DB.prepare('DELETE FROM stock WHERE id=?').bind(id).run()
  return c.json({ ok: true, deleted: res.meta?.changes || 0 })
})

app.patch('/api/admin/requirements/:id/status', requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const { status } = await c.req.json().catch(() => ({})) as any
  if (!['new', 'contacted', 'matched', 'closed'].includes(status)) return c.json({ error: 'Invalid status' }, 400)
  await c.env.DB.prepare('UPDATE requirements SET status=? WHERE id=?').bind(status, id).run()
  return c.json({ ok: true })
})

// Auto-suggest matching stock for a requirement.
// Uses Gemini (understands Hindi spellings + nearby localities) when GEMINI_API_KEY is set; else SQL overlap.
app.get('/api/admin/requirements/:id/suggest', requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const req = await c.env.DB.prepare('SELECT * FROM requirements WHERE id=?').bind(id).first<any>()
  if (!req) return c.json({ error: 'Requirement not found' }, 404)

  // candidate pool = all active stock (AI decides nearby-area / spelling matches, not SQL)
  const pool = (await c.env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM matches m WHERE m.stock_id=s.id) AS match_count
     FROM stock s WHERE s.status='active' ORDER BY s.created_at DESC LIMIT 60`
  ).all<any>()).results
  if (!pool.length) return c.json({ items: [], mode: 'empty' })

  if (c.env.GEMINI_API_KEY && await rateLimit(c.env, `aimatch:${clientIp(c)}`, 60, 600)) {
    try {
      const list = pool.map((s: any) => ({ id: s.id, type: s.type, location: s.location, colony: s.colony, size_sqft: s.size_sqyd, rate_lakh: s.rate_lakh }))
      const prompt = `You are a real-estate match-maker for an Indian rural/semi-urban property CRM. Match ONE buyer requirement to the available properties.

BUYER REQUIREMENT:
type: ${req.type || 'any'}
location: ${req.location || 'any'}
budget: ${req.budget_min_lakh ?? '?'} to ${req.budget_max_lakh ?? '?'} lakh
notes: ${String(req.notes || '').slice(0, 300) || '-'}

AVAILABLE PROPERTIES (JSON array):
${JSON.stringify(list)}

Return ONLY this JSON: {"matches":[{"id":<id>,"score":<0-100>,"reason":"<very short why>"}]}

Matching rules:
- LOCATION matters most. Treat nearby localities / areas within the SAME city or region as a match (e.g. Borkheda, Devli Arab Road, Raipura are all in/near Kota; colonies of the same town match the town). Understand Hindi AND English spellings and transliteration (बोरखेड़ा = Borkheda, झालावाड़ = Jhalawar, कोटा = Kota) and minor misspellings.
- BUDGET: a property within budget scores high; up to ~20% above the buyer's max is acceptable with lower score; far above budget scores low.
- TYPE: same type scores high; a close type (e.g. Plot vs Commercial Plot) can still match with a lower score.
- Include ONLY properties with score >= 40, ranked by score descending. If none fit, return {"matches":[]}.`

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${c.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
      })
      if (res.ok) {
        const data = await res.json<any>()
        const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
        const matches = (() => { try { const p = JSON.parse(txt); return Array.isArray(p?.matches) ? p.matches : [] } catch { return [] } })()
        const byId = new Map(pool.map((s: any) => [s.id, s]))
        const items = matches
          .filter((m: any) => byId.has(Number(m.id)))
          .sort((a: any, b: any) => (b.score || 0) - (a.score || 0))
          .map((m: any) => ({ ...fmtStock(byId.get(Number(m.id))), _reason: String(m.reason || '').slice(0, 120) }))
        return c.json({ items, mode: 'ai' })
      }
    } catch { /* fall through to SQL */ }
  }

  // SQL fallback: location/budget/type overlap
  const { results } = await c.env.DB.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM matches m WHERE m.stock_id=s.id) AS match_count
    FROM stock s
    WHERE s.status='active'
      AND (s.location = ? OR s.colony LIKE '%' || ? || '%' OR ? LIKE '%' || s.location || '%')
      AND (? IS NULL OR s.rate_lakh IS NULL OR s.rate_lakh <= ? + 10)
      AND (s.type = ? OR ? IS NULL)
    ORDER BY ABS(COALESCE(s.rate_lakh,0) - COALESCE(?,0)) ASC
    LIMIT 12
  `).bind(req.location, req.location, req.location, req.budget_max_lakh, req.budget_max_lakh, req.type, req.type, req.budget_max_lakh).all<any>()
  return c.json({ items: results.map(fmtStock), mode: 'sql' })
})

// Manual match & send (increments lead_count)
app.post('/api/admin/matches', requireStaff, async (c) => {
  const user = c.get('user') as JWTPayload
  const { requirement_id, stock_ids } = await c.req.json().catch(() => ({})) as any
  if (!requirement_id || !Array.isArray(stock_ids) || !stock_ids.length) return c.json({ error: 'requirement_id and stock_ids are required' }, 400)
  let added = 0
  for (const sid of stock_ids) {
    const res = await c.env.DB.prepare(
      'INSERT OR IGNORE INTO matches (requirement_id, stock_id, matched_by) VALUES (?,?,?)'
    ).bind(requirement_id, Number(sid), user.name).run()
    if (res.meta.changes > 0) {
      await c.env.DB.prepare('UPDATE stock SET lead_count = lead_count + 1 WHERE id=?').bind(Number(sid)).run()
      added++
    }
  }
  let notified = false
  if (added > 0) {
    await c.env.DB.prepare("UPDATE requirements SET status='matched' WHERE id=? AND status!='closed'").bind(requirement_id).run()
    notified = await notifyBuyerWhatsApp(c.env, Number(requirement_id), stock_ids.map(Number)).catch(() => false)
  }
  return c.json({ ok: true, added, notified })
})

app.get('/api/admin/matches', requireStaff, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT m.*, r.name AS buyer_name, r.mobile AS buyer_mobile, r.location AS req_location,
           s.location AS stock_location, s.colony, s.rate_lakh, s.type AS stock_type
    FROM matches m
    JOIN requirements r ON r.id = m.requirement_id
    JOIN stock s ON s.id = m.stock_id
    ORDER BY m.matched_at DESC LIMIT 100
  `).all<any>()
  return c.json({ items: results })
})

// Source/channel-wise analytics
app.get('/api/admin/analytics', requireStaff, async (c) => {
  const stockBySource = await c.env.DB.prepare('SELECT source_type, COUNT(*) n FROM stock GROUP BY source_type').all<any>()
  const reqBySource = await c.env.DB.prepare('SELECT source_type, COUNT(*) n FROM requirements GROUP BY source_type').all<any>()
  const stockByStatus = await c.env.DB.prepare('SELECT status, COUNT(*) n FROM stock GROUP BY status').all<any>()
  const reqByStatus = await c.env.DB.prepare('SELECT status, COUNT(*) n FROM requirements GROUP BY status').all<any>()
  const topLeads = await c.env.DB.prepare('SELECT id, location, colony, rate_lakh, lead_count FROM stock ORDER BY lead_count DESC LIMIT 5').all<any>()
  const last7 = await c.env.DB.prepare(`
    SELECT date(created_at) d,
      SUM(CASE WHEN source_type='self' THEN 1 ELSE 0 END) self,
      SUM(CASE WHEN source_type='telecaller' THEN 1 ELSE 0 END) telecaller
    FROM requirements WHERE created_at >= datetime('now','-7 days') GROUP BY date(created_at) ORDER BY d
  `).all<any>()
  return c.json({
    stock_by_source: stockBySource.results, req_by_source: reqBySource.results,
    stock_by_status: stockByStatus.results, req_by_status: reqByStatus.results,
    top_leads: topLeads.results, last7: last7.results,
  })
})

// Field feedback list + reason-wise tally (the "which problem is biggest" dashboard).
// ponytail: full-scan JSON tally in JS — fine for thousands of rows. Normalize to a reasons table if it ever gets slow.
app.get('/api/admin/feedback', requireStaff, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 500').all<any>()
  const items = results.map((r: any) => ({ ...r, reasons: (() => { try { return JSON.parse(r.reasons || '[]') } catch { return [] } })() }))
  const reasonCounts: Record<string, number> = {}
  const trustCounts = { no: 0, little: 0, yes: 0 }
  const understandCounts = { full: 0, partial: 0, none: 0 }
  const { results: all } = await c.env.DB.prepare('SELECT reasons, trust, understanding FROM feedback').all<any>()
  for (const row of all) {
    try { for (const k of JSON.parse(row.reasons || '[]')) reasonCounts[k] = (reasonCounts[k] || 0) + 1 } catch {}
    if (row.trust in trustCounts) (trustCounts as any)[row.trust]++
    if (row.understanding in understandCounts) (understandCounts as any)[row.understanding]++
  }
  return c.json({ items, total: all.length, reason_counts: reasonCounts, trust_counts: trustCounts, understanding_counts: understandCounts })
})

// Agent/Realtor light-add form (auth-protected, Phase 3 light version)
app.post('/api/agent/stock', requireStaff, async (c) => {
  const b = await c.req.json().catch(() => ({})) as any
  const { seller_name, mobile, location, type, source_name, source_type } = b
  if (!seller_name || !mobile || !location || !type || !source_name) return c.json({ error: 'All fields are required' }, 400)
  const st = ['realtor', 'agent', 'new_agent'].includes(source_type) ? source_type : 'agent'
  const r = await c.env.DB.prepare(
    `INSERT INTO stock (seller_name, mobile, location, colony, size_sqyd, rate_lakh, type, txn, rent_monthly, description, status, source_type, source_name, is_public, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, 1, 'agent_form')`
  ).bind(
    String(seller_name).trim(), String(mobile).trim(), String(location).trim(),
    b.colony ? String(b.colony).trim() : null,
    b.size_sqyd ? Number(b.size_sqyd) : null,
    b.rate_lakh ? Number(b.rate_lakh) : null,
    String(type),
    b.txn === 'rent' ? 'rent' : 'sale',
    b.rent_monthly ? Number(b.rent_monthly) : null,
    b.description ? String(b.description).slice(0, 500) : null,
    st, String(source_name).trim()
  ).run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

/* ---------------- daily huddle / standup ---------------- */
// ponytail: hardcoded IST offset — this team is India-based. Change if you go multi-timezone.
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')

// Team member: submit / update own standup for a day (default today). One row per person per day.
app.post('/api/huddle/standup', requireAuth, async (c) => {
  const user = c.get('user') as JWTPayload
  const b = await c.req.json().catch(() => ({})) as any
  const date = isDate(b.work_date) ? b.work_date : istToday()
  const clip = (v: any) => v ? String(v).slice(0, 2000).trim() || null : null
  const yesterday = clip(b.yesterday), issues = clip(b.issues), today = clip(b.today)
  if (!yesterday && !issues && !today) return c.json({ error: 'Kuch to bharo — kal ke task, issue ya aaj ke task' }, 400)
  await c.env.DB.prepare(`
    INSERT INTO standups (user_id, work_date, yesterday, issues, today)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, work_date) DO UPDATE SET
      yesterday=excluded.yesterday, issues=excluded.issues, today=excluded.today, updated_at=datetime('now')
  `).bind(user.uid, date, yesterday, issues, today).run()
  return c.json({ ok: true, work_date: date })
})

// Team member: own recent standups (includes sir's feedback)
app.get('/api/huddle/mine', requireAuth, async (c) => {
  const user = c.get('user') as JWTPayload
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM standups WHERE user_id=? ORDER BY work_date DESC LIMIT 30'
  ).bind(user.uid).all<any>()
  return c.json({ items: results })
})

// Admin board for one day: everyone's standup + who hasn't posted. This is the meeting view.
app.get('/api/huddle/board', requireAdmin, async (c) => {
  const date = isDate(c.req.query('date')) ? c.req.query('date') : istToday()
  const { results } = await c.env.DB.prepare(`
    SELECT s.*, u.name AS user_name, u.role FROM standups s
    JOIN users u ON u.id = s.user_id WHERE s.work_date = ? ORDER BY u.name
  `).bind(date).all<any>()
  const posted = new Set(results.map((r: any) => r.user_id))
  const { results: everyone } = await c.env.DB.prepare(
    "SELECT id, name FROM users WHERE role='telecaller' AND active=1 ORDER BY name"
  ).all<any>()
  const missing = everyone.filter((u: any) => !posted.has(u.id)).map((u: any) => u.name)
  return c.json({ date, items: results, missing })
})

// Admin: leave / update feedback on a standup
app.post('/api/huddle/feedback', requireAdmin, async (c) => {
  const user = c.get('user') as JWTPayload
  const { id, feedback } = await c.req.json().catch(() => ({})) as any
  if (!id) return c.json({ error: 'id required' }, 400)
  await c.env.DB.prepare('UPDATE standups SET feedback=?, feedback_by=? WHERE id=?')
    .bind(feedback ? String(feedback).slice(0, 1000).trim() || null : null, user.name, Number(id)).run()
  return c.json({ ok: true })
})

/* ---- sir manages the team (add / list / enable / reset huddle members) ---- */

// List all team members (telecallers) — shows who is huddle-only vs full CRM staff
app.get('/api/huddle/members', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, phone, huddle_only, active, created_at FROM users WHERE role='telecaller' ORDER BY active DESC, name"
  ).all<any>()
  return c.json({ items: results })
})

// Add a huddle-only member — own login, but no CRM data access
app.post('/api/huddle/members', requireAdmin, async (c) => {
  const b = await c.req.json().catch(() => ({})) as any
  const name = String(b.name || '').trim()
  const phone = String(b.phone || '').trim()
  const password = String(b.password || '')
  if (!name || !phone || !password) return c.json({ error: 'Naam, phone aur password teeno chahiye' }, 400)
  if (!/^\d{10}$/.test(phone)) return c.json({ error: 'Phone 10 digit ka hona chahiye' }, 400)
  if (password.length < 4) return c.json({ error: 'Password kam se kam 4 characters ka rakho' }, 400)
  const dupe = await c.env.DB.prepare('SELECT id FROM users WHERE phone=?').bind(phone).first<any>()
  if (dupe) return c.json({ error: 'Ye phone pehle se registered hai' }, 409)
  const salt = crypto.randomUUID()
  const hash = await hashPassword(password, salt)
  const r = await c.env.DB.prepare(
    "INSERT INTO users (name, phone, password_hash, salt, role, huddle_only, active) VALUES (?,?,?,?,'telecaller',1,1)"
  ).bind(name, phone, hash, salt).run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

// Enable / disable a member's login (huddle-only members only, to be safe)
app.post('/api/huddle/members/:id/active', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const { active } = await c.req.json().catch(() => ({})) as any
  await c.env.DB.prepare("UPDATE users SET active=? WHERE id=? AND huddle_only=1").bind(active ? 1 : 0, id).run()
  return c.json({ ok: true })
})

// Reset a huddle-only member's password
app.post('/api/huddle/members/:id/password', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const { password } = await c.req.json().catch(() => ({})) as any
  if (!password || String(password).length < 4) return c.json({ error: 'Password kam se kam 4 characters ka rakho' }, 400)
  const salt = crypto.randomUUID()
  const hash = await hashPassword(String(password), salt)
  const r = await c.env.DB.prepare("UPDATE users SET password_hash=?, salt=? WHERE id=? AND huddle_only=1").bind(hash, salt, id).run()
  if (r.meta.changes === 0) return c.json({ error: 'Sirf huddle-only members ka password yahan se reset hota hai' }, 400)
  return c.json({ ok: true })
})

// Non-API misses → try static assets (covers /login, /dashboard, /telecaller extension-less URLs)
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404)
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
