const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────
const SUPABASE_URL = 'https://fhhwfqlbgmsscmqihjyz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZoaHdmcWxiZ21zc2NtcWloanl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MzgwNTksImV4cCI6MjA4NzAxNDA1OX0.T1n19S4_D7eNX4bz9AovBXwKrwOjGxvrzFGpO4nNxJ4';
const WA_TOKEN   = process.env.WA_TOKEN;   // set in Railway env vars
const WA_PHONE_ID = '1023140200877702';

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

// ─── HELPERS ──────────────────────────────────────────────

async function sendWhatsApp(phone, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message }
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    console.log(`✅ WhatsApp sent to ${phone}`);
  } catch (err) {
    console.error('❌ WhatsApp error:', err.response?.data || err.message);
  }
}

async function sendWhatsAppImage(phone, imageUrl, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'image',
        image: { link: imageUrl, caption }
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    console.log(`✅ WhatsApp image sent to ${phone}`);
  } catch (err) {
    console.error('❌ WhatsApp image error:', err.response?.data || err.message);
  }
}

async function getEventImage(eventType) {
  try {
    const key = `event_${eventType.toLowerCase().replace(/ /g, '_')}_image`;
    const res = await supabase.get(
      `/rest/v1/workflow_content?content_key=eq.${key}&select=text_content&is_active=eq.true`
    );
    return res.data?.[0]?.text_content || null;
  } catch {
    return null;
  }
}

async function saveVoiceCall(data) {
  try {
    await supabase.post('/rest/v1/voice_calls', {
      phone: data.phone,
      name: data.name,
      call_type: 'inbound',
      call_status: 'completed',
      gathered_event_type: data.event_type,
      gathered_venue: data.venue_name,
      gathered_guest_count: data.guest_count,
      gathered_event_date: data.event_date,
      whatsapp_sent: false
    });
    console.log(`✅ Voice call saved for ${data.phone}`);
  } catch (err) {
    console.error('❌ Supabase voice_call error:', err.response?.data || err.message);
  }
}

async function updateLead(phone, eventType) {
  try {
    await supabase.patch(
      `/rest/v1/leads?phone=eq.${phone}`,
      {
        event_type: eventType,
        voice_qualified: true,
        last_call_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    );
    console.log(`✅ Lead updated for ${phone}`);
  } catch (err) {
    console.error('❌ Lead update error:', err.response?.data || err.message);
  }
}

async function markWhatsAppSent(phone) {
  try {
    await supabase.patch(
      `/rest/v1/voice_calls?phone=eq.${phone}&whatsapp_sent=eq.false`,
      { whatsapp_sent: true, updated_at: new Date().toISOString() }
    );
  } catch {}
}

// ─── WHATSAPP FLOW ────────────────────────────────────────

async function handleWhatsAppFlow(data) {
  const { phone, name, event_type, venue_booked, venue_name, guest_count, event_date } = data;

  // 1. Save to Supabase
  await saveVoiceCall(data);
  await updateLead(phone, event_type);

  // 2. Send venue message
  if (venue_booked === true || venue_booked === 'true') {
    await sendWhatsApp(phone,
      `🎉 ${name} ji!\n\nPhoenix Events mein aapka swagat hai!\n\n` +
      `🎊 Event: ${event_type}\n🏛️ Venue: ${venue_name || 'Aapka selected venue'}\n\n` +
      `Hum abhi aapke venue ke liye hamare kaam ki images bhej rahe hain! ✨\n\n` +
      `Hamara specialist 5 ghante mein contact karega.\n🌐 phoenixeventsandproduction.com`
    );
  } else {
    await sendWhatsApp(phone,
      `🏛️ ${name} ji!\n\nPhoenix Events ke saath aapki baat achi lagi! 😊\n\n` +
      `Hamare 7 premium partner venues Pimpri-Chinchwad mein:\n\n` +
      `1️⃣ Sky Blue Banquet Hall — Ravet ⭐4.7\n` +
      `2️⃣ Thopate Banquets — Rahatani\n` +
      `3️⃣ Blue Water Banquet Hall — Punawale ⭐5.0\n` +
      `4️⃣ RamKrishna Veg Banquet — Ravet ⭐4.4\n` +
      `5️⃣ Shree Krishna Palace — Pimpri ⭐4.3\n` +
      `6️⃣ Raghunandan AC Banquet — Tathawade ⭐4.0\n` +
      `7️⃣ Rangoli Banquet Hall — Chinchwad ⭐4.3\n\n` +
      `Inme se koi pasand aaye toh batao! 🎊\n\n🌐 phoenixeventsandproduction.com`
    );
  }

  // 3. Send event portfolio image if available
  if (event_type) {
    const imageUrl = await getEventImage(event_type);
    if (imageUrl) {
      await sendWhatsAppImage(
        phone,
        imageUrl,
        `✨ ${event_type} ke liye hamare kaam ki jhalak! Aisa hi banayenge hum aapka event! 🎉`
      );
    }
  }

  // 4. Send final summary message
  await sendWhatsApp(phone,
    `✨ ${name} ji, Phoenix Events mein aapka swagat hai!\n\n` +
    `Aapki details:\n` +
    `🎊 Event: ${event_type || 'TBD'}\n` +
    `👥 Guests: ${guest_count || 'TBD'}\n` +
    `📅 Date: ${event_date || 'TBD'}\n\n` +
    `Hamara specialist 5 ghante mein aapko call karega ek customised proposal ke saath! 🎉\n\n` +
    `🌐 phoenixeventsandproduction.com\n\n` +
    `'menu' type karein aur hamare services dekhein!`
  );

  // 5. Mark WhatsApp sent
  await markWhatsAppSent(phone);
}

// ─── ROUTES ───────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Phoenix Events Webhook Server is running! 🚀' });
});

// Main Bolna webhook
app.post('/phoenix-bolna-agent', async (req, res) => {
  console.log('\n📞 Webhook received:', JSON.stringify(req.body, null, 2));

  const body = req.body;

  // ── Tool call: save_lead_data ──
  if (body.tool_call?.name === 'save_lead_data' || 
      body.name === 'save_lead_data' ||
      body.function?.name === 'save_lead_data') {

    // Extract arguments from different possible formats
    const args = body.tool_call?.arguments || 
                 body.arguments || 
                 body.function?.arguments || 
                 body.data || 
                 body;

    const phone = (body.call?.customer?.number || body.from_number || '').replace('+', '');

    const data = {
      phone,
      name:         args.name        || 'Guest',
      event_type:   args.event_type  || '',
      venue_booked: args.venue_booked || false,
      venue_name:   args.venue_name  || '',
      guest_count:  args.guest_count || '',
      event_date:   args.event_date  || ''
    };

    console.log('📋 Lead data extracted:', data);

    // Respond immediately so Bolna doesn't timeout
    res.json({ result: 'Lead saved. Sending WhatsApp now!' });

    // Then process async
    handleWhatsAppFlow(data).catch(console.error);
    return;
  }

  // ── Tool call: get_venue_list ──
  if (body.tool_call?.name === 'get_venue_list' || 
      body.name === 'get_venue_list' ||
      body.function?.name === 'get_venue_list') {

    return res.json({
      result: 'Sky Blue Banquet Hall (Ravet ⭐4.7), Thopate Banquets (Rahatani), Blue Water Banquet Hall (Punawale ⭐5.0), RamKrishna Veg Banquet (Ravet ⭐4.4), Shree Krishna Palace (Pimpri ⭐4.3), Raghunandan AC Banquet (Tathawade ⭐4.0), Rangoli Banquet Hall (Chinchwad ⭐4.3) - all in Pimpri-Chinchwad Pune.'
    });
  }

  // ── Unknown event — log and respond ──
  console.log('⚠️ Unknown webhook event type. Raw body logged above.');
  res.json({ status: 'received' });
});

// ─── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Phoenix Webhook Server running on port ${PORT}`);
});
