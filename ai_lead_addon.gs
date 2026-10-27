/**
 * ============================================================
 *  AI LEAD ENTRY (Gemini) — text/voice se lead fields nikaalo.
 *  Call-audit wale SAME Apps Script project me paste karo (GEMINI_KEY already set hai).
 *
 *  plot-crm (index.html) call karta hai:  doGet?parseLead=<hinglish text>&callback=...
 *  Hum Gemini se structured JSON (name, mobile, budget, status, contactAfter...) wapas dete hain.
 *
 *  ── SETUP (2 step) ──
 *   1. Ye poora file Apps Script project me naya file ya Code.gs ke end me paste karo.
 *   2. apne doGet(e) ke SABSE UPAR ye 1 branch add karo:
 *          if (e.parameter.parseLead) return _aiLeadOut(e);
 *   Phir: Deploy → Manage deployments → edit → New version → Deploy (same /exec URL rehta hai).
 *
 *  ── TEST ──  function "testParseLead" → Run → Logs me parsed JSON.
 * ============================================================
 */

// doGet branch isi ko call karega — JSONP (callback) me result wapas.
function _aiLeadOut(e) {
  var out;
  try { out = parseLeadFromText(e.parameter.parseLead); }
  catch (err) { out = { error: String(err && err.message || err) }; }
  var cb = e.parameter.callback || 'callback';
  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(out) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// CORE: Hinglish text -> lead fields (Gemini, server-side key)
function parseLeadFromText(text) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('GEMINI_KEY script property set nahi hai.');
  if (!text || !String(text).trim()) throw new Error('text khaali hai');
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');

  var prompt =
    'Tum Akshardham Associates (Jhalawar me plot/zameen bechne wali real-estate company) ke CRM assistant ho. ' +
    'Niche Hindi/Hinglish me ek nayi lead ki jaankari hai (telecaller ne bol kar ya likh kar di). ' +
    'Usme se CRM fields nikaalo. Jo field text me na ho use KHAALI chhodo — apne se mat banao.\n' +
    'Rules:\n' +
    '- mobile = sirf digits (10 ya 12 digit).\n' +
    '- budgetMin/budgetMax = rupees me number. (1 lakh = 100000, 1 crore = 10000000. "20-25 lakh" => min 2000000, max 2500000).\n' +
    '- cash, loanAmt = rupees me number.\n' +
    '- status = in me se EK: fresh, warm, visit, nurture, hot, booked, lost. (Agar pata na chale to "fresh").\n' +
    '- ptype = Plot / House / Commercial / Hospital/Institutional / Agricultural (ya khaali).\n' +
    '- loan = yes / no (ya khaali). token = yes / no (ya khaali).\n' +
    '- loanStatus = Not started / Applied / Approved / Rejected (ya khaali).\n' +
    '- locations = comma-separated jagah (jaise "Jhalawar, Kota").\n' +
    '- contactAfter = agar customer ne kaha "X ke baad call karna / baad me baat karenge" to us din ki date YYYY-MM-DD do. Aaj ' + todayStr + ' hai. Warna khaali.\n' +
    '- family = koi bhi personal/family/occupation context jo kaam aaye.\n' +
    '\nText:\n' + text;

  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: {
        name:{type:'STRING'}, mobile:{type:'STRING'}, occupation:{type:'STRING'},
        city:{type:'STRING'}, colony:{type:'STRING'}, locations:{type:'STRING'},
        ptype:{type:'STRING'}, size:{type:'STRING'},
        budgetMin:{type:'NUMBER'}, budgetMax:{type:'NUMBER'}, cash:{type:'NUMBER'},
        loan:{type:'STRING'}, loanAmt:{type:'NUMBER'}, loanStatus:{type:'STRING'},
        token:{type:'STRING'}, status:{type:'STRING'}, contactAfter:{type:'STRING'},
        refBy:{type:'STRING'}, family:{type:'STRING'}
      } }
    }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
  var res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json', muteHttpExceptions:true, payload: JSON.stringify(payload) });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText());
  var j = JSON.parse(res.getContentText());
  var out = j.candidates && j.candidates[0] && j.candidates[0].content &&
            j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
  if (!out) throw new Error('Gemini se khaali jawab: ' + res.getContentText());
  return JSON.parse(out);
}

function testParseLead() {
  var t = 'Ramesh Sharma ka number 98765 43210, Jhalawar me plot chahiye do bigha, budget 20 se 25 lakh, cash hai thoda loan bhi lega, Diwali ke baad call karna';
  Logger.log(JSON.stringify(parseLeadFromText(t), null, 2));
}
