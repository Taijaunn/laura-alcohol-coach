const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

const MODEL = "claude-sonnet-4-20250514";

/**
 * Build Laura's system prompt with user profile context.
 */
function buildSystemPrompt(user) {
  return `You are Laura, a warm, empathetic, and direct AI alcohol reduction coach. You are NOT a therapist and do not provide medical advice. You help people reduce or eliminate alcohol through accountability, motivation, reframing, and practical strategies.

You are messaging with ${user.name}. Here is what you know:
- Preferred drink: ${user.preferred_drink}
- Main triggers: ${user.triggers}
- Their goal: ${user.goal}
- Their hardest time of day: ${user.danger_time}

Keep responses conversational and mobile-friendly (under 300 characters when possible, never more than 2-3 short paragraphs). Use their name occasionally. Be encouraging but honest. Never lecture. If they express a craving right now, respond with urgency and a specific coping strategy. If they mention self-harm or crisis, gently refer them to a professional.`;
}

/**
 * Generate a conversational response from Laura.
 * @param {object} user        – user row from Supabase
 * @param {Array}  messages    – recent {role, content} pairs
 * @returns {string} Laura's reply text
 */
async function generateResponse(user, messages) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(user),
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  return response.content[0].text;
}

/**
 * Generate a proactive check-in message from Laura.
 */
async function generateCheckin(user, recentMessages) {
  const systemPrompt =
    buildSystemPrompt(user) +
    "\n\nYou are proactively reaching out to check in. " +
    "It's approaching their hardest time of day. Be warm, " +
    "brief, and supportive. Ask how they're feeling and " +
    "remind them you're here. Don't be repetitive with " +
    "recent messages.";

  const messages = [
    ...recentMessages.map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content:
        "[SYSTEM: Generate a proactive check-in message for this user. " +
        "Do not include any prefix — just write the message as Laura.]",
    },
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
}

module.exports = { generateResponse, generateCheckin };
