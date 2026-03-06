require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const db = require("./lib/supabase");
const blooio = require("./lib/blooio");
const claude = require("./lib/claude");

const app = express();

// ── Fallback message for errors ──────────────────────────────
const FALLBACK_MSG =
  "Hey, I'm having a little trouble right now. Can you try sending that again in a moment? \u{1F499}";

// ── Timezone word map ────────────────────────────────────────
const tzMap = {
  eastern: "America/New_York",
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  central: "America/Chicago",
  ct: "America/Chicago",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  mountain: "America/Denver",
  mt: "America/Denver",
  mst: "America/Denver",
  mdt: "America/Denver",
  pacific: "America/Los_Angeles",
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  hawaii: "Pacific/Honolulu",
  alaska: "America/Anchorage",
};

// ── Onboarding questions (used for validation) ───────────────
const onboardingQuestions = {
  name: "What's your name?",
  preferred_drink: "What's your drink of choice?",
  triggers:
    "What usually triggers your urge to drink? (For example: work stress, social situations, boredom, emotions, etc.)",
  goal: "What's your goal? (Cut back, stop completely, only weekends, etc.)",
  danger_time:
    "Is there a specific time of day you find hardest to resist drinking?",
  timezone:
    "What timezone are you in? (e.g., Eastern, Central, Mountain, Pacific)",
};

// ── Capture raw body for HMAC verification, then parse JSON ──
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ── Per-phone processing lock to prevent duplicate replies ───
const processing = new Set();

// ── Health check ──────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", app: "Laura \u2014 Alcohol Coach" });
});

// ── Blooio inbound webhook ───────────────────────────────────
app.post("/webhook/blooio", async (req, res) => {
  try {
    // 1. Verify signature
    const signature = req.headers["x-blooio-signature"];
    if (process.env.BLOOIO_WEBHOOK_SECRET && signature) {
      if (!blooio.verifySignature(req.rawBody, signature)) {
        console.warn(
          "Webhook signature verification failed \u2014 check BLOOIO_WEBHOOK_SECRET"
        );
      }
    }

    // 2. Only process inbound messages
    if (req.body.event !== "message.received") {
      return res.status(200).json({ ignored: true });
    }

    // 3. Ignore messages sent by the Blooio device itself
    if (req.body.sender === req.body.internal_id) {
      return res.status(200).json({ ignored: true });
    }

    // 4. Extract phone + text
    const phone = req.body.external_id || req.body.sender;
    const text = (req.body.text || "").trim();

    if (!phone) {
      return res.status(400).json({ error: "Missing phone number" });
    }

    // Respond 200 immediately so Blooio doesn't retry
    res.status(200).json({ received: true });

    // 5. Ignore blank messages
    if (!text) return;

    // 6. Prevent duplicate processing
    if (processing.has(phone)) {
      console.log(`Already processing a message for ${phone}, skipping`);
      return;
    }
    processing.add(phone);

    try {
      // 7. Get or create user
      let user = await db.getUser(phone);

      // 8. Check for reset command
      if (text.toLowerCase() === "reset") {
        await db.deleteUserMessages(phone);
        if (user) await db.deleteUser(phone);
        user = await db.createUser(phone);
        const greeting =
          "Hey! I'm Laura \u{1F44B} I'm so glad you're here. I'm your " +
          "personal alcohol reduction coach and I'm here to support " +
          "you every step of the way. What's your name?";
        await blooio.sendMessage(phone, greeting);
        await db.saveMessage(phone, "assistant", greeting);
        return;
      }

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
    } finally {
      processing.delete(phone);
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ── Onboarding flow ──────────────────────────────────────────

async function handleOnboarding(user, phone, text) {
  try {
    await db.saveMessage(phone, "user", text);

    let reply;

    if (!user.name) {
      // Step 1: name
      const valid = await claude.isValidOnboardingAnswer(
        onboardingQuestions.name,
        text
      );
      if (!valid) {
        reply =
          "No worries! I'd love to get to know you. What's your first name?";
      } else {
        const name = await claude.extractName(text);
        await db.updateUser(phone, { name });
        reply =
          `Nice to meet you, ${name}! \u{1F60A} So I can help you better \u2014 ` +
          "what's your drink of choice?";
      }
    } else if (!user.preferred_drink) {
      // Step 2: drink of choice
      const valid = await claude.isValidOnboardingAnswer(
        onboardingQuestions.preferred_drink,
        text
      );
      if (!valid) {
        reply =
          "I want to make sure I understand you \u2014 what's your drink of choice? " +
          "(Beer, wine, spirits, cocktails, etc.)";
      } else {
        await db.updateUser(phone, { preferred_drink: text });
        reply =
          "Got it. Now, what usually triggers your urge to drink? " +
          "(For example: work stress, social situations, boredom, emotions, etc.)";
      }
    } else if (!user.triggers) {
      // Step 3: triggers
      const valid = await claude.isValidOnboardingAnswer(
        onboardingQuestions.triggers,
        text
      );
      if (!valid) {
        reply =
          "I hear you! But I'd love to understand \u2014 what usually triggers " +
          "your urge to drink? (Stress, social situations, boredom, etc.)";
      } else {
        await db.updateUser(phone, { triggers: text });
        reply =
          "Thank you for being honest about that. " +
          "What's your goal? (Cut back, stop completely, only weekends, etc.)";
      }
    } else if (!user.goal) {
      // Step 4: goal
      const valid = await claude.isValidOnboardingAnswer(
        onboardingQuestions.goal,
        text
      );
      if (!valid) {
        reply =
          "I want to help you get where you want to be \u2014 what's your goal " +
          "with drinking? (Cut back, stop completely, only weekends, etc.)";
      } else {
        await db.updateUser(phone, { goal: text });
        reply =
          "Love that. What time of day do you find hardest to resist drinking?";
      }
    } else if (!user.danger_time) {
      // Step 5: danger time
      const valid = await claude.isValidOnboardingAnswer(
        onboardingQuestions.danger_time,
        text
      );
      if (!valid) {
        reply =
          "No problem! Is there a specific time of day when the urge to drink " +
          "hits hardest? (Evening, after work, late night, etc.)";
      } else {
        await db.updateUser(phone, { danger_time: text });
        reply =
          "One more thing \u2014 what timezone are you in? " +
          "(e.g., Eastern, Central, Mountain, Pacific)";
      }
    } else if (!user.timezone) {
      // Step 6: timezone → finalize onboarding
      const input = text.toLowerCase().trim();
      const tz = tzMap[input];
      if (!tz) {
        reply =
          "I didn't quite catch that. Could you tell me your timezone? " +
          "(Eastern, Central, Mountain, or Pacific)";
      } else {
        const checkInTime = calculateCheckInTime(user.danger_time);
        await db.updateUser(phone, {
          timezone: tz,
          check_in_time: checkInTime,
          onboarding_complete: true,
        });
        reply =
          `Thank you for sharing all of that with me, ${user.name}. I already ` +
          "know we're going to make real progress together. I'll check " +
          "in with you \u2014 and I'm always here if you need me. " +
          "Just message me anytime \u{1F499}";
      }
    } else {
      // All fields filled but onboarding_complete somehow false
      await db.updateUser(phone, { onboarding_complete: true });
      reply =
        `Welcome back, ${user.name}! You're all set. ` +
        "Message me anytime you need support \u{1F499}";
    }

    await blooio.sendMessage(phone, reply);
    await db.saveMessage(phone, "assistant", reply);
  } catch (err) {
    console.error("Onboarding error:", err);
    try {
      await blooio.sendMessage(phone, FALLBACK_MSG);
    } catch (sendErr) {
      console.error("Failed to send fallback message:", sendErr);
    }
  }
}

// ── Ongoing conversation ─────────────────────────────────────

async function handleConversation(user, phone, text) {
  try {
    // Save inbound message
    await db.saveMessage(phone, "user", text);

    // Pull recent history
    const history = await db.getRecentMessages(phone, 20);

    // Generate Laura's response
    const reply = await claude.generateResponse(user, history);

    // Send and persist
    await blooio.sendMessage(phone, reply);
    await db.saveMessage(phone, "assistant", reply);
  } catch (err) {
    console.error("Conversation error:", err);
    try {
      await blooio.sendMessage(phone, FALLBACK_MSG);
    } catch (sendErr) {
      console.error("Failed to send fallback message:", sendErr);
    }
  }
}

// ── Proactive check-in cron (every minute) ───────────────────

cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const today = now.toISOString().split("T")[0]; // YYYY-MM-DD

    const users = await db.getUsersDueForCheckin(today);

    for (const user of users) {
      try {
        // Convert current UTC time to user's local timezone
        const userTz = user.timezone || "America/New_York";
        const localTime = now.toLocaleTimeString("en-US", {
          timeZone: userTz,
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });
        // localTime is "HH:MM"

        if (localTime !== user.check_in_time) continue;

        const recentMessages = await db.getRecentMessages(user.phone, 5);
        const checkinText = await claude.generateCheckin(user, recentMessages);

        await blooio.sendMessage(user.phone, checkinText);
        await db.saveMessage(user.phone, "assistant", checkinText);
        await db.markCheckinDone(user.phone, today);

        console.log(
          `Check-in sent to ${user.phone} at ${localTime} (${userTz})`
        );
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
