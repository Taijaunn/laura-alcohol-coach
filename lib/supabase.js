const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Users ──────────────────────────────────────────────

async function getUser(phone) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createUser(phone) {
  const { data, error } = await supabase
    .from("users")
    .insert({ phone })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateUser(phone, fields) {
  const { data, error } = await supabase
    .from("users")
    .update(fields)
    .eq("phone", phone)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Messages ───────────────────────────────────────────

async function saveMessage(userPhone, role, content) {
  const { error } = await supabase
    .from("messages")
    .insert({ user_phone: userPhone, role, content });
  if (error) throw error;
}

async function getRecentMessages(userPhone, limit = 20) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("user_phone", userPhone)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// ── Check-in queries ──────────────────────────────────

async function getUsersDueForCheckin(currentHHMM, today) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("check_in_time", currentHHMM)
    .eq("onboarding_complete", true)
    .or(`last_checkin_date.is.null,last_checkin_date.neq.${today}`);
  if (error) throw error;
  return data || [];
}

async function markCheckinDone(phone, today) {
  const { error } = await supabase
    .from("users")
    .update({ last_checkin_date: today })
    .eq("phone", phone);
  if (error) throw error;
}

module.exports = {
  getUser,
  createUser,
  updateUser,
  saveMessage,
  getRecentMessages,
  getUsersDueForCheckin,
  markCheckinDone,
};
