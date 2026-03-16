const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = 'https://qjxqebtxhfwaufmccewj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqeHFlYnR4aGZ3YXVmbWNjZXdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzUyMzQsImV4cCI6MjA4OTE1MTIzNH0.XdS-G7J2qbMEKj3lvdba0jnTDV0K1AnXe0JBym8qPKA';
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID || '1023140200877702';

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function cleanPhone(phone) {
  if (!phone) return '';
  return String(phone).replace('+', '').replace(/\s/g, '').trim();
}

function cleanVal(val) {
  if (!val) return '';
  var s = String(val).trim();
  if (s.toUpperCase() === 'NULL' || s === '{}' || s === 'undefined' || s === 'null' || s === '') return '';
  return s;
}

function validDate(val) {
  if (!val) return null;
  var s = String(val).trim();
  if (!/\d/.test(s)) return null;
  if (s.length < 4) return null;
  return s;
}

function parseDuration(body) {
  // Bolna sends duration as conversation_duration (confirmed from logs)
  var d = body.conversation_duration || body.call_duration || body.duration ||
    body.call_length || body.duration_seconds ||
    (body.metadata && body.metadata.call_duration) ||
    (body.metadata && body.metadata.duration) || 0;
  var n = parseFloat(d);
  return isNaN(n) ? 0 : Math.round(n);
}

function parseGuestCount(val) {
  if (!val) return null;
  var s = String(val).toLowerCase().trim();
  var maps = {
    'ek sau': 100, 'do sau': 200, 'teen sau': 300, 'char sau': 400, 'paanch sau': 500,
    'pachaas': 50, 'sau': 100, 'ek hazar': 1000, 'hazaar': 1000,
    'fifty': 50, 'one hundred': 100, 'two hundred': 200, 'three hundred': 300,
    'four hundred': 400, 'five hundred': 500, 'hundred': 100, 'thousand': 1000,
    'पचास': 50, 'सौ': 100, 'दो सौ': 200, 'तीन सौ': 300, 'हजार': 1000
  };
  for (var k in maps) { if (s.indexOf(k) !== -1) return maps[k]; }
  var n = parseInt(s.replace(/[^0-9]/g, ''));
  return isNaN(n) ? null : n;
}

var VENUES = [
  { index: 1, name: 'Sky Blue Banquet Hall', area: 'Punawale/Ravet', rating: '4.7', capacity: '100-500', features: 'AC, Parking, Stage, Catering' },
  { index: 2, name: 'Blue Water Banquet Hall', area: 'Punawale', rating: '5.0', capacity: '50-300', features: 'Premium AC, Parking' },
  { index: 3, name: 'Thopate Banquets', area: 'Rahatani', rating: '', capacity: '100-400', features: 'Parking, Stage' },
  { index: 4, name: 'RamKrishna Veg Banquet', area: 'Ravet', rating: '4.4', capacity: '50-250', features: 'Veg Only, AC, Parking' },
  { index: 5, name: 'Shree Krishna Palace', area: 'Pimpri Colony', rating: '4.3', capacity: '100-600', features: 'Large Hall, Stage, Parking' },
  { index: 6, name: 'Raghunandan AC Banquet', area: 'Tathawade', rating: '4.0', capacity: '100-350', features: 'Full AC, Parking, Stage' },
  { index: 7, name: 'Rangoli Banquet Hall', area: 'Chinchwad', rating: '4.3', capacity: '100-500', features: 'AC, Parking, Decoration Support' }
];

function getVenueIndex(venueName) {
  if (!venueName) return null;
  var lower = venueName.toLowerCase();
  for (var v = 0; v < VENUES.length; v++) {
    if (lower.indexOf(VENUES[v].name.toLowerCase().split(' ')[0].toLowerCase()) !== -1) return VENUES[v].index;
  }
  return null;
}

async function getLeadByPhone(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + cleanPhone(phone) + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { console.error('getLeadByPhone:', e.message); return null; }
}

async function getMediaByKey(key) {
  try {
    var res = await supabase.get('/rest/v1/workflow_content?content_key=eq.' + key + '&is_active=eq.true&select=text_content,media_assets(public_url)');
    if (res.data && res.data[0]) {
      if (res.data[0].media_assets && res.data[0].media_assets.public_url) return res.data[0].media_assets.public_url;
      if (res.data[0].text_content) return res.data[0].text_content;
    }
    return null;
  } catch (e) { return null; }
}

async function getEventImage(eventType) {
  if (!eventType) return null;
  var url = await getMediaByKey('event_' + eventType.toLowerCase().replace(/\s+/g, '_') + '_image');
  if (url) return url;
  try {
    var res = await supabase.get('/rest/v1/media_assets?subcategory=eq.' + eventType.toLowerCase() + '&is_active=eq.true&file_type=eq.image&select=public_url&order=sort_order.asc&limit=1');
    if (res.data && res.data[0]) return res.data[0].public_url;
  } catch (e) {}
  return null;
}

async function saveVoiceCall(data) {
  try {
    await supabase.post('/rest/v1/voice_calls', {
      phone: data.phone, name: data.name || 'Guest',
      call_type: 'inbound', call_status: 'completed',
      gathered_event_type: data.event_type || null,
      gathered_venue: data.venue_name || null,
      gathered_guest_count: parseGuestCount(data.guest_count),
      gathered_event_date: data.event_date || null,
      whatsapp_sent: false,
      duration_seconds: data.duration_seconds || 0,
      call_outcome: data.event_type ? 'data_collected' : 'no_data'
    });
  } catch (e) { console.error('saveVoiceCall:', e.message); }
}

async function logConversation(phone, content, direction) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: direction || 'inbound',
      message_type: 'voice', content: content,
      status: 'completed', channel: 'voice'
    });
  } catch (e) {}
}

async function upsertLead(data) {
  try {
    var phone = cleanPhone(data.phone);
    var existing = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    var isNew = !existing.data || existing.data.length === 0;
    var prev = isNew ? null : existing.data[0];
    var now = new Date().toISOString();

    var payload = {
      phone: phone, updated_at: now, last_interaction: now,
      last_channel: 'voice', voice_qualified: true, last_call_at: now,
      call_count: isNew ? 1 : ((prev.call_count || 0) + 1),
      call_duration_seconds: isNew ? (data.duration_seconds || 0) : ((prev.call_duration_seconds || 0) + (data.duration_seconds || 0))
    };

    if (data.name && data.name !== 'Guest' && data.name !== 'Unknown') payload.name = data.name;
    if (data.event_type) payload.event_type = data.event_type;
    if (data.venue_name) payload.venue = data.venue_name;
    if (data.guest_count) payload.guest_count = parseGuestCount(data.guest_count);
    if (data.event_date) payload.event_date = data.event_date;
    if (data.city) payload.city = data.city;
    if (data.area) payload.area = data.area;
    if (data.services_needed) payload.services_needed = data.services_needed;
    if (data.package_type) payload.package_type = data.package_type;
    if (data.function_list) payload.function_list = data.function_list;
    if (data.relationship_to_event) payload.relationship_to_event = data.relationship_to_event;
    if (data.preferred_call_time) payload.preferred_call_time = data.preferred_call_time;
    if (data.preferred_call_date) payload.preferred_call_date = data.preferred_call_date;
    if (data.language) payload.language = data.language;
    if (data.competitor_comparing !== undefined && data.competitor_comparing !== '') {
      payload.competitor_comparing = data.competitor_comparing === 'true' || data.competitor_comparing === true;
    }
    if (data.catering_needed !== undefined && data.catering_needed !== '') {
      payload.catering_needed = data.catering_needed === 'true' || data.catering_needed === true;
    }
    // Save call summary and transcript so WA agent can continue the conversation naturally
    if (data._callSummary) payload.call_summary = data._callSummary;
    if (data._callTranscript) payload.last_voice_transcript = data._callTranscript.substring(0, 3000);

    if (data.event_date) {
      try {
        var parts = String(data.event_date).split('/');
        if (parts.length === 3) {
          var daysUntil = Math.floor((new Date(parts[2], parts[1] - 1, parts[0]) - new Date()) / 86400000);
          payload.urgency_level = daysUntil <= 30 ? 'high' : daysUntil <= 90 ? 'medium' : 'low';
        }
      } catch (e) {}
    }

    if (isNew) {
      payload.source = 'voice_call'; payload.status = 'new';
      payload.first_channel = 'voice'; payload.whatsapp_count = 0;
      payload.lead_score = 5; payload.created_at = now;
      await supabase.post('/rest/v1/leads', payload);
      console.log('New lead created:', phone);
    } else {
      if (!prev.first_channel) payload.first_channel = 'voice';
      if (prev.status === 'qualified' || prev.status === 'converted') delete payload.status;
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, payload);
      console.log('Lead updated:', phone);
    }
  } catch (e) { console.error('upsertLead:', e.message); }
}

async function sendWhatsApp(phone, message) {
  try {
    if (!WA_TOKEN) { console.error('WA_TOKEN missing — cannot send WA'); return; }
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    console.log('Sending WA to:', fp, '| Token starts:', WA_TOKEN.substring(0, 20) + '...');
    var chunks = message.length <= 4000 ? [message] : (function() {
      var arr = []; var t = message;
      while (t.length > 0) { var c = t.substring(0, 4000); arr.push(c.trim()); t = t.substring(c.length).trim(); }
      return arr;
    })();
    for (var i = 0; i < chunks.length; i++) {
      var waRes = await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
        { messaging_product: 'whatsapp', to: fp, type: 'text', text: { body: chunks[i] } },
        { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
      );
      console.log('WA API response:', JSON.stringify(waRes.data).substring(0, 200));
      if (chunks.length > 1) await sleep(600);
    }
    console.log('WA sent OK to', fp);
  } catch (e) {
    console.error('sendWhatsApp FAILED:', JSON.stringify(e.response ? e.response.data : e.message));
    console.error('Phone used:', phone, '| PhoneID:', WA_PHONE_ID);
  }
}

async function sendWhatsAppImage(phone, imageUrl, caption) {
  try {
    if (!WA_TOKEN || !imageUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('WA image sent to', fp);
  } catch (e) { console.error('sendWhatsAppImage:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function handleHandoffFlow(data) {
  console.log('Handoff WA flow for:', data.phone);
  var name = (data.name && data.name !== 'Guest' && data.name !== 'Unknown') ? data.name : '';
  var ev = data.event_type || '';
  var venue = data.venue_name || '';
  var venueBooked = data.venue_booked === true || data.venue_booked === 'true';

  // 1. Warm greeting — reference the call, mention WA message + images/videos coming
  var greeting = '';
  if (name) greeting += '*' + name + '* ji! 😊\n\n';
  greeting += 'Main Aishwarya hoon — Phoenix Events & Production se. Abhi aapse call pe baat hui!\n\n';
  if (ev) {
    greeting += 'Aapke *' + ev + '* event ke liye hamare kuch khoobsurat kaam ki jhalak aur venue ki photos/videos abhi bhej rahi hoon WhatsApp pe! 📸✨\n\n';
  } else {
    greeting += 'Phoenix Events ke kuch khoobsurat kaam ki photos aur videos abhi bhej rahi hoon! 📸✨\n\n';
  }
  greeting += 'Aur hamare specialist *jald hi* personally aapko call karenge — yeh hamaara vaada hai! 🙏';
  await sendWhatsApp(data.phone, greeting);
  await sleep(1500);

  // 2. Event portfolio image — always send if event type known
  if (ev) {
    var eImg = await getEventImage(ev);
    if (eImg) {
      await sendWhatsAppImage(data.phone, eImg, '🎊 Hamare ' + ev + ' events — aisa banate hain hum! ✨');
      await sleep(1000);
    } else {
      // No image uploaded yet — send text appreciation instead
      await sendWhatsApp(data.phone,
        '🎊 *' + ev + ' events* mein hum kya karte hain:\n' +
        '✨ Custom theme decoration\n' +
        '📸 Professional photography & videography\n' +
        '🎵 DJ & sound systems\n' +
        '💡 Stage & lighting setup\n' +
        '🌸 Full floral decoration\n\n' +
        'Aur bhi bohot kuch — sab aapke sapnon ke hisaab se! 😊'
      );
      await sleep(1000);
    }
  }

  // 3. Venue section — logic based on whether venue is booked or not
  if (venueBooked && venue) {
    // Already booked a venue — send their venue image + appreciation
    var vi = getVenueIndex(venue);
    if (vi) {
      var vImg = await getMediaByKey('venue_' + vi + '_image');
      if (vImg) {
        await sleep(800);
        await sendWhatsAppImage(data.phone, vImg, '🏛️ ' + venue + ' — yahan hum kya kar sakte hain dekho! ✨');
        await sleep(800);
      }
    }
    await sendWhatsApp(data.phone,
      '🏛️ *' + venue + '* — ek bohot accha choice hai! 👌\n\n' +
      'Hamare specialist is venue ke saath kaam kar chuke hain — aapka event yahan bhi yaaadgaar banayenge! 😊'
    );
    await sleep(1000);
  } else {
    // Venue not booked — send full venue list + mention location-based suggestion
    await sendWhatsApp(data.phone,
      '🏛️ *Hamare 7 Premium Partner Venues — Pimpri-Chinchwad, Pune:*\n\n' +
      '1️⃣ *Sky Blue Banquet Hall* ⭐ 4.7\n' +
      '📍 Punawale/Ravet | 100–500 guests\n\n' +
      '2️⃣ *Blue Water Banquet Hall* ⭐ 5.0\n' +
      '📍 Punawale | 50–300 guests\n\n' +
      '3️⃣ *Thopate Banquets*\n' +
      '📍 Rahatani | 100–400 guests\n\n' +
      '4️⃣ *RamKrishna Veg Banquet* ⭐ 4.4 🌱\n' +
      '📍 Ravet | 50–250 guests (Pure Veg)\n\n' +
      '5️⃣ *Shree Krishna Palace* ⭐ 4.3\n' +
      '📍 Pimpri Colony | 100–600 guests\n\n' +
      '6️⃣ *Raghunandan AC Banquet* ⭐ 4.0\n' +
      '📍 Tathawade | 100–350 guests\n\n' +
      '7️⃣ *Rangoli Banquet Hall* ⭐ 4.3\n' +
      '📍 Chinchwad | 100–500 guests\n\n' +
      'Kisi bhi venue ki zyada jaankari ya photos chahiye? Bas naam batao! 😊'
    );
    await sleep(1200);

    // Send images of first 2 venues as preview
    var img1 = await getMediaByKey('venue_1_image');
    if (img1) { await sendWhatsAppImage(data.phone, img1, '✨ Sky Blue Banquet Hall — Punawale/Ravet ⭐ 4.7'); await sleep(800); }
    var img2 = await getMediaByKey('venue_3_image');
    if (img2) { await sendWhatsAppImage(data.phone, img2, '✨ Blue Water Banquet Hall — Punawale ⭐ 5.0'); await sleep(800); }
  }

  // 4. Details summary + specialist CTA + vaada
  var d = '✅ *Call mein jo details save ki hain:*\n\n';
  if (ev)                  d += '🎊 *Event:* ' + ev + '\n';
  if (data.guest_count)    d += '👥 *Guests:* ' + data.guest_count + '\n';
  if (data.event_date)     d += '📅 *Date:* ' + data.event_date + '\n';
  if (venue)               d += '🏛️ *Venue:* ' + venue + '\n';
  if (data.services_needed) d += '✨ *Services:* ' + data.services_needed + '\n';
  if (data.package_type)   d += '📦 *Package:* ' + data.package_type.charAt(0).toUpperCase() + data.package_type.slice(1) + '\n';
  if (data.preferred_call_time) d += '📞 *Callback time:* ' + data.preferred_call_time + '\n';
  if (data.city)           d += '📍 *City/Area:* ' + data.city + '\n';
  d += '\n';
  d += 'Hamare specialist *jald hi* aapko personally call karenge — *yeh hamaara vaada hai!* 🙏\n\n';
  d += 'Tab tak agar koi bhi sawaal ho, koi venue ki photo dekhni ho, ya koi bhi baat karni ho — bas yahan message karo! Main hamesha available hoon 😊\n\n';
  d += '📞 *+91 80357 35856*\n';
  d += '🌐 phoenixeventsandproduction.com\n';
  d += '📸 @phoenix_events_and_production';

  await sendWhatsApp(data.phone, d);

  try {
    await supabase.patch('/rest/v1/leads?phone=eq.' + cleanPhone(data.phone), { handoff_wa_sent: true, updated_at: new Date().toISOString() });
    await supabase.patch('/rest/v1/voice_calls?phone=eq.' + cleanPhone(data.phone) + '&whatsapp_sent=eq.false', { whatsapp_sent: true });
  } catch (e) {}

  console.log('Handoff complete for', data.phone);
}

function extractFromTranscript(transcript) {
  var data = { name: '', event_type: '', venue_booked: false, venue_name: '', guest_count: '', event_date: '' };
  if (!transcript) return data;
  var nameP = [/माझं नाव ([^\n,।]+)/i, /mera naam ([^\n,।]+)/i, /my name is ([^\n,।]+)/i, /naav ([^\n,।]+)/i, /I am ([A-Z][a-z]+)/];
  for (var i = 0; i < nameP.length; i++) { var m = transcript.match(nameP[i]); if (m) { data.name = m[1].trim().split(' ')[0]; break; } }
  var events = ['wedding', 'birthday', 'engagement', 'sangeet', 'haldi', 'mehendi', 'anniversary', 'corporate', 'reception', 'baby shower', 'namkaran', 'shaadi', 'lagna'];
  for (var j = 0; j < events.length; j++) { if (transcript.toLowerCase().indexOf(events[j]) !== -1) { data.event_type = events[j].charAt(0).toUpperCase() + events[j].slice(1); break; } }
  var gm = transcript.match(/(\d+)\s*(guest|log|माणस|मेहमान)/i);
  if (gm) data.guest_count = gm[1];
  return data;
}

// ── ROUTES ──
app.get('/', function(req, res) { res.json({ status: 'Phoenix Events Voice Agent VERSION 11', timestamp: new Date().toISOString() }); });
app.get('/phoenix-bolna-agent', function(req, res) { res.json({ status: 'webhook active', version: 8 }); });

app.post('/phoenix-bolna-agent', async function(req, res) {
  console.log('\n=== BOLNA WEBHOOK ===');
  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

  // Log full payload so we can see exactly what Bolna sends
  console.log('BODY KEYS:', body ? Object.keys(body) : 'empty');
  console.log('BODY PREVIEW:', JSON.stringify(body).substring(0, 600));

  // Bolna wraps some events inside a "message" object
  var msg = (body && body.message) || {};

  var status = cleanVal(
    (body && body.status) ||
    (body && body.type) ||
    (msg && msg.type) ||
    ''
  );

  // userNumber = the CALLER's mobile number (not the Plivo/agent number)
  // Bolna sends caller in: user_number, from, call.customer.number, message.call.customer.number
  // body.to = the Plivo number (agent side) — NEVER use this
  var userNumber = cleanVal(
    (body && body.user_number) ||
    (body && body.from) ||
    (msg && msg.call && msg.call.customer && msg.call.customer.number) ||
    (body && body.call && body.call.customer && body.call.customer.number) ||
    (body && body.caller_number) ||
    (body && body.caller) ||
    ''
  );
  // Extra safety: if userNumber looks like our Plivo number, ignore it
  // Our Plivo number is +918035735856 / 918035735856
  if (userNumber === '918035735856' || userNumber === '8035735856') {
    userNumber = '';
  }

  var toolName = cleanVal(
    (body && body.name) ||
    (body && body.tool_name) ||
    (body && body.tool_call && body.tool_call.name) ||
    (body && body.function && body.function.name) ||
    (body && body.task && body.task.name) ||
    (msg && msg.tool_call && msg.tool_call.name) ||
    ''
  );

  console.log('Tool:', toolName, '| Status:', status, '| User:', userNumber);

  // ── get_lead_data ──
  if (toolName === 'get_lead_data') {
    var phone = cleanPhone(userNumber || (body && body.user_number));
    if (!phone) return res.json({ result: 'new_caller', is_returning: false });
    var lead = await getLeadByPhone(phone);
    if (lead && lead.name && lead.name !== 'Guest') {
      return res.json({
        result: 'returning_caller', is_returning: true,
        name: lead.name || '', event_type: lead.event_type || '',
        venue: lead.venue || '', guest_count: lead.guest_count ? String(lead.guest_count) : '',
        event_date: lead.event_date || '', call_count: lead.call_count || 0,
        package_type: lead.package_type || '', services_needed: lead.services_needed || '',
        preferred_call_time: lead.preferred_call_time || '', last_channel: lead.last_channel || 'voice'
      });
    }
    return res.json({ result: 'new_caller', is_returning: false });
  }

  // ── get_venue_list ──
  if (toolName === 'get_venue_list') {
    var args = body && (body.arguments || body.parameters || body.data || {});
    var gc = parseGuestCount(cleanVal((args && args.guest_count) || ''));
    var filtered = gc ? VENUES.filter(function(v) { var max = parseInt(v.capacity.split('-').pop()); return max >= gc; }) : VENUES;
    if (!filtered.length) filtered = VENUES;
    var text = filtered.map(function(v) {
      return v.index + ') ' + v.name + ' - ' + v.area + (v.rating ? ' (' + v.rating + ' stars)' : '') + ' | ' + v.capacity + ' guests | ' + v.features;
    }).join(' | ');
    return res.json({ result: text });
  }

  // ── save_lead_data (mid-call) ──
  if (toolName === 'save_lead_data') {
    var args2 = body && (body.arguments || body.parameters || body.data || body.input) || body;
    var p2 = cleanPhone(userNumber || (args2 && args2.phone) || '');
    if (p2) {
      upsertLead({
        phone: p2, name: cleanVal(args2 && args2.name), event_type: cleanVal(args2 && args2.event_type),
        venue_booked: args2 && args2.venue_booked, venue_name: cleanVal(args2 && args2.venue_name),
        guest_count: cleanVal(String((args2 && args2.guest_count) || '')),
        event_date: validDate(cleanVal(args2 && args2.event_date)),
        city: cleanVal(args2 && args2.city), area: cleanVal(args2 && args2.area),
        services_needed: cleanVal(args2 && args2.services_needed), package_type: cleanVal(args2 && args2.package_type),
        function_list: cleanVal(args2 && args2.function_list), relationship_to_event: cleanVal(args2 && args2.relationship_to_event),
        preferred_call_time: cleanVal(args2 && args2.preferred_call_time), preferred_call_date: cleanVal(args2 && args2.preferred_call_date),
        language: cleanVal(args2 && args2.language), competitor_comparing: args2 && args2.competitor_comparing,
        catering_needed: args2 && args2.catering_needed, duration_seconds: 0
      }).catch(function(e) { console.error('mid-call save error:', e.message); });
    }
    return res.json({ result: 'Haan, save ho gaya. Aage baat karein.' });
  }

  // ── Call completed ──
  if (status === 'completed' && userNumber) {
    var p3 = cleanPhone(userNumber);
    var dur = parseDuration(body);
    console.log('COMPLETED:', p3, dur + 's');
    var ext = extractFromTranscript(body.transcript || '');
    // Bolna sends extractions in extracted_data or custom_extractions
    var ex = body.extracted_data || body.custom_extractions || body.extractions || body.agent_extraction || {};
    console.log('EXTRACTED DATA:', JSON.stringify(ex).substring(0, 300));
    if (typeof ex === 'object' && ex !== null) {
      // Support both field name variants Bolna might use
      var n = cleanVal(ex.customer_name || ex.name || ex.caller_name || '');
      if (n) ext.name = n;
      var et = cleanVal(ex.event_type || ex.eventType || ex.occasion || '');
      if (et) ext.event_type = et;
      var vb = ex.venue_booked !== undefined ? ex.venue_booked : ex.venueBooked;
      if (vb !== undefined) ext.venue_booked = vb;
      var vn = cleanVal(ex.venue_name || ex.venueName || ex.venue || '');
      if (vn) ext.venue_name = vn;
      var gc = ex.guest_count || ex.guestCount || ex.guests;
      if (gc) ext.guest_count = cleanVal(String(gc));
      var ed = ex.event_date || ex.eventDate || ex.date;
      if (ed) ext.event_date = validDate(cleanVal(ed));
      var pt = cleanVal(ex.package_type || ex.packageType || ex.package || '');
      if (pt) ext.package_type = pt;
      var sn = cleanVal(ex.services_needed || ex.services || ex.servicesNeeded || '');
      if (sn) ext.services_needed = sn;
      var pct = cleanVal(ex.preferred_call_time || ex.callbackTime || ex.callback_time || '');
      if (pct) ext.preferred_call_time = pct;
      var rel = cleanVal(ex.relationship_to_event || ex.relationship || '');
      if (rel) ext.relationship_to_event = rel;
      var fl = cleanVal(ex.function_list || ex.functions || '');
      if (fl) ext.function_list = fl;
      var lang = cleanVal(ex.language_spoken || ex.language || '');
      if (lang) ext.language = lang;
      var ca = cleanVal(ex.city_area || ex.city || ex.area || '');
      if (ca) ext.city = ca;
      if (ex.competitor_comparing !== undefined) ext.competitor_comparing = ex.competitor_comparing;
    }
    var prev2 = await getLeadByPhone(p3);
    var final = {
      phone: p3,
      name: cleanVal(ext.name) || (prev2 && prev2.name) || 'Guest',
      event_type: cleanVal(ext.event_type) || (prev2 && prev2.event_type) || '',
      venue_booked: ext.venue_booked || false,
      venue_name: cleanVal(ext.venue_name) || (prev2 && prev2.venue) || '',
      guest_count: cleanVal(ext.guest_count) || (prev2 && String(prev2.guest_count || '')) || '',
      event_date: validDate(ext.event_date) || (prev2 && prev2.event_date) || null,
      package_type: cleanVal(ext.package_type) || (prev2 && prev2.package_type) || '',
      services_needed: cleanVal(ext.services_needed) || (prev2 && prev2.services_needed) || '',
      preferred_call_time: cleanVal(ext.preferred_call_time) || (prev2 && prev2.preferred_call_time) || '',
      relationship_to_event: cleanVal(ext.relationship_to_event) || '',
      function_list: cleanVal(ext.function_list) || '',
      language: cleanVal(ext.language) || '',
      city: cleanVal(ext.city) || '',
      competitor_comparing: ext.competitor_comparing,
      duration_seconds: dur
    };
    // Save transcript + summary to leads table so WA agent can read it
    var callSummary = cleanVal(body.summary || body.call_summary || '');
    var callTranscript = cleanVal(body.transcript || '');
    if (!callSummary && final.event_type) {
      // Build a basic summary if Bolna didn't provide one
      callSummary = 'Voice call hua. Naam: ' + (final.name || 'unknown') + '. ';
      if (final.event_type) callSummary += 'Event: ' + final.event_type + '. ';
      if (final.guest_count) callSummary += 'Guests: ' + final.guest_count + '. ';
      if (final.event_date) callSummary += 'Date: ' + final.event_date + '. ';
      if (final.venue_name) callSummary += 'Venue: ' + final.venue_name + '. ';
      if (final.package_type) callSummary += 'Package: ' + final.package_type + '. ';
      if (final.services_needed) callSummary += 'Services: ' + final.services_needed + '. ';
      if (final.preferred_call_time) callSummary += 'Preferred call time: ' + final.preferred_call_time + '. ';
    }
    final._callSummary = callSummary;
    final._callTranscript = callTranscript;

    res.json({ status: 'received' });
    saveVoiceCall(final).catch(function(e) { console.error(e.message); });
    upsertLead(final).catch(function(e) { console.error(e.message); });
    logConversation(p3, 'Voice call | ' + (final.event_type || 'no event') + ' | ' + dur + 's', 'inbound').catch(function() {});
    handleHandoffFlow(final).catch(function(e) { console.error('handoff error:', e.message); });
    return;
  }

  if (status === 'initiated' && userNumber) {
    logConversation(cleanPhone(userNumber), 'Voice call initiated', 'inbound').catch(function() {});
    return res.json({ status: 'acknowledged' });
  }

  res.json({ status: 'received' });
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() { console.log('Phoenix Events Voice Agent VERSION 11 running on port ' + PORT); });
