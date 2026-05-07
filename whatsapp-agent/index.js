const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const SUPABASE_URL = 'https://sainjerowmjetpmtezwg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
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

async function sendVideoAsLink(phone, youtubeId, caption) {
  try {
    if (!youtubeId) return;
    var msg = (caption ? caption + '\n' : '') + '🎥 https://www.youtube.com/watch?v=' + youtubeId;
    await sendText(phone, msg);
  } catch (e) {}
}

// ── SUPABASE ──
async function getLead(phone) {
  try {
    var res = await supabase.get('/rest/v1/wp_leads?phone=eq.' + encodeURIComponent(phone) + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { console.error('getLead:', e.message); return null; }
}

async function upsertLead(phone, name, fields) {
  try {
    var existing = await getLead(phone);
    var now = new Date().toISOString();
    var topLevel = ['name','phone','email','status','event_type','package_type','urgency_level','lead_score','source_channel','last_message','tags'];
    var topFields = {};
    var metaFields = {};
    Object.keys(fields || {}).forEach(function(k) {
      if (topLevel.indexOf(k) !== -1) topFields[k] = fields[k];
      else metaFields[k] = fields[k];
    });
    if (!existing) {
      var payload = Object.assign({ phone: phone, name: name || 'Friend', status: 'new', source_channel: 'whatsapp', lead_score: 0, created_at: now, updated_at: now }, topFields);
      if (Object.keys(metaFields).length > 0) payload.metadata = metaFields;
      await supabase.post('/rest/v1/wp_leads', payload);
      console.log('New wp_lead:', phone);
    } else {
      var update = Object.assign({ updated_at: now }, topFields);
      if (Object.keys(metaFields).length > 0) update.metadata = Object.assign({}, existing.metadata || {}, metaFields);
      if (name && name !== 'Friend' && name !== 'Unknown' && !existing.name) update.name = name;
      if (existing.status === 'converted') delete update.status;
      await supabase.patch('/rest/v1/wp_leads?phone=eq.' + encodeURIComponent(phone), update);
    }
  } catch (e) { console.error('upsertLead:', e.message); }
}

async function incrementLeadScore(phone, amount) {
  try {
    var lead = await getLead(phone);
    if (lead) await supabase.patch('/rest/v1/wp_leads?phone=eq.' + encodeURIComponent(phone), { lead_score: (lead.lead_score || 0) + amount, updated_at: new Date().toISOString() });
  } catch (e) {}
}

async function getConversationHistory(phone) {
  try {
    var res = await supabase.get('/rest/v1/wp_conversations?lead_phone=eq.' + encodeURIComponent(phone) + '&order=created_at.desc&limit=20&select=direction,message,created_at');
    if (!res.data || res.data.length === 0) return [];
    return res.data.reverse();
  } catch (e) { return []; }
}

async function logInbound(phone, message, msgId) {
  try {
    var lead = await getLead(phone);
    await supabase.post('/rest/v1/wp_conversations', { lead_id: lead ? lead.id : null, lead_phone: phone, direction: 'inbound', message: message, message_type: 'text', metadata: msgId ? { whatsapp_message_id: msgId } : {} });
  } catch (e) {}
}

async function logOutbound(phone, message) {
  try {
    var lead = await getLead(phone);
    await supabase.post('/rest/v1/wp_conversations', { lead_id: lead ? lead.id : null, lead_phone: phone, direction: 'outbound', message: message, message_type: 'text' });
  } catch (e) {}
}

// ── MEDIA — using dashboard's RPC wp_get_media_slot_pack ──
async function getMediaSlotPack(entityKind, entityId) {
  try {
    var res = await supabase.post('/rest/v1/rpc/wp_get_media_slot_pack', {
      p_entity_kind: entityKind,
      p_entity_id: entityId || null
    });
    if (!res.data) return { images: [], videos: [] };
    var slots = Array.isArray(res.data) ? res.data : [];
    var images = [];
    var videos = [];
    // Sort by slot_index
    slots.sort(function(a, b) { return (a.slot_index || 0) - (b.slot_index || 0); });
    slots.forEach(function(slot) {
      if (slot.media_type === 'image' && slot.cloudinary_url) images.push(slot.cloudinary_url);
      if (slot.media_type === 'video' && slot.youtube_id) videos.push(slot.youtube_id);
    });
    return { images: images, videos: videos };
  } catch (e) {
    console.error('getMediaSlotPack error:', e.message);
    return { images: [], videos: [] };
  }
}

// Resolve entity_id from name — looks up events/venues/services tables
async function resolveEntityId(entityKind, name) {
  try {
    if (!name) return null;
    var nameLower = name.toLowerCase();
    if (entityKind === 'event') {
      // events table: title column
      var res = await supabase.get('/rest/v1/events?select=id,title&is_active=eq.true');
      if (res.data) {
        var match = res.data.find(function(r) { return r.title && r.title.toLowerCase().includes(nameLower); });
        if (match) return match.id;
      }
    } else if (entityKind === 'venue') {
      // collaborations table: name column
      var res2 = await supabase.get('/rest/v1/collaborations?select=id,name&is_active=eq.true');
      if (res2.data) {
        var match2 = res2.data.find(function(r) { return r.name && r.name.toLowerCase().includes(nameLower); });
        if (match2) return match2.id;
      }
    } else if (entityKind === 'service') {
      var res3 = await supabase.get('/rest/v1/services?select=id,title&is_active=eq.true');
      if (res3.data) {
        var match3 = res3.data.find(function(r) { return r.title && r.title.toLowerCase().includes(nameLower); });
        if (match3) return match3.id;
      }
    }
    return null;
  } catch (e) { return null; }
}

// Send event media
async function sendEventPortfolio(phone, eventType) {
  if (!eventType) return;
  var entityId = await resolveEntityId('event', eventType);
  var media = await getMediaSlotPack('event', entityId);
  // Fallback to global if no media found
  if (media.images.length === 0 && media.videos.length === 0) {
    media = await getMediaSlotPack('global', null);
  }
  for (var i = 0; i < media.images.length; i++) {
    await sleep(600);
    await sendImage(phone, media.images[i], i === 0 ? ('📸 Hamare *' + eventType + '* events — aisa banate hain hum! ✨') : '');
  }
  for (var j = 0; j < media.videos.length; j++) {
    await sleep(800);
    await sendVideoAsLink(phone, media.videos[j], j === 0 ? ('🎥 ' + eventType + ' highlights') : '');
  }
}

// Send venue media
async function sendVenuePortfolio(phone, venueName) {
  if (!venueName) return;
  var entityId = await resolveEntityId('venue', venueName);
  var media = await getMediaSlotPack('venue', entityId);
  if (media.images.length === 0 && media.videos.length === 0) {
    media = await getMediaSlotPack('global', null);
  }
  for (var i = 0; i < media.images.length; i++) {
    await sleep(600);
    await sendImage(phone, media.images[i], i === 0 ? ('🏛️ *' + venueName + '* — hamare kaam ki jhalak ✨') : '');
  }
  for (var j = 0; j < media.videos.length; j++) {
    await sleep(800);
    await sendVideoAsLink(phone, media.videos[j], '🎥 ' + venueName + ' highlights');
  }
}

// ── KNOWLEDGE BASE ──
async function getKnowledgeBase() {
  try {
    var res = await supabase.get('/rest/v1/knowledge_base?is_active=eq.true&select=category,title,content&order=category.asc');
    return res.data || [];
  } catch (e) { return []; }
}

function buildKnowledgeContext(kb) {
  if (!kb || kb.length === 0) return '';
  var grouped = {};
  kb.forEach(function(item) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push('## ' + item.title + '\n' + item.content);
  });
  return Object.keys(grouped).map(function(cat) { return '### ' + cat.toUpperCase() + '\n' + grouped[cat].join('\n\n'); }).join('\n\n');
}

// ── EXTRACT LEAD DATA ──
function extractLeadData(aiText) {
  var updates = {};
  var patterns = {
    name: /\[LEAD:name=([^\]]+)\]/, event_type: /\[LEAD:event_type=([^\]]+)\]/, venue: /\[LEAD:venue=([^\]]+)\]/,
    guest_count: /\[LEAD:guest_count=([^\]]+)\]/, event_date: /\[LEAD:event_date=([^\]]+)\]/, status: /\[LEAD:status=([^\]]+)\]/,
    package_type: /\[LEAD:package_type=([^\]]+)\]/, services_needed: /\[LEAD:services=([^\]]+)\]/, theme: /\[LEAD:theme=([^\]]+)\]/,
    indoor_outdoor: /\[LEAD:indoor_outdoor=([^\]]+)\]/, email: /\[LEAD:email=([^\]]+)\]/, city: /\[LEAD:city=([^\]]+)\]/,
    function_list: /\[LEAD:functions=([^\]]+)\]/, relationship_to_event: /\[LEAD:relationship=([^\]]+)\]/,
    preferred_call_time: /\[LEAD:call_time=([^\]]+)\]/, instagram_id: /\[LEAD:instagram=([^\]]+)\]/
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

var OUR_VENUE_KEYWORDS = ['sky blue', 'blue water', 'thopate', 'ramkrishna', 'ram krishna', 'shree krishna', 'raghunandan', 'rangoli'];
function isOurVenue(v) { if (!v) return false; var l = v.toLowerCase(); return OUR_VENUE_KEYWORDS.some(function(k) { return l.indexOf(k) !== -1; }); }

// ── GROQ ──
async function callGroq(phone, userMessage, lead, history, knowledgeBase) {
  var kb = buildKnowledgeContext(knowledgeBase);
  var alreadyKnow = [];
  var missing = [];
  var venueIsOurs = false;
  var meta = (lead && lead.metadata) || {};

  if (lead) {
    var hasName = lead.name && lead.name !== 'Friend' && lead.name !== 'Guest' && lead.name !== 'Unknown';
    if (hasName) alreadyKnow.push('Naam: ' + lead.name); else missing.push('naam');
    if (lead.event_type) alreadyKnow.push('Event: ' + lead.event_type); else missing.push('event type');
    if (meta.event_date) alreadyKnow.push('Event date: ' + meta.event_date); else missing.push('event date');
    if (meta.guest_count) alreadyKnow.push('Guests: ' + meta.guest_count); else missing.push('guest count');
    if (meta.venue) { alreadyKnow.push('Venue: ' + meta.venue); venueIsOurs = isOurVenue(meta.venue); } else missing.push('venue');
    if (meta.function_list) alreadyKnow.push('Functions: ' + meta.function_list); else missing.push('function_list');
    if (meta.services_needed) alreadyKnow.push('Services: ' + meta.services_needed); else missing.push('services_needed');
    if (meta.indoor_outdoor) alreadyKnow.push('Indoor/Outdoor: ' + meta.indoor_outdoor); else missing.push('indoor_outdoor');
    if (meta.theme) alreadyKnow.push('Theme: ' + meta.theme); else missing.push('theme');
    if (!venueIsOurs && !meta.city) missing.push('city_area');
    if (meta.city) alreadyKnow.push('City: ' + meta.city);
    if (lead.package_type) alreadyKnow.push('Package: ' + lead.package_type); else missing.push('package_type');
    if (meta.preferred_call_time) alreadyKnow.push('Callback time: ' + meta.preferred_call_time);
    if (lead.email) alreadyKnow.push('Email: ' + lead.email);
  }

  var returningCtx = (lead && (lead.lead_score > 0 || Object.keys(meta).length > 0))
    ? '\n\nRETURNING USER: Pehle baat ho chuki hai. Warmly continue. Jo pata hai dobara mat poocho.'
    : '';

  var allCollected = missing.length === 0;
  var leadContext = lead
    ? 'PATA HAI:\n' + (alreadyKnow.join('\n') || 'Kuch nahi') +
      '\n\nMISSING (priority order):\n' +
      (allCollected ? 'SAARA DATA MIL GAYA — support mode only.' : missing.map(function(m, i) { return (i+1)+'. '+m; }).join('\n')) +
      '\nJO PATA HAI WOH MAT POOCHO.' + returningCtx
    : 'NAYA USER. Collect karo: naam, event, date, guests, venue, functions, services, indoor/outdoor, theme, package.';

  var systemPrompt =
    'Tu Aishwarya hai — Phoenix Events & Production ki WhatsApp assistant, Pimpri-Chinchwad, Pune.\n\n' +

    'LANGUAGE: HAMESHA Hinglish (Hindi words, Roman script). WRONG: Devanagari paragraphs. RIGHT: "Aapka event indoor ya outdoor?"\n' +
    'Sirf exception: "यह हमारा वादा है"\n\n' +

    'PERSONALITY: Warm, bubbly, genuine saheli. Female words always. "aap" use karo. No robotic phrases.\n\n' +

    'BANNED: "Ab mujhe lagta hai", "Maine jaankari prapt kar li", "Kya aap mujhe bata sakte hain"\n\n' +

    'RESPONSE: 1-2 lines. EK SAWAAL per message. Bridge: "Achha waise —"\n\n' +

    'ENGAGEMENT QUESTIONS (data collection ke baad ya between questions, relevant hone pe):\n' +
    '- Venue ke baare mein: "Aapne agar Sky Blue ya Blue Water nahi dekha — kya main unke kuch photos bhejun? Bahut popular hain!"\n' +
    '- Event services ke baare mein: "Aapke wedding ke liye photography bhi chahiye hogi — hamare photographers ka portfolio dekhna chahoge?"\n' +
    '- Other venues/events: "Koi bhi venue ya event jo hamare list mein nahi — no problem! Hamare manager personally coordinate karenge. Aap tension mat lo 😊"\n' +
    '- Services not in our list: "Yeh service hum directly provide nahi karte lekin hamare network mein hai — hamare manager aapko connect karenge!"\n' +
    '- After collecting main data: "Ek kaam — kya aap hamare Instagram pe hamare kaam ki jhalak dekhna chahenge? @phoenix_events_and_production"\n' +
    'RULE: Engagement questions naturally weave karo — data collection break nahi honi chahiye. Missing data pehle.\n\n' +

    'UNKNOWN VENUE/EVENT/SERVICE HANDLING:\n' +
    '- User ka venue hamare 7 mein nahi: "Koi baat nahi! Hum kisi bhi venue pe kaam karte hain. Hamare manager wahan bhi coordinate kar lenge 😊"\n' +
    '- User ka event hamare list mein nahi: "Bilkul! Hum yeh bhi karte hain — hamare manager aapko proper detail denge"\n' +
    '- Service not available: "Yeh service hamare package mein nahi hai lekin hamare network se arrange ho sakta hai. Manager connect karenge!"\n\n' +

    'PRICING: KABHI number mat batao. "Price ke liye specialist se baat karein."\n\n' +

    'CUSTOMER STATUS:\n' + leadContext + '\n\n' +

    'KNOWLEDGE BASE:\n' + kb + '\n\n' +

    'COMPANY: Phoenix Events & Production | Pimpri-Chinchwad | Founded 2017 by Kevin | 500+ events\n' +
    'Web: phoenixeventsandproduction.com | IG: @phoenix_events_and_production | Call: +91 80357 35856\n\n' +

    'VENUES:\n' +
    '1. Sky Blue Banquet Hall — Punawale/Ravet | 4.7★ | 100-500 guests\n' +
    '2. Blue Water Banquet Hall — Punawale | 5.0★ | 50-300 guests\n' +
    '3. Thopate Banquets — Rahatani | 100-400 guests\n' +
    '4. RamKrishna Veg Banquet — Ravet | 4.4★ | 50-250 guests (veg)\n' +
    '5. Shree Krishna Palace — Pimpri Colony | 4.3★ | 100-600 guests\n' +
    '6. Raghunandan AC Banquet — Tathawade | 4.0★ | 100-350 guests\n' +
    '7. Rangoli Banquet Hall — Chinchwad | 4.3★ | 100-500 guests\n\n' +

    'DATA RULES: No repeat questions. One question per message. city_area only if venue not ours. Summary only if user asks. Specialist calls — never "main call karungi".\n\n' +

    'INDOOR/OUTDOOR: "Indore" as answer = indoor. "bahar/lawn" = outdoor.\n\n' +

    'IMAGES: [SEND:image=event_wedding_image], [SEND:image=event_birthday_image], etc.\n' +
    'Venues: [SEND:image=venue_1_image] (Sky Blue) to [SEND:image=venue_7_image] (Rangoli)\n\n' +

    'DATA TAGS (end of message, invisible):\n' +
    '[LEAD:name=] [LEAD:event_type=] [LEAD:venue=] [LEAD:guest_count=] [LEAD:event_date=]\n' +
    '[LEAD:package_type=] [LEAD:services=] [LEAD:theme=] [LEAD:indoor_outdoor=]\n' +
    '[LEAD:email=] [LEAD:city=] [LEAD:functions=] [LEAD:relationship=] [LEAD:call_time=]\n' +
    '[LEAD:status=qualified] [LEAD:score+5]';

  var messages = [];
  history.forEach(function(h) { messages.push({ role: h.direction === 'inbound' ? 'user' : 'assistant', content: h.message || '' }); });
  messages.push({ role: 'user', content: userMessage });

  try {
    var response = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', max_tokens: 350, temperature: 0.5, messages: [{ role: 'system', content: systemPrompt }].concat(messages) },
      { headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' } }
    );
    var fullText = response.data.choices[0].message.content;
    console.log('Groq:', fullText.substring(0, 120));
    return fullText;
  } catch (err) {
    console.error('Groq error:', JSON.stringify(err.response ? err.response.data : err.message));
    return 'Ek second, thodi dikkat aa gayi. Humein call karein: +91 80357 35856 🙏';
  }
}

// ── MAIN HANDLER ──
async function handleMessage(phone, userMessage, name, msgId) {
  console.log('MSG from:', phone, '|', userMessage.substring(0, 50));
  await logInbound(phone, userMessage, msgId);

  var [lead, history, kb] = await Promise.all([getLead(phone), getConversationHistory(phone), getKnowledgeBase()]);
  await upsertLead(phone, name, {});

  var aiResponse = await callGroq(phone, userMessage, lead, history, kb);
  var extracted = extractLeadData(aiResponse);
  var imagesToSend = extracted._sendImages || [];
  var scoreIncrement = extracted._scoreIncrement || 0;
  delete extracted._sendImages; delete extracted._scoreIncrement;

  await sendText(phone, cleanAiTags(aiResponse));

  // Send media using RPC-based system
  for (var i = 0; i < imagesToSend.length; i++) {
    try {
      var key = imagesToSend[i];
      var em = key.match(/event_([a-z]+)_image/);
      var vm = key.match(/venue_(\d+)_image/);
      if (em) {
        await sendEventPortfolio(phone, em[1]);
      } else if (vm) {
        var vNames = ['Sky Blue Banquet Hall','Blue Water Banquet Hall','Thopate Banquets','RamKrishna Veg Banquet','Shree Krishna Palace','Raghunandan AC Banquet','Rangoli Banquet Hall'];
        await sendVenuePortfolio(phone, vNames[parseInt(vm[1])-1] || 'Venue');
      }
    } catch (e) { console.error('media error:', e.message); }
  }

  // Fixes
  if (extracted.indoor_outdoor && String(extracted.indoor_outdoor).toLowerCase() === 'indore') extracted.indoor_outdoor = 'indoor';
  if (extracted.city) {
    var cv = String(extracted.city).toLowerCase().trim();
    if (cv === 'indoor' || cv === 'andar') { extracted.indoor_outdoor = 'indoor'; delete extracted.city; }
    else if (cv === 'outdoor' || cv === 'bahar') { extracted.indoor_outdoor = 'outdoor'; delete extracted.city; }
    else if (extracted.city.length > 50 || /venue|banquet|hall|mentioned|customer|stated/i.test(extracted.city)) delete extracted.city;
  }
  if (extracted.venue) { extracted.venue_name = extracted.venue; delete extracted.venue; }
  if (extracted.event_date) {
    try {
      var p = extracted.event_date.split('/');
      if (p.length === 3) { var d = Math.floor((new Date(p[2],p[1]-1,p[0])-new Date())/86400000); extracted.urgency_level = d<=30?'high':d<=90?'medium':'low'; }
    } catch(e) {}
  }

  var topLevelFields = ['name','email','status','event_type','package_type','urgency_level','lead_score'];
  var topUp = {}; var metaUp = {};
  Object.keys(extracted).forEach(function(k) { if (topLevelFields.indexOf(k)!==-1) topUp[k]=extracted[k]; else metaUp[k]=extracted[k]; });
  if (userMessage) topUp.last_message = userMessage.substring(0, 200);
  var allF = Object.assign({}, topUp, metaUp);
  if (Object.keys(allF).length > 0) await upsertLead(phone, extracted.name || name, allF);
  if (scoreIncrement) await incrementLeadScore(phone, scoreIncrement);
}

// ── WEBSITE LEAD WEBHOOK ──
// Dashboard's DB trigger already creates wp_lead — we just need to send WA message
app.post('/website-lead', async function(req, res) {
  try {
    res.json({ status: 'received' });
    var data = req.body;
    var phone = data.phone || data.mobile || '';
    var name = data.name || data.full_name || 'Friend';
    var eventType = data.event || data.event_type || '';
    var venue = data.venue || data.venue_name || '';
    if (!phone) return;
    phone = String(phone).replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;
    if (phone.startsWith('0')) phone = '91' + phone.slice(1);
    console.log('Website lead WA trigger:', phone, eventType, venue);

    // Update lead with WA source marker (lead already exists from DB trigger)
    await upsertLead(phone, name, { source_channel: 'website', event_type: eventType, metadata: { venue: venue } });

    var greeting = 'Hi *' + name + '* ji! 😊\n\nAapki enquiry mili — *' + (eventType || 'event') + '* ke liye';
    if (venue) greeting += ', *' + venue + '* mein';
    greeting += '!\n\nMain Aishwarya hoon — Phoenix Events se. Kuch khoobsurat photos bhejti hoon abhi! 📸✨';
    await sendText(phone, greeting);
    await sleep(1000);

    if (eventType) await sendEventPortfolio(phone, eventType);
    if (venue) { await sleep(500); await sendVenuePortfolio(phone, venue); }
    await sleep(1000);

    var firstQ = eventType
      ? ('*' + eventType + '* event ke liye — kab ka plan hai? Approximate date bhi chalegi! 📅')
      : 'Kaunsa khaas occasion plan ho raha hai? 😊';
    await sendText(phone, firstQ);
  } catch (e) { console.error('website-lead error:', e.message); }
});

// ── ROUTES ──
app.get('/whatsapp', function(req, res) {
  var mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
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
    if (isDuplicate(msgId)) return;
    var phone = msg.from;
    var contacts = value.contacts || [];
    var name = (contacts[0] && contacts[0].profile && contacts[0].profile.name) || 'Friend';
    var messageText = (msg.text && msg.text.body) || (msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.title) || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) || (msg.button && msg.button.text) || '';
    if (!messageText.trim()) return;
    console.log('Incoming | Phone:', phone, '| Name:', name, '| Msg:', messageText.substring(0, 60));
    handleMessage(phone, messageText, name, msgId).catch(function(e) { console.error('handleMessage error:', e.message); });
  } catch (e) { console.error('Webhook error:', e.message); }
});

app.get('/', function(req, res) { res.json({ status: 'Phoenix WhatsApp AI Agent VERSION 9', timestamp: new Date().toISOString() }); });

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Phoenix WhatsApp AI Agent VERSION 9 running on port ' + PORT); });
