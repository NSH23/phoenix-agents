const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const SUPABASE_URL = 'https://qjxqebtxhfwaufmccewj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID || '1023140200877702';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'phoenix_verify_2024';
const GROQ_KEY = process.env.GROQ_API_KEY;

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

// ── DEDUPLICATION ──
var processedMessages = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) return true;
  processedMessages.add(msgId);
  if (processedMessages.size > 1000) processedMessages.delete(processedMessages.values().next().value);
  return false;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function splitMessage(text) {
  if (!text || text.length <= 4000) return [text || ''];
  var chunks = []; var t = text;
  while (t.length > 0) { var c = t.substring(0, 4000); chunks.push(c.trim()); t = t.substring(c.length).trim(); }
  return chunks;
}

// ── WA SEND ──
async function sendText(phone, message) {
  try {
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    var chunks = splitMessage(message);
    for (var i = 0; i < chunks.length; i++) {
      await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
        { messaging_product: 'whatsapp', to: fp, type: 'text', text: { body: chunks[i] } },
        { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
      );
      if (chunks.length > 1) await sleep(600);
    }
    await logOutbound(phone, message);
  } catch (e) { console.error('sendText FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendImage(phone, imageUrl, caption) {
  try {
    if (!imageUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('sendImage FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

// ── SUPABASE ──
async function getLead(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { return null; }
}

async function upsertLead(phone, name, fields) {
  try {
    var existing = await getLead(phone);
    var now = new Date().toISOString();
    if (!existing) {
      var payload = Object.assign({
        phone: phone, name: name || 'Friend', status: 'new', step: 'ai_chat',
        source: fields && fields.source ? fields.source : 'whatsapp',
        first_channel: 'whatsapp', last_channel: 'whatsapp',
        whatsapp_count: 1, call_count: 0, lead_score: 0,
        last_interaction: now, created_at: now
      }, fields || {});
      await supabase.post('/rest/v1/leads', payload);
    } else {
      var update = Object.assign({
        last_interaction: now, last_channel: 'whatsapp',
        whatsapp_count: (existing.whatsapp_count || 0) + 1, updated_at: now
      }, fields || {});
      if (name && name !== 'Friend' && name !== 'Unknown' && !existing.name) update.name = name;
      if (existing.status === 'qualified' || existing.status === 'converted') delete update.status;
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, update);
    }
  } catch (e) { console.error('upsertLead:', e.message); }
}

async function incrementLeadScore(phone, amount) {
  try {
    var lead = await getLead(phone);
    if (lead) await supabase.patch('/rest/v1/leads?phone=eq.' + phone, { lead_score: (lead.lead_score || 0) + amount });
  } catch (e) {}
}

async function getConversationHistory(phone) {
  try {
    var res = await supabase.get('/rest/v1/conversations?lead_phone=eq.' + phone + '&channel=eq.whatsapp&order=created_at.desc&limit=20&select=direction,content,created_at');
    if (!res.data || res.data.length === 0) return [];
    return res.data.reverse();
  } catch (e) { return []; }
}

async function logInbound(phone, message, msgId) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'inbound', message_type: 'text',
      content: message, whatsapp_message_id: msgId || '', status: 'received', channel: 'whatsapp'
    }, { headers: { Prefer: 'resolution=ignore-duplicates' } });
  } catch (e) {}
}

async function logOutbound(phone, message) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'outbound', message_type: 'text',
      content: message, status: 'sent', channel: 'whatsapp'
    });
  } catch (e) {}
}

async function getKnowledgeBase() {
  try {
    var res = await supabase.get('/rest/v1/knowledge_base?is_active=eq.true&select=category,title,content&order=category.asc');
    return res.data || [];
  } catch (e) { return []; }
}

// Map any venue name variation Groq might invent → correct content_key
var VENUE_KEY_MAP = {
  'sky_blue_banquet_hall_image': 'venue_1_image',
  'sky_blue_image': 'venue_1_image',
  'skyblue_image': 'venue_1_image',
  'blue_water_banquet_hall_image': 'venue_2_image',
  'blue_water_image': 'venue_2_image',
  'bluewater_image': 'venue_2_image',
  'thopate_banquets_image': 'venue_3_image',
  'thopate_image': 'venue_3_image',
  'ramkrishna_veg_banquet_image': 'venue_4_image',
  'ramkrishna_image': 'venue_4_image',
  'shree_krishna_palace_image': 'venue_5_image',
  'shree_krishna_image': 'venue_5_image',
  'raghunandan_ac_banquet_image': 'venue_6_image',
  'raghunandan_image': 'venue_6_image',
  'rangoli_banquet_hall_image': 'venue_7_image',
  'rangoli_image': 'venue_7_image',
  // event aliases
  'shaadi_image': 'event_wedding_image',
  'wedding_image': 'event_wedding_image',
  'birthday_image': 'event_birthday_image',
  'bday_image': 'event_birthday_image',
  'engagement_image': 'event_engagement_image',
  'sangeet_image': 'event_sangeet_image',
  'haldi_image': 'event_haldi_image',
  'mehendi_image': 'event_mehendi_image',
  'anniversary_image': 'event_anniversary_image',
  'corporate_image': 'event_corporate_image',
};

async function getMediaImage(key) {
  try {
    // Normalize key — lowercase, replace spaces/hyphens with underscores
    var normalizedKey = key.toLowerCase().replace(/[\s-]+/g, '_');
    // Check alias map first
    var resolvedKey = VENUE_KEY_MAP[normalizedKey] || normalizedKey;
    console.log('Image lookup: ' + key + ' → ' + resolvedKey);
    // text_content holds the image URL directly — no join needed
    var res = await supabase.get('/rest/v1/workflow_content?content_key=eq.' + resolvedKey + '&is_active=eq.true&select=text_content');
    if (res.data && res.data[0] && res.data[0].text_content) {
      console.log('Image URL found:', res.data[0].text_content.substring(0, 80));
      return res.data[0].text_content;
    }
    return null;
  } catch (e) { console.error('getMediaImage error:', e.message); return null; }
}

function buildKnowledgeContext(kb) {
  if (!kb || kb.length === 0) return '';
  var grouped = {};
  kb.forEach(function(item) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push('## ' + item.title + '\n' + item.content);
  });
  return Object.keys(grouped).map(function(cat) {
    return '### ' + cat.toUpperCase() + '\n' + grouped[cat].join('\n\n');
  }).join('\n\n');
}

// ── EXTRACT LEAD DATA FROM AI RESPONSE ──
function extractLeadData(aiText) {
  var updates = {};
  var patterns = {
    name: /\[LEAD:name=([^\]]+)\]/,
    event_type: /\[LEAD:event_type=([^\]]+)\]/,
    venue: /\[LEAD:venue=([^\]]+)\]/,
    guest_count: /\[LEAD:guest_count=([^\]]+)\]/,
    event_date: /\[LEAD:event_date=([^\]]+)\]/,
    status: /\[LEAD:status=([^\]]+)\]/,
    package_type: /\[LEAD:package_type=([^\]]+)\]/,
    services_needed: /\[LEAD:services=([^\]]+)\]/,
    theme: /\[LEAD:theme=([^\]]+)\]/,
    indoor_outdoor: /\[LEAD:indoor_outdoor=([^\]]+)\]/,
    email: /\[LEAD:email=([^\]]+)\]/,
    city: /\[LEAD:city=([^\]]+)\]/,
    source: /\[LEAD:source=([^\]]+)\]/,
    function_list: /\[LEAD:functions=([^\]]+)\]/,
    relationship_to_event: /\[LEAD:relationship=([^\]]+)\]/,
    preferred_call_time: /\[LEAD:call_time=([^\]]+)\]/,
    instagram_id: /\[LEAD:instagram=([^\]]+)\]/
  };
  for (var key in patterns) {
    var m = aiText.match(patterns[key]);
    if (m) {
      if (key === 'guest_count') { var n = parseInt(m[1]); if (!isNaN(n)) updates.guest_count = n; }
      else updates[key] = m[1].trim();
    }
  }
  var scoreMatch = aiText.match(/\[LEAD:score\+(\d+)\]/);
  if (scoreMatch) updates._scoreIncrement = parseInt(scoreMatch[1]);
  var imgMatch = aiText.match(/\[SEND:image=([^\]]+)\]/g);
  if (imgMatch) updates._sendImages = imgMatch.map(function(t) { return t.replace('[SEND:image=', '').replace(']', ''); });
  return updates;
}

function cleanAiTags(text) {
  return text.replace(/\[LEAD:[^\]]+\]/g, '').replace(/\[SEND:[^\]]+\]/g, '').trim();
}


// ── CALL GROQ AI ──
async function callGroq(phone, userMessage, lead, history, knowledgeBase) {
  var kb = buildKnowledgeContext(knowledgeBase);

  // Build what we already know about this lead
  var alreadyKnow = [];
  var missing = [];
  if (lead) {
    var hasName = lead.name && lead.name !== 'Friend' && lead.name !== 'Guest' && lead.name !== 'Unknown';
    if (hasName) alreadyKnow.push('Naam: ' + lead.name); else missing.push('naam');
    if (lead.event_type) alreadyKnow.push('Event: ' + lead.event_type); else missing.push('event type');
    if (lead.event_date) alreadyKnow.push('Event date: ' + lead.event_date); else missing.push('event date');
    if (lead.guest_count) alreadyKnow.push('Guests: ' + lead.guest_count); else missing.push('guest count');
    if (lead.venue) alreadyKnow.push('Venue: ' + lead.venue); else missing.push('venue preference');
    if (lead.package_type) alreadyKnow.push('Package: ' + lead.package_type); else missing.push('package type');
    if (lead.services_needed) alreadyKnow.push('Services: ' + lead.services_needed); else missing.push('services needed');
    if (lead.city) alreadyKnow.push('City: ' + lead.city);
    if (lead.preferred_call_time) alreadyKnow.push('Preferred call time: ' + lead.preferred_call_time);
    if (lead.email) alreadyKnow.push('Email: ' + lead.email);
    if (lead.callback_date) alreadyKnow.push('Callback scheduled: ' + lead.callback_date);
  }

  // Voice call context — this is the magic for continuity
  var voiceContext = '';
  if (lead && lead.call_count > 0) {
    voiceContext = '\n\nVOICE CALL CONTEXT (BAHUT IMPORTANT):\n';
    voiceContext += 'Is user se pehle ek voice call hua hai Aishwarya ke saath. ';
    voiceContext += 'Ab user WhatsApp pe message kar raha/rahi hai — SAME Aishwarya ho tum, conversation continue ho rahi hai.\n';
    if (lead.call_summary && lead.call_summary.trim()) {
      voiceContext += 'Call ka summary: ' + lead.call_summary + '\n';
    }
    if (lead.last_voice_transcript && lead.last_voice_transcript.trim()) {
      var shortTranscript = lead.last_voice_transcript.substring(0, 800);
      voiceContext += 'Call transcript (partial): ' + shortTranscript + '\n';
    }
    voiceContext += '\nCall ka natural continuation karo:\n';
    voiceContext += '- Call mein jo baat hui usका reference de — "call pe jo baat hui thi", "jaise aapne bataya tha"\n';
    voiceContext += '- Jo data call pe collect hua woh DOBARA mat maango\n';
    voiceContext += '- Sirf jo baaki missing hai woh naturally poocho\n';
    voiceContext += '- Feel aana chahiye ki same Aishwarya hai jo call pe thi\n';
  } else if (lead && lead.whatsapp_count > 0) {
    voiceContext = '\n\nRETURNING WA USER: Pehle WhatsApp pe baat ho chuki hai. Warmly continue karo.';
  }

  var leadContext = lead
    ? 'CUSTOMER KE BAARE MEIN JO PATA HAI:\n' + (alreadyKnow.length ? alreadyKnow.join('\n') : 'Kuch nahi pata abhi') +
      '\n\nJO ABHI BAAKI HAI COLLECT KARNA:\n' + (missing.length ? missing.join(', ') : 'Sab data mil gaya!') +
      '\n\nJO PEHLE SE PATA HAI WOH BILKUL MAT POOCHO — sirf missing fields collect karo ek-ek karke.' + voiceContext
    : 'NAYA CUSTOMER — pehli baar baat ho rahi hai.\nSabhi major questions ek-ek karke poochne hain: naam, event, date, guests, venue, package, services.';

  var systemPrompt = 'Tu Aishwarya hai — Phoenix Events & Production ki WhatsApp assistant, Pimpri-Chinchwad, Pune se.\n\n' +

    'HAMESHA SIRF HINDI MEIN BAAT KAR — chahe user kuch bhi bheje.\n' +
    'Hindi Devanagari ya Hinglish (Hindi words, Roman script) use kar — lekin KABHI bhi English ya Marathi mein reply mat kar.\n' +
    'Agar user English mein likhe, toh bhi Hindi mein jawab de — "Bilkul! Main batati hoon..." ki tarah.\n' +
    'Agar user Marathi mein likhe, toh bhi Hindi mein jawab de — "Haan zaroor..." ki tarah.\n\n' +

    'PERSONALITY:\n' +
    '- Fun, bubbly, warm — jaise ek helpful saheli jo genuinely events ke liye excited hoti hai\n' +
    '- Real insaan ki tarah baat kar — kabhi robotic mat lag\n' +
    '- Hamesha apne liye female words use kar: bataungi, karungi, hoon, rahi hoon — kabhi bataunga/karunga mat likhna\n' +
    '- User ko "aap" se address kar\n' +
    '- Choti natural reactions theek hain: "Wah!", "Ooh nice!", "Acha!" — par sirf jab genuinely fit ho\n\n' +

    'RESPONSE STYLE:\n' +
    '- 2-3 lines max — short, warm, conversational\n' +
    '- Ek hi sawaal ek response mein\n' +
    '- *bold* important cheezein — venue names, dates\n' +
    '- Emojis natural jagah use kar\n' +
    '- Paragraph mat likho — crisp rakho\n\n' +

    'CUSTOMER STATUS:\n' + leadContext + '\n\n' +

    'KNOWLEDGE BASE:\n' + kb + '\n\n' +

    'COMPANY INFO:\n' +
    'Phoenix Events & Production | Pimpri-Chinchwad, Pune\n' +
    'Website: phoenixeventsandproduction.com\n' +
    'Instagram: @phoenix_events_and_production\n' +
    'Call: +91 80357 35856\n\n' +

    'PARTNER VENUES (7):\n' +
    '1. Sky Blue Banquet Hall — Punawale/Ravet ⭐4.7 | 100-500 guests\n' +
    '2. Blue Water Banquet Hall — Punawale ⭐5.0 | 50-300 guests\n' +
    '3. Thopate Banquets — Rahatani | 100-400 guests\n' +
    '4. RamKrishna Veg Banquet — Ravet ⭐4.4 | 50-250 guests (veg only)\n' +
    '5. Shree Krishna Palace — Pimpri Colony ⭐4.3 | 100-600 guests\n' +
    '6. Raghunandan AC Banquet — Tathawade ⭐4.0 | 100-350 guests\n' +
    '7. Rangoli Banquet Hall — Chinchwad ⭐4.3 | 100-500 guests\n\n' +

    'CONVERSATION FLOW (jo already pata hai woh SKIP karo):\n' +
    '1. Naam (agar nahi pata)\n' +
    '2. Event type → turant related portfolio image bhejo\n' +
    '3. Event date\n' +
    '4. Guest count\n' +
    '5. Venue (suggest hamare venues, images bhejo)\n' +
    '6. Services — pehle options batao, phir poocho\n' +
    '7. Package type (simple/standard/premium/luxury)\n' +
    '8. Preferred callback time → specialist ke liye\n' +
    '9. Summary + specialist CTA\n\n' +

    'IMAGES — ZAROOR BHEJO (exact keys use karo):\n' +
    'EVENT IMAGES — exact key:\n' +
    '[SEND:image=event_wedding_image] — shaadi/wedding\n' +
    '[SEND:image=event_birthday_image] — birthday\n' +
    '[SEND:image=event_engagement_image] — engagement\n' +
    '[SEND:image=event_sangeet_image] — sangeet\n' +
    '[SEND:image=event_haldi_image] — haldi\n' +
    '[SEND:image=event_mehendi_image] — mehendi\n' +
    '[SEND:image=event_anniversary_image] — anniversary\n' +
    '[SEND:image=event_corporate_image] — corporate\n' +
    'VENUE IMAGES — exact key:\n' +
    '[SEND:image=venue_1_image] — Sky Blue Banquet Hall\n' +
    '[SEND:image=venue_2_image] — Blue Water Banquet Hall\n' +
    '[SEND:image=venue_3_image] — Thopate Banquets\n' +
    '[SEND:image=venue_4_image] — RamKrishna Veg Banquet\n' +
    '[SEND:image=venue_5_image] — Shree Krishna Palace\n' +
    '[SEND:image=venue_6_image] — Raghunandan AC Banquet\n' +
    '[SEND:image=venue_7_image] — Rangoli Banquet Hall\n' +
    'KABHI BHI apni taraf se key mat banao — sirf yahi exact keys use karo\n' +
    'Jab bhi event ya venue discuss ho → relevant image bhejo\n\n' +

    'STRICT RULES:\n' +
    '- Sirf Phoenix Events related topics pe baat karo\n' +
    '- Off-topic: "Main sirf Phoenix Events ke baare mein help kar sakti hoon 😊"\n' +
    '- Price kabhi mat batao — "Exact pricing ke liye hamare specialist se baat karein"\n' +
    '- Disrespect: ek baar warn karo, dobara ho toh conversation khatam karo\n\n' +

    'CALLBACK SCHEDULING:\n' +
    '"Kya main specialist ka callback schedule kar doon? Woh jald hi call karenge!\n' +
    'Kaunsa time suit karega — morning, afternoon ya evening?"\n' +
    '[LEAD:status=callback_scheduled] [LEAD:call_time=evening]\n\n' +

    'DATA COLLECTION TAGS (message ke BILKUL END mein — user ko nahi dikhte):\n' +
    '[LEAD:name=Rahul] [LEAD:event_type=Wedding] [LEAD:venue=Sky Blue Banquet Hall]\n' +
    '[LEAD:guest_count=200] [LEAD:event_date=15/06/2026] [LEAD:package_type=premium]\n' +
    '[LEAD:services=decoration,photography] [LEAD:theme=Royal] [LEAD:indoor_outdoor=indoor]\n' +
    '[LEAD:email=rahul@gmail.com] [LEAD:city=Pimpri-Chinchwad]\n' +
    '[LEAD:functions=mehendi,sangeet] [LEAD:relationship=self] [LEAD:call_time=evening]\n' +
    '[LEAD:status=qualified] [LEAD:score+5]';

  var messages = [];
  history.forEach(function(h) {
    messages.push({ role: h.direction === 'inbound' ? 'user' : 'assistant', content: h.content });
  });
  messages.push({ role: 'user', content: userMessage });

  try {
    var response = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', max_tokens: 300, temperature: 0.5, messages: [{ role: 'system', content: systemPrompt }].concat(messages) },
      { headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' } }
    );
    var fullText = response.data.choices[0].message.content;
    console.log('Groq response:', fullText.substring(0, 150));
    return fullText;
  } catch (err) {
    console.error('Groq error:', JSON.stringify(err.response ? err.response.data : err.message));
    return 'Ek second, thodi technical dikkat aa gayi. Kripya dobara try karein ya humein call karein: +91 80357 35856 🙏';
  }
}

// ── MAIN MESSAGE HANDLER ──
async function handleMessage(phone, userMessage, name, msgId) {
  console.log('Message from:', phone, '| text:', userMessage.substring(0, 60));
  await logInbound(phone, userMessage, msgId);

  var [lead, history, knowledgeBase] = await Promise.all([getLead(phone), getConversationHistory(phone), getKnowledgeBase()]);
  await upsertLead(phone, name, {});

  var aiResponse = await callGroq(phone, userMessage, lead, history, knowledgeBase);
  var extracted = extractLeadData(aiResponse);
  var imagesToSend = extracted._sendImages || [];
  var scoreIncrement = extracted._scoreIncrement || 0;
  delete extracted._sendImages;
  delete extracted._scoreIncrement;

  var cleanResponse = cleanAiTags(aiResponse);
  await sendText(phone, cleanResponse);

  // Send images
  for (var i = 0; i < imagesToSend.length; i++) {
    try {
      var imgUrl = await getMediaImage(imagesToSend[i]);
      if (imgUrl) { await sleep(600); await sendImage(phone, imgUrl, '✨ Phoenix Events'); }
    } catch (e) {}
  }

  // Map venue field
  if (extracted.venue) { extracted.venue_name = extracted.venue; delete extracted.venue; }

  // Update urgency
  if (extracted.event_date) {
    try {
      var parts = extracted.event_date.split('/');
      if (parts.length === 3) {
        var days = Math.floor((new Date(parts[2], parts[1] - 1, parts[0]) - new Date()) / 86400000);
        extracted.urgency_level = days <= 30 ? 'high' : days <= 90 ? 'medium' : 'low';
      }
    } catch (e) {}
  }

  if (Object.keys(extracted).length > 0) {
    // Remove fields that don't exist in leads table schema
    var safeExtracted = Object.assign({}, extracted);
    delete safeExtracted.venue_name; // handled separately above
    // Only keep known valid fields
    var validFields = ['name','event_type','event_date','guest_count','venue','status',
      'package_type','services_needed','theme','indoor_outdoor','email','city',
      'source','function_list','relationship_to_event','preferred_call_time',
      'instagram_id','urgency_level','callback_date','callback_time','associate_name'];
    var filteredExtracted = {};
    Object.keys(safeExtracted).forEach(function(k) {
      if (validFields.indexOf(k) !== -1) filteredExtracted[k] = safeExtracted[k];
    });
    if (Object.keys(filteredExtracted).length > 0) {
      await upsertLead(phone, filteredExtracted.name || name, filteredExtracted);
    }
  }
  if (scoreIncrement) await incrementLeadScore(phone, scoreIncrement);
}

// ── WEBHOOK ROUTES ──
app.get('/whatsapp', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('Webhook verified'); res.status(200).send(challenge); }
  else res.sendStatus(403);
});

app.post('/whatsapp', async function(req, res) {
  try {
    var body = req.body;
    res.sendStatus(200);
    if (!body.object || body.object !== 'whatsapp_business_account') return;
    var entry = body.entry && body.entry[0];
    var changes = entry && entry.changes && entry.changes[0];
    var value = changes && changes.value;
    var messages = value && value.messages;
    if (!messages || !messages[0]) return;
    var msg = messages[0];
    if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') return;
    var msgId = msg.id;
    if (isDuplicate(msgId)) { console.log('Duplicate dropped:', msgId); return; }
    var phone = msg.from;
    var contacts = value.contacts || [];
    var name = (contacts[0] && contacts[0].profile && contacts[0].profile.name) || 'Friend';
    var messageText =
      (msg.text && msg.text.body) ||
      (msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.title) ||
      (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) ||
      (msg.button && msg.button.text) || '';
    if (!messageText.trim()) return;
    console.log('Incoming | Phone:', phone, '| Name:', name, '| Msg:', messageText.substring(0, 60));
    handleMessage(phone, messageText, name, msgId).catch(function(e) { console.error('handleMessage error:', e.message); });
  } catch (e) { console.error('Webhook error:', e.message); }
});

app.get('/', function(req, res) {
  res.json({ status: 'Phoenix WhatsApp AI Agent VERSION 5', timestamp: new Date().toISOString() });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Phoenix WhatsApp AI Agent VERSION 5 running on port ' + PORT); });
