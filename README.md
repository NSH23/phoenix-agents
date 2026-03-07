# Phoenix Events Webhook Server

Handles Bolna voice agent tool calls → saves to Supabase → sends WhatsApp.

## Deploy to Railway (Free)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Add environment variable: WA_TOKEN = your WhatsApp token
5. Railway gives you a URL like: https://phoenix-webhook.up.railway.app

## Update Bolna Tools

In both tools (save_lead_data and get_venue_list), update the URL to:
https://your-railway-url/phoenix-bolna-agent

## Environment Variables

WA_TOKEN = your WhatsApp permanent token from Meta developer console

## Test

Visit https://your-railway-url/ — should show:
{"status": "Phoenix Events Webhook Server is running! 🚀"}
