const express = require('express');
const axios = require('axios');
const app = express();

var ALLOWED_ORIGINS = [
  'https://phoenixeventsandproduction.com',
  'https://www.phoenixeventsandproduction.com',
  'http://localhost:8085',
  'http://localhost:5173',
  'http://127.0.0.1:8085',
  'http://127.0.0.1:5173'
];
if (process.env.ADMIN_CORS_ORIGIN) {
  process.env.ADMIN_CORS_ORIGIN.split(',').forEach(function(o) {
    var t = o.trim();
    if (t && ALLOWED_ORIGINS.indexOf(t) === -1) ALLOWED_ORIGINS.push(t);
  });
}

function isAllowedAdminOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
  try {
    var host = new URL(origin).hostname.toLowerCase();
    if (host === 'phoenixeventsandproduction.com' || host.endsWith('.phoenixeventsandproduction.com')) return true;
    if (host.endsWith('.vercel.app')) return true;
  } catch (e) {}
  return false;
}

app.use(function(req, res, next) {
  var origin = req.headers.origin;
  if (isAllowedAdminOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wp-admin-secret');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

process.on('uncaughtException', function(err) { console.error('UNCAUGHT EXCEPTION:', err); });
process.on('unhandledRejection', function(reason) { console.error('UNHANDLED REJECTION:', reason); });

console.log('Starting Phoenix WhatsApp — Aishwarya v13...');

const SUPABASE_URL = 'https://sainjerowmjetpmtezwg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'phoenix_verify_2024';
const GROQ_KEY = process.env.GROQ_API_KEY;
const WP_ADMIN_SECRET = process.env.WP_ADMIN_SECRET || '';

function requireAdmin(req, res, next) {
  if (!WP_ADMIN_SECRET) return next();
  if (req.headers['x-wp-admin-secret'] === WP_ADMIN_SECRET) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

console.log('SUPABASE_KEY:', SUPABASE_KEY ? 'Loaded' : 'MISSING');
console.log('WA_TOKEN:', WA_TOKEN ? 'Loaded' : 'MISSING');
console.log('WA_PHONE_ID:', WA_PHONE_ID ? 'Loaded' : 'MISSING');
console.log('GROQ_KEY:', GROQ_KEY ? 'Loaded' : 'MISSING');

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

// ── DEDUP ──
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

// Safely converts any value to string — prevents [object Object]
function safeStr(val) {
  if (!val) return '';
  if (typeof val === 'object') {
    if (Array.isArray(val)) return val.join(', ');
    var j = JSON.stringify(val);
    return j === '{}' ? '' : j;
  }
  var s = String(val).trim();
  if (s === '{}' || s === 'null' || s === 'undefined' || s === 'NULL') return '';
  return s;
}

function cleanVal(val) {
  if (!val) return '';
  var s = String(val).trim();
  if (s.toUpperCase() === 'NULL' || s === '{}' || s === 'undefined' || s === 'null' || s === '') return '';
  return s;
}

// Parse guest count from Hindi/Marathi/English words
function parseGuestCount(val) {
  if (!val) return null;
  var s = String(val).toLowerCase().trim();
  var maps = {
    'ek sau': 100, 'do sau': 200, 'teen sau': 300, 'char sau': 400, 'paanch sau': 500,
    'pachaas': 50, 'sau': 100, 'ek hazar': 1000, 'hazaar': 1000,
    'fifty': 50, 'one hundred': 100, 'two hundred': 200, 'three hundred': 300,
    'four hundred': 400, 'five hundred': 500, 'hundred': 100, 'thousand': 1000
  };
  for (var k in maps) { if (s.indexOf(k) !== -1) return maps[k]; }
  var n = parseInt(s.replace(/[^0-9]/g, ''));
  return isNaN(n) ? null : n;
}

// ── VENUE DATA ──
var VENUES = [
  { index: 1, name: 'Sky Blue Banquet Hall',   area: 'Punawale/Ravet', rating: '4.7', capacity: '100-500' },
  { index: 2, name: 'Blue Water Banquet Hall', area: 'Punawale',       rating: '5.0', capacity: '50-300'  },
  { index: 3, name: 'Thopate Banquets',        area: 'Rahatani',       rating: '',    capacity: '100-400' },
  { index: 4, name: 'RamKrishna Veg Banquet',  area: 'Ravet',          rating: '4.4', capacity: '50-250'  },
  { index: 5, name: 'Shree Krishna Palace',    area: 'Pimpri Colony',  rating: '4.3', capacity: '100-600' },
  { index: 6, name: 'Raghunandan AC Banquet',  area: 'Tathawade',      rating: '4.0', capacity: '100-350' },
  { index: 7, name: 'Rangoli Banquet Hall',    area: 'Chinchwad',      rating: '4.3', capacity: '100-500' }
];

var OUR_VENUE_KEYWORDS = ['sky blue','blue water','thopate','ramkrishna','ram krishna','shree krishna','raghunandan','rangoli'];
function isOurVenue(v) {
  if (!v) return false;
  var l = v.toLowerCase();
  return OUR_VENUE_KEYWORDS.some(function(k) { return l.indexOf(k) !== -1; });
}

function getVenueIndex(venueName) {
  if (!venueName) return null;
  var lower = String(venueName).toLowerCase();
  for (var v = 0; v < VENUES.length; v++) {
    if (lower.indexOf(VENUES[v].name.toLowerCase().split(' ')[0]) !== -1) return VENUES[v].index;
    if (lower.indexOf(VENUES[v].name.toLowerCase()) !== -1) return VENUES[v].index;
  }
  return null;
}

// ── WA SEND ──
async function sendText(phone, message, logMeta) {
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
    await logOutbound(phone, message, 'text', Object.assign({ source: 'agent' }, logMeta || {}));
  } catch (e) { console.error('sendText FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); throw e; }
}

async function sendImage(phone, imageUrl, caption, logMeta) {
  try {
    if (!imageUrl) { console.log('sendImage: no imageUrl, skipping'); return; }
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    console.log('Sending image to', phone, ':', imageUrl.substring(0, 80));
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('Image sent OK to', phone);
    var label = caption && caption.trim() ? caption.trim() : 'Photo sent';
    await logOutbound(phone, label, 'image', Object.assign({ media_url: imageUrl }, logMeta || {}));
  } catch (e) { console.error('sendImage FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendVideo(phone, videoUrl, caption, logMeta) {
  try {
    if (!videoUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'video', video: { link: videoUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('Video sent OK to', phone);
    var label = caption && caption.trim() ? caption.trim() : 'Video sent';
    await logOutbound(phone, label, 'video', Object.assign({ media_url: videoUrl }, logMeta || {}));
  } catch (e) { console.error('sendVideo FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendDocument(phone, docUrl, filename, caption, logMeta) {
  try {
    if (!docUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    var docPayload = { link: docUrl };
    if (filename) docPayload.filename = filename;
    if (caption) docPayload.caption = caption;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'document', document: docPayload },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('Document sent OK to', phone);
    var label = caption && caption.trim() ? caption.trim() : (filename ? 'Document: ' + filename : 'Document sent');
    await logOutbound(phone, label, 'document', Object.assign({ media_url: docUrl, filename: filename || null }, logMeta || {}));
  } catch (e) { console.error('sendDocument FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendYoutubeLink(phone, youtubeId, caption) {
  try {
    if (!youtubeId) return;
    var msg = (caption ? caption + '\n' : '') + 'https://www.youtube.com/watch?v=' + youtubeId;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'text', text: { body: msg } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    await logOutbound(phone, (caption || 'Video link') + ' — YouTube', 'video', { youtube_id: youtubeId, media_url: 'https://www.youtube.com/watch?v=' + youtubeId, source: 'agent' });
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
    var topLevel = ['name','phone','email','status','event_type','urgency_level','lead_score','source_channel','last_message','tags'];
    var topFields = {}; var metaFields = {};
    Object.keys(fields || {}).forEach(function(k) {
      if (topLevel.indexOf(k) !== -1) topFields[k] = fields[k]; else metaFields[k] = fields[k];
    });
    if (!existing) {
      var payload = Object.assign({ phone: phone, name: name || 'Friend', status: 'new', source_channel: 'whatsapp', lead_score: 0, created_at: now, updated_at: now }, topFields);
      if (Object.keys(metaFields).length > 0) payload.metadata = metaFields;
      await supabase.post('/rest/v1/wp_leads', payload);
      console.log('New wp_lead:', phone);
    } else {
      var update = Object.assign({ updated_at: now }, topFields);
      if (Object.keys(metaFields).length > 0) update.metadata = Object.assign({}, existing.metadata || {}, metaFields);
      if (name && name !== 'Friend' && name !== 'Unknown' && (!existing.name || existing.name === 'Friend')) update.name = name;
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

async function logOutbound(phone, message, messageType, metadata) {
  try {
    var lead = await getLead(phone);
    await supabase.post('/rest/v1/wp_conversations', {
      lead_id: lead ? lead.id : null,
      lead_phone: phone,
      direction: 'outbound',
      message: message || '',
      message_type: messageType || 'text',
      metadata: metadata || {}
    });
  } catch (e) {}
}

function normalizePhone(phone) {
  phone = String(phone || '').replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;
  if (phone.startsWith('0')) phone = '91' + phone.slice(1);
  return phone;
}

// ── MEDIA — RPC-based with 3-level fallback ──
// DROP-IN: Replace your entire getMediaSlotPack function in Railway index.js with this block.
// Root cause: wp_get_media_slot_pack returns { images: [...], videos: [...] }, not a flat slot array.

async function getMediaSlotPack(entityKind, entityId) {
  try {
    console.log('getMediaSlotPack:', entityKind, entityId);
    var res = await supabase.post('/rest/v1/rpc/wp_get_media_slot_pack', {
      p_entity_kind: entityKind,
      p_entity_id: entityId || null
    });
    console.log('getMediaSlotPack response:', JSON.stringify(res.data).substring(0, 300));
    if (!res.data) return { images: [], videos: [] };

    var images = [];
    var videos = [];

    // wp_get_media_slot_pack returns { images: [...], videos: [...] }
    if (!Array.isArray(res.data) && (res.data.images || res.data.videos)) {
      var imgSlots = res.data.images || [];
      var vidSlots = res.data.videos || [];
      imgSlots.sort(function(a, b) { return (a.slot_index || 0) - (b.slot_index || 0); });
      vidSlots.sort(function(a, b) { return (a.slot_index || 0) - (b.slot_index || 0); });
      imgSlots.forEach(function(slot) {
        var url = slot && slot.cloudinary_url;
        if (url && String(url).trim() && url !== 'null') images.push(url);
      });
      vidSlots.forEach(function(slot) {
        var yt = slot && slot.youtube_id;
        if (yt && String(yt).trim() && yt !== 'null') videos.push(yt);
      });
    } else {
      // wp_get_media_slots_for_whatsapp returns a flat array
      var slots = Array.isArray(res.data) ? res.data : [];
      slots.sort(function(a, b) { return (a.slot_index || 0) - (b.slot_index || 0); });
      slots.forEach(function(slot) {
        if (slot.media_type === 'image' && slot.cloudinary_url) images.push(slot.cloudinary_url);
        if (slot.media_type === 'video' && slot.youtube_id) videos.push(slot.youtube_id);
      });
    }

    console.log('Media result — images:', images.length, 'videos:', videos.length);
    return { images: images, videos: videos };
  } catch (e) {
    console.error('getMediaSlotPack error:', e.message, e.response ? JSON.stringify(e.response.data) : '');
    return { images: [], videos: [] };
  }
}
async function resolveEntityId(entityKind, name) {
  try {
    if (!name) return null;
    var nameLower = name.toLowerCase().trim();
    if (entityKind === 'event') {
      var res = await supabase.get('/rest/v1/events?select=id,title&is_active=eq.true');
      if (res.data && res.data.length > 0) {
        var match = res.data.find(function(r) { return r.title && r.title.toLowerCase() === nameLower; });
        if (!match) match = res.data.find(function(r) { return r.title && r.title.toLowerCase().includes(nameLower); });
        if (!match) match = res.data.find(function(r) { return r.title && nameLower.includes(r.title.toLowerCase()); });
        if (match) return match.id;
      }
    } else if (entityKind === 'venue') {
      var res2 = await supabase.get('/rest/v1/collaborations?select=id,name&is_active=eq.true');
      if (res2.data && res2.data.length > 0) {
        var match2 = res2.data.find(function(r) { return r.name && r.name.toLowerCase() === nameLower; });
        if (!match2) match2 = res2.data.find(function(r) { return r.name && r.name.toLowerCase().includes(nameLower); });
        if (!match2) match2 = res2.data.find(function(r) { return r.name && nameLower.includes(r.name.toLowerCase().split(' ')[0]); });
        if (match2) return match2.id;
      }
    } else if (entityKind === 'service') {
      var res3 = await supabase.get('/rest/v1/services?select=id,title&is_active=eq.true');
      if (res3.data && res3.data.length > 0) {
        var match3 = res3.data.find(function(r) { return r.title && r.title.toLowerCase().includes(nameLower); });
        if (!match3) match3 = res3.data.find(function(r) { return r.title && nameLower.includes(r.title.toLowerCase()); });
        if (match3) return match3.id;
      }
    }
    return null;
  } catch (e) { console.error('resolveEntityId:', e.message); return null; }
}

async function sendEventPortfolio(phone, eventType) {
  if (!eventType) return;
  console.log('sendEventPortfolio:', eventType);
  var entityId = await resolveEntityId('event', eventType);
  var media = { images: [], videos: [] };
  if (entityId) media = await getMediaSlotPack('event', entityId);
  if (media.images.length === 0 && media.videos.length === 0) media = await getMediaSlotPack('event', null);
  if (media.images.length === 0 && media.videos.length === 0) media = await getMediaSlotPack('global', null);
  if (media.images.length === 0 && media.videos.length === 0) { console.log('No event media for:', eventType); return; }
  for (var i = 0; i < media.images.length; i++) {
    await sleep(700);
    await sendImage(phone, media.images[i], i === 0 ? ('📸 Hamare *' + eventType + '* events — aisa banate hain hum! ✨') : '');
  }
  for (var j = 0; j < media.videos.length; j++) {
    await sleep(900);
    await sendYoutubeLink(phone, media.videos[j], j === 0 ? ('🎥 ' + eventType + ' event highlights') : '');
  }
}

async function sendVenuePortfolio(phone, venueName) {
  if (!venueName) return;
  console.log('sendVenuePortfolio:', venueName);
  var entityId = await resolveEntityId('venue', venueName);
  var media = { images: [], videos: [] };
  if (entityId) media = await getMediaSlotPack('venue', entityId);
  if (media.images.length === 0 && media.videos.length === 0) media = await getMediaSlotPack('venue', null);
  if (media.images.length === 0 && media.videos.length === 0) media = await getMediaSlotPack('global', null);
  if (media.images.length === 0 && media.videos.length === 0) { console.log('No venue media for:', venueName); return; }
  for (var i = 0; i < media.images.length; i++) {
    await sleep(700);
    await sendImage(phone, media.images[i], i === 0 ? ('🏛️ *' + venueName + '* — hamare kaam ki jhalak ✨') : '');
  }
  for (var j = 0; j < media.videos.length; j++) {
    await sleep(900);
    await sendYoutubeLink(phone, media.videos[j], '🎥 ' + venueName + ' — setup preview');
  }
}

async function sendServicePortfolio(phone, serviceName) {
  if (!serviceName) return;
  var entityId = await resolveEntityId('service', serviceName);
  var media = { images: [], videos: [] };
  if (entityId) media = await getMediaSlotPack('service', entityId);
  if (media.images.length === 0 && media.videos.length === 0) media = await getMediaSlotPack('global', null);
  for (var i = 0; i < media.images.length; i++) {
    await sleep(700);
    await sendImage(phone, media.images[i], i === 0 ? ('📸 Hamare *' + serviceName + '* ka portfolio ✨') : '');
  }
  for (var j = 0; j < media.videos.length; j++) {
    await sleep(900);
    await sendYoutubeLink(phone, media.videos[j], '🎥 ' + serviceName + ' portfolio');
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

// ── EXTRACT LEAD DATA FROM AI RESPONSE ──
function extractLeadData(aiText) {
  var updates = {};
  var patterns = {
    name:           /\[LEAD:name=([^\]]+)\]/,
    event_type:     /\[LEAD:event_type=([^\]]+)\]/,
    venue:          /\[LEAD:venue=([^\]]+)\]/,
    guest_count:    /\[LEAD:guest_count=([^\]]+)\]/,
    event_date:     /\[LEAD:event_date=([^\]]+)\]/,
    status:         /\[LEAD:status=([^\]]+)\]/,
    services_needed:/\[LEAD:services=([^\]]+)\]/,
    theme:          /\[LEAD:theme=([^\]]+)\]/,
    indoor_outdoor: /\[LEAD:indoor_outdoor=([^\]]+)\]/,
    email:          /\[LEAD:email=([^\]]+)\]/,
    city:           /\[LEAD:city=([^\]]+)\]/,
    function_list:  /\[LEAD:functions=([^\]]+)\]/,
    relationship_to_event:  /\[LEAD:relationship=([^\]]+)\]/,
    preferred_call_time:    /\[LEAD:call_time=([^\]]+)\]/,
    instagram_id:   /\[LEAD:instagram=([^\]]+)\]/
  };
  for (var key in patterns) {
    var m = aiText.match(patterns[key]);
    if (m) {
      if (key === 'guest_count') {
        var parsed = parseGuestCount(m[1]);
        if (parsed) updates.guest_count = parsed;
      } else { updates[key] = m[1].trim(); }
    }
  }
  var scoreMatch = aiText.match(/\[LEAD:score\+(\d+)\]/);
  if (scoreMatch) updates._scoreIncrement = parseInt(scoreMatch[1]);

  // New media tags
  var evMatch = aiText.match(/\[SEND:event=([^\]]+)\]/g);
  if (evMatch) updates._sendEventMedia = evMatch.map(function(t) { return t.replace('[SEND:event=', '').replace(']', '').trim(); });
  var vnMatch = aiText.match(/\[SEND:venue=([^\]]+)\]/g);
  if (vnMatch) updates._sendVenueMedia = vnMatch.map(function(t) { return t.replace('[SEND:venue=', '').replace(']', '').trim(); });
  var svMatch = aiText.match(/\[SEND:service=([^\]]+)\]/g);
  if (svMatch) updates._sendServiceMedia = svMatch.map(function(t) { return t.replace('[SEND:service=', '').replace(']', '').trim(); });

  // Legacy image tag support (backward compat)
  var legacyMatch = aiText.match(/\[SEND:image=([^\]]+)\]/g);
  if (legacyMatch) {
    if (!updates._sendEventMedia) updates._sendEventMedia = [];
    if (!updates._sendVenueMedia) updates._sendVenueMedia = [];
    legacyMatch.forEach(function(tag) {
      var k2 = tag.replace('[SEND:image=', '').replace(']', '').trim();
      var em = k2.match(/event_([a-z]+)_image/);
      var vm = k2.match(/venue_(\d+)_image/);
      var sm = k2.match(/([a-z]+)_service_image/);
      if (em) updates._sendEventMedia.push(em[1]);
      else if (vm) {
        var vNames = ['Sky Blue Banquet Hall','Blue Water Banquet Hall','Thopate Banquets','RamKrishna Veg Banquet','Shree Krishna Palace','Raghunandan AC Banquet','Rangoli Banquet Hall'];
        updates._sendVenueMedia.push(vNames[parseInt(vm[1]) - 1] || 'Venue');
      } else if (sm) {
        if (!updates._sendServiceMedia) updates._sendServiceMedia = [];
        updates._sendServiceMedia.push(sm[1]);
      }
    });
  }
  return updates;
}

function cleanAiTags(text) {
  return text.replace(/\[LEAD:[^\]]+\]/g, '').replace(/\[SEND:[^\]]+\]/g, '').trim();
}

// ── GROQ AI ──
async function callGroq(phone, userMessage, lead, history, knowledgeBase) {
  var kb = buildKnowledgeContext(knowledgeBase);
  var meta = (lead && lead.metadata) || {};
  var alreadyKnow = []; var missing = []; var venueIsOurs = false;

  if (lead) {
    var hasName = lead.name && lead.name !== 'Friend' && lead.name !== 'Guest' && lead.name !== 'Unknown';
    if (hasName) alreadyKnow.push('Naam: ' + lead.name); else missing.push('naam');
    if (lead.event_type) alreadyKnow.push('Event: ' + lead.event_type); else missing.push('event_type');
    if (meta.event_date) alreadyKnow.push('Event date: ' + meta.event_date); else missing.push('event_date');
    if (meta.guest_count || lead.guest_count) alreadyKnow.push('Guests: ' + (meta.guest_count || lead.guest_count)); else missing.push('guest_count');
    if (meta.venue_name) { alreadyKnow.push('Venue: ' + meta.venue_name); venueIsOurs = isOurVenue(meta.venue_name); } else missing.push('venue');
    if (meta.relationship_to_event) alreadyKnow.push('Relationship: ' + meta.relationship_to_event); else missing.push('relationship_to_event');
    if (meta.function_list) alreadyKnow.push('Functions: ' + meta.function_list); else missing.push('function_list');
    if (meta.services_needed) alreadyKnow.push('Services: ' + meta.services_needed); else missing.push('services_needed');
    if (meta.indoor_outdoor) alreadyKnow.push('Indoor/Outdoor: ' + meta.indoor_outdoor); else missing.push('indoor_outdoor');
    if (meta.theme) alreadyKnow.push('Theme: ' + meta.theme); else missing.push('theme');
    if (!venueIsOurs && !meta.city) missing.push('city_area');
    if (meta.city) alreadyKnow.push('City: ' + meta.city);
    if (meta.preferred_call_time) alreadyKnow.push('Callback time: ' + meta.preferred_call_time); else missing.push('preferred_call_time');
    if (lead.email) alreadyKnow.push('Email: ' + lead.email);
  }

  var isReturning = lead && (lead.lead_score > 0 || Object.keys(meta).length > 0);
  var allCollected = missing.length === 0;

  var leadContext = lead
    ? 'JO PATA HAI:\n' + (alreadyKnow.join('\n') || 'Kuch nahi abhi tak') +
      '\n\nJO MISSING HAI (priority order mein collect karo):\n' +
      (allCollected ? 'SAB DATA MIL GAYA — sirf support/followup karo.' : missing.map(function(m, i) { return (i + 1) + '. ' + m; }).join('\n')) +
      '\nJO PATA HAI WOH DOBARA MAT POOCHO.' +
      (isReturning ? '\n\nRETURNING USER: Pehle baat ho chuki hai — warmly continue karo.' : '\n\nNAYA USER.')
    : 'NAYA USER — Step 1 se shuru: naam poocho.';

  var systemPrompt = 'Tu Aishwarya hai — Phoenix Events & Production ki WhatsApp assistant, Pimpri-Chinchwad, Pune.\n\n' +

'LANGUAGE: Hamesha Hinglish mein baat karo — Hindi words, Roman script. Exception: "यह हमारा वादा है" sirf Devanagari mein.\n\n' +

'PERSONALITY:\n' +
'- Warm, playful, genuinely caring saheli — real insaan ki tarah, kabhi robotic nahi\n' +
'- Genuinely excited raho events ke baare mein\n' +
'- Apne liye hamesha female words: "main samajh gayi", "main bhejungi", "main hoon yahan"\n' +
'- Caller ko hamesha "aap" bolo\n' +
'- Naam sunke ZERO reaction — "Wah", "Sundar naam" — bilkul nahi. Naam ke baad directly aage badho.\n' +
'- Options menu ki tarah KABHI mat gino — "1. shaadi, 2. birthday" — nahi\n' +
'- Har response max 2-3 lines — WhatsApp hai, novel nahi\n' +
'- Ek message mein sirf EK sawaal\n' +
'- Conversation tum lead karo\n\n' +

'STRICTLY BANNED:\n' +
'"note kar leti hoon" / "note kar rahi hoon" — silently save karo, announce mat karo\n' +
'"package" / "pricing" / "cost" / "rate" / "quote" — kabhi nahi\n' +
'"kya aap mujhe bata sakte hain" — too formal\n' +
'"Maine jaankari prapt kar li" — robotic\n' +
'"Ab mujhe lagta hai" — awkward\n\n' +

'CONVERSATION FLOW (strict order):\n\n' +

'STEP 1 — NAAM:\n' +
'Pehle message pe: warmly welcome karo + naam poocho.\n' +
'"Hi! 😊 Phoenix Events & Production mein aapka swagat hai — main Aishwarya hoon! Pehle aapka naam batao!"\n' +
'Naam milne ke baad: ZERO reaction, directly aage badho.\n\n' +

'STEP 2 — EVENT TYPE:\n' +
'"[Name] ji, batao — kaunsa khaas occasion plan ho raha hai? 🎊"\n' +
'Agar unclear: "Shaadi hai, birthday hai, ya kuch aur khaas?"\n' +
'Save: [LEAD:event_type=]\n' +
'Event type milte hi — warm excited response do + [SEND:event=<event_type>] tag lagao.\n\n' +

'EVENT TYPE RESPONSES (milne pe yeh bolo, phir TURANT [SEND:event=...] tag):\n' +
'Wedding/Shaadi: "Shaadi! 🎊 Bahut exciting — hum full decoration, stage, lighting, photography, DJ, catering — poora sapna banate hain! Ye dekho abhi!"\n' +
'Birthday: "Birthday! 🎂 Theme decoration, cake setup, DJ, photography — complete party! Abhi photos bhejti hoon!"\n' +
'Engagement: "Engagement! 💍 Elegant floral, ring ceremony setup, photography — sab hum handle karte hain! Photos dekho!"\n' +
'Sangeet: "Sangeet! 🎵 Amazing stage, DJ, dynamic lighting, anchor — full dhamaka! Photos abhi aa rahi hain!"\n' +
'Haldi: "Haldi! 💛 Vibrant marigold, traditional setup, photography — ekdum rangeen! Photos bhejti hoon!"\n' +
'Mehendi: "Mehendi! 🌿 Colorful setup, mehendi artist, photography — magical evening! Photos dekho!"\n' +
'Anniversary: "Anniversary! ❤️ Romantic decoration, special surprises, photography — itne saalon ka pyaar celebrate karte hain! Photos abhi!"\n' +
'Corporate: "Corporate event! 💼 Professional stage, AV setup, branding, catering, anchoring — complete! Photos bhejti hoon!"\n' +
'Koi bhi aur: "Bahut khaas occasion hai! Hum yeh bhi ekdum khoobsurat bana dete hain! Photos dekho abhi! 📸"\n\n' +

'STEP 3 — VENUES INTRODUCE:\n' +
'Photos ke baad venues ka natural mention karo:\n' +
'"Aur haan — hamare paas Pimpri-Chinchwad mein 7 premium partner venues hain 🏛️\n' +
'Sky Blue Banquet Hall, Blue Water Banquet Hall, Thopate Banquets, RamKrishna Veg Banquet, Shree Krishna Palace, Raghunandan AC Banquet, aur Rangoli Banquet Hall.\n' +
'Kya aapne koi venue pehle se decide kiya hai?"\n\n' +

'VENUE RESPONSES:\n' +
'Hamare 7 mein se koi: "Bahut accha choice! Hum wahan kai baar kaam kar chuke hain 😊 Wahan ke photos bhi bhejti hoon!" → [SEND:venue=<exact venue name>]\n' +
'Alag venue: "Koi baat nahi — hum kisi bhi venue pe equally khoobsurat kaam karte hain 😊" → [LEAD:venue=<name>]\n' +
'Decide nahi: "Koi baat nahi! In saaton venues pe humein special pricing milti hai — aapko seedha benefit hota hai 😊 Details bhejungi!"\n' +
'Save: [LEAD:venue=]\n\n' +

'STEP 4 — EVENT DATE:\n' +
'"Kab ka plan hai approximately? Date decide ho gayi hai ya abhi soch rahe hain? 📅"\n' +
'Save: [LEAD:event_date=] (DD/MM/YYYY)\n\n' +

'STEP 5 — GUEST COUNT:\n' +
'"Aur kitne log aayenge approximately? 😊"\n' +
'Save: [LEAD:guest_count=]\n\n' +

'STEP 6 — RELATIONSHIP:\n' +
'"Yeh event aapke liye hai ya kisi khaas insaan ke liye? 😊"\n' +
'Save: [LEAD:relationship=]\n\n' +

'STEP 7 — FUNCTIONS:\n' +
'"Sirf [event_type] hai ya aur bhi functions hain? Mehendi, haldi, sangeet, reception — kuch aur bhi? 🎊"\n' +
'Save: [LEAD:functions=]\n\n' +

'STEP 8 — SERVICES:\n' +
'"Kaun si services chahiye? Photography, videography, decoration, DJ, catering, mehendi artist — kya kya? 😊"\n' +
'Service batane pe: [SEND:service=<service>]\n' +
'Save: [LEAD:services=]\n\n' +

'STEP 9 — INDOOR/OUTDOOR:\n' +
'"Indoor mein plan hai ya outdoor? 🌿"\n' +
'Save: [LEAD:indoor_outdoor=]\n\n' +

'STEP 10 — THEME:\n' +
'"Koi specific theme ya color scheme? Ya hum suggest karein? 🎨"\n' +
'Save: [LEAD:theme=]\n\n' +

'STEP 11 — CALLBACK TIME:\n' +
'"[Name] ji — hamare specialist personally aapko call karenge poori detail ke liye! Kaunsa time best rahega — subah, dopahar ya shaam? ☎️"\n' +
'Save: [LEAD:call_time=]\n\n' +

'STEP 12 — CLOSING (jab sab data collect ho jaaye):\n' +
'"[Name] ji, bahut bahut shukriya! 🙏 Hamare specialist jald hi personally aapko call karenge ek customised plan lekar — *यह हमारा वादा है!* ✨\n' +
'Koi bhi sawaal ho toh main yahan hoon 😊"\n' +
'[LEAD:status=qualified] [LEAD:score+10]\n\n' +

'"AUR PHOTOS CHAHIYE?" RULE:\n' +
'Jab bhi photos bhejo — ek-do messages baad naturally poocho:\n' +
'"Aur photos dekhna chahoge? Main aur bhi bhej sakti hoon — bas batao! 😊"\n' +
'Agar haan bole: us category ki aur photos, ya doosri venue/event ki photos bhejo.\n\n' +

'MEDIA TAGS (in use karo, backend automatically bhej dega):\n' +
'[SEND:event=wedding] [SEND:event=birthday] [SEND:event=sangeet] [SEND:event=engagement]\n' +
'[SEND:event=haldi] [SEND:event=mehendi] [SEND:event=anniversary] [SEND:event=corporate]\n' +
'[SEND:venue=Sky Blue Banquet Hall] [SEND:venue=Blue Water Banquet Hall]\n' +
'[SEND:venue=Thopate Banquets] [SEND:venue=RamKrishna Veg Banquet]\n' +
'[SEND:venue=Shree Krishna Palace] [SEND:venue=Raghunandan AC Banquet] [SEND:venue=Rangoli Banquet Hall]\n' +
'[SEND:service=photography] [SEND:service=videography] [SEND:service=decoration] [SEND:service=DJ] [SEND:service=catering]\n\n' +

'COMMON SITUATIONS:\n' +
'PRICING: "Exact amount event ki poori details ke baad — specialist aapko proper customised plan denge, koi hidden charge nahi! 😊"\n' +
'DATE AVAILABILITY: "Exact availability specialist call mein confirm ho jaayegi 😊"\n' +
'COMPANY INFO: "Phoenix Events & Production — 2017 mein Kevin ne shuru ki thi! 500+ events, 12 saal ka experience, 98% client satisfaction 😊 Celebrity events bhi kiye hain humne!"\n' +
'INSTAGRAM: "Zaroor dekho — @phoenix_events_and_production 📸"\n' +
'RUDE/IMPATIENT: "Hamare specialist se seedha baat karein: +91 80357 35856"\n' +
'OFF TOPIC: "Zaroor! Lekin pehle ek cheez confirm kar leti hoon — [next missing question]? 😊"\n\n' +

'DATA TAGS (message end mein, user ko nahi dikhte):\n' +
'[LEAD:name=] [LEAD:event_type=] [LEAD:venue=] [LEAD:guest_count=] [LEAD:event_date=]\n' +
'[LEAD:services=] [LEAD:theme=] [LEAD:indoor_outdoor=] [LEAD:email=] [LEAD:city=]\n' +
'[LEAD:functions=] [LEAD:relationship=] [LEAD:call_time=] [LEAD:status=] [LEAD:score+5]\n' +
'Sirf jo relevant ho wahi tags lagao.\n\n' +

'DATA RULES:\n' +
'- Jo pata hai woh DOBARA MAT POOCHO\n' +
'- Ek message mein sirf EK sawaal\n' +
'- city_area sirf tab poocho agar venue hamare 7 mein nahi\n' +
'- Data tags silently lagao — announce mat karo\n\n' +

'CURRENT CUSTOMER STATUS:\n' + leadContext + '\n\n' +

'KNOWLEDGE BASE:\n' + kb + '\n\n' +

'COMPANY:\n' +
'Phoenix Events & Production | Pimpri-Chinchwad, Pune\n' +
'Founded 2017 by Kevin | 500+ events | 12 years | 50+ partners | 98% satisfaction\n' +
'Web: phoenixeventsandproduction.com | IG: @phoenix_events_and_production | Call: +91 80357 35856\n\n' +

'PARTNER VENUES:\n' +
'1. Sky Blue Banquet Hall — Punawale/Ravet | 4.7★ | 100-500 guests\n' +
'2. Blue Water Banquet Hall — Punawale | 5.0★ | 50-300 guests\n' +
'3. Thopate Banquets — Rahatani | 100-400 guests\n' +
'4. RamKrishna Veg Banquet — Ravet | 4.4★ | 50-250 guests (Pure Veg)\n' +
'5. Shree Krishna Palace — Pimpri Colony | 4.3★ | 100-600 guests\n' +
'6. Raghunandan AC Banquet — Tathawade | 4.0★ | 100-350 guests\n' +
'7. Rangoli Banquet Hall — Chinchwad | 4.3★ | 100-500 guests';

  var messages = [];
  history.forEach(function(h) { messages.push({ role: h.direction === 'inbound' ? 'user' : 'assistant', content: h.message || '' }); });
  messages.push({ role: 'user', content: userMessage });

  try {
    var response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 450,
      temperature: 0.55,
      messages: [{ role: 'system', content: systemPrompt }].concat(messages)
    }, { headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' } });

    var fullText = response.data.choices[0].message.content;
    console.log('Groq response:', fullText.substring(0, 250));
    return fullText;
  } catch (err) {
    console.error('Groq error:', JSON.stringify(err.response ? err.response.data : err.message));
    return 'Ek second, thodi technical dikkat aa gayi 😊 Seedha call kar sakte hain: *+91 80357 35856*';
  }
}

// ── MAIN MESSAGE HANDLER ──
async function handleMessage(phone, userMessage, name, msgId) {
  console.log('MSG from:', phone, '|', userMessage.substring(0, 60));
  await logInbound(phone, userMessage, msgId);

  var [lead, history, kb] = await Promise.all([getLead(phone), getConversationHistory(phone), getKnowledgeBase()]);
  await upsertLead(phone, name, {});

  var aiResponse = await callGroq(phone, userMessage, lead, history, kb);
  var extracted = extractLeadData(aiResponse);

  var sendEventMediaList   = extracted._sendEventMedia   || [];
  var sendVenueMediaList   = extracted._sendVenueMedia   || [];
  var sendServiceMediaList = extracted._sendServiceMedia || [];
  var scoreIncrement       = extracted._scoreIncrement   || 0;
  delete extracted._sendEventMedia;
  delete extracted._sendVenueMedia;
  delete extracted._sendServiceMedia;
  delete extracted._scoreIncrement;

  // 1. Send text response
  await sendText(phone, cleanAiTags(aiResponse));

  // 2. Send event media
  for (var i = 0; i < sendEventMediaList.length; i++) { await sleep(800); await sendEventPortfolio(phone, sendEventMediaList[i]); }

  // 3. Send venue media
  for (var j = 0; j < sendVenueMediaList.length; j++) { await sleep(800); await sendVenuePortfolio(phone, sendVenueMediaList[j]); }

  // 4. Send service media
  for (var k = 0; k < sendServiceMediaList.length; k++) { await sleep(800); await sendServicePortfolio(phone, sendServiceMediaList[k]); }

  // ── Fix extraction errors ──
  if (extracted.indoor_outdoor && String(extracted.indoor_outdoor).toLowerCase() === 'indore') extracted.indoor_outdoor = 'indoor';
  if (extracted.city) {
    var cv = String(extracted.city).toLowerCase().trim();
    if (cv === 'indoor' || cv === 'andar') { extracted.indoor_outdoor = 'indoor'; delete extracted.city; }
    else if (cv === 'outdoor' || cv === 'bahar') { extracted.indoor_outdoor = 'outdoor'; delete extracted.city; }
    else if (extracted.city.length > 50 || /venue|banquet|hall|mentioned|customer/i.test(extracted.city)) delete extracted.city;
  }
  if (extracted.venue) { extracted.venue_name = extracted.venue; delete extracted.venue; }
  if (extracted.guest_count) {
    var gc = parseGuestCount(String(extracted.guest_count));
    if (gc) extracted.guest_count = gc; else delete extracted.guest_count;
  }
  if (extracted.event_date) {
    try {
      var parts = String(extracted.event_date).split('/');
      if (parts.length === 3) {
        var days = Math.floor((new Date(parts[2], parseInt(parts[1]) - 1, parseInt(parts[0])) - new Date()) / 86400000);
        extracted.urgency_level = days <= 30 ? 'high' : days <= 90 ? 'medium' : 'low';
      }
    } catch (e) {}
  }

  var topLevelFields = ['name','email','status','event_type','urgency_level','lead_score'];
  var topUp = {}; var metaUp = {};
  Object.keys(extracted).forEach(function(k) {
    if (topLevelFields.indexOf(k) !== -1) topUp[k] = extracted[k]; else metaUp[k] = extracted[k];
  });
  if (userMessage) topUp.last_message = userMessage.substring(0, 200);
  var allFields = Object.assign({}, topUp, metaUp);
  if (Object.keys(allFields).length > 0) await upsertLead(phone, extracted.name || name, allFields);
  if (scoreIncrement) await incrementLeadScore(phone, scoreIncrement);
}

// ── WEBSITE LEAD WEBHOOK ──
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
    console.log('Website lead:', phone, eventType, venue);
    await upsertLead(phone, name, { source_channel: 'website', event_type: eventType });

    var greeting = 'Hi *' + name + '* ji! 😊\n\n';
    greeting += 'Aapki enquiry mili — ';
    if (eventType) greeting += '*' + eventType + '* ke liye';
    if (venue) greeting += ', *' + venue + '* mein';
    greeting += '!\n\nMain Aishwarya hoon — Phoenix Events & Production se 😊 Kuch khoobsurat photos bhejti hoon abhi! 📸✨';
    await sendText(phone, greeting);
    await sleep(1200);

    if (eventType) await sendEventPortfolio(phone, eventType);
    if (venue) { await sleep(600); await sendVenuePortfolio(phone, venue); }
    await sleep(1200);

    var firstQ = eventType
      ? ('*' + eventType + '* ke liye — kab ka plan hai? Approximate date bhi chalegi! 📅')
      : 'Kaunsa khaas occasion plan ho raha hai? 😊';
    await sendText(phone, firstQ);
  } catch (e) { console.error('website-lead error:', e.message); }
});

// ── ADMIN: send text / image / video / document (from admin dashboard) ──
app.post('/admin-send-media', requireAdmin, async function(req, res) {
  try {
    var data = req.body || {};
    var phone = normalizePhone(data.phone);
    var mediaType = String(data.media_type || 'text').toLowerCase();
    var url = data.url || data.media_url || '';
    var caption = data.caption || data.message || '';
    var filename = data.filename || '';
    if (!phone) return res.status(400).json({ error: 'phone required' });

    var logMeta = { source: 'admin' };

    if (mediaType === 'text') {
      var text = data.message || caption;
      if (!text) return res.status(400).json({ error: 'message required' });
      await sendText(phone, text);
      return res.json({ status: 'sent', type: 'text' });
    }
    if (!url) return res.status(400).json({ error: 'url required for media' });

    if (mediaType === 'image') {
      await sendImage(phone, url, caption, logMeta);
    } else if (mediaType === 'video') {
      await sendVideo(phone, url, caption, logMeta);
    } else if (mediaType === 'document') {
      await sendDocument(phone, url, filename, caption, logMeta);
    } else {
      return res.status(400).json({ error: 'media_type must be text, image, video, or document' });
    }
    return res.json({ status: 'sent', type: mediaType });
  } catch (e) {
    console.error('admin-send-media error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── FOLLOW-UPS (text + optional media, schedule or send now) ──
function buildFollowupMediaMeta(data) {
  var url = data.media_url || data.url || '';
  var mediaType = data.media_type ? String(data.media_type).toLowerCase() : '';
  if (!url || !mediaType) return null;
  return {
    media_type: mediaType,
    media_url: url,
    filename: data.filename || '',
    caption: data.caption || data.media_caption || ''
  };
}

async function deliverFollowupPayload(phone, message, metadata, logSource) {
  phone = normalizePhone(phone);
  var logMeta = { source: logSource || 'admin' };
  var meta = metadata && typeof metadata === 'object' ? metadata : {};
  var hasText = message && String(message).trim();
  var hasMedia = meta.media_url && meta.media_type;

  if (!hasText && !hasMedia) throw new Error('nothing to send');

  if (hasText) {
    await sendText(phone, String(message).trim(), logMeta);
    await sleep(800);
  }
  if (hasMedia) {
    var mt = String(meta.media_type).toLowerCase();
    var cap = meta.caption || '';
    if (mt === 'image') await sendImage(phone, meta.media_url, cap, logMeta);
    else if (mt === 'video') await sendVideo(phone, meta.media_url, cap, logMeta);
    else if (mt === 'document') await sendDocument(phone, meta.media_url, meta.filename || '', cap, logMeta);
    else throw new Error('unsupported media_type: ' + mt);
    await sleep(800);
  }
}

async function runPendingFollowups() {
  var now = new Date().toISOString();
  var result = await supabase.get(
    '/rest/v1/wp_followups?status=eq.pending&scheduled_at=lte.' + encodeURIComponent(now) +
    '&select=*&limit=50&order=scheduled_at.asc'
  );
  if (!result.data || result.data.length === 0) return { processed: 0, total: 0 };
  var sent = 0;
  for (var i = 0; i < result.data.length; i++) {
    var f = result.data[i];
    try {
      await deliverFollowupPayload(f.lead_phone, f.message, f.metadata || {}, 'admin');
      await supabase.patch('/rest/v1/wp_followups?id=eq.' + f.id, {
        status: 'sent',
        updated_at: new Date().toISOString()
      });
      sent++;
      await sleep(1000);
    } catch (e) {
      console.error('Followup failed:', f.lead_phone, f.id, e.message);
      await supabase.patch('/rest/v1/wp_followups?id=eq.' + f.id, {
        status: 'failed',
        updated_at: new Date().toISOString()
      });
    }
  }
  console.log('Processed followups:', sent, '/', result.data.length);
  return { processed: sent, total: result.data.length };
}

app.post('/schedule-followup', requireAdmin, async function(req, res) {
  try {
    var data = req.body || {};
    var phone = data.phone;
    var message = data.message || '';
    var sendNow = data.send_now || false;
    var mediaMeta = buildFollowupMediaMeta(data);
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (!String(message).trim() && !mediaMeta) return res.status(400).json({ error: 'message or media required' });
    phone = normalizePhone(phone);
    var metadata = mediaMeta || {};
    if (sendNow) {
      await deliverFollowupPayload(phone, message, metadata, 'admin');
      return res.json({ status: 'sent' });
    }
    var scheduledAt = data.scheduled_at || new Date(Date.now() + 3600000).toISOString();
    var lead = await getLead(phone);
    await supabase.post('/rest/v1/wp_followups', {
      lead_id: lead ? lead.id : null,
      lead_phone: phone,
      scheduled_at: scheduledAt,
      message: String(message).trim() || null,
      metadata: metadata,
      status: 'pending'
    });
    return res.json({ status: 'scheduled', scheduled_at: scheduledAt });
  } catch (e) {
    console.error('schedule-followup error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/process-followups', requireAdmin, async function(req, res) {
  try {
    var result = await runPendingFollowups();
    return res.json(Object.assign({ status: 'ok' }, result));
  } catch (e) {
    console.error('process-followups error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── WHATSAPP WEBHOOK ──
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

// ── MISC ROUTES ──
app.get('/', function(req, res) { res.json({ status: 'Phoenix WhatsApp — Aishwarya v13', timestamp: new Date().toISOString() }); });
app.get('/health', function(req, res) { res.status(200).json({ success: true, service: 'running', version: 13, timestamp: new Date().toISOString() }); });
app.get('/privacy-policy', function(req, res) {
  res.send('<html><body><h1>Privacy Policy</h1><p>Phoenix Events & Production WhatsApp Agent. We collect only the information you provide to help plan your event. Data stored securely, never shared with third parties.</p></body></html>');
});

var PORT = process.env.PORT || 3000;
var WP_FOLLOWUP_POLL_MS = parseInt(process.env.WP_FOLLOWUP_POLL_MS || '60000', 10);
var followupPollBusy = false;

var server = app.listen(PORT, '0.0.0.0', function() {
  console.log('================================');
  console.log('Phoenix WhatsApp — Aishwarya v13');
  console.log('Port: ' + PORT);
  console.log('Follow-up auto-poll every ' + WP_FOLLOWUP_POLL_MS + 'ms');
  console.log('================================');

  setInterval(function() {
    if (followupPollBusy) return;
    followupPollBusy = true;
    runPendingFollowups()
      .catch(function(e) { console.error('followup poll error:', e.message); })
      .finally(function() { followupPollBusy = false; });
  }, WP_FOLLOWUP_POLL_MS);

  setTimeout(function() {
    runPendingFollowups().catch(function(e) { console.error('followup startup poll:', e.message); });
  }, 20000);
});
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
