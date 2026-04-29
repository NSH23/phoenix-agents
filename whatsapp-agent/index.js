const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ── CONFIG ──
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

// Videos sent as text link (YouTube) since WA video requires direct MP4 URL
async function sendVideoAsLink(phone, youtubeId, caption) {
  try {
    if (!youtubeId) return;
    var msg = (caption ? caption + '\n' : '') + '🎥 https://www.youtube.com/watch?v=' + youtubeId;
    await sendText(phone, msg);
  } catch (e) { console.error('sendVideoAsLink FAILED:', e.message); }
}

// ── SUPABASE — NEW SCHEMA (wp_leads, wp_conversations) ──

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

    // Extract known top-level fields, rest go into metadata
    var topLevel = ['name','phone','email','status','event_type','package_type','urgency_level','lead_score','source_channel','last_message','tags'];
    var topFields = {};
    var metaFields = {};

    Object.keys(fields || {}).forEach(function(k) {
      if (topLevel.indexOf(k) !== -1) topFields[k] = fields[k];
      else metaFields[k] = fields[k];
    });

    if (!existing) {
      // New lead
      var payload = Object.assign({
        phone: phone,
        name: name || 'Friend',
        status: 'new',
        source_channel: 'whatsapp',
        lead_score: 0,
        created_at: now,
        updated_at: now
      }, topFields);

      // Merge extra fields into metadata
      if (Object.keys(metaFields).length > 0) {
        payload.metadata = metaFields;
      }

      await supabase.post('/rest/v1/wp_leads', payload);
      console.log('New wp_lead created:', phone);
    } else {
      // Update existing lead
      var update = Object.assign({ updated_at: now }, topFields);

      // Merge new metaFields into existing metadata
      if (Object.keys(metaFields).length > 0) {
        var existingMeta = existing.metadata || {};
        update.metadata = Object.assign({}, existingMeta, metaFields);
      }

      if (name && name !== 'Friend' && name !== 'Unknown' && !existing.name) update.name = name;
      if (existing.status === 'converted') delete update.status;

      await supabase.patch('/rest/v1/wp_leads?phone=eq.' + encodeURIComponent(phone), update);
      console.log('wp_lead updated:', phone);
    }
  } catch (e) { console.error('upsertLead:', e.message); }
}

async function incrementLeadScore(phone, amount) {
  try {
    var lead = await getLead(phone);
    if (lead) {
      await supabase.patch('/rest/v1/wp_leads?phone=eq.' + encodeURIComponent(phone),
        { lead_score: (lead.lead_score || 0) + amount, updated_at: new Date().toISOString() }
      );
    }
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
    // First get or create the lead to get its ID
    var lead = await getLead(phone);
    await supabase.post('/rest/v1/wp_conversations', {
      lead_id: lead ? lead.id : null,
      lead_phone: phone,
      direction: 'inbound',
      message: message,
      message_type: 'text',
      metadata: msgId ? { whatsapp_message_id: msgId } : {}
    });
  } catch (e) {}
}

async function logOutbound(phone, message) {
  try {
    var lead = await getLead(phone);
    await supabase.post('/rest/v1/wp_conversations', {
      lead_id: lead ? lead.id : null,
      lead_phone: phone,
      direction: 'outbound',
      message: message,
      message_type: 'text'
    });
  } catch (e) {}
}

// ── MEDIA — NEW SCHEMA (wp_media_assets: cloudinary_url for images, youtube_id for videos) ──

// Get images for an event type or venue
// category examples: 'wedding', 'birthday', 'venue_sky_blue' etc.
// We fetch from wp_media_assets — admin uploads tagged by title/description
async function getMediaByCategory(category) {
  try {
    // Search by title or description containing the category keyword
    var res = await supabase.get(
      '/rest/v1/wp_media_assets?is_active=eq.true&select=media_type,cloudinary_url,youtube_id,title' +
      '&or=(title.ilike.*' + encodeURIComponent(category) + '*,description.ilike.*' + encodeURIComponent(category) + '*)' +
      '&order=created_at.asc&limit=6'
    );
    if (!res.data || res.data.length === 0) return { images: [], videos: [] };
    var images = [];
    var videos = [];
    res.data.forEach(function(asset) {
      if (asset.media_type === 'image' && asset.cloudinary_url) images.push(asset.cloudinary_url);
      if (asset.media_type === 'video' && asset.youtube_id) videos.push(asset.youtube_id);
    });
    return { images: images.slice(0, 4), videos: videos.slice(0, 2) };
  } catch (e) { console.error('getMediaByCategory error:', e.message); return { images: [], videos: [] }; }
}

// Map event type → search keyword
function getEventKeyword(eventType) {
  if (!eventType) return '';
  var t = eventType.toLowerCase();
  if (t.includes('wedding') || t.includes('shaadi')) return 'wedding';
  if (t.includes('birthday')) return 'birthday';
  if (t.includes('engagement')) return 'engagement';
  if (t.includes('sangeet')) return 'sangeet';
  if (t.includes('haldi')) return 'haldi';
  if (t.includes('mehendi')) return 'mehendi';
  if (t.includes('anniversary')) return 'anniversary';
  if (t.includes('corporate')) return 'corporate';
  if (t.includes('reception')) return 'reception';
  return t;
}

// Map venue name → search keyword
function getVenueKeyword(venueName) {
  if (!venueName) return '';
  var v = venueName.toLowerCase();
  if (v.includes('sky blue')) return 'sky blue';
  if (v.includes('blue water')) return 'blue water';
  if (v.includes('thopate')) return 'thopate';
  if (v.includes('ramkrishna') || v.includes('ram krishna')) return 'ramkrishna';
  if (v.includes('shree krishna')) return 'shree krishna';
  if (v.includes('raghunandan')) return 'raghunandan';
  if (v.includes('rangoli')) return 'rangoli';
  return venueName.split(' ')[0].toLowerCase();
}

// Send event portfolio (images + video links)
async function sendEventPortfolio(phone, eventType) {
  var keyword = getEventKeyword(eventType);
  if (!keyword) return;
  var media = await getMediaByCategory(keyword);
  for (var i = 0; i < media.images.length; i++) {
    await sleep(600);
    var cap = i === 0 ? ('📸 Hamare *' + eventType + '* events — aisa banate hain hum! ✨') : '';
    await sendImage(phone, media.images[i], cap);
  }
  for (var j = 0; j < media.videos.length; j++) {
    await sleep(800);
    var vcap = j === 0 ? ('🎥 ' + eventType + ' event highlights') : '';
    await sendVideoAsLink(phone, media.videos[j], vcap);
  }
}

// Send venue portfolio
async function sendVenuePortfolio(phone, venueName) {
  var keyword = getVenueKeyword(venueName);
  if (!keyword) return;
  var media = await getMediaByCategory(keyword);
  for (var i = 0; i < media.images.length; i++) {
    await sleep(600);
    var cap = i === 0 ? ('🏛️ *' + venueName + '* — hamare kaam ki jhalak ✨') : '';
    await sendImage(phone, media.images[i], cap);
  }
  for (var j = 0; j < media.videos.length; j++) {
    await sleep(800);
    await sendVideoAsLink(phone, media.videos[j], '🎥 ' + venueName + ' highlights');
  }
}

// ── KNOWLEDGE BASE ──
async function getKnowledgeBase() {
  try {
    // knowledge_base table may or may not exist in new schema — graceful fallback
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

var OUR_VENUE_KEYWORDS = ['sky blue', 'blue water', 'thopate', 'ramkrishna', 'ram krishna', 'shree krishna', 'raghunandan', 'rangoli'];
function isOurVenue(venueName) {
  if (!venueName) return false;
  var lower = String(venueName).toLowerCase();
  return OUR_VENUE_KEYWORDS.some(function(k) { return lower.indexOf(k) !== -1; });
}

// ── GROQ AI ──
async function callGroq(phone, userMessage, lead, history, knowledgeBase) {
  var kb = buildKnowledgeContext(knowledgeBase);
  var alreadyKnow = [];
  var missing = [];
  var venueIsOurs = false;

  // Read from both top-level fields and metadata
  var meta = (lead && lead.metadata) || {};

  if (lead) {
    var hasName = lead.name && lead.name !== 'Friend' && lead.name !== 'Guest' && lead.name !== 'Unknown';
    if (hasName) alreadyKnow.push('Naam: ' + lead.name); else missing.push('naam');
    if (lead.event_type) alreadyKnow.push('Event type: ' + lead.event_type); else missing.push('event type');
    if (meta.event_date) alreadyKnow.push('Event date: ' + meta.event_date); else missing.push('event date');
    if (meta.guest_count) alreadyKnow.push('Guests: ' + meta.guest_count); else missing.push('guest count');
    if (meta.venue) { alreadyKnow.push('Venue: ' + meta.venue); venueIsOurs = isOurVenue(meta.venue); } else missing.push('venue');

    // Priority: function_list → services_needed → indoor_outdoor → theme → city_area → package_type
    if (meta.function_list) alreadyKnow.push('Functions: ' + meta.function_list); else missing.push('function_list — "Aur kya functions plan hain? Mehendi, haldi, sangeet, reception?"');
    if (meta.services_needed) alreadyKnow.push('Services: ' + meta.services_needed); else missing.push('services_needed — "Kaun si services chahiye? Decoration, photography, DJ, lighting?"');
    if (meta.indoor_outdoor) alreadyKnow.push('Indoor/Outdoor: ' + meta.indoor_outdoor); else missing.push('indoor_outdoor — "Event indoor hoga ya outdoor?"');
    if (meta.theme) alreadyKnow.push('Theme: ' + meta.theme); else missing.push('theme — "Koi specific theme ya colour scheme hai?"');
    if (!venueIsOurs) {
      if (meta.city) alreadyKnow.push('City/Area: ' + meta.city);
      else missing.push('city_area — "Aap kis area mein event karna chahte hain?"');
    } else {
      if (meta.city) alreadyKnow.push('City/Area: ' + meta.city);
    }
    if (lead.package_type) alreadyKnow.push('Package: ' + lead.package_type); else missing.push('package_type — "Budget ke hisaab se: simple, standard, premium ya luxury?"');
    if (meta.preferred_call_time) alreadyKnow.push('Preferred call time: ' + meta.preferred_call_time);
    if (lead.email) alreadyKnow.push('Email: ' + lead.email);
  }

  // Returning user context
  var returningContext = '';
  if (lead && (lead.lead_score > 0 || (meta && Object.keys(meta).length > 0))) {
    returningContext = '\n\nRETURNING USER: Is user se pehle baat ho chuki hai. Warmly continue karo. Jo pehle se pata hai woh DOBARA mat poocho.';
  }

  var allCollected = missing.length === 0;

  var leadContext = lead
    ? 'CUSTOMER KE BAARE MEIN JO PATA HAI:\n' +
      (alreadyKnow.length ? alreadyKnow.join('\n') : 'Kuch nahi pata abhi') +
      '\n\nJO MISSING HAI (PRIORITY ORDER — EK-EK KARKE):\n' +
      (allCollected ? 'SAARA DATA MIL GAYA! Support mode mein raho.' : missing.map(function(m, i) { return (i+1) + '. ' + m; }).join('\n')) +
      '\n\nJO PEHLE SE PATA HAI WOH BILKUL MAT POOCHO.' + returningContext
    : 'NAYA CUSTOMER — pehli baar baat ho rahi hai. Collect karo: naam, event type, event date, guest count, venue, function_list, services_needed, indoor_outdoor, theme, package_type.';

  var systemPrompt =
    'Tu Aishwarya hai — Phoenix Events & Production ki WhatsApp assistant, Pimpri-Chinchwad, Pune se.\n\n' +

    'LANGUAGE RULE — SABSE IMPORTANT:\n' +
    'HAMESHA Hinglish mein baat kar — Hindi words, Roman script mein.\n' +
    'CORRECT: "Aapka event indoor hoga ya outdoor?"\n' +
    'WRONG: "आपका इवेंट इंडोर होगा या आउटडोर?"\n' +
    'Sirf ek exception: "यह हमारा वादा है" — Devanagari mein.\n' +
    'KABHI English ya Marathi mein reply mat karo.\n\n' +

    'PERSONALITY:\n' +
    '- Warm, bubbly, genuine — helpful saheli ki tarah\n' +
    '- HAMESHA female words: bataungi, karungi, hoon, rahi hoon\n' +
    '- User ko "aap" bolna\n' +
    '- Natural reactions genuinely fit hone pe: "Wah!", "Nice!", "Ekdum sahi!"\n\n' +

    'BANNED PHRASES:\n' +
    '- "Ab mujhe lagta hai..."\n' +
    '- "Maine saari jaankari prapt kar li"\n' +
    '- "Kya aap mujhe bata sakte hain..."\n' +
    '- Any robotic customer service phrase\n\n' +

    'RESPONSE STYLE:\n' +
    '- 1-2 lines max — short, warm, WhatsApp ping\n' +
    '- EK HI SAWAAL per response — never two questions together\n' +
    '- Bridge sentences: "Achha waise —", "Ek cheez aur —"\n' +
    '- Seedha poocho: "Indoor ya outdoor?" NOT "Kya aap bata sakte hain..."\n\n' +

    'INDOOR/OUTDOOR RULE:\n' +
    '- "Indoor", "andar" → indoor_outdoor=indoor\n' +
    '- "Outdoor", "bahar", "lawn" → indoor_outdoor=outdoor\n' +
    '- "Indore" as answer to indoor/outdoor → treat as indoor\n\n' +

    'PRICING RULE — STRICT:\n' +
    'Price ke baare mein KABHI koi number mat batao — chahe kitna bhi force kare.\n' +
    '"Price ke liye hamare specialist se baat karein."\n\n' +

    'CUSTOMER STATUS:\n' + leadContext + '\n\n' +

    'KNOWLEDGE BASE:\n' + kb + '\n\n' +

    'COMPANY INFO:\n' +
    'Phoenix Events & Production | Pimpri-Chinchwad, Pune\n' +
    'Founded 2017 by Kevin | 500+ events | 98% client satisfaction\n' +
    'Website: phoenixeventsandproduction.com | Instagram: @phoenix_events_and_production | Call: +91 80357 35856\n\n' +

    'PARTNER VENUES (7):\n' +
    '1. Sky Blue Banquet Hall — Punawale/Ravet | 4.7★ | 100-500 guests\n' +
    '2. Blue Water Banquet Hall — Punawale | 5.0★ | 50-300 guests\n' +
    '3. Thopate Banquets — Rahatani | 100-400 guests\n' +
    '4. RamKrishna Veg Banquet — Ravet | 4.4★ | 50-250 guests (veg only)\n' +
    '5. Shree Krishna Palace — Pimpri Colony | 4.3★ | 100-600 guests\n' +
    '6. Raghunandan AC Banquet — Tathawade | 4.0★ | 100-350 guests\n' +
    '7. Rangoli Banquet Hall — Chinchwad | 4.3★ | 100-500 guests\n\n' +

    'DATA RULES:\n' +
    '- Jo pehle se pata hai WOH DOBARA MAT POOCHO\n' +
    '- EK RESPONSE MEIN SIRF EK SAWAAL\n' +
    '- Missing fields priority order mein collect karo\n' +
    '- city_area SIRF tab poocho jab venue hamare 7 partner venues mein se nahi hai\n' +
    '- Summary SIRF jab user maange\n' +
    '- Specialist ke liye: "hamare specialist call karenge" — kabhi "main call karungi" nahi\n\n' +

    'IMAGES:\n' +
    'Jab event ya venue discuss ho → [SEND:image=event_wedding_image] jaisi keys use karo\n' +
    'Events: event_wedding_image, event_birthday_image, event_engagement_image, event_sangeet_image,\n' +
    'event_haldi_image, event_mehendi_image, event_anniversary_image, event_corporate_image\n' +
    'Venues: venue_1_image (Sky Blue) through venue_7_image (Rangoli)\n\n' +

    'DATA TAGS (message ke END mein — invisible):\n' +
    '[LEAD:name=] [LEAD:event_type=] [LEAD:venue=] [LEAD:guest_count=] [LEAD:event_date=]\n' +
    '[LEAD:package_type=] [LEAD:services=] [LEAD:theme=] [LEAD:indoor_outdoor=]\n' +
    '[LEAD:email=] [LEAD:city=] [LEAD:functions=] [LEAD:relationship=] [LEAD:call_time=]\n' +
    '[LEAD:status=qualified] [LEAD:score+5]';

  var messages = [];
  history.forEach(function(h) {
    messages.push({ role: h.direction === 'inbound' ? 'user' : 'assistant', content: h.message || h.content || '' });
  });
  messages.push({ role: 'user', content: userMessage });

  try {
    var response = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', max_tokens: 350, temperature: 0.5,
        messages: [{ role: 'system', content: systemPrompt }].concat(messages) },
      { headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' } }
    );
    var fullText = response.data.choices[0].message.content;
    console.log('Groq response:', fullText.substring(0, 150));
    return fullText;
  } catch (err) {
    console.error('Groq error:', JSON.stringify(err.response ? err.response.data : err.message));
    return 'Ek second, thodi technical dikkat aa gayi. Humein call karein: +91 80357 35856 🙏';
  }
}

// ── MAIN MESSAGE HANDLER ──
async function handleMessage(phone, userMessage, name, msgId) {
  console.log('Message from:', phone, '| text:', userMessage.substring(0, 60));
  await logInbound(phone, userMessage, msgId);

  var [lead, history, knowledgeBase] = await Promise.all([
    getLead(phone),
    getConversationHistory(phone),
    getKnowledgeBase()
  ]);

  // Ensure lead exists
  await upsertLead(phone, name, {});

  var aiResponse = await callGroq(phone, userMessage, lead, history, knowledgeBase);
  var extracted = extractLeadData(aiResponse);
  var imagesToSend = extracted._sendImages || [];
  var scoreIncrement = extracted._scoreIncrement || 0;
  delete extracted._sendImages;
  delete extracted._scoreIncrement;

  var cleanResponse = cleanAiTags(aiResponse);
  await sendText(phone, cleanResponse);

  // Send images using new wp_media_assets system
  for (var i = 0; i < imagesToSend.length; i++) {
    try {
      var key = imagesToSend[i];
      // Determine if event or venue image
      var eventMatch = key.match(/event_([a-z]+)_image/);
      var venueMatch = key.match(/venue_(\d+)_image/);
      if (eventMatch) {
        var evType = eventMatch[1]; // wedding, birthday etc
        await sendEventPortfolio(phone, evType);
      } else if (venueMatch) {
        var venueIdx = parseInt(venueMatch[1]);
        var venueNames = ['Sky Blue Banquet Hall','Blue Water Banquet Hall','Thopate Banquets',
          'RamKrishna Veg Banquet','Shree Krishna Palace','Raghunandan AC Banquet','Rangoli Banquet Hall'];
        var vName = venueNames[venueIdx - 1] || 'Venue ' + venueIdx;
        await sendVenuePortfolio(phone, vName);
      }
    } catch (e) { console.error('media send error:', e.message); }
  }

  // Indore/indoor fix
  if (extracted.indoor_outdoor) {
    if (String(extracted.indoor_outdoor).toLowerCase().trim() === 'indore') extracted.indoor_outdoor = 'indoor';
  }
  if (extracted.city) {
    var cv = String(extracted.city).toLowerCase().trim();
    if (cv === 'indoor' || cv === 'andar') { extracted.indoor_outdoor = 'indoor'; delete extracted.city; }
    else if (cv === 'outdoor' || cv === 'bahar') { extracted.indoor_outdoor = 'outdoor'; delete extracted.city; }
    else if (extracted.city.length > 50 || /venue|banquet|hall|mentioned|customer|stated/i.test(extracted.city)) {
      delete extracted.city;
    }
  }

  // Map venue field
  if (extracted.venue) { extracted.venue_name = extracted.venue; delete extracted.venue; }

  // Urgency from event date
  if (extracted.event_date) {
    try {
      var parts = extracted.event_date.split('/');
      if (parts.length === 3) {
        var days = Math.floor((new Date(parts[2], parts[1]-1, parts[0]) - new Date()) / 86400000);
        extracted.urgency_level = days <= 30 ? 'high' : days <= 90 ? 'medium' : 'low';
      }
    } catch (e) {}
  }

  // Fields that go to top-level vs metadata
  var topLevelFields = ['name','email','status','event_type','package_type','urgency_level','lead_score'];
  var topUpdate = {};
  var metaUpdate = {};

  Object.keys(extracted).forEach(function(k) {
    if (topLevelFields.indexOf(k) !== -1) topUpdate[k] = extracted[k];
    else metaUpdate[k] = extracted[k];
  });

  // Update last_message
  if (userMessage) topUpdate.last_message = userMessage.substring(0, 200);

  var allFields = Object.assign({}, topUpdate, metaUpdate);
  if (Object.keys(allFields).length > 0) {
    await upsertLead(phone, extracted.name || name, allFields);
  }

  if (scoreIncrement) await incrementLeadScore(phone, scoreIncrement);
}

// ── WEBSITE LEAD WEBHOOK ──
// Called when website form is submitted — auto-send WA message
app.post('/website-lead', async function(req, res) {
  try {
    res.json({ status: 'received' });
    var data = req.body;
    console.log('Website lead received:', JSON.stringify(data).substring(0, 200));

    var phone = data.phone || data.mobile || data.contact;
    var name = data.name || data.full_name || 'Friend';
    var eventType = data.event || data.event_type || '';
    var venue = data.venue || data.venue_name || '';

    if (!phone) { console.log('Website lead: no phone, skipping'); return; }

    // Clean phone — ensure Indian format
    phone = String(phone).replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;
    if (phone.startsWith('0')) phone = '91' + phone.slice(1);

    console.log('Website lead — phone:', phone, '| name:', name, '| event:', eventType, '| venue:', venue);

    // Save to wp_leads
    await upsertLead(phone, name, {
      event_type: eventType,
      source_channel: 'website',
      metadata: { venue: venue, source: 'website_form' }
    });

    // Send greeting on WA
    var greeting = 'Hi *' + name + '* ji! 😊\n\n';
    greeting += 'Aapki enquiry mili — *' + (eventType || 'event') + '* ke liye';
    if (venue) greeting += ', *' + venue + '* mein';
    greeting += '!\n\n';
    greeting += 'Main Aishwarya hoon — Phoenix Events & Production se. Abhi aapko kuch khoobsurat photos bhejti hoon! 📸✨';
    await sendText(phone, greeting);
    await sleep(1000);

    // Send event portfolio if event type known
    if (eventType) await sendEventPortfolio(phone, eventType);

    // Send venue portfolio if venue known
    if (venue) {
      await sleep(500);
      await sendVenuePortfolio(phone, venue);
    }

    await sleep(1000);

    // Ask first missing question
    var firstQ = eventType
      ? ('*' + eventType + '* event ke liye — kab ka plan hai? Date approximate bhi chalegi! 📅')
      : 'Kaunsa khaas occasion plan ho raha hai? 😊';
    await sendText(phone, firstQ);

  } catch (e) { console.error('website-lead error:', e.message); }
});

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
  res.json({ status: 'Phoenix WhatsApp AI Agent VERSION 8', timestamp: new Date().toISOString() });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Phoenix WhatsApp AI Agent VERSION 8 running on port ' + PORT); });
