const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname)));

console.log('🚀 Starting Phoenix WhatsApp Agent...');

const SUPABASE_URL = 'https://sainjerowmjetpmtezwg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'phoenix_verify_2024';
const GROQ_KEY = process.env.GROQ_API_KEY;

// Environment variable checks
console.log('✅ SUPABASE_KEY:', SUPABASE_KEY ? 'Loaded' : 'Missing');
console.log('✅ WA_TOKEN:', WA_TOKEN ? 'Loaded' : 'Missing');
console.log('✅ WA_PHONE_ID:', WA_PHONE_ID ? 'Loaded' : 'Missing');
console.log('✅ VERIFY_TOKEN:', VERIFY_TOKEN ? 'Loaded' : 'Missing');
console.log('✅ GROQ_KEY:', GROQ_KEY ? 'Loaded' : 'Missing');

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

  if (processedMessages.has(msgId)) {
    return true;
  }

  processedMessages.add(msgId);

  if (processedMessages.size > 1000) {
    processedMessages.delete(
      processedMessages.values().next().value
    );
  }

  return false;
}

function sleep(ms) {
  return new Promise(function(r) {
    setTimeout(r, ms);
  });
}

function splitMessage(text) {
  if (!text || text.length <= 4000) {
    return [text || ''];
  }

  var chunks = [];
  var t = text;

  while (t.length > 0) {
    var c = t.substring(0, 4000);
    chunks.push(c.trim());
    t = t.substring(c.length).trim();
  }

  return chunks;
}

/* =========================================================
   PRIVACY POLICY ROUTE
========================================================= */

app.get('/privacy-policy', function(req, res) {
  res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

/* =========================================================
   HEALTH CHECK ROUTES
========================================================= */

app.get('/', function(req, res) {
  res.json({
    status: 'Phoenix WhatsApp AI Agent LIVE',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', function(req, res) {
  res.status(200).json({
    success: true,
    service: 'running',
    timestamp: new Date().toISOString()
  });
});

/* =========================================================
   WHATSAPP WEBHOOK VERIFICATION
========================================================= */

app.get('/whatsapp', function(req, res) {

  console.log('📩 Webhook verification request received');

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Mode:', mode);
  console.log('Token:', token);

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {

    console.log('✅ WEBHOOK VERIFIED SUCCESSFULLY');

    return res.status(200).send(challenge);
  }

  console.log('❌ WEBHOOK VERIFICATION FAILED');

  return res.sendStatus(403);
});

/* =========================================================
   WHATSAPP MESSAGE WEBHOOK
========================================================= */

app.post('/whatsapp', async function(req, res) {

  try {

    console.log('📨 Incoming webhook event');

    const body = req.body;

    // Always acknowledge Meta immediately
    res.sendStatus(200);

    console.log(
      JSON.stringify(body, null, 2)
    );

    if (
      !body.object ||
      body.object !== 'whatsapp_business_account'
    ) {
      console.log('❌ Not a WhatsApp business webhook');
      return;
    }

    const entry =
      body.entry &&
      body.entry[0];

    const changes =
      entry &&
      entry.changes &&
      entry.changes[0];

    const value =
      changes &&
      changes.value;

    const messages =
      value &&
      value.messages;

    if (!messages || !messages[0]) {
      console.log('⚠️ No messages found');
      return;
    }

    const msg = messages[0];

    if (
      msg.type !== 'text' &&
      msg.type !== 'interactive' &&
      msg.type !== 'button'
    ) {
      console.log('⚠️ Unsupported message type:', msg.type);
      return;
    }

    const msgId = msg.id;

    if (isDuplicate(msgId)) {
      console.log('⚠️ Duplicate message skipped');
      return;
    }

    const phone = msg.from;

    const contacts = value.contacts || [];

    const name =
      (contacts[0] &&
      contacts[0].profile &&
      contacts[0].profile.name) ||
      'Friend';

    const messageText =
      (msg.text && msg.text.body) ||
      (msg.interactive &&
        msg.interactive.list_reply &&
        msg.interactive.list_reply.title) ||
      (msg.interactive &&
        msg.interactive.button_reply &&
        msg.interactive.button_reply.title) ||
      (msg.button &&
        msg.button.text) ||
      '';

    if (!messageText.trim()) {
      console.log('⚠️ Empty message');
      return;
    }

    console.log('================================');
    console.log('📱 Phone:', phone);
    console.log('👤 Name:', name);
    console.log('💬 Message:', messageText);
    console.log('================================');

    handleMessage(
      phone,
      messageText,
      name,
      msgId
    ).catch(function(e) {

      console.error(
        '❌ handleMessage error:',
        e.message
      );

    });

  } catch (e) {

    console.error(
      '❌ Webhook error:',
      e.message
    );

  }
});

/* =========================================================
   KEEP YOUR EXISTING FUNCTIONS BELOW
   (sendText, sendImage, callGroq, handleMessage etc.)
========================================================= */

/* =========================================================
   SERVER START
========================================================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, function() {

  console.log('================================');
  console.log('🚀 Phoenix WhatsApp Agent Running');
  console.log('🌐 Port:', PORT);
  console.log(
    '🔗 URL: https://phoenix-whatsapp-agent-production.up.railway.app'
  );
  console.log('================================');

});
