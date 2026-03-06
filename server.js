require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const db = require("./lib/supabase");
const blooio = require("./lib/blooio");
const claude = require("./lib/claude");

const app = express();

// ── Capture raw body for HMAC verification, then parse JSON ──
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ── Health check ──────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", app: "Laura — Alcohol Coach" });
});

// ── Blooio inbound webhook ───────────────────────────────────
app.post("/webhook/blooio", async (req, res) => {
  try {
    // 1. Verify signature (skip if secret not configured or verification fails during debug)
    const signature = req.headers["x-blooio-signature"];
    if (process.env.BLOOIO_WEBHOOK_SECRET && signature) {
      if (!blooio.verifySignature(req.rawBody, signature)) {
        console.warn("Webhook signature verification failed — check BLOOIO_WEBHOOK_SECRET");
      }
    }

    // 2. Extract phone + text (Blooio uses external_id/sender for phone)
    const phone = req.body.external_id || req.body.sender;
    const text = (req.body.text || "").trim();

    if (!phone) {
      return res.status(400).json({ error: "Missing phone number" });
    }

    // Respond 200 immediately so Blooio doesn't retry
    res.status(200).json({ received: true });

    // 3. Ignore blank messages
    if (!text) return;

    // 4. Route: onboarding or conversation
    let user = await db.getUser(phone);

    if (!user) {
      // Brand-new user
      user = await db.createUser(phone);
      await db.saveMessage(phone, "user", text);
      const greeting =
        "Hey! I'm Laura \u{1F44B} I'm so glad you're here. I'm your " +
        "personal alcohol reduction coach and I'm here to support " +
        "you every step of the way. What's your name?";
      await blooio.sendMessage(phone, greeting);
      await db.saveMessage(phone, "assistant", greeting);
      return;
    }

    if (!user.onboarding_complete) {
      await handleOnboarding(user, phone, text);
    } else {
      await handleConversation(user, phone, text);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    // Already sent 200, so we just log
  }
});

// ── Onboarding flow ──────────────────────────────────────────
// We infer the current step from which profile fields are filled.

async function handleOnboarding(user, phone, text) {
  await db.saveMessage(phone, "user", text);

  let reply;

  if (!user.name) {
    // Step 1: they just told us their name
    await db.updateUser(phone, { name: text });
    reply =
      `Nice to meet you, ${text}! \u{1F60A} So I can help you better — ` +
      `what's your drink of choice?`;
  } else if (!user.preferred_drink) {
    // Step 2: drink of choice
    await db.updateUser(phone, { preferred_drink: text });
    reply =
      "Got it. Now, what usually triggers your urge to drink? " +
      "(For example: work stress, social situations, boredom, emotions, etc.)";
  } else if (!user.triggers) {
    // Step 3: triggers
    await db.updateUser(phone, { triggers: text });
    reply =
      "Thank you for being honest about that. " +
      "What's your goal? (Cut back, stop completely, only weekends, etc.)";
  } else if (!user.goal) {
    // Step 4: goal
    await db.updateUser(phone, { goal: text });
    reply =
      "Love that. Last question — is there a specific time of day " +
      "you find hardest to resist drinking?";
  } else if (!user.danger_time) {
    // Step 5: danger time → finalize onboarding
    const checkInTime = calculateCheckInTime(text);
    await db.updateUser(phone, {
      danger_time: text,
      check_in_time: checkInTime,
      onboarding_complete: true,
    });
    reply =
      `Thank you for sharing that with me, ${user.name}. I already ` +
      "know we're going to make real progress together. I'll check " +
      "in with you \u2014 and I'm always here if you need me. " +
      "Just message me anytime \u{1F499}";
  } else {
    // All fields filled but onboarding_complete somehow false — fix it
    await db.updateUser(phone, { onboarding_complete: true });
    reply =
      `Welcome back, ${user.name}! You're all set. ` +
      "Message me anytime you need support \u{1F499}";
  }

  await blooio.sendMessage(phone, reply);
  await db.saveMessage(phone, "assistant", reply);
}

// ── Ongoing conversation ─────────────────────────────────────

async function handleConversation(user, phone, text) {
  // Save inbound message
  await db.saveMessage(phone, "user", text);

  // Pull recent history
  const history = await db.getRecentMessages(phone, 20);

  // Generate Laura's response
  const reply = await claude.generateResponse(user, history);

  // Send and persist
  await blooio.sendMessage(phone, reply);
  await db.saveMessage(phone, "assistant", reply);
}

// ── Proactive check-in cron (every minute) ───────────────────

cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const currentHHMM =
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0");
    const today = now.toISOString().split("T")[0]; // YYYY-MM-DD

    const users = await db.getUsersDueForCheckin(currentHHMM, today);

    for (const user of users) {
      try {
        const recentMessages = await db.getRecentMessages(user.phone, 5);
        const checkinText = await claude.generateCheckin(user, recentMessages);

        await blooio.sendMessage(user.phone, checkinText);
        await db.saveMessage(user.phone, "assistant", checkinText);
        await db.markCheckinDone(user.phone, today);

        console.log(`Check-in sent to ${user.phone} at ${currentHHMM}`);
      } catch (err) {
        console.error(`Check-in failed for ${user.phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Cron error:", err.message);
  }
});

// ── Helpers ──────────────────────────────────────────────────

/**
 * Parse a free-text time like "6pm", "evening", "after work",
 * "9:00 PM" into HH:MM format, then subtract 30 minutes to
 * get the check-in time.
 */
function calculateCheckInTime(dangerTimeText) {
  const input = dangerTimeText.toLowerCase().trim();

  // Map common words to hour values
  const wordMap = {
    morning: 8,
    noon: 12,
    afternoon: 14,
    "after work": 17,
    evening: 18,
    night: 20,
    "late night": 22,
    midnight: 0,
  };

  let hours = null;
  let minutes = 0;

  // Check word map first
  for (const [word, h] of Object.entries(wordMap)) {
    if (input.includes(word)) {
      hours = h;
      break;
    }
  }

  // Try to parse numeric times: "6pm", "6:30 pm", "18:00", "6 PM"
  if (hours === null) {
    const match = input.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (match) {
      hours = parseInt(match[1], 10);
      minutes = match[2] ? parseInt(match[2], 10) : 0;
      const meridiem = match[3]?.toLowerCase();
      if (meridiem === "pm" && hours < 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
    }
  }

  // Default to 18:00 (6 PM) if we can't parse
  if (hours === null) {
    hours = 18;
  }

  // Subtract 30 minutes for check-in time
  let totalMinutes = hours * 60 + minutes - 30;
  if (totalMinutes < 0) totalMinutes += 24 * 60;

  const checkHour = Math.floor(totalMinutes / 60) % 24;
  const checkMin = totalMinutes % 60;

  return (
    String(checkHour).padStart(2, "0") +
    ":" +
    String(checkMin).padStart(2, "0")
  );
}

// ── Start server ────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Laura is running on port ${PORT}`);
});
