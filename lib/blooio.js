const crypto = require("crypto");
const axios = require("axios");

const BASE_URL = "https://backend.blooio.com/v2/api";

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.BLOOIO_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Send a message to a phone number via Blooio.
 */
async function sendMessage(phone, text) {
  const url = `${BASE_URL}/chats/${encodeURIComponent(phone)}/messages`;
  const { data } = await axios.post(url, { text }, { headers: getHeaders() });
  return data;
}

/**
 * Verify the HMAC-SHA256 signature on an inbound Blooio webhook.
 * Returns true if valid.
 */
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.BLOOIO_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signatureHeader, "hex")
  );
}

/**
 * Check if a contact supports iMessage.
 */
async function checkCapabilities(phone) {
  const url = `${BASE_URL}/contacts/${encodeURIComponent(phone)}/capabilities`;
  const { data } = await axios.get(url, { headers: getHeaders() });
  return data;
}

module.exports = { sendMessage, verifySignature, checkCapabilities };
