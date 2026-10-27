/**
 * ============================================================
 *  AKSHARDHAM ASSOCIATES — Smart Call Log (Code.gs)
 *  Sab kuch ek file me: Call Log + Assign-notification + AI Call Audit + Huddle→Sheet.
 *
 *  SETUP (ek-ek baar):
 *   • setupSheets()        → sheets + columns ready
 *   • Script Properties:
 *        FIREBASE_SA  = service account JSON (notification ke liye)
 *        GEMINI_KEY   = Gemini API key       (audit ke liye)
 *   • installAssignNotify()→ assign notification auto (har 5 min)
 *   • installCallAudit()   → calllog recordings auto-audit (har 10 min)
 *
 *  Deploy change ke baad: Deploy → Manage deployments → Edit → New version → Deploy
 * ============================================================
 */

// ─── SHEET NAMES ──────────────────────────────────────────
const SHEET_LOGS       = 'logs';
const SHEET_CONTACTS   = 'contacts';
const SHEET_USERS      = 'users';
const SHEET_CATEGORIES = 'categories';
const SHEET_HUDDLE     = 'huddle';   // Huddle standups yahan mirror hote hain (tracking)

const CONTACT_COLS = ['ID', 'User', 'Name', 'Mobile', 'Category', 'Saved At', 'assignedTo', 'Feedback', 'CallDate'];
const LOG_COLS = ['id','uid','user','date','cat','name','mob','purpose','resp','action','next','comment','dur','hasRec','ts'];
const USER_COLS = ['id','name','pw','role','tc'];
const CAT_COLS = ['name'];
const HUDDLE_COLS = ['Timestamp','Date','Name','Type','Task','Status','Remark','Proof'];


// ══════════════════════════════════════════════════════════
//  doGet — App se sync pull (JSONP)
// ══════════════════════════════════════════════════════════
function doGet(e) {
  const cb = (e && e.parameter && e.parameter.callback) ? e.parameter.callback : 'callback';

  // Recording playback URL — app poochta hai ?rec=<logId>
  if (e && e.parameter && e.parameter.rec) {
    let recUrl = '';
    try { recUrl = findRecUrl(String(e.parameter.rec)); } catch (er) {}
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify({ recUrl: recUrl }) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  // AI audit — plot-crm poochta hai ?audit=<recording URL> (Cloudinary). Gemini audit JSON wapas.
  if (e && e.parameter && e.parameter.audit) {
    var _a = {};
    try { _a = auditFromUrl(String(e.parameter.audit)); } catch (er) { _a = { error: er.message }; }
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(_a) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const rawUsers = readSheet(ss, SHEET_USERS);
    const usersFull = rawUsers.map(u => ({
      id   : u['login id'] || u['loginid'] || u['id']       || '',
      name : u['name']     || '',
      pw   : u['password'] || u['pw']      || '',
      role : u['role']     || '',
      tc   : u['telecaller'] === 'yes' || u['tc'] === 'true' || u['tc'] === true
    })).filter(u => u.id && u.pw);

    const users = usersFull.map(u => ({ id: u.id, name: u.name, role: u.role, tc: u.tc }));

    const categories = readSheet(ss, SHEET_CATEGORIES)
                         .map(r => r.name || r.category || '')
                         .filter(Boolean);

    const rawContacts = readSheet(ss, SHEET_CONTACTS);

    const contacts = rawContacts.map(r => {
      const rawUid = r['assignedto'] || r['uid'] || '';
      const uid    = normalizeUid(rawUid, usersFull);
      const uObj   = usersFull.find(u => u.id === uid);
      return {
        id         : r['id']         || r['ID']         || '',
        uid        : uid,
        user       : uObj ? uObj.name : (r['user'] || r['User'] || ''),
        name       : r['name']       || r['Name']       || '',
        mob        : r['mobile']     || r['Mobile']     || r['mob'] || '',
        cat        : r['category']   || r['Category']   || r['cat'] || 'Customer',
        feedback   : r['feedback']   || '',
        callDate   : r['calldate']   || r['call date']  || '',
        assignedTo : uid,
        ts         : r['saved at']   || r['ts']         || ''
      };
    }).filter(r => {
      const mob = String(r.mob || '').replace(/\s/g,'');
      return mob && /^[+\d]{7,15}$/.test(mob);
    });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const rawLogs = readSheet(ss, SHEET_LOGS);
    let _logIdx = 0;
    const logs = rawLogs
      .filter(r => r['uid'] && ((r['date'] || (r['ts']||'').slice(0,10) || '') >= cutoffStr))
      .map(r => {
        _logIdx++;
        const autoId = r['id'] || ('SL' + _logIdx + '_' + (r['uid']||'').slice(0,4) + (r['date']||'').replace(/-/g,''));
        return {
          id      : autoId,
          uid     : r['uid']     || '',
          user    : r['user']    || '',
          date    : r['date']    || (r['ts'] || '').slice(0, 10),
          cat     : r['cat']     || '',
          name    : r['name']    || '',
          mob     : r['mob']     || '',
          purpose : r['purpose'] || '',
          resp    : r['resp']    || '',
          action  : r['action']  || '',
          next    : r['next']    || '',
          comment : r['comment'] || '',
          dur     : r['dur']     || '',
          hasRec  : r['hasrec'] === 'true' || r['hasrec'] === true,
          audScore : r['auditscore']  || '',
          audChecks: r['auditchecks'] || '',
          audNote  : r['auditnote']   || '',
          audIssues: r['auditissues'] || '',
          ts      : r['ts']      || r['date'] || ''
        };
      })
      .filter(r => r.uid);

    const payload = { users, categories, contacts, logs };

    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(payload) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);

  } catch(err) {
    const payload = { error: err.message };
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(payload) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
}


// ══════════════════════════════════════════════════════════
//  doPost — App se data save (LockService se serialized)
// ══════════════════════════════════════════════════════════
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Server busy, please retry' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const body   = JSON.parse(e.postData.contents);
    const type   = body.type;
    const record = body.record || {};
    const ss     = SpreadsheetApp.getActiveSpreadsheet();

    if (type === 'login') {
      return doLoginCheck(ss, record);
    }

    if (type === 'log') {
      saveLog(ss, record);
    } else if (type === 'contact') {
      if (record.action === 'delete') {
        deleteContact(ss, record);
      } else {
        saveContact(ss, record);
      }
    } else if (type === 'member') {
      saveMember(ss, record);
    } else if (type === 'category') {
      saveCategory(ss, record);
    } else if (type === 'recording') {
      saveRecordingToDrive(record);
    } else if (type === 'huddle') {
      huddleToSheet_(ss, record);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doLoginCheck(ss, rec) {
  try {
    const id = String(rec.id || '').trim().toLowerCase();
    const pw = String(rec.pw || '');
    if (!id || !pw) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const rawUsers = readSheet(ss, SHEET_USERS);
    const users = rawUsers.map(u => ({
      id   : u['login id'] || u['loginid'] || u['id']       || '',
      name : u['name']     || '',
      pw   : u['password'] || u['pw']      || '',
      role : u['role']     || '',
      tc   : u['telecaller'] === 'yes' || u['tc'] === 'true' || u['tc'] === true
    })).filter(u => u.id && u.pw);

    const match = users.find(u => u.id.toLowerCase() === id && u.pw === pw);
    if (match) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        user: { id: match.id, name: match.name, role: match.role, tc: match.tc }
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: false }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ══════════════════════════════════════════════════════════
//  SAVE FUNCTIONS
// ══════════════════════════════════════════════════════════
function saveLog(ss, rec) {
  const sheet = getOrCreateSheet(ss, SHEET_LOGS, LOG_COLS);
  upsertRow(sheet, LOG_COLS, rec, 'id');
}

function saveContact(ss, rec) {
  const sheet = getOrCreateSheet(ss, SHEET_CONTACTS, CONTACT_COLS);
  const row = [
    rec.id       || '',
    rec.user     || '',
    rec.name     || '',
    rec.mob      || '',
    rec.cat      || 'Customer',
    rec.ts       || new Date().toISOString(),
    rec.uid      || '',
    rec.feedback || '',
    rec.callDate || ''
  ];
  const idColIdx = 0;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idColIdx]) === String(rec.id)) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

function deleteContact(ss, rec) {
  const sheet = ss.getSheetByName(SHEET_CONTACTS);
  if (!sheet) return;
  const mob = String(rec.mob || '').replace(/\s+/g, '');
  if (!mob) return;
  const mobIdx = CONTACT_COLS.indexOf('Mobile');
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    const rowMob = String(data[i][mobIdx] || '').replace(/\s+/g, '');
    if (rowMob === mob) {
      sheet.deleteRow(i + 1);
    }
  }
}

function saveMember(ss, rec) {
  const sheet = getOrCreateSheet(ss, SHEET_USERS, USER_COLS);
  const action = rec.action || 'add';
  if (action === 'delete') {
    deleteRow(sheet, USER_COLS, 'id', rec.id);
    return;
  }
  if (!rec.pw) {
    const existing = readSheet(ss, SHEET_USERS).find(u => String(u['id'] || u['login id'] || u['loginid'] || '') === String(rec.id || ''));
    if (existing) rec.pw = existing['pw'] || existing['password'] || '';
  }
  upsertRow(sheet, USER_COLS, rec, 'id');
}

function saveCategory(ss, rec) {
  const sheet = getOrCreateSheet(ss, SHEET_CATEGORIES, CAT_COLS);
  const action = rec.action || 'add';
  if (action === 'remove') {
    deleteRow(sheet, CAT_COLS, 'name', rec.name);
  } else {
    const existing = readSheet(ss, SHEET_CATEGORIES).map(r => r.name || '');
    if (!existing.includes(rec.name)) {
      sheet.appendRow([rec.name]);
    }
  }
}

// ── HUDDLE → SHEET ── standup (kal ka kaam / aaj ke task / issues) "huddle" tab me.
//    Re-save/edit pe same date+name ki purani rows hata ke nayi daalta hai (no duplicate).
function huddleToSheet_(ss, rec) {
  const sheet = getOrCreateSheet(ss, SHEET_HUDDLE, HUDDLE_COLS);
  const date = rec.date || '', name = rec.name || '';
  const data = sheet.getDataRange().getValues();   // col1=Date, col2=Name
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(date) && String(data[i][2]) === String(name)) sheet.deleteRow(i + 1);
  }
  const now = new Date(), rows = [];
  (rec.yesterday || []).forEach(x => rows.push([now, date, name, 'Kal',   x.t || '', x.st || '', x.rm || '', x.proofUrl || '']));
  (rec.tasks     || []).forEach(x => rows.push([now, date, name, 'Aaj',   x.t || '', x.st || '', x.rm || '', x.proofUrl || '']));
  (rec.issues    || []).forEach(t => { if (t) rows.push([now, date, name, 'Issue', t, '', '', '']); });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HUDDLE_COLS.length).setValues(rows);
}


// ══════════════════════════════════════════════════════════
//  CALL RECORDINGS -> GOOGLE DRIVE
// ══════════════════════════════════════════════════════════
function recFolder() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('REC_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Akshardham Call Recordings');
  props.setProperty('REC_FOLDER_ID', f.getId());
  return f;
}
function saveRecordingToDrive(rec) {
  if (!rec || !rec.id || !rec.data) return;
  const folder = recFolder();
  const name = rec.name || (rec.id + '.m4a');
  const ex = folder.getFilesByName(name);
  while (ex.hasNext()) ex.next().setTrashed(true);
  const blob = Utilities.newBlob(Utilities.base64Decode(rec.data), rec.mime || 'audio/mpeg', name);
  const file = folder.createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
}
function findRecUrl(recId) {
  const folder = recFolder();
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const n = f.getName();
    const base = n.indexOf('.') >= 0 ? n.slice(0, n.lastIndexOf('.')) : n;
    if (n === recId || base === recId) {
      return 'https://drive.google.com/uc?export=download&id=' + f.getId();
    }
  }
  return '';
}


// ══════════════════════════════════════════════════════════
//  UID NORMALIZATION
// ══════════════════════════════════════════════════════════
function levenshtein(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push([i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[m][n];
}

function normalizeUid(uid, users) {
  if (!uid) return '';
  const clean = String(uid).trim().toLowerCase();
  let match = users.find(u => u.id.toLowerCase().trim() === clean);
  if (match) return match.id;
  match = users.find(u => u.name.toLowerCase().replace(/\s+/g,'') === clean.replace(/\s+/g,''));
  if (match) return match.id;
  let best = null, bestDist = 3;
  users.forEach(u => {
    const d = levenshtein(clean, u.id.toLowerCase().trim());
    if (d < bestDist) { bestDist = d; best = u; }
  });
  if (best) return best.id;
  return uid;
}


// ══════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════
function readSheet(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const tz = Session.getScriptTimeZone();
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) {
        const val = row[i];
        if (val instanceof Date && !isNaN(val)) {
          obj[h] = Utilities.formatDate(val, tz, 'yyyy-MM-dd');
        } else {
          obj[h] = String(val != null ? val : '').trim();
        }
      }
    });
    return obj;
  }).filter(r => Object.values(r).some(v => v !== ''));
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    const hRange = sheet.getRange(1, 1, 1, headers.length);
    hRange.setFontWeight('bold');
    hRange.setBackground('#15242c');
    hRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function upsertRow(sheet, headers, rec, keyField) {
  const keyIdx = headers.indexOf(keyField);
  if (keyIdx < 0 || !rec[keyField]) {
    sheet.appendRow(headers.map(h => rec[h] != null ? rec[h] : ''));
    return;
  }
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][keyIdx]) === String(rec[keyField])) {
      sheet.getRange(i + 1, 1, 1, headers.length)
           .setValues([headers.map(h => rec[h] != null ? rec[h] : '')]);
      return;
    }
  }
  sheet.appendRow(headers.map(h => rec[h] != null ? rec[h] : ''));
}

function deleteRow(sheet, headers, colName, value) {
  const colIdx = headers.map(h => h.toLowerCase()).indexOf(colName.toLowerCase());
  if (colIdx < 0) return;
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][colIdx]) === String(value)) {
      sheet.deleteRow(i + 1);
    }
  }
}


// ══════════════════════════════════════════════════════════
//  SETUP — ek baar: Run -> setupSheets
// ══════════════════════════════════════════════════════════
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet(ss, SHEET_LOGS, LOG_COLS);
  getOrCreateSheet(ss, SHEET_USERS, USER_COLS);
  getOrCreateSheet(ss, SHEET_CATEGORIES, CAT_COLS);
  getOrCreateSheet(ss, SHEET_HUDDLE, HUDDLE_COLS);
  const contactSheet = getOrCreateSheet(ss, SHEET_CONTACTS, CONTACT_COLS);
  const headers = contactSheet.getRange(1, 1, 1, Math.max(contactSheet.getLastColumn(), 1)).getValues()[0]
                    .map(h => String(h).trim().toLowerCase());
  CONTACT_COLS.forEach(col => {
    if (headers.indexOf(col.toLowerCase()) === -1) {
      const lastCol = contactSheet.getLastColumn();
      contactSheet.getRange(1, lastCol + 1).setValue(col)
                  .setFontWeight('bold').setBackground('#15242c').setFontColor('#ffffff');
      headers.push(col.toLowerCase());
    }
  });
  const catSheet = ss.getSheetByName(SHEET_CATEGORIES);
  const catData = catSheet.getDataRange().getValues();
  if (catData.length <= 1) {
    ['Customer', 'Agent', 'Networker', 'Vendor'].forEach(c => catSheet.appendRow([c]));
  }
  Logger.log('✅ Setup complete');
}


/**
 * ============================================================
 *  ASSIGN NOTIFICATION — sheet se number assign hote hi FCM push.
 *  Setup: FIREBASE_SA (service account JSON) → Script Properties.
 *         installAssignNotify() ek baar Run.
 * ============================================================
 */
const FB_PROJECT = 'plot-crm';
const SHEETID_TO_EMAIL = {
  krishan:      'krishan.sr1974@gmail.com',
  rupesh:       'akdrupesh@gmail.com',
  sunil:        'akdsunil88@gmail.com',
  luv:          'trainer.akshardham@gmail.com',
  leeladhar:    'akd.leeladhar@gmail.com',
  raghavendra:  'akd.raghav@gmail.com',
  sunilmeghwal: 'akd.sunilm@gmail.com',
  rashid:       'shanu.akshardham@gmail.com'
};

function _fcmAccessToken() {
  const raw = PropertiesService.getScriptProperties().getProperty('FIREBASE_SA');
  if (!raw) throw new Error('FIREBASE_SA script property set nahi hai.');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const body = enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  const sig = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(head + '.' + body, sa.private_key)
  ).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }
  });
  const j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('Access token nahi mila: ' + res.getContentText());
  return j.access_token;
}

function _tokensForEmail(accessToken, email) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT + '/databases/(default)/documents:runQuery';
  const q = { structuredQuery: {
    from: [{ collectionId: 'tokens' }],
    where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
    limit: 25
  }};
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true, payload: JSON.stringify(q) });
  const out = [];
  try {
    (JSON.parse(res.getContentText()) || []).forEach(x => {
      if (x.document && x.document.fields && x.document.fields.token) out.push(x.document.fields.token.stringValue);
    });
  } catch (e) {}
  return out;
}

function _sendFcm(accessToken, token, title, body) {
  const url = 'https://fcm.googleapis.com/v1/projects/' + FB_PROJECT + '/messages:send';
  const msg = { message: {
    token: token,
    notification: { title: title, body: body },
    android: { priority: 'HIGH', notification: { channel_id: 'reminders', sound: 'default' } },
    data: { type: 'assign' }
  }};
  UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true, payload: JSON.stringify(msg) });
}

function _notifiedCol(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim().toLowerCase());
  let idx = headers.indexOf('notified');
  if (idx >= 0) return idx + 1;
  const col = lastCol + 1;
  sheet.getRange(1, col).setValue('Notified').setFontWeight('bold').setBackground('#15242c').setFontColor('#ffffff');
  return col;
}

function notifyNewAssignments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CONTACTS);
  if (!sheet) return;
  const nCol = _notifiedCol(sheet);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const iAssign = headers.indexOf('assignedto');
  const iMob = headers.indexOf('mobile');
  if (iAssign < 0 || iMob < 0) return;

  const counts = {};
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const id = String(data[r][iAssign] || '').trim().toLowerCase();
    const mob = String(data[r][iMob] || '').replace(/\s+/g, '');
    const done = String(data[r][nCol - 1] || '').trim();
    if (!id || !mob || done) continue;
    counts[id] = (counts[id] || 0) + 1;
    rows.push(r + 1);
  }
  if (!rows.length) return;

  let at;
  try { at = _fcmAccessToken(); } catch (e) { Logger.log('Token error: ' + e.message); return; }
  Object.keys(counts).forEach(id => {
    const email = SHEETID_TO_EMAIL[id.replace(/[^a-z0-9]/g,'')];
    if (!email) { Logger.log('Email mapping nahi: ' + id); return; }
    const toks = _tokensForEmail(at, email);
    const c = counts[id];
    toks.forEach(tk => _sendFcm(at, tk, '📞 Naye number assign',
      c + ' naya number aapko assign hua hai — Call Log kholke call karo.'));
  });
  rows.forEach(rr => sheet.getRange(rr, nCol).setValue('yes'));
}

function markAllNotifiedBaseline() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CONTACTS);
  if (!sheet) return;
  const nCol = _notifiedCol(sheet);
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const iAssign = headers.indexOf('assignedto'), iMob = headers.indexOf('mobile');
  for (let r = 1; r < data.length; r++) {
    const id = String(data[r][iAssign] || '').trim();
    const mob = String(data[r][iMob] || '').trim();
    const done = String(data[r][nCol - 1] || '').trim();
    if (id && mob && !done) sheet.getRange(r + 1, nCol).setValue('yes');
  }
}

function installAssignNotify() {
  markAllNotifiedBaseline();
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'notifyNewAssignments') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('notifyNewAssignments').timeBased().everyMinutes(5).create();
  Logger.log('✅ Assign-notification chalu — har 5 min me naye assign check honge.');
}

function testAssignPush() {
  const at = _fcmAccessToken();
  const toks = _tokensForEmail(at, 'krishan.sr1974@gmail.com');
  Logger.log('Tokens mile: ' + toks.length);
  toks.forEach(tk => _sendFcm(at, tk, '✅ Test', 'Assign notification setup sahi hai!'));
}


/**
 * ============================================================
 *  AI CALL AUDIT (Gemini)
 *  Setup: GEMINI_KEY → Script Properties.
 *   • calllog (Sheet+Drive): installCallAudit() → har 10 min auto
 *   • plot-crm (Firebase+Cloudinary): doGet?audit=<recUrl> (upar handle hota hai)
 *   • Test: testAuditOne()
 * ============================================================
 */
var GEMINI_MODEL = 'gemini-2.5-flash';
var AUDIT_MAX_PER_RUN = 5;
var AUDIT_LOG_COLS = ['AuditScore', 'AuditChecks', 'AuditNote', 'AuditIssues', 'AuditedAt'];

// Checklist — dono flow me same. Badalna ho to sirf yahan.
var AUDIT_CHECKLIST = [
  'intro: Telecaller ne sahi intro diya? (Akshardham Associates se bol rahe, mam/office se baat hui thi — ye bataya)',
  'rapport: Rapport banaya? (customer ki posting/gaon/kaam/family jaisi koi personal baat se jodne ki koshish)',
  'questions: Zaroori sawaal pooche? (area/location, budget, plot size)',
  'requirement: Customer ki requirement sahi se samajh/capture ki?',
  'tone: Baat ka tone polite aur professional tha?',
  'nextstep: Call ke end me next step set kiya? (kab aana hai / follow-up / kya bhejna hai)'
];

function _runAudit(bytes, mime) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('GEMINI_KEY script property set nahi hai.');
  if (bytes.length > 18 * 1024 * 1024) throw new Error('recording bahut badi (inline audit limit ~18MB)');
  var b64 = Utilities.base64Encode(bytes);

  var prompt =
    'Tum ek real-estate telecalling QA auditor ho. Niche ek Hindi/Hinglish call recording hai — ' +
    'Akshardham Associates (Jhalawar me plot/zameen bechne wali company) ke telecaller aur ek customer ke beech. ' +
    'Call ko dhyan se suno aur SIRF telecaller ki performance ko is checklist pe parkho:\n' +
    AUDIT_CHECKLIST.map(function (c, i) { return (i + 1) + '. ' + c; }).join('\n') +
    '\n\nHar point ka true/false do (true = sahi kiya). ' +
    'score = kitne true / 6 (jaise "4/6"). ' +
    'note = 1-2 line Hinglish me overall feedback. ' +
    'issues = sabse badi 1-2 kami jo sudharni chahiye (Hinglish). ' +
    'Agar recording me awaaz saaf nahi / call hui hi nahi lagti to sab false, score "0/6", note me wajah likho.';

  var payload = {
    contents: [{ parts: [ { text: prompt }, { inlineData: { mimeType: mime, data: b64 } } ] }],
    generationConfig: {
      temperature: 0.2, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: {
        intro:{type:'BOOLEAN'}, rapport:{type:'BOOLEAN'}, questions:{type:'BOOLEAN'},
        requirement:{type:'BOOLEAN'}, tone:{type:'BOOLEAN'}, nextstep:{type:'BOOLEAN'},
        score:{type:'STRING'}, note:{type:'STRING'}, issues:{type:'STRING'}
      }, required:['intro','rapport','questions','requirement','tone','nextstep','score','note','issues'] }
    }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(key);
  var res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json',
    muteHttpExceptions:true, payload: JSON.stringify(payload) });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText());
  var j = JSON.parse(res.getContentText());
  var out = j.candidates && j.candidates[0] && j.candidates[0].content &&
            j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
  if (!out) throw new Error('Gemini se khaali jawab: ' + res.getContentText());
  return JSON.parse(out);
}

function auditRecording(fileId) {
  var file = DriveApp.getFileById(fileId), blob = file.getBlob();
  return _runAudit(blob.getBytes(), _audioMime(file.getName(), blob.getContentType()));
}

function auditFromUrl(url) {
  if (!url) throw new Error('url nahi di');
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions:true, followRedirects:true });
  if (res.getResponseCode() !== 200) throw new Error('recording fetch fail ' + res.getResponseCode());
  var blob = res.getBlob();
  return _runAudit(blob.getBytes(), _audioMime(url, blob.getContentType()));
}

function _audioMime(name, fallback) {
  var ext = String(name || '').toLowerCase().split('?')[0].split('.').pop();
  var map = { mp3:'audio/mp3', mpeg:'audio/mp3', m4a:'audio/aac', aac:'audio/aac',
              wav:'audio/wav', ogg:'audio/ogg', opus:'audio/ogg', flac:'audio/flac' };
  return map[ext] || (fallback && fallback.indexOf('audio') === 0 ? fallback : 'audio/mp3');
}

function _checksStr(r) {
  return 'intro'+(r.intro?'✓':'✗') + ' rapport'+(r.rapport?'✓':'✗') +
       ' Q'+(r.questions?'✓':'✗') + ' req'+(r.requirement?'✓':'✗') +
       ' tone'+(r.tone?'✓':'✗') + ' next'+(r.nextstep?'✓':'✗');
}

function _auditCols(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var idx = {};
  AUDIT_LOG_COLS.forEach(function (c) {
    var i = headers.indexOf(c.toLowerCase());
    if (i < 0) { lastCol++; sheet.getRange(1, lastCol).setValue(c).setFontWeight('bold').setBackground('#15242c').setFontColor('#ffffff'); headers.push(c.toLowerCase()); i = lastCol - 1; }
    idx[c] = i + 1;
  });
  return idx;
}
function _logIdRowMap(sheet) {
  var data = sheet.getDataRange().getValues(), map = {};
  for (var i = 1; i < data.length; i++) { var id = String(data[i][0] || '').trim(); if (id) map[id] = i + 1; }
  return map;
}

function auditNewRecordings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sheet = ss.getSheetByName(SHEET_LOGS);
  if (!sheet) return;
  var idx = _auditCols(sheet), rowMap = _logIdRowMap(sheet), folder = recFolder(), it = folder.getFiles(), done = 0;
  while (it.hasNext() && done < AUDIT_MAX_PER_RUN) {
    var f = it.next(), n = f.getName(), base = n.indexOf('.') >= 0 ? n.slice(0, n.lastIndexOf('.')) : n;
    var row = rowMap[base] || rowMap[n];
    if (!row) continue;
    if (String(sheet.getRange(row, idx['AuditedAt']).getValue() || '').trim()) continue;
    try {
      var r = auditRecording(f.getId());
      sheet.getRange(row, idx['AuditScore']).setValue(r.score || '');
      sheet.getRange(row, idx['AuditChecks']).setValue(_checksStr(r));
      sheet.getRange(row, idx['AuditNote']).setValue(r.note || '');
      sheet.getRange(row, idx['AuditIssues']).setValue(r.issues || '');
    } catch (e) {
      sheet.getRange(row, idx['AuditNote']).setValue('audit error: ' + e.message);
    }
    sheet.getRange(row, idx['AuditedAt']).setValue(new Date().toISOString());
    done++;
  }
  Logger.log('Audited ' + done + ' recording(s).');
}

function installCallAudit() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'auditNewRecordings') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('auditNewRecordings').timeBased().everyMinutes(10).create();
  Logger.log('✅ Call-audit chalu — har 10 min me nayi recordings audit hongi.');
}

function testAuditOne() {
  var folder = recFolder(), files = [], it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  if (!files.length) { Logger.log('Folder me koi recording nahi mili.'); return; }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  Logger.log('Auditing: ' + files[0].getName());
  Logger.log(JSON.stringify(auditRecording(files[0].getId()), null, 2));
}


/**
 * ============================================================
 *  DAILY PUSH + ATTENDANCE REMINDER (FCM)
 *   • sendDailyGoodMorning — roz ~9 baje quote + birthday
 *   • sendAttendanceReminder — roz ~9:45 "attendance+standup 10:10 tak"
 *  SETUP (ek baar):
 *   1) Project Settings (⚙) → Time zone = (GMT+05:30) India
 *   2) installDailyPush()  → Run
 *   3) installAttendanceReminder() → Run
 *   Test: testDailyPush() / testAttendanceReminder()
 * ============================================================
 */
var REMIND_HOUR = 9, REMIND_MIN = 45;   // ~9:45 (deadline 10:10 se pehle) — badal sakte ho

function _fsGet(at, path){
  var url='https://firestore.googleapis.com/v1/projects/'+FB_PROJECT+'/databases/(default)/documents/'+path;
  var res=UrlFetchApp.fetch(url,{headers:{Authorization:'Bearer '+at},muteHttpExceptions:true});
  if(res.getResponseCode()!==200) return null;
  try{ return JSON.parse(res.getContentText()).fields||{}; }catch(e){ return null; }
}
function _allTokens(at){
  var url='https://firestore.googleapis.com/v1/projects/'+FB_PROJECT+'/databases/(default)/documents:runQuery';
  var q={ structuredQuery:{ from:[{collectionId:'tokens'}], limit:500 } };
  var res=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+at},muteHttpExceptions:true,payload:JSON.stringify(q)});
  var out=[]; try{ (JSON.parse(res.getContentText())||[]).forEach(function(x){ if(x.document&&x.document.fields&&x.document.fields.token) out.push(x.document.fields.token.stringValue); }); }catch(e){}
  return out;
}
function sendDailyGoodMorning(){
  var at; try{ at=_fcmAccessToken(); }catch(e){ Logger.log('Token error: '+e.message); return; }
  var f=_fsGet(at,'config/engage')||{};
  var quotes=((f.quotes&&f.quotes.arrayValue&&f.quotes.arrayValue.values)||[]).map(function(v){ return v.stringValue; });
  var bdays=((f.birthdays&&f.birthdays.arrayValue&&f.birthdays.arrayValue.values)||[]).map(function(v){
    var g=(v.mapValue&&v.mapValue.fields)||{}; return { name:g.name&&g.name.stringValue, date:g.date&&g.date.stringValue, type:g.type&&g.type.stringValue }; });
  var dayIdx=Math.floor((Date.now()+5.5*3600*1000)/86400000);
  var quote=quotes.length ? quotes[dayIdx%quotes.length] : '';
  var md=new Date(Date.now()+5.5*3600*1000).toISOString().slice(5,10);
  var todayB=bdays.filter(function(b){ return (b.date||'').slice(-5)===md; });
  var title='🌅 Good morning!';
  var body = quote || 'Aaj accha din ho — lage raho!';
  if(todayB.length) body += '  🎂 Aaj ' + todayB.map(function(b){ return b.name+(b.type==='anniv'?' (Anniversary)':''); }).join(', ') + ' ka din!';
  var toks=_allTokens(at);
  toks.forEach(function(tk){ _sendFcm(at, tk, title, body); });
  Logger.log('Daily push bheja — '+toks.length+' device · "'+body+'"');
}
function installDailyPush(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='sendDailyGoodMorning') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDailyGoodMorning').timeBased().everyDays(1).atHour(9).create();
  Logger.log('✅ Daily good-morning push chalu — roz ~9 baje (India time).');
}
function testDailyPush(){ sendDailyGoodMorning(); }

function sendAttendanceReminder(){
  var at; try{ at=_fcmAccessToken(); }catch(e){ Logger.log('Token error: '+e.message); return; }
  var toks=_allTokens(at);
  toks.forEach(function(tk){
    _sendFcm(at, tk, '⏰ Attendance + Standup',
      'Kripya aaj ki attendance aur standup 10:10 baje tak bhar dein 🙏');
  });
  Logger.log('Reminder bheja — '+toks.length+' device.');
}
function installAttendanceReminder(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='sendAttendanceReminder') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendAttendanceReminder').timeBased().everyDays(1).atHour(REMIND_HOUR).nearMinute(REMIND_MIN).create();
  Logger.log('✅ Attendance/Standup reminder chalu — roz ~'+REMIND_HOUR+':'+REMIND_MIN+' (India time).');
}
function testAttendanceReminder(){ sendAttendanceReminder(); }
