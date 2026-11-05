/**
 * ============================================================
 *  TALKING AGENT "Saathi" — voice reporting (Sarvam STT/TTS + OpenAI)
 *  Call-audit / AI-lead wale SAME Apps Script project me paste karo.
 *
 *  plot-crm (index.html) JSONP se call karta hai:
 *     doGet?agentTurn=1&audio=<cloudinary audio URL>&mode=plan|report
 *           &hist=<JSON messages>&tasks=<JSON tasks>&name=<member>&callback=...
 *  Hum wapas dete hain: { transcript, reply, audio (base64 mp3), data, error? }
 *     data = { reply, tasks:[{t,st,rm}], issues:[], feedback, score, complete }
 *
 *  ── SETUP ──
 *   1. Ye file project me paste karo.
 *   2. Script Properties me daalo:  SARVAM_KEY = <sarvam key>,  OPENAI_KEY = <openai key>
 *   3. doGet(e) ke TOP me ye branch add karo:
 *          if (e.parameter.agentTurn) return _agentOut(e);
 *   4. Deploy → Manage deployments → New version → Deploy.
 *  ── TEST ──  testAgentTTS()  (sirf TTS check karega)
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

  var mode = (p.mode === 'report') ? 'report' : 'plan';
  var transcript = p.audio ? _sarvamSTT(sarvam, String(p.audio)) : '';

  var hist = []; try { hist = JSON.parse(p.hist || '[]'); } catch (e) {}
  var existing = '';
  try { var t = JSON.parse(p.tasks || '[]');
    existing = t.map(function (x, i) { return (i + 1) + '. ' + (x.t || ''); }).join('\n'); } catch (e) {}

  var messages = [{ role: 'system', content: _agentSystem(mode, p.name || '', existing) }].concat(hist);
  if (transcript) messages.push({ role: 'user', content: transcript });
  else if (!hist.length) messages.push({ role: 'user', content: '(conversation shuru karo)' });

  var data = _openaiChat(oai, messages);
  var audioB64 = (data && data.reply) ? _sarvamTTS(sarvam, data.reply) : '';
  return { transcript: transcript, reply: (data && data.reply) || '', data: data, audio: audioB64 };
}

function _agentSystem(mode, name, existing) {
  var who = name ? (name + ' ') : '';
  var base =
    'Tum "Saathi" ho — Akshardham Associates (Jhalawar real-estate) ka daily reporting assistant. ' +
    who + 'team member se Hindi/Hinglish me chhoti, polite, natural baat karo (ek-do line par turn). ' +
    'Tum hamesha ek JSON object do (aur kuch nahi) in fields ke saath: ' +
    'reply (tum jo bologe, Hindi), tasks (array of {t,st,rm}: t=kaam, st=""/"done"/"pending"/"wip", rm=remark), ' +
    'issues (array of string), feedback (1 line, report mode me), score (0-10 number ya null), complete (true jab zaroori baat ho gayi).\n';
  if (mode === 'plan') {
    return base +
      'MODE = PLAN (subah): member se poochho aaj ke 3-5 kaam kya hain. Unhe tasks[] me daalo (sirf t bharo, st khaali). ' +
      'Jab member bol de ki itne hi hain, reply me confirm karke complete=true karo. Score=null, feedback="".';
  }
  return base +
    'MODE = REPORT (shaam): member ko aaj subah ke ye kaam the:\n' + (existing || '(koi plan nahi tha)') + '\n' +
    'Har kaam ka status poochho (hua/nahi/kitna) aur proof (photo ya call recording). tasks[] me har kaam ka st (done/pending/wip) aur rm (kya hua + proof mention) bharo. ' +
    'Jo nahi hua uski wajah poochho. Ant me chhota feedback do aur score 0-10 (kitne % kaam + report quality). Jab sab cover ho jaye complete=true.';
}

function _openaiChat(key, messages) {
  var res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.3,
      response_format: { type: 'json_object' }, messages: messages })
  });
  if (res.getResponseCode() !== 200) throw new Error('OpenAI ' + res.getResponseCode() + ': ' + res.getContentText());
  var j = JSON.parse(res.getContentText());
  var txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  var data = {}; try { data = JSON.parse(txt); } catch (e) { data = { reply: String(txt || ''), complete: false }; }
  if (!('complete' in data)) data.complete = false;
  return data;
}

function _sarvamSTT(key, audioUrl) {
  var a = UrlFetchApp.fetch(audioUrl, { muteHttpExceptions: true, followRedirects: true });
  if (a.getResponseCode() !== 200) throw new Error('audio fetch fail ' + a.getResponseCode());
  var blob = a.getBlob().setName('rec.webm');
  var res = UrlFetchApp.fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'post', muteHttpExceptions: true,
    headers: { 'api-subscription-key': key },
    payload: { file: blob, model: SARVAM_STT_MODEL, language_code: 'hi-IN' }
  });
  if (res.getResponseCode() !== 200) throw new Error('Sarvam STT ' + res.getResponseCode() + ': ' + res.getContentText());
  return (JSON.parse(res.getContentText()).transcript) || '';
}

function _sarvamTTS(key, text) {
  var t = String(text || '').slice(0, 1400);
  if (!t) return '';
  var res = UrlFetchApp.fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'api-subscription-key': key },
    payload: JSON.stringify({ text: t, language_code: 'hi-IN', model: SARVAM_TTS_MODEL,
      speaker: SARVAM_TTS_SPEAKER, speech_sample_rate: 22050, output_audio_codec: 'mp3' })
  });
  if (res.getResponseCode() !== 200) throw new Error('Sarvam TTS ' + res.getResponseCode() + ': ' + res.getContentText());
  var arr = JSON.parse(res.getContentText()).audios || [];
  return arr.join('');   // base64 mp3
}

function testAgentTTS() {
  var sarvam = PropertiesService.getScriptProperties().getProperty('SARVAM_KEY');
  if (!sarvam) { Logger.log('SARVAM_KEY set nahi'); return; }
  var b64 = _sarvamTTS(sarvam, 'Namaste! Main Saathi hoon. Aaj ke kaam bataiye.');
  Logger.log('TTS base64 length: ' + b64.length);
}
