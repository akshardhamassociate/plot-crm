// Daily standup reminder — GitHub Actions (free). Pushes EVERY registered device
// to fill their Daily Huddle standup for today. Reuses the same tokens + service account.
// Env FIREBASE_SA = Firebase service-account JSON (GitHub secret, same as send-reminders.js).
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

const APP_URL = 'https://akshardhamassociate.github.io/plot-crm/';

(async () => {
  const tokensSnap = await db.collection('tokens').get();
  const tokens = [];
  tokensSnap.forEach(d => { const t = d.data(); if (t.token) tokens.push(t.token); });
  if (!tokens.length) { console.log('standup reminder: no registered devices'); return; }

  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {          // FCM multicast = max 500 tokens/call
    const batch = tokens.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: batch,
      notification: {
        title: 'Good morning 👋 Daily Huddle',
        body: "It's standup time — open the app and add your tasks for today."
      },
      android: { priority: 'high', notification: { channelId: 'reminders', sound: 'default' } },
      webpush: { fcmOptions: { link: APP_URL } }
    });
    sent += res.successCount;
    res.responses.forEach((r, j) => {                     // dead tokens saaf karo
      if (!r.success) {
        const code = (r.error && r.error.code) || '';
        if (code.includes('not-registered') || code.includes('invalid-argument'))
          db.collection('tokens').doc(batch[j]).delete().catch(() => {});
      }
    });
  }
  console.log(`standup reminder sent to ${sent}/${tokens.length} devices`);
})().catch(e => { console.error(e); process.exit(1); });
