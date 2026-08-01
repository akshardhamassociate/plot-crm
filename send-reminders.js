// Daily follow-up reminders — runs on GitHub Actions (free), sends FCM push to each executive.
// Needs env FIREBASE_SA = the Firebase service-account JSON (stored as a GitHub secret).
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

const OPEN = ['fresh', 'warm', 'hot', 'visit'];
const APP_URL = 'https://akshardhamassociate.github.io/plot-crm/';
// "today" in IST (GitHub runners are UTC)
const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

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

  // due follow-ups (today or overdue) grouped by executive
  const dueByExec = {};
  leadsSnap.forEach(d => {
    const L = d.data();
    if (!OPEN.includes(L.status)) return;
    const fus = L.followUps || [];
    const nextDate = fus.length ? fus[0].nextDate : '';   // newest follow-up is first
    if (!nextDate || nextDate > istToday) return;          // due = today or earlier
    const k = (L.exec || '').trim().toLowerCase();
    if (!k) return;
    (dueByExec[k] = dueByExec[k] || []).push(L.name || 'lead');
  });

  let totalSent = 0;
  for (const k of Object.keys(dueByExec)) {
    const tokens = byName[k];
    if (!tokens || !tokens.length) continue;                // no registered device for this exec
    const names = dueByExec[k];
    const body = names.length <= 3 ? names.join(', ') : names.slice(0, 3).join(', ') + ` +${names.length - 3} aur`;
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: `🔔 Aaj ${names.length} follow-up due`, body },
      webpush: { fcmOptions: { link: APP_URL } }
    });
    totalSent += res.successCount;
    // remove dead tokens
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code || '';
        if (code.includes('not-registered') || code.includes('invalid-argument')) {
          db.collection('tokens').doc(tokens[i]).delete().catch(() => {});
        }
      }
    });
  }
  console.log(`[${istToday}] execs due: ${Object.keys(dueByExec).length}, notifications sent: ${totalSent}`);
})().catch(e => { console.error(e); process.exit(1); });
