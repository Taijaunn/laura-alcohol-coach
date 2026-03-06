# Laura — AI Alcohol Reduction Coach

A full-stack AI coaching app that helps people reduce or eliminate alcohol, powered by Claude and delivered entirely via iMessage/SMS through Blooio. No frontend UI — all interaction happens through text messaging.

## Stack

- **Backend:** Node.js + Express
- **Messaging:** Blooio API v2 (iMessage/SMS)
- **AI:** Anthropic Claude (claude-sonnet-4-20250514)
- **Database:** Supabase (Postgres)
- **Scheduler:** node-cron (proactive check-ins)

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd laura-alcohol-coach
npm install
```

### 2. Create `.env`

Copy the example and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `BLOOIO_API_KEY` | Your Blooio API key |
| `BLOOIO_WEBHOOK_SECRET` | Webhook signing secret from Blooio |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (not anon key) |
| `PORT` | Server port (default: 3000) |

### 3. Create Supabase tables

Run this SQL in your Supabase SQL Editor:

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  preferred_drink TEXT,
  triggers TEXT,
  goal TEXT,
  danger_time TEXT,
  check_in_time TEXT,
  onboarding_complete BOOLEAN DEFAULT FALSE,
  last_checkin_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages table
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast message lookups
CREATE INDEX idx_messages_user_phone ON messages (user_phone, created_at);

-- Index for check-in cron queries
CREATE INDEX idx_users_checkin ON users (check_in_time, onboarding_complete);
```

### 4. Register Blooio webhook

Once your server is deployed and accessible at a public URL, register the webhook:

```bash
curl -X POST https://backend.blooio.com/v2/api/webhooks \
  -H "Authorization: Bearer YOUR_BLOOIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-deployed-url.com/webhook/blooio",
    "events": ["message.received"]
  }'
```

### 5. Run locally

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Deploy

### Railway

1. Connect your GitHub repo to Railway
2. Set all environment variables in the Railway dashboard
3. Railway auto-detects `npm start` from package.json
4. Use the generated Railway URL to register your Blooio webhook

### Render

1. Create a new Web Service on Render
2. Connect your repo, set build command to `npm install` and start command to `npm start`
3. Add all environment variables
4. Use the generated Render URL to register your Blooio webhook

## How it works

1. **New user texts in** — Laura introduces herself and walks them through onboarding (name, drink of choice, triggers, goal, hardest time of day)
2. **After onboarding** — Laura becomes a free-form AI coach, using their profile to personalize every response
3. **Proactive check-ins** — A cron job runs every minute and sends a warm check-in message 30 minutes before each user's hardest time of day
4. **Conversation history** — The last 20 messages are included in every Claude API call for context continuity

## Project structure

```
├── server.js          # Express server, webhook route, onboarding, cron
├── lib/
│   ├── supabase.js    # Database helpers (users + messages)
│   ├── blooio.js      # Blooio API (send messages, verify webhooks)
│   └── claude.js      # Claude API (generate responses + check-ins)
├── package.json
├── .env.example
└── README.md
```
