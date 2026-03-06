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
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}

async function deleteUserMessages(userPhone) {
  const { error } = await supabase
    .from("messages")
    .delete()
    .eq("user_phone", userPhone);
  if (error) throw error;
}

async function deleteUser(phone) {
  const { error } = await supabase
    .from("users")
    .delete()
    .eq("phone", phone);
  if (error) throw error;
}

// ── Check-in queries ──────────────────────────────────

async function getUsersDueForCheckin(today) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("onboarding_complete", true)
    .not("check_in_time", "is", null)
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
  deleteUser,
  deleteUserMessages,
};
