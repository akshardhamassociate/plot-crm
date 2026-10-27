/**
 * ============================================================
 *  HUDDLE → SHEET  — har standup (kal ka kaam / aaj ke task / issues)
 *  ek Google Sheet tab "Huddle" me bhi chala jaata hai (tracking ke liye).
 *  Call-audit / AI-lead wale SAME Apps Script project me paste karo.
 *
 *  plot-crm (index.html) POST karta hai:  { type:'huddle', record:{...} }
 *
 *  ── SETUP (2 step) ──
 *   1. Ye poora file project me naya file ya Code.gs ke end me paste karo.
 *   2. apne doPost(e) ke SABSE UPAR ye branch add karo:
 *          var _b = JSON.parse(e.postData.contents);
 *          if (_b && _b.type === 'huddle') return huddleToSheet_(_b.record);
 *      (Agar doPost me pehle se body parse ho rahi hai to sirf
 *       `if (body.type==='huddle') return huddleToSheet_(body.record);` daal do.)
 *   Phir: Deploy → Manage deployments → edit → New version → Deploy.
 *
 *  ── TEST ──  function "testHuddleSheet" → Run → "Huddle" tab me rows aa jayengi.
 * ============================================================
 */

var HUDDLE_SHEET = 'Huddle';
var HUDDLE_HEAD  = ['Timestamp','Date','Name','Type','Task','Status','Remark','Proof'];

function huddleToSheet_(rec) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(HUDDLE_SHEET);
    if (!sh) { sh = ss.insertSheet(HUDDLE_SHEET); sh.appendRow(HUDDLE_HEAD); }
    if (sh.getLastRow() === 0) sh.appendRow(HUDDLE_HEAD);

    var date = rec.date || '';
    var name = rec.name || '';

    // Purani rows (same date+name) hata do — re-save/edit pe duplicate na ho.
    var last = sh.getLastRow();
    if (last > 1) {
      var vals = sh.getRange(2, 2, last - 1, 2).getValues(); // cols Date, Name
      for (var r = vals.length - 1; r >= 0; r--) {
        if (String(vals[r][0]) === String(date) && String(vals[r][1]) === String(name)) {
          sh.deleteRow(r + 2);
        }
      }
    }

    var now = new Date();
    var rows = [];
    (rec.yesterday || []).forEach(function (x) { rows.push(row_(now, date, name, 'Kal', x)); });
    (rec.tasks    || []).forEach(function (x) { rows.push(row_(now, date, name, 'Aaj', x)); });
    (rec.issues   || []).forEach(function (t) { if (t) rows.push([now, date, name, 'Issue', t, '', '', '']); });

    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HUDDLE_HEAD.length).setValues(rows);

    return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function row_(now, date, name, type, x) {
  return [now, date, name, type, (x.t || ''), (x.st || ''), (x.rm || ''), (x.proofUrl || '')];
}

function testHuddleSheet() {
  huddleToSheet_({
    date: '2026-10-27', name: 'Test User',
    yesterday: [{ t: 'Kal ka kaam', st: 'done', rm: 'ho gaya' }],
    tasks:     [{ t: 'Aaj 10 call', st: 'wip', rm: '', proofUrl: '' }],
    issues:    ['Net slow tha']
  });
}
