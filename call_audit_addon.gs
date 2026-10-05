/**
 * ============================================================
 *  CALL AUDIT (Gemini) — Code.gs ke END me paste karo.
 *  (recFolder, SHEET_LOGS upar se aate hain. GEMINI_KEY Script Properties me set hona chahiye.)
 *
 *  Do flow:
 *   A) calllog (Sheet + Drive) → auditNewRecordings() / installCallAudit() auto
 *   B) plot-crm (Firebase + Cloudinary) → plot-crm khud doGet?audit=<recUrl> call karta
 *      hai (JSONP), hum Gemini se audit karke JSON wapas dete hain. Iske liye doGet me
 *      '?audit=' wali 6 line add karni padti hai (alag se di gayi hai).
 *
 *  ── TEST ──  function "testAuditOne" → Run → latest Drive recording ka audit Logs me.
 *  ── CALLLOG AUTO ──  function "installCallAudit" → Run (har 10 min).
 * ============================================================
 */

var GEMINI_MODEL = 'gemini-2.5-flash';
var AUDIT_MAX_PER_RUN = 5;
var AUDIT_LOG_COLS = ['AuditScore', 'AuditChecks', 'AuditNote', 'AuditIssues', 'AuditedAt'];

// Checklist — Gemini isi pe call parkhega (dono flow me same). Badalna ho to sirf yahan.
var AUDIT_CHECKLIST = [
  'intro: Telecaller ne sahi intro diya? (Akshardham Associates se bol rahe, mam/office se baat hui thi — ye bataya)',
  'rapport: Rapport banaya? (customer ki posting/gaon/kaam/family jaisi koi personal baat se jodne ki koshish)',
  'questions: Zaroori sawaal pooche? (area/location, budget, plot size)',
  'requirement: Customer ki requirement sahi se samajh/capture ki?',
  'tone: Baat ka tone polite aur professional tha?',
  'nextstep: Call ke end me next step set kiya? (kab aana hai / follow-up / kya bhejna hai)'
];

// ── CORE: audio bytes → Gemini audit JSON ──
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

// ── Drive file (calllog flow) ──
function auditRecording(fileId) {
  var file = DriveApp.getFileById(fileId), blob = file.getBlob();
  return _runAudit(blob.getBytes(), _audioMime(file.getName(), blob.getContentType()));
}

// ── Cloudinary/koi bhi URL (plot-crm flow) ──
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

// ── calllog: logs sheet me audit columns ──
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

// ── calllog MAIN: bina-audit recordings audit karke logs sheet me likho ──
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
