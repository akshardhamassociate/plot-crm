/**
 * ============================================================
 *  TALKING AGENT "Saathi" — real voice assistant
 *  Sarvam (STT/TTS, Hindi) + OpenAI (tool-calling / function-calling).
 *  Agent app ke data ko TOOLS se dekhta/kaam karta hai (tools browser me chalte
 *  hain — server sirf OpenAI/Sarvam chalata hai). Call-audit wale SAME project me paste karo.
 *
 *  App JSONP se call karta hai (chhote payloads, multi-round loop):
 *    doGet?agentTurn=1&msgs=<JSON messages>&audio=<cloudinary URL, optional>&callback=...
 *  Return:
 *    tool round  -> { transcript, msgs, toolCalls:[{id,name,args}] }
 *    final reply -> { transcript, reply, audio(base64 mp3), msgs }
 *
 *  SETUP: Script Properties me SARVAM_KEY + OPENAI_KEY.
 *         doGet(e) ke TOP me:  if (e.parameter.agentTurn) return _agentOut(e);
 *         Deploy -> New version. Test: testAgentTTS()
 * ============================================================
 */

var OPENAI_MODEL = 'gpt-4o-mini';
var SARVAM_STT_MODEL = 'saaras:v4';
var SARVAM_TTS_MODEL = 'bulbul:v3';
var SARVAM_TTS_SPEAKER = 'shubh';

function _agentOut(e) {
  var out;
  try { out = agentTurn(e.parameter); }
  catch (err) { out = { error: String(err && err.message || err) }; }
  var cb = e.parameter.callback || 'callback';
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(out) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function agentTurn(p) {
  var sarvam = PropertiesService.getScriptProperties().getProperty('SARVAM_KEY');
  var oai = PropertiesService.getScriptProperties().getProperty('OPENAI_KEY');
  if (!sarvam || !oai) throw new Error('SARVAM_KEY / OPENAI_KEY script property set nahi hai.');

  var msgs = []; try { msgs = JSON.parse(p.msgs || '[]'); } catch (e) {}
  var transcript = '';
  if (p.audio) { transcript = _sarvamSTT(sarvam, String(p.audio)); msgs.push({ role: 'user', content: transcript }); }

  var full = [{ role: 'system', content: _agentSystem() }].concat(msgs);
  var r = _openaiTools(oai, full);
  var msg = (r.choices && r.choices[0] && r.choices[0].message) || { content: '' };
  msgs.push(msg);

  if (msg.tool_calls && msg.tool_calls.length) {
    var tc = msg.tool_calls.map(function (t) { return { id: t.id, name: t.function.name, args: t.function.arguments || '{}' }; });
    return { transcript: transcript, msgs: msgs, toolCalls: tc };
  }
  var reply = msg.content || '';
  var audio = reply ? _sarvamTTS(sarvam, reply) : '';
  return { transcript: transcript, reply: reply, audio: audio, msgs: msgs };
}

function _agentSystem() {
  return [
    'Tum "Saathi" ho — Akshardham Associates (Jhalawar me plot/zameen bechne wali real-estate company) ke Plot-CRM app ke andar ka voice assistant.',
    'Natural, dostana, chhoti Hindi/Hinglish me baat karo — jaise ek madadgaar team-mate. Ek-do line par turn, zyada lamba nahi. Numbers short bolo.',
    'Tumhare paas TOOLS hain jinse tum app ka LIVE data dekh sakte ho aur kaam kar sakte ho. Jab user kuch bhi poochhe — kaunsi lead, kiska follow-up aaj due hai, funnel/pipeline value, kaun thanda pad gaya (going cold), kisi lead ka status/detail, ya daily plan/report daalna ho — to pehle sahi tool call karo, phir uske jawab se baat karo. Apne se data mat banao.',
    'Daily reporting: subah "plan" (aaj ke kaam) save_plan se, shaam "report" (kya hua + status + proof + feedback) save_report se. Report me har task ka status aur proof poochho, phir chhota feedback + score (0-10) do.',
    'Follow-up log karna ho to add_followup, nayi lead banani ho to create_lead (form khulega, user confirm karega), kahin le jana ho to open.',
    'Agar koi cheez app se bahar ki hai to politely bol do ki tum CRM ke kaam me madad karte ho.'
  ].join(' ');
}

// Tool schemas — app (browser) inhe execute karta hai
function _agentTools() {
  var fn = function (name, desc, props, req) {
    return { type: 'function', function: { name: name, description: desc,
      parameters: { type: 'object', properties: props || {}, required: req || [] } } };
  };
  return [
    fn('search_leads', 'Naam / mobile / colony se leads dhoondho', { query: { type: 'string' } }, ['query']),
    fn('lead_detail', 'Ek lead ki poori detail (status, requirement, finance, last follow-ups, deal, line of action)', { id: { type: 'string' } }, ['id']),
    fn('list_leads', 'Leads ki list ek category me', { kind: { type: 'string', enum: ['due_today', 'overdue', 'going_cold', 'new', 'hot'] } }, ['kind']),
    fn('funnel_summary', 'Pipeline/funnel value + har stage ke counts + Won', {}, []),
    fn('today_standup', 'Kisi member ka aaj ka standup (tasks + status). Naam na do to khud ka.', { name: { type: 'string' } }, []),
    fn('add_followup', 'Ek lead pe follow-up log karo (baat + agli date + status)', { leadId: { type: 'string' }, note: { type: 'string' }, nextDate: { type: 'string' }, nextAction: { type: 'string' }, status: { type: 'string' } }, ['leadId']),
    fn('create_lead', 'Nayi lead ka form prefill karke kholo (user confirm karega)', { name: { type: 'string' }, mobile: { type: 'string' }, colony: { type: 'string' }, status: { type: 'string' } }, ['name']),
    fn('save_plan', 'Aaj ke kaam (plan) standup me save karo', { tasks: { type: 'array', items: { type: 'string' } } }, ['tasks']),
    fn('save_report', 'Shaam ki report save karo: har task ka status + feedback + score', { tasks: { type: 'array', items: { type: 'object', properties: { t: { type: 'string' }, st: { type: 'string' }, rm: { type: 'string' } } } }, feedback: { type: 'string' }, score: { type: 'number' } }, ['tasks']),
    fn('open', 'App me kahin le jao', { what: { type: 'string', enum: ['lead', 'leads', 'funnel', 'board', 'reminders', 'today', 'huddle'] }, id: { type: 'string' } }, ['what'])
  ];
}

function _openaiTools(key, messages) {
  var res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.4, messages: messages,
      tools: _agentTools(), tool_choice: 'auto', parallel_tool_calls: false })
  });
  if (res.getResponseCode() !== 200) throw new Error('OpenAI ' + res.getResponseCode() + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}

function _sarvamSTT(key, audioUrl) {
  var a = UrlFetchApp.fetch(audioUrl, { muteHttpExceptions: true, followRedirects: true });
  if (a.getResponseCode() !== 200) throw new Error('audio fetch fail ' + a.getResponseCode());
  var res = UrlFetchApp.fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'post', muteHttpExceptions: true, headers: { 'api-subscription-key': key },
    payload: { file: a.getBlob().setName('rec.webm'), model: SARVAM_STT_MODEL, language_code: 'hi-IN' }
  });
  if (res.getResponseCode() !== 200) throw new Error('Sarvam STT ' + res.getResponseCode() + ': ' + res.getContentText());
  return (JSON.parse(res.getContentText()).transcript) || '';
}

function _sarvamTTS(key, text) {
  var t = String(text || '').slice(0, 1400); if (!t) return '';
  var res = UrlFetchApp.fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'api-subscription-key': key },
    payload: JSON.stringify({ text: t, language_code: 'hi-IN', model: SARVAM_TTS_MODEL,
      speaker: SARVAM_TTS_SPEAKER, speech_sample_rate: 22050, output_audio_codec: 'mp3' })
  });
  if (res.getResponseCode() !== 200) throw new Error('Sarvam TTS ' + res.getResponseCode() + ': ' + res.getContentText());
  return (JSON.parse(res.getContentText()).audios || []).join('');
}

function testAgentTTS() {
  var sarvam = PropertiesService.getScriptProperties().getProperty('SARVAM_KEY');
  if (!sarvam) { Logger.log('SARVAM_KEY set nahi'); return; }
  Logger.log('TTS base64 length: ' + _sarvamTTS(sarvam, 'Namaste! Main Saathi hoon, bataiye kya madad karun?').length);
}
