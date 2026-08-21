// Daily reminders — GitHub Actions (free). Notifies EVERY assigned executive about
// leads that are pending: newly assigned (no follow-up yet) OR follow-up due/overdue.
// Env FIREBASE_SA = Firebase service-account JSON (GitHub secret).
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

const OPEN = ['fresh', 'warm', 'hot', 'visit'];
const APP_URL = 'https://akshardhamassociate.github.io/plot-crm/';
const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);  // today in IST

(async () => {
  const [leadsSnap, tokensSnap] = await Promise.all([
    db.collection('leads').get(),
    db.collection('tokens').get()
  ]);

  // tokens grouped by executive name (lowercased)
  const byName = {};
  tokensSnap.forEach(d => {
    const t = d.data();
    const k = (t.nameKey || '').trim();
    if (t.token && k) (byName[k] = byName[k] || []).push(t.token);
  });

  // pending leads grouped by EACH assigned executive
  const dueByExec = {};
  leadsSnap.forEach(d => {
    const L = d.data();
    if (!OPEN.includes(L.status)) return;
    const fus = L.followUps || [];
    const nextDate = fus.length ? fus[0].nextDate : '';   // newest follow-up first
    const isNew = fus.length === 0;                        // assigned, koi kaam nahi hua
    const isDue = nextDate && nextDate <= istToday;        // due today or overdue
    if (!isNew && !isDue) return;
    const execs = (Array.isArray(L.execs) && L.execs.length) ? L.execs : (L.exec ? [L.exec] : []);
    execs.forEach(e => {
      const k = (e || '').trim().toLowerCase();
      if (k) (dueByExec[k] = dueByExec[k] || []).push(L.name || 'lead');
    });
  });

  let totalSent = 0;
  for (const k of Object.keys(dueByExec)) {
    const tokens = byName[k];
    if (!tokens || !tokens.length) continue;               // us exec ka koi device registered nahi
    const names = dueByExec[k];
    const body = names.length <= 3 ? names.join(', ') : names.slice(0, 3).join(', ') + ` +${names.length - 3} aur`;
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: `🔔 ${names.length} lead pe kaam baaki`, body },
      data: { badge: String(names.length) },   // app icon ka number set karega
      webpush: { fcmOptions: { link: APP_URL } }
    });
    totalSent += res.successCount;
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = (r.error && r.error.code) || '';
        if (code.includes('not-registered') || code.includes('invalid-argument')) {
          db.collection('tokens').doc(tokens[i]).delete().catch(() => {});
        }
      }
    });
  }
  console.log(`[${istToday}] execs notified: ${Object.keys(dueByExec).length}, sent: ${totalSent}`);
})().catch(e => { console.error(e); process.exit(1); });
