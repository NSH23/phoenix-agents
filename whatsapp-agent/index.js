const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const SUPABASE_URL = 'https://fhhwfqlbgmsscmqihjyz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID || '1023140200877702';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'phoenix_verify_2024';

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

// ─────────────────────────────────────────────
// DEDUPLICATION — ignore duplicate webhook hits
// ─────────────────────────────────────────────
const processedMessages = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) return true;
  processedMessages.add(msgId);
  // Keep set from growing forever
  if (processedMessages.size > 1000) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }
  return false;
}

// ─────────────────────────────────────────────
// WHATSAPP SEND HELPERS
// ─────────────────────────────────────────────
async function sendText(phone, message) {
  try {
    var fullPhone = phone.startsWith('+') ? phone : '+' + phone;
    var resp = await axios.post(
      'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fullPhone, type: 'text', text: { body: message } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    await logOutbound(phone, message, 'text');
    return resp.data;
  } catch (err) {
    console.error('sendText FAILED:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function sendImage(phone, imageUrl, caption) {
  try {
    var fullPhone = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post(
      'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fullPhone, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    await logOutbound(phone, '[image] ' + caption, 'image');
  } catch (err) {
    console.error('sendImage FAILED:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function sendInteractiveList(phone, header, body, footer, buttonLabel, sections) {
  try {
    var fullPhone = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post(
      'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      {
        messaging_product: 'whatsapp', to: fullPhone, type: 'interactive',
        interactive: { type: 'list', header: { type: 'text', text: header },
          body: { text: body }, footer: { text: footer },
          action: { button: buttonLabel, sections: sections }
        }
      },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    await logOutbound(phone, '[list] ' + header, 'interactive');
  } catch (err) {
    console.error('sendInteractiveList FAILED:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

// ─────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────
async function getLead(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { console.error('getLead error:', e.message); return null; }
}

async function createLead(phone, name) {
  try {
    var res = await supabase.post('/rest/v1/leads', {
      phone, name, step: 'main_menu', lead_score: 0, status: 'new',
      source: 'whatsapp', first_channel: 'whatsapp', last_channel: 'whatsapp',
      whatsapp_count: 1, last_interaction: new Date().toISOString()
    });
    console.log('New lead created:', phone);
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { console.error('createLead error:', e.message); return null; }
}

async function updateLead(phone, fields) {
  try {
    fields.last_interaction = new Date().toISOString();
    fields.last_channel = 'whatsapp';
    await supabase.patch('/rest/v1/leads?phone=eq.' + phone, fields);
  } catch (e) { console.error('updateLead error:', e.message); }
}

async function incrementLeadScore(phone, amount) {
  try {
    await supabase.post('/rest/v1/rpc/increment_lead_score', { p_phone: phone, p_increment: amount });
  } catch (e) {
    // Fallback if RPC doesn't exist — manual increment
    try {
      var lead = await getLead(phone);
      if (lead) await supabase.patch('/rest/v1/leads?phone=eq.' + phone, { lead_score: (lead.lead_score || 0) + amount });
    } catch (e2) { console.error('incrementLeadScore error:', e2.message); }
  }
}

async function incrementWhatsAppCount(phone) {
  try {
    var lead = await getLead(phone);
    if (lead) {
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, {
        whatsapp_count: (lead.whatsapp_count || 0) + 1
      });
    }
  } catch (e) { console.error('incrementWhatsAppCount error:', e.message); }
}

async function logInbound(phone, message, msgId) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'inbound', message_type: 'text',
      content: message, whatsapp_message_id: msgId || '', status: 'received',
      channel: 'whatsapp'
    }, { headers: { Prefer: 'resolution=ignore-duplicates' } });
  } catch (e) {}
}

async function logOutbound(phone, message, type) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'outbound', message_type: type || 'text',
      content: message, status: 'sent', channel: 'whatsapp'
    });
  } catch (e) {}
}

async function getMediaImage(key) {
  try {
    var res = await supabase.get(
      '/rest/v1/workflow_content?content_key=eq.' + key +
      '&is_active=eq.true&select=text_content,media_asset_id,media_assets(public_url)'
    );
    if (res.data && res.data[0]) {
      var row = res.data[0];
      if (row.media_assets && row.media_assets.public_url) return row.media_assets.public_url;
      if (row.text_content) return row.text_content;
    }
    return null;
  } catch (e) { return null; }
}

// ─────────────────────────────────────────────
// VENUE DATA
// ─────────────────────────────────────────────
const VENUES = [
  { id: '1', name: 'Sky Blue Banquet Hall', location: 'Punawale, Ravet', rating: '4.7', key: 'venue_1_image' },
  { id: '2', name: 'Blue Water Banquet Hall', location: 'Punawale', rating: '5.0', key: 'venue_2_image' },
  { id: '3', name: 'Thopate Banquets', location: 'Rahatani', rating: '', key: 'venue_3_image' },
  { id: '4', name: 'RamKrishna Veg Banquet', location: 'Ravet', rating: '4.4', key: 'venue_4_image' },
  { id: '5', name: 'Shree Krishna Palace', location: 'Pimpri Colony', rating: '4.3', key: 'venue_5_image' },
  { id: '6', name: 'Raghunandan AC Banquet', location: 'Tathawade', rating: '4.0', key: 'venue_6_image' },
  { id: '7', name: 'Rangoli Banquet Hall', location: 'Chinchwad', rating: '4.3', key: 'venue_7_image' }
];

const EVENT_TYPES = {
  '1': 'Wedding', '2': 'Birthday', '3': 'Engagement',
  '4': 'Sangeet', '5': 'Haldi', '6': 'Mehendi',
  '7': 'Anniversary', '8': 'Corporate', '9': 'Other'
};

const TIME_SLOTS = {
  '1': '10:00 AM – 11:00 AM', '2': '11:00 AM – 12:00 PM',
  '3': '12:00 PM – 01:00 PM', '4': '02:00 PM – 03:00 PM',
  '5': '03:00 PM – 04:00 PM', '6': '04:00 PM – 05:00 PM',
  '7': '05:00 PM – 06:00 PM', '8': '06:00 PM – 07:00 PM'
};

// ─────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────
function welcomeMessage(name) {
  return `👋 Welcome back, ${name}! 🎉\n\nGreat to hear from you again. Let's plan something amazing together!\n\n🌐 phoenixeventsandproduction.com\n\nHere's what we can help you with:\n\n1️⃣ 🏛️ View Venues\n2️⃣ 🎊 View Events\n3️⃣ ✨ View Services\n4️⃣ ℹ️ About Phoenix\n5️⃣ 📞 Talk to Manager\n\nReply with a number to continue! 😊`;
}

function newWelcomeMessage(name) {
  return `👋 Welcome to Phoenix Events & Production, ${name}! 🎉\n\nWe specialize in creating unforgettable events — from dream weddings to grand corporate galas.\n\n🌐 phoenixeventsandproduction.com\n\nHere's what we can help you with:\n\n1️⃣ 🏛️ View Venues\n2️⃣ 🎊 View Events\n3️⃣ ✨ View Services\n4️⃣ ℹ️ About Phoenix\n5️⃣ 📞 Talk to Manager\n\nReply with a number! 😊`;
}

const SERVICES_MSG = `✨ Our Services:\n\n1️⃣ 🎯 Event Planning & Management\n2️⃣ 🌸 Decoration & Themes\n3️⃣ 💡 Stage & Lighting\n4️⃣ 🎵 Sound & DJ\n5️⃣ 📸 Photography & Videography\n6️⃣ 🍽️ Catering\n7️⃣ 🎭 Entertainment\n8️⃣ 🏢 Corporate Branding\n9️⃣ 🎨 Custom Themes\n\nReply with a number for details, or 'menu' to go back.`;

const ABOUT_MSG = `🌟 About Phoenix Events & Production\n\nFounded in 2017 by Kevin with a vision to make every celebration extraordinary.\n\n✅ 500+ Events Completed\n✅ 12+ Years Excellence\n✅ 50+ Premium Partners\n✅ 98% Client Satisfaction\n\nIn 2024, we launched PnP Production — bringing design and production under one roof.\n\nWe've hosted celebrity events including Sonali Kulkarni and many more.\n\n🌐 phoenixeventsandproduction.com\n\nType 'menu' to explore more.`;

const VENUE_LIST_MSG = `🏛️ Our 7 Premium Partner Venues in Pimpri-Chinchwad:\n\n1️⃣ Sky Blue Banquet Hall — Punawale ⭐4.7\n2️⃣ Blue Water Banquet Hall — Punawale ⭐5.0\n3️⃣ Thopate Banquets — Rahatani\n4️⃣ RamKrishna Veg Banquet — Ravet ⭐4.4\n5️⃣ Shree Krishna Palace — Pimpri Colony ⭐4.3\n6️⃣ Raghunandan AC Banquet — Tathawade ⭐4.0\n7️⃣ Rangoli Banquet Hall — Chinchwad ⭐4.3\n\nReply with the venue number for photos & details!`;

const EVENT_LIST_MSG = `🎊 Which type of event are you planning?\n\n1️⃣ 💍 Wedding\n2️⃣ 🎂 Birthday\n3️⃣ 💑 Engagement\n4️⃣ 🎵 Sangeet\n5️⃣ 🌸 Haldi\n6️⃣ 🎨 Mehendi\n7️⃣ 💝 Anniversary\n8️⃣ 🏢 Corporate Event\n9️⃣ 🎪 Other\n\nReply with the number of your event type!`;

// ─────────────────────────────────────────────
// NORMALIZE MESSAGE
// ─────────────────────────────────────────────
function normalize(msg) {
  if (!msg) return '';
  return msg.trim().toLowerCase()
    .replace(/[।,!?]/g, '')
    .replace(/\s+/g, ' ');
}

function isGreeting(msg) {
  return ['menu', 'restart', 'hi', 'hello', 'hey', 'hii', 'helo', 'start',
    'namaste', 'hlo', 'namaskar', 'hai', 'हेलो', 'नमस्ते'].includes(msg);
}

function isValidDate(str) {
  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str);
}

function isValidGuestCount(str) {
  return /^\d+$/.test(str.trim()) && parseInt(str) > 0 && parseInt(str) < 100000;
}

// ─────────────────────────────────────────────
// STEP HANDLERS
// ─────────────────────────────────────────────
async function handleMainMenu(phone, msg, lead) {
  switch (msg) {
    case '1': // Venues
      await updateLead(phone, { step: 'selecting_venue' });
      await incrementLeadScore(phone, 1);
      await sendText(phone, VENUE_LIST_MSG);
      break;

    case '2': // Events
      await updateLead(phone, { step: 'asking_event' });
      await sendText(phone, EVENT_LIST_MSG);
      break;

    case '3': // Services
      await updateLead(phone, { step: 'asking_services' });
      await sendText(phone, SERVICES_MSG);
      break;

    case '4': // About
      await updateLead(phone, { step: 'asking_about_response' });
      await sendText(phone, ABOUT_MSG);
      break;

    case '5': // Manager
      await updateLead(phone, { step: 'asking_callback_date', status: 'manager_requested' });
      await incrementLeadScore(phone, 2);
      await sendText(phone, '📞 Great! Let\'s schedule a callback with our event specialist.\n\nWhat date works best for you? 📅\n\nPlease reply in DD/MM/YYYY format.\n\nExample: 25/03/2026');
      break;

    default:
      await sendText(phone, welcomeMessage(lead.name));
  }
}

async function handleVenueSelection(phone, msg, lead) {
  var venueNum = msg.replace(/[^0-9]/g, '');
  var venue = VENUES.find(v => v.id === venueNum);

  if (!venue) {
    await sendText(phone, '❌ Please reply with a venue number (1-7).\n\n' + VENUE_LIST_MSG);
    return;
  }

  // Send venue image from dashboard
  var imgUrl = await getMediaImage(venue.key);
  if (imgUrl) {
    await sendImage(phone, imgUrl, '🏛️ ' + venue.name);
  }

  var ratingStr = venue.rating ? ' ⭐' + venue.rating : '';
  await sendText(phone,
    '🏛️ *' + venue.name + '*' + ratingStr + '\n📍 ' + venue.location +
    '\n\nWould you like to book this venue for your event?\n\n1️⃣ Yes, I\'m interested\n2️⃣ See other venues\n3️⃣ Back to main menu'
  );
  await updateLead(phone, { step: 'venue_' + venue.id + '_booking', venue: venue.name });
}

async function handleVenueBooking(phone, msg, lead, venueNum) {
  switch (msg) {
    case '1': // Interested
      await updateLead(phone, { step: 'asking_event', venue_booked: true });
      await incrementLeadScore(phone, 2);
      await sendText(phone, '🎉 Excellent choice! Let\'s plan your perfect event.\n\n' + EVENT_LIST_MSG);
      break;
    case '2': // See other venues
      await updateLead(phone, { step: 'selecting_venue' });
      await sendText(phone, VENUE_LIST_MSG);
      break;
    case '3': // Back to menu
      await updateLead(phone, { step: 'main_menu' });
      await sendText(phone, welcomeMessage(lead.name));
      break;
    default:
      await sendText(phone, 'Please reply:\n1️⃣ Yes, I\'m interested\n2️⃣ See other venues\n3️⃣ Back to main menu');
  }
}

async function handleEventSelection(phone, msg, lead) {
  var eventType = EVENT_TYPES[msg];
  if (!eventType) {
    await sendText(phone, '❌ Please reply with a number (1-9).\n\n' + EVENT_LIST_MSG);
    return;
  }

  await updateLead(phone, { event_type: eventType, step: 'qualification' });
  await incrementLeadScore(phone, 3);

  // Send event portfolio image
  var imgKey = 'event_' + eventType.toLowerCase() + '_image';
  var imgUrl = await getMediaImage(imgKey);
  if (imgUrl) {
    await sendImage(phone, imgUrl, '✨ Our ' + eventType + ' work!');
  }

  // Check if event date already saved
  if (lead.event_date) {
    // Skip to guest count
    await sendText(phone, 'How many guests are you expecting? 👥\n\nPlease enter a number.');
    await updateLead(phone, { step: 'asking_guest_count' });
  } else {
    await sendText(phone, 'Perfect! Let\'s gather some details. 📝\n\nWhen is your event date? (DD/MM/YYYY)\n\nExample: 23/12/2026');
    await updateLead(phone, { step: 'asking_event_date' });
  }
}

async function handleEventDate(phone, msg, lead) {
  if (!isValidDate(msg)) {
    await sendText(phone, '❌ Please enter the date in DD/MM/YYYY format.\n\nExample: 25/12/2026');
    return;
  }
  await updateLead(phone, { event_date: msg, step: 'asking_guest_count' });
  await sendText(phone, 'How many guests are you expecting? 👥\n\nPlease enter a number.');
}

async function handleGuestCount(phone, msg, lead) {
  if (!isValidGuestCount(msg)) {
    await sendText(phone, '❌ Please enter a valid number of guests.\n\nExample: 150');
    return;
  }
  await updateLead(phone, {
    guest_count: parseInt(msg), step: 'completed', status: 'qualified'
  });
  await incrementLeadScore(phone, 5);

  await sendText(phone,
    '✅ Perfect!\n\nThank you for providing all the details. Our event specialist will contact you shortly with a customised proposal.\n\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '🎊 Event: ' + (lead.event_type || 'TBD') + '\n' +
    '📅 Date: ' + (lead.event_date || 'TBD') + '\n' +
    '👥 Guests: ' + msg + '\n' +
    '🏛️ Venue: ' + (lead.venue || 'TBD') + '\n' +
    '━━━━━━━━━━━━━━━━\n\n' +
    'We\'re excited to make your event unforgettable! 🎉\n\n' +
    'Type \'menu\' anytime to explore more.'
  );
}

async function handleServices(phone, msg, lead) {
  var serviceDetails = {
    '1': '🎯 *Event Planning & Management*\n\nFrom concept to execution — we handle every detail. Timelines, vendor coordination, day-of management and more. Your dream event, perfectly executed.',
    '2': '🌸 *Decoration & Themes*\n\nCustom themes, floral arrangements, backdrop setups, table decor and more. We transform any venue into a magical experience.',
    '3': '💡 *Stage & Lighting*\n\nProfessional stage design, LED walls, ambient lighting, spotlights and dynamic effects that create the perfect atmosphere.',
    '4': '🎵 *Sound & DJ*\n\nPremium sound systems, professional DJ services, live music coordination and crystal clear audio for every event.',
    '5': '📸 *Photography & Videography*\n\nProfessional photographers and videographers who capture every precious moment. Cinematic reels, candid shots and full coverage.',
    '6': '🍽️ *Catering*\n\nMulti-cuisine menus, live counters, professional service staff. Vegetarian and non-vegetarian options tailored to your taste.',
    '7': '🎭 *Entertainment*\n\nAnchors, performers, dance troupes, magicians and more. We make your event unforgettable with world-class entertainment.',
    '8': '🏢 *Corporate Branding*\n\nBranded stages, AV setups, exhibition displays, corporate gifting and professional event management for business events.',
    '9': '🎨 *Custom Themes*\n\nHave a unique vision? We bring any theme to life — from vintage to futuristic, destination-style to cultural extravaganzas.'
  };

  var detail = serviceDetails[msg];
  if (detail) {
    await sendText(phone, detail + '\n\n📞 Want to discuss this service?\n\nReply \'manager\' to talk to our specialist or \'menu\' to go back.');
    await updateLead(phone, { step: 'asking_services' });
  } else if (msg === 'menu' || msg === '0') {
    await updateLead(phone, { step: 'main_menu' });
    await sendText(phone, welcomeMessage(lead.name));
  } else {
    await sendText(phone, SERVICES_MSG);
  }
}

async function handleAboutResponse(phone, msg, lead) {
  if (msg === 'menu' || msg === '0') {
    await updateLead(phone, { step: 'main_menu' });
    await sendText(phone, welcomeMessage(lead.name));
  } else if (msg === 'manager' || msg === '5') {
    await updateLead(phone, { step: 'asking_callback_date', status: 'manager_requested' });
    await sendText(phone, '📞 Great! Let\'s schedule a callback.\n\nWhat date works best for you? 📅\n\nPlease reply in DD/MM/YYYY format.\n\nExample: 25/03/2026');
  } else {
    await updateLead(phone, { step: 'main_menu' });
    await sendText(phone, welcomeMessage(lead.name));
  }
}

async function handleCallbackDate(phone, msg, lead) {
  if (!isValidDate(msg)) {
    await sendText(phone, '❌ Please enter the date in DD/MM/YYYY format.\n\nExample: 25/03/2026');
    return;
  }
  await updateLead(phone, { callback_date: msg, step: 'asking_callback_time' });
  await sendText(phone,
    'Perfect! 📅 ' + msg + ' noted.\n\n🕐 Choose your preferred time slot:\n\n' +
    '1️⃣ 10:00 AM – 11:00 AM\n2️⃣ 11:00 AM – 12:00 PM\n3️⃣ 12:00 PM – 01:00 PM\n' +
    '4️⃣ 02:00 PM – 03:00 PM\n5️⃣ 03:00 PM – 04:00 PM\n6️⃣ 04:00 PM – 05:00 PM\n' +
    '7️⃣ 05:00 PM – 06:00 PM\n8️⃣ 06:00 PM – 07:00 PM\n\nReply with the number.'
  );
}

async function handleCallbackTime(phone, msg, lead) {
  var timeSlot = TIME_SLOTS[msg];
  if (!timeSlot) {
    await sendText(phone, '❌ Please reply with a number (1-8) to select your preferred time slot.');
    return;
  }
  await updateLead(phone, { callback_time: timeSlot, step: 'completed', status: 'callback_scheduled' });
  await sendText(phone,
    '✅ Call Scheduled Successfully!\n\n━━━━━━━━━━━━━━━━━━━━━\n' +
    '👤 Name: ' + lead.name + '\n' +
    '📅 Date: ' + (lead.callback_date || 'TBD') + '\n' +
    '🕐 Time: ' + timeSlot + '\n' +
    '📞 We\'ll call you on this number\n━━━━━━━━━━━━━━━━━━━━━\n\n' +
    'Our specialist will discuss:\n✨ Your event vision & ideas\n🏛️ Venue recommendations\n' +
    '💰 Budget & packages\n📋 Complete event planning\n\n' +
    'We\'re excited to bring your dream event to life! 🎉\n\n' +
    '🌐 phoenixeventsandproduction.com\n\nType \'menu\' to explore more while you wait.'
  );
}

// ─────────────────────────────────────────────
// FOLLOW-UP SCHEDULER (runs every hour)
// ─────────────────────────────────────────────
async function runFollowUps() {
  try {
    console.log('Running follow-up check...');
    var res = await supabase.get(
      '/rest/v1/leads?status=not.in.(qualified,converted,inactive,completed,callback_scheduled)' +
      '&follow_up_count=lt.3&select=*'
    );
    var leads = res.data || [];
    var now = new Date();
    var windows = [6, 24, 48]; // hours between follow-ups

    for (var lead of leads) {
      var lastInteraction = new Date(lead.last_interaction || lead.created_at);
      var hoursSince = (now - lastInteraction) / (1000 * 60 * 60);
      var followUpCount = lead.follow_up_count || 0;
      var requiredWindow = windows[followUpCount] || 6;

      if (hoursSince >= requiredWindow) {
        var messages = [
          'Hi ' + lead.name + '! 👋\n\nJust checking in — are you still planning an event?\n\nWe\'d love to help make it unforgettable. 🎉\n\nReply \'menu\' to continue or \'manager\' to speak with our team.',
          'Hello ' + lead.name + '! 🌟\n\nWe noticed you were exploring our services. Any questions we can answer?\n\nOur event specialists are ready to help. Reply \'help\' or \'manager\' anytime.',
          'Hi ' + lead.name + ', this is our final follow-up.\n\nIf you\'re ready to plan your event, just reply \'menu\'.\n\nWe wish you all the best! 🙏\n— Phoenix Events Team'
        ];

        await sendText(lead.phone, messages[followUpCount]);
        await supabase.patch('/rest/v1/leads?phone=eq.' + lead.phone, {
          follow_up_count: followUpCount + 1,
          last_interaction: now.toISOString()
        });

        // Deactivate after 3 follow-ups
        if (followUpCount + 1 >= 3) {
          await supabase.patch('/rest/v1/leads?phone=eq.' + lead.phone, { status: 'inactive' });
        }

        console.log('Follow-up ' + (followUpCount + 1) + ' sent to:', lead.phone);
      }
    }
  } catch (e) {
    console.error('runFollowUps error:', e.message);
  }
}

// Run follow-ups every hour
setInterval(runFollowUps, 60 * 60 * 1000);

// ─────────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────────
async function handleMessage(phone, rawMessage, name, msgId) {
  // Log inbound
  await logInbound(phone, rawMessage, msgId);

  // Get or create lead
  var lead = await getLead(phone);
  if (!lead) {
    lead = await createLead(phone, name);
    // Send welcome list
    await sendText(phone, newWelcomeMessage(name));
    await updateLead(phone, { step: 'main_menu' });
    return;
  }

  // Increment WA count
  await incrementWhatsAppCount(phone);

  var msg = normalize(rawMessage);
  var step = lead.step || 'main_menu';

  // Greetings always reset to main menu
  if (isGreeting(msg)) {
    await updateLead(phone, { step: 'main_menu' });
    await sendText(phone, welcomeMessage(lead.name || name));
    return;
  }

  // Manager shortcut from anywhere
  if (msg === 'manager' || msg === 'call' || msg === 'help') {
    await updateLead(phone, { step: 'asking_callback_date', status: 'manager_requested' });
    await incrementLeadScore(phone, 2);
    await sendText(phone, '📞 Sure! Let\'s schedule a callback with our specialist.\n\nWhat date works best for you? 📅\n\nPlease reply in DD/MM/YYYY format.\n\nExample: 25/03/2026');
    return;
  }

  console.log('Step:', step, '| Msg:', msg, '| Phone:', phone);

  // Route by step
  if (step === 'main_menu') {
    await handleMainMenu(phone, msg, lead);
  } else if (step === 'selecting_venue') {
    await handleVenueSelection(phone, msg, lead);
  } else if (step.startsWith('venue_') && step.endsWith('_booking')) {
    var venueNum = step.replace('venue_', '').replace('_booking', '');
    await handleVenueBooking(phone, msg, lead, venueNum);
  } else if (step === 'asking_event') {
    await handleEventSelection(phone, msg, lead);
  } else if (step === 'asking_event_date') {
    await handleEventDate(phone, msg, lead);
  } else if (step === 'asking_guest_count' || step === 'qualification') {
    await handleGuestCount(phone, msg, lead);
  } else if (step === 'asking_services') {
    await handleServices(phone, msg, lead);
  } else if (step === 'asking_about_response') {
    await handleAboutResponse(phone, msg, lead);
  } else if (step === 'asking_callback_date') {
    await handleCallbackDate(phone, msg, lead);
  } else if (step === 'asking_callback_time') {
    await handleCallbackTime(phone, msg, lead);
  } else if (step === 'completed' || step === 'callback_scheduled') {
    // Already completed — treat as menu
    await updateLead(phone, { step: 'main_menu' });
    await sendText(phone, welcomeMessage(lead.name || name));
  } else {
    // Unknown step — reset to main menu
    await updateLead(phone, { step: 'main_menu' });
    await sendText(phone, welcomeMessage(lead.name || name));
  }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Webhook verification
app.get('/whatsapp', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook receiver
app.post('/whatsapp', async function(req, res) {
  try {
    var body = req.body;

    // Always respond 200 immediately to Meta
    res.sendStatus(200);

    // Check it's a WhatsApp message
    if (!body.object || body.object !== 'whatsapp_business_account') return;

    var entry = body.entry && body.entry[0];
    var changes = entry && entry.changes && entry.changes[0];
    var value = changes && changes.value;
    var messages = value && value.messages;

    if (!messages || !messages[0]) return;

    var msg = messages[0];

    // Only handle text and interactive messages, ignore status updates
    if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') return;

    var msgId = msg.id;
    if (isDuplicate(msgId)) {
      console.log('Duplicate message ignored:', msgId);
      return;
    }

    var phone = msg.from;
    var contacts = value.contacts || [];
    var name = (contacts[0] && contacts[0].profile && contacts[0].profile.name) || 'Friend';

    // Extract message text — handle text, interactive list reply, button reply
    var messageText =
      (msg.text && msg.text.body) ||
      (msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.id) ||
      (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.id) ||
      (msg.button && msg.button.text) || '';

    if (!messageText) return;

    console.log('Incoming | Phone:', phone, '| Name:', name, '| Msg:', messageText);

    // Handle asynchronously so Meta doesn't timeout
    handleMessage(phone, messageText, name, msgId).catch(function(e) {
      console.error('handleMessage error:', e.message);
    });

  } catch (e) {
    console.error('Webhook error:', e.message);
  }
});

app.get('/', function(req, res) {
  res.json({ status: 'Phoenix WhatsApp Agent VERSION 1', timestamp: new Date().toISOString() });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Phoenix WhatsApp Agent running on port ' + PORT);
});
