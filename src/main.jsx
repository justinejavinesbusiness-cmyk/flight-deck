import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";

/* ============================================================
   FLIGHT DECK v3 — Job Search Operating System
   - DASHBOARD first: focus, check-ins, due follow-ups, support
   - Focus carryover: no new daily focus until yesterday's is done
   - Completed focus archives to HISTORY (accomplishments, editable)
   - Monthly runway check-in (day editable)
   - Emotional Support on demand (de-escalate -> reconnect -> 1 action)
   - Sync-first boot: daily check-ins are shared across devices and
     never regenerated per device
   ============================================================ */

const SUPA_URL = "https://ywzvhloswottkasvhzfv.supabase.co";
const SUPA_KEY = "sb_publishable_YyQQvJHwJh3B0c6ZJCcuhQ__gCrN_ld";
/* Storage uploads/deletes route through a Supabase Edge Function that uses the
   service role key server-side (bypasses RLS entirely) — direct client-side
   anonymous Storage writes proved unreliable regardless of key format or RLS
   policy content, so the client never touches Storage's REST API directly. */
const EDGE_UPLOAD_URL = `${SUPA_URL}/functions/v1/upload`;
/* realtime broadcast client — used only for "something changed" pings between
   devices on the same sync code; data itself still flows through the RPCs */
const supa = createClient(SUPA_URL, SUPA_KEY, { realtime: { params: { eventsPerSecond: 2 } } });

const C = {
  bg: "#0E1420",
  panel: "#17202F",
  panelEdge: "#232F42",
  ink: "#E8EDF5",
  muted: "#7A8699",
  amber: "#F5B942",
  green: "#4ADE80",
  red: "#F87171",
  blue: "#7DB0F7",
};

const MODES = ["DASHBOARD", "GOAL", "PIPELINE", "CONTENT", "EMOTIONS", "COPY", "HISTORY"];

/* ============================================================
   COPY LIBRARY

   A reusable store of email copy, kept separate from any one lead. The reason
   it exists: the same message gets rewritten from scratch every time, so
   nothing is ever tested. A library makes copy comparable — you grade what
   worked, and next time you start from the best version instead of a blank box.

   Drafts are slotted by PURPOSE (first contact, follow-up 1..N, re-engage),
   which is what lets a follow-up row pull the right one automatically.
   ============================================================ */
const COPY_PURPOSES = [
  { key: "outreach", label: "First contact", hint: "The opening message" },
  { key: "followup:1", label: "Follow-up 1", hint: "First nudge, usually days later" },
  { key: "followup:2", label: "Follow-up 2", hint: "Second nudge — change the angle" },
  { key: "followup:3", label: "Follow-up 3", hint: "Last in the sequence" },
  { key: "followup:4", label: "Follow-up 4+", hint: "Anything beyond the third" },
  { key: "reconnect", label: "Re-engage", hint: "For nurture and gone-cold leads" },
  { key: "other", label: "Other", hint: "Thank-yous, replies, anything else" },
];
const copyPurposeLabel = (k) => COPY_PURPOSES.find((p) => p.key === k)?.label || "Other";
/* follow-up rows are 0-indexed internally; anything past the third shares the
   "4+" slot rather than creating an endless list of near-identical purposes */
const purposeForFollowUp = (i) => (i >= 3 ? "followup:4" : `followup:${i + 1}`);
const normCopyDraft = (d) => ({
  id: d?.id || uid(),
  title: d?.title || "",
  body: d?.body || "",
  purpose: COPY_PURPOSES.some((p) => p.key === d?.purpose) ? d.purpose : "outreach",
  grade: Math.max(0, Math.min(5, +d?.grade || 0)),
  source: d?.source === "ai" ? "ai" : "user",
  createdAt: d?.createdAt || today(),
  timesUsed: Math.max(0, +d?.timesUsed || 0),
  lastUsedAt: d?.lastUsedAt || "",
});
/* best = highest graded, then most used, then newest. Ungraded drafts sort
   last so a fresh untested draft never displaces one you've rated. */
const rankCopy = (a, b) => b.grade - a.grade || b.timesUsed - a.timesUsed || (b.createdAt || "").localeCompare(a.createdAt || "");
const bestCopyFor = (drafts, purpose) => (drafts || []).filter((d) => d.purpose === purpose).sort(rankCopy)[0] || null;
/* ---- navigation glyphs ----
   One visual family: thin monochrome geometric shapes, no colour emoji. The
   old set mixed both (⌂ ▦ ♡ ★ against 🎯 📝 ⛽), so three items carried their
   own fixed colours and fought the amber active state that's supposed to be
   the only thing drawing your eye.

   Monochrome also means the glyph inherits the active/inactive colour, which
   is what makes the selected tab read instantly on a dark bar. Shapes lean
   instrument-panel to match the rest of the app: a bullseye for the target,
   a half-filled gauge for runway. */
const NAV_ITEMS = [
  ["⌂", "Home", 0],
  ["◎", "Goal", 1],
  ["▤", "CRM", 2],
  ["✎", "Content", 3],
  ["♡", "Mind", 4],
  ["✉", "Copy", 5],
  ["☆", "Wins", 6],
];

const TITLES = {
  DASHBOARD: "Dashboard",
  GOAL: "Goal Planner",
  PIPELINE: "Pipeline (CRM)",
  CONTENT: "Content",
  EMOTIONS: "Mind",
  COPY: "Copy Library",
  HISTORY: "Accomplishments",
};
const uid = () => Math.random().toString(36).slice(2, 10);
/* ---- configurable "day" timezone ----
   The app's whole notion of "today" (goal targets, due dates, digest,
   archiving, everything) is driven by this single offset rather than the
   device's local clock or raw UTC — so it stays consistent regardless of
   where the device physically is, and can be changed in Settings to whatever
   country's midnight should decide when the day rolls over. Defaults to the
   Philippines (UTC+8). Fixed offsets only — no DST handling, since DST rules
   vary by country and year; this keeps the model simple and predictable. */
let DAY_TZ_OFFSET_HOURS = 8;
const setDayTimezoneOffset = (hours) => {
  DAY_TZ_OFFSET_HOURS = typeof hours === "number" ? hours : 8;
};
const TIMEZONE_OPTIONS = [
  { label: "Philippines (UTC+8)", offset: 8 },
  { label: "Singapore / Hong Kong / China (UTC+8)", offset: 8 },
  { label: "Japan / Korea (UTC+9)", offset: 9 },
  { label: "Australia — Sydney/Melbourne (UTC+10)", offset: 10 },
  { label: "Australia — Perth (UTC+8)", offset: 8 },
  { label: "India (UTC+5:30)", offset: 5.5 },
  { label: "United Arab Emirates (UTC+4)", offset: 4 },
  { label: "United Kingdom (UTC+0)", offset: 0 },
  { label: "Germany / France / Central Europe (UTC+1)", offset: 1 },
  { label: "United States — Eastern (UTC-5)", offset: -5 },
  { label: "United States — Central (UTC-6)", offset: -6 },
  { label: "United States — Mountain (UTC-7)", offset: -7 },
  { label: "United States — Pacific (UTC-8)", offset: -8 },
  { label: "Canada — Eastern (UTC-5)", offset: -5 },
];
const today = () => {
  const d = new Date(Date.now() + DAY_TZ_OFFSET_HOURS * 3600000);
  return d.toISOString().slice(0, 10);
};
const thisMonth = () => today().slice(0, 7);

/* ---- week + follow-up helpers ---- */
const mondayOf = (d) => {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};
/* "this week" anchored to the configured day-timezone (today()), not the
   device's raw local clock — mondayOf(new Date()) would silently disagree
   with the rest of the app whenever the configured offset differs from
   wherever the device actually is. */
const mondayOfToday = () => mondayOf(new Date(today() + "T00:00:00"));
const iso = (d) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
const fmtShort = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const weekLabel = (mon) => {
  const sat = new Date(mon);
  sat.setDate(sat.getDate() + 5);
  return `${fmtShort(mon)} – ${fmtShort(sat)}`;
};
const weekOptions = () => {
  const cur = mondayOf(new Date());
  const out = [];
  for (let i = 1; i >= -11; i--) {
    const m = new Date(cur);
    m.setDate(m.getDate() + i * 7);
    out.push({ label: weekLabel(m), start: iso(m) });
  }
  return out;
};
const weekStartOfDate = (isoDate) => {
  if (!isoDate) return null;
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d)) return null;
  return iso(mondayOf(d));
};
const addDays = (isoDate, n) => {
  if (!isoDate) return "";
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d)) return "";
  d.setDate(d.getDate() + (+n || 0));
  /* MUST use iso(), not d.toISOString(): the Date above is LOCAL midnight, and
     toISOString converts to UTC — so anywhere east of Greenwich (PH is UTC+8,
     local midnight = 16:00 UTC the day before) every result came back a full
     day early. That made follow-ups fire a day sooner than scheduled and made
     week-end land on Friday instead of Saturday. iso() offsets it back. */
  return iso(d);
};

/* ---- application status model ---- */
const APP_STATUSES = ["", "outreach", "applied", "followed up", "replied", "screening", "interview", "final round", "offer", "rejected", "bad fit"];
const APP_SOURCES = ["LinkedIn", "Instagram", "Facebook", "Referral", "Job board", "Company site", "X / Twitter", "Other"];
const JOB_BOARD_OPTIONS = ["Onlinejobs.ph", "Upwork", "Indeed", "Jobstreet", "We Work Remotely", "Other"];
const OUTREACH_KINDS = ["warm", "cold"];
/* ---- touch points: a log of individual interactions, distinct from the
   overall status/outreachKind — e.g. "messaged on Facebook July 5", "cold
   emailed July 3", each tagged to whichever application or contact it
   belongs to by simply living nested inside that entry. */
const TOUCHPOINT_CHANNELS = ["Facebook", "Instagram", "LinkedIn", "Cold email", "Phone call", "Text/SMS", "In person", "Other"];
/* One glyph per channel, for the narrow mobile row where the full name eats
   the space the follow-up controls need. Monochrome to match the nav — a
   coloured emoji here would out-shout the amber "done" tick beside it. */
const CHANNEL_ICON = {
  Facebook: "f",
  Instagram: "◙",
  LinkedIn: "in",
  "Cold email": "✉",
  "Phone call": "☎",
  "Text/SMS": "▭",
  "In person": "◇",
  Other: "·",
};
const channelIcon = (c) => CHANNEL_ICON[c] || "·";
const OUTREACH_CHANNELS = ["Email", "Call", "Text", "Other"];
/* "bad fit" reasons — multi-select, for companies that don't align on comp/values/etc */
const BAD_FIT_REASONS = ["Salary too low", "Values mismatch", "Culture concerns", "Red flags in process", "Scope creep", "Other"];

/* ---- account / contact relationship model ---- */
const CONTACT_STATUSES = ["", "outreach", "replied", "discovery call", "ongoing", "closed"];
const contactStatusLabel = (s) => (s ? s : "Not contacted yet");
const contactStatusColor = (s) =>
  s === "closed" ? C.muted : s === "ongoing" ? C.green : s === "discovery call" ? C.amber : s === "replied" || s === "outreach" ? C.blue : C.muted;
const isContactBlankStatus = (c) => !c.status;
/* whole days between a date and today (negative if the date is in the future).
   Declared up here because nurtureState below needs it and `const` doesn't
   hoist — calling it earlier would throw at runtime, not at build. */
const daysSince = (isoDate) => {
  if (!isoDate) return null;
  return Math.floor((new Date(today() + "T00:00:00") - new Date(isoDate + "T00:00:00")) / 86400000);
};
const isContactOpen = (c) => c.status !== "closed";
const isContactOutreached = (c) => !!c.status; /* any status set means real contact has happened */
/* ---- nurture stage ----
   A contact that hasn't moved in months isn't dead and isn't active — it's
   dormant, and the app previously had no word for that. It sat in "outreach"
   looking identical to something you messaged yesterday.

   The window is deliberate: before 60 days it's just a slow thread, and the
   follow-up queue already covers it. After ~90 days a cold restart reads
   better than another follow-up on the old one, so the entry graduates to
   STALE and stops pretending it's a live conversation.

   Only OPEN, already-outreached contacts qualify — a closed contact is
   resolved, and one you never wrote to was never nurturing. */
const NURTURE_FROM_DAYS = 60;
const NURTURE_TO_DAYS = 90;
const nurtureState = (c) => {
  if (!c || !isContactOpen(c) || !isContactOutreached(c)) return "";
  /* "discovery call" and beyond means it IS moving — nurture is about silence
     in the early stages, not about a slow interview process */
  if (["discovery call", "ongoing"].includes(c.status)) return "";
  const last = lastActivityDate(c);
  if (!last) return "";
  const d = daysSince(last);
  if (d >= NURTURE_TO_DAYS) return "stale";
  if (d >= NURTURE_FROM_DAYS) return "nurture";
  return "";
};
const NURTURE_META = {
  nurture: { label: "NURTURE", color: "amber", hint: "quiet 60+ days — worth a light touch, not a hard pitch" },
  stale: { label: "GONE COLD", color: "muted", hint: "quiet 90+ days — restart cold rather than follow up again" },
};

/* ---- social engagement cadence ----
   Engaging with someone's posts is a different loop from following up: it's
   commenting on their work, not chasing a reply, and its rhythm is set by THEM
   rather than by you. Someone posting daily expects interaction often enough
   to be noticed; someone posting monthly would find weekly engagement odd.

   So the cadence is derived from their posting frequency, not chosen. The
   ratios are deliberately conservative — roughly one engagement per 2-3 of
   their posts. Engaging with everything reads as monitoring, not interest. */
const POST_FREQUENCIES = [
  { key: "daily", label: "Daily", sub: "posts most days", everyDays: 4 },
  { key: "weekly", label: "A few times a week", sub: "2-4 posts a week", everyDays: 9 },
  { key: "biweekly", label: "Weekly", sub: "about one a week", everyDays: 16 },
  { key: "monthly", label: "Monthly or less", sub: "occasional", everyDays: 35 },
];
const postFreqOf = (k) => POST_FREQUENCIES.find((f) => f.key === k) || null;
/* last time you engaged — falls back to when you marked them active, so a
   newly-flagged contact becomes due on their own cadence rather than instantly */
const lastEngagedDate = (c) => c?.lastEngagedAt || c?.socialSince || "";
const engagementDueDate = (c) => {
  const f = postFreqOf(c?.postFrequency);
  if (!c?.socialActive || !f) return "";
  const from = lastEngagedDate(c);
  return from ? addDays(from, f.everyDays) : today();
};
const isEngagementDue = (c) => {
  if (!c?.socialActive || !isContactOpen(c)) return false;
  const due = engagementDueDate(c);
  return !!due && due <= today();
};
const engagementOverdueDays = (c) => {
  const due = engagementDueDate(c);
  return due && due <= today() ? daysSince(due) : 0;
};

const isContactDue = (c) => {
  if (isContactBlankStatus(c)) return false;
  const n = nextFollowUp(c);
  return !!(n && isContactOpen(c) && n.date <= today());
};

const ACCOUNT_STATUSES = ["", "closed", "bad fit"];
const accountStatusLabel = (s) => (s === "closed" ? "closed" : s === "bad fit" ? "bad fit" : "active");
const accountStatusColor = (s) => (s === "closed" ? C.muted : s === "bad fit" ? C.red : C.green);
/* ---- LinkedIn connection state ----
   A connection request is its own little pipeline sitting before any real
   conversation, and it has a failure mode the rest of the app doesn't cover:
   it can sit pending forever with nothing to react to. So a request that's
   been out 7 days is flagged — not because LinkedIn tells you anything, but
   because at that point it's on you to either follow up another way or write
   it off, and an unmarked pending request quietly becomes a dead lead. */
const LI_STATUSES = [
  { key: "", label: "Not sent", color: "muted" },
  { key: "requested", label: "Request sent", color: "amber" },
  { key: "connected", label: "Connected", color: "green" },
  { key: "declined", label: "Declined / ignored", color: "red" },
  { key: "withdrawn", label: "Withdrawn", color: "muted" },
  { key: "na", label: "Messaged without connecting", color: "blue" },
];
const LI_META = (k) => LI_STATUSES.find((x) => x.key === (k || "")) || LI_STATUSES[0];
const LI_STALE_DAYS = 7;
const DEFAULT_TOUCH_CHANNEL = "LinkedIn";

/* Ticking a follow-up means you actually sent something, so it should leave a
   trace in the log rather than only moving the next due date. The channel is
   chosen per follow-up (defaulting to whatever you use most) because "I
   followed up" is useless six weeks later if you can't remember whether it was
   a LinkedIn DM or an email. */
const followUpTouchpoint = (channel, index) => ({
  id: uid(),
  date: today(),
  channel: channel || DEFAULT_TOUCH_CHANNEL,
  note: `Follow-up #${(index || 0) + 1}`,
  fromFollowUp: true,
});
/* only a PENDING request can go stale — the other states are resolved */
const liStaleDays = (c) => {
  if (!c?.linkedin || c.liStatus !== "requested" || !c.liStatusAt) return 0;
  const d = daysSince(c.liStatusAt);
  return d >= LI_STALE_DAYS ? d : 0;
};

/* ---- per-contact history ----
   Append-only. Touch points record what you did; this records what CHANGED,
   which is the part that was previously invisible — a contact could move from
   outreach to closed with nothing to show when or why. */
const logEntry = (kind, text) => ({ id: uid(), at: today(), kind, text });

const withLog = (c, entries) => ({ ...c, history: [...(entries || []), ...(c.history || [])].slice(0, 200) });
/* merges the change log and the touch points into one ordered timeline */
function contactTimeline(c) {
  const events = [
    ...(c?.history || []).map((h) => ({ id: h.id, at: h.at, kind: h.kind, text: h.text })),
    ...(c?.touchpoints || []).map((t) => ({ id: t.id, at: t.date, kind: "touch", text: `${t.channel || "Touch point"}${t.note ? ` — ${t.note}` : ""}` })),
  ];
  if (c?.contacted) events.push({ id: "first", at: c.contacted, kind: "first", text: "First contacted" });
  return events.filter((e) => e.at).sort((a, b) => b.at.localeCompare(a.at) || String(b.id).localeCompare(String(a.id)));
}

const isAccountOpen = (acc) => !acc.status;
/* live = not archived. An account is UNTOUCHED when nobody inside it has been
   reached yet — including accounts with no contacts at all, which are the ones
   most easily forgotten: they look tracked but have no way in yet. */
const liveContacts = (acc) => (acc?.contacts || []).filter((c) => !c.archivedAt && !c.tombstoned);
const isAccountUntouched = (acc) => !liveContacts(acc).some((c) => isContactOutreached(c));
const hasNoWayIn = (acc) => liveContacts(acc).length === 0;

/* ---- syncing account-contact outreach into the real pipeline ----
   Outreaching a contact is real outreach — it should count everywhere an
   application does (funnel, goals, conversion, donuts) without every one of
   those systems needing special-cased contact-awareness. So instead of
   merging counts in parallel, each outreached contact gets a real, linked
   entry in state.applications (source "Accounts", fromAccountContact: true),
   kept in sync as the contact's own status/tags/follow-ups change. */
const CONTACT_TO_APP_STATUS = { "": "", outreach: "outreach", replied: "replied", "discovery call": "screening", ongoing: "interview", closed: "rejected" };
const mapContactStatusToAppStatus = (contactStatus) => CONTACT_TO_APP_STATUS[contactStatus] ?? "";
/* reverse of the above — used when converting a standalone application into
   an account contact. The contact status model is coarser than the
   application one (5 stages vs 11), so some detail is necessarily collapsed:
   applied/followed up both become "outreach" (still pre-reply), screening
   becomes "discovery call", interview/final round/offer all become "ongoing"
   (there's no finer contact-side equivalent), and rejected/bad fit both
   become "closed". */
const APP_TO_CONTACT_STATUS = {
  "": "",
  outreach: "outreach",
  applied: "outreach",
  "followed up": "outreach",
  replied: "replied",
  screening: "discovery call",
  interview: "ongoing",
  "final round": "ongoing",
  offer: "ongoing",
  rejected: "closed",
  "bad fit": "closed",
};
const mapAppStatusToContactStatus = (appStatus) => APP_TO_CONTACT_STATUS[appStatus] ?? "outreach";
/* pure: builds a new account (with one contact) from a standalone
   application's data — the actual linking back into a real application
   happens via the normal sync pathway once this account is saved. */
/* shared: builds a contact object from application-shaped data (company,
   contact, email, phone, linkedin, status, etc.) — used both when converting
   a whole application into an account, and when merging a second application
   for the same company+role into an account as an additional contact. */
/* Everything the application knew about the PERSON, carried across. This used
   to silently drop the LinkedIn connection state, the engagement cadence, the
   reply flag and the whole history log — so converting an old lead quietly
   erased months of tracking. Conversion must never lose data; it changes the
   shape of a record, not its contents. */
function contactFromApplicationData(data) {
  return {
    id: uid(),
    name: data.contact || "",
    /* the role is the closest thing an application has to a job title, and
       dropping it meant "generic person" drafts lost their role clause */
    position: data.contactPosition || "",
    email: data.email || "",
    phone: data.contactPhone || "",
    linkedin: data.contactLinkedin || "",
    notes: data.notes || "",
    status: mapAppStatusToContactStatus(data.status),
    outreachKind: data.outreachKind || "",
    outreachChannel: data.outreachChannel || "",
    contacted: data.contacted || "",
    followUps: Array.isArray(data.followUps) ? data.followUps.map((f) => ({ ...f })) : [],
    touchpoints: Array.isArray(data.touchpoints) ? data.touchpoints.map((t) => ({ ...t })) : [],
    /* LinkedIn connection pipeline */
    liStatus: data.liStatus || "",
    liStatusAt: data.liStatusAt || "",
    /* social engagement cadence */
    socialActive: !!data.socialActive,
    postFrequency: data.postFrequency || "",
    socialSince: data.socialSince || "",
    lastEngagedAt: data.lastEngagedAt || "",
    /* "a human actually answered" — feeds the funnel's replied-vs-silent split */
    gotReply: !!data.gotReply,
    history: Array.isArray(data.history) ? data.history.map((h) => ({ ...h })) : [],
    linkedApplicationId: null,
  };
}
/* The company-level half. Notes and bad-fit reasons were being thrown away
   here too — an application's notes are about the company as much as the
   person, so they're kept on BOTH rather than picked between. */
function convertApplicationToAccount(app) {
  return {
    id: uid(),
    company: app.company || "",
    website: app.website || "",
    industry: app.industry || "",
    headcount: app.headcount || "",
    status: "",
    highConfidence: !!app.highConfidence,
    badReasons: Array.isArray(app.badReasons) ? [...app.badReasons] : [],
    notes: app.notes || "",
    /* pool membership survives the shape change, so coverage doesn't drop */
    ...(app.fromPool ? { fromPool: true, poolName: app.poolName || "", hook: app.hook || "", researchedAt: app.researchedAt || "", poolAddedAt: app.poolAddedAt || today() } : {}),
    contacts: [contactFromApplicationData(app)],
  };
}
/* ---- reapplications ----
   Applying to the same company + job title a second time is a genuinely
   different thing from a duplicate row: the first attempt CLOSED (rejected,
   bad fit, or an offer you turned down) and you're taking another swing,
   usually months later after a new posting. That deserves its own tag — both
   so the history is honest in interviews ("yes, I applied in March") and so
   the funnel doesn't read a reapplication as a fresh cold lead.

   Attempts are numbered: the original is attempt 1, the first reapplication
   is 2, and so on. The number matters beyond display — it separates the
   convergence groups, so a new attempt reaching "screening" never drags the
   old rejected entry along with it. */
const attemptOf = (a) => Math.max(1, +a?.attempt || 1);
const isReapply = (a) => attemptOf(a) > 1;
/* pure: every non-archived entry for this company+role, excluding one id
   (the entry being edited). Includes account-linked entries — a reapplication
   after an account contact went cold is still a reapplication. */
function findPriorAttempts(company, role, applications, excludeId) {
  const q = normCompanyName(company);
  const roleQ = normRoleName(role);
  if (!q || !roleQ) return [];
  return (applications || [])
    .filter((a) => a.id !== excludeId && !a.archivedAt && normCompanyName(a.company) === q && normRoleName(a.role) === roleQ)
    .sort((a, b) => attemptOf(b) - attemptOf(a) || (b.contacted || "").localeCompare(a.contacted || ""));
}
/* the attempt number a NEW entry should take for this company+role */
const nextAttemptNumber = (company, role, applications) => {
  const prior = findPriorAttempts(company, role, applications, null);
  return prior.length ? Math.max(...prior.map(attemptOf)) + 1 : 1;
};

/* pure: is there already an OPEN, standalone application for the same
   company + role? Case-insensitive, whitespace-trimmed on both sides. Synced
   (already account-linked) entries are excluded — those are already exactly
   what this feature would otherwise suggest creating. Entries that have CLOSED
   (rejected / bad fit / offer) are excluded too: a second application after a
   closed one isn't a duplicate at all, it's a reapplication, and it routes to
   findPriorAttempts and the reapply prompt instead. */
function findDuplicateApplication(company, role, applications) {
  const q = normCompanyName(company);
  const roleQ = (role || "").trim().toLowerCase();
  if (!q || !roleQ) return null;
  return (
    (applications || []).find(
      (a) => !a.fromAccountContact && !a.archivedAt && isOpenApp(a) && normCompanyName(a.company) === q && (a.role || "").trim().toLowerCase() === roleQ
    ) || null
  );
}
/* pure: merges a second application for the same company+role into an
   account. If no account exists for the company yet, the FIRST (existing)
   application becomes the account, exactly like a normal single conversion.
   The new application's contact is added: as a genuinely NEW contact if the
   name differs from anyone already on the account, or folded into the
   matching existing contact (refreshing its outreach info) if the name is
   the same person. Returns the updated accounts array; the caller is
   responsible for removing the original standalone application(s) — the
   normal sync pathway (once accounts are saved) creates the properly linked
   replacement application(s). */
function mergeApplicationIntoAccount(existingApp, newAppData, accounts) {
  const q = normCompanyName(existingApp.company);
  const existingAccount = (accounts || []).find((acc) => normCompanyName(acc.company) === q);
  const newContact = contactFromApplicationData(newAppData);
  const newContactName = (newAppData.contact || "").trim().toLowerCase();

  if (existingAccount) {
    const matchIdx = newContactName ? existingAccount.contacts.findIndex((c) => (c.name || "").trim().toLowerCase() === newContactName) : -1;
    const contacts =
      matchIdx !== -1
        ? existingAccount.contacts.map((c, i) => (i === matchIdx ? { ...c, ...newContact, id: c.id, linkedApplicationId: c.linkedApplicationId } : c))
        : [...existingAccount.contacts, newContact];
    return (accounts || []).map((acc) => (acc.id === existingAccount.id ? { ...acc, contacts } : acc));
  }

  /* no account yet — the existing application becomes one, per the normal
     single conversion, then the new application's contact is added alongside
     the one that came from the existing application (never the same contact
     twice, since a brand-new account only ever starts with one). */
  const newAccount = convertApplicationToAccount(existingApp);
  const existingContactName = (existingApp.contact || "").trim().toLowerCase();
  if (newContactName && newContactName === existingContactName) {
    newAccount.contacts = [{ ...newAccount.contacts[0], ...newContact, id: newAccount.contacts[0].id }];
  } else {
    newAccount.contacts = [...newAccount.contacts, newContact];
  }
  return [newAccount, ...(accounts || [])];
}
/* pure: given an account's OLD and NEW contact lists plus the current applications
   array, returns the updated contacts (with linkedApplicationId set/cleared) and
   the updated applications array (linked entries created/updated/removed). */
function syncContactsToApplications(accountCompany, accountWebsite, oldContacts, newContacts, applications) {
  let apps = applications.slice();
  const newIds = new Set((newContacts || []).map((c) => c.id));

  /* a contact that no longer exists on the account loses its linked application too */
  (oldContacts || []).forEach((oc) => {
    if (!newIds.has(oc.id) && oc.linkedApplicationId) {
      apps = apps.filter((a) => a.id !== oc.linkedApplicationId);
    }
  });

  const updatedContacts = (newContacts || []).map((c) => {
    const hasLink = !!(c.linkedApplicationId && apps.some((a) => a.id === c.linkedApplicationId));

    if (!c.status) {
      /* reverted to "not contacted" — the linked pipeline entry no longer applies */
      if (hasLink) apps = apps.filter((a) => a.id !== c.linkedApplicationId);
      return { ...c, linkedApplicationId: null };
    }

    /* mirror of contactFromApplicationData — the two directions must carry the
       same fields, or a round trip through convert-and-sync would quietly
       shed data each time it crossed */
    const payload = {
      company: accountCompany,
      website: accountWebsite,
      contact: c.name,
      contactPosition: c.position || "",
      email: c.email,
      contactPhone: c.phone,
      contactLinkedin: c.linkedin,
      source: "Accounts",
      status: mapContactStatusToAppStatus(c.status),
      contacted: c.contacted,
      outreachKind: c.outreachKind,
      outreachChannel: c.outreachChannel || "",
      followUps: c.followUps || [],
      touchpoints: c.touchpoints || [],
      liStatus: c.liStatus || "",
      liStatusAt: c.liStatusAt || "",
      socialActive: !!c.socialActive,
      postFrequency: c.postFrequency || "",
      socialSince: c.socialSince || "",
      lastEngagedAt: c.lastEngagedAt || "",
      gotReply: !!c.gotReply,
      history: Array.isArray(c.history) ? c.history.map((h) => ({ ...h })) : [],
      notes: c.notes,
      fromAccountContact: true,
    };

    if (hasLink) {
      apps = apps.map((a) => (a.id === c.linkedApplicationId ? { ...a, ...payload } : a));
      return c;
    }
    const newId = uid();
    apps = [{ id: newId, ...payload }, ...apps];
    return { ...c, linkedApplicationId: newId };
  });

  /* report what was dropped so the caller can tombstone it — a removal that
     isn't recorded gets undone by the next sync merge */
  const keptIds = new Set(apps.map((a) => a.id));
  const removedIds = applications.filter((a) => !keptIds.has(a.id)).map((a) => a.id);
  return { contacts: updatedContacts, applications: apps, removedIds };
}

/* ---- content management model ---- */
const CONTENT_STATUSES = ["idea", "draft", "design", "scheduled", "published"];

/* ============================================================
   CONTENT COMMITMENT DEVICES

   The weekly count alone is a LAGGING indicator — it only tells you you've
   failed after the week is gone. These four measures give the content goal
   actual teeth without turning it into a guilt machine:

     · BUFFER — how many finished pieces are queued and ready to go. The real
       failure mode isn't missing a publish day, it's having nothing banked.
       Missing a day with 3 in reserve is fine; 0 in reserve is the emergency.
     · IDEA FLOOR — a minimum stock of raw ideas, because "no idea ready to
       work on" is what actually kills a design day.
     · STREAK + FREEZE — consecutive weeks hitting the target, with one freeze
       per calendar month that absorbs a miss without breaking the chain. A
       naked streak is brittle: one bad week during a hard job-search stretch
       and the whole device gets abandoned. The freeze is what makes it hold.
     · SKIP REASONS — skipping is no longer free and silent. Each miss records
       WHY, which turns a pile of guilt into a diagnosis: four missed design
       days in five weeks means the schedule is wrong, not that you are.
   ============================================================ */
const CONTENT_SKIP_REASONS = [
  { key: "noIdea", label: "No idea ready to work on", fix: "Your idea bank ran dry — the fix is an ideation session, not more discipline." },
  { key: "noTime", label: "No time — job search took priority", fix: "This is the search working as intended. Content is nurturing, not the engine." },
  { key: "stalled", label: "Idea exists but stalled at design", fix: "The piece is too ambitious for one sitting. Shrink the scope, not the schedule." },
  { key: "motivation", label: "Honestly just didn't feel like it", fix: "The most normal reason there is. This is exactly what the buffer and freeze are for." },
];
const skipReasonLabel = (k) => CONTENT_SKIP_REASONS.find((r) => r.key === k)?.label || k;
const DEFAULT_CONTENT_BUFFER_TARGET = 2;
const DEFAULT_CONTENT_IDEA_FLOOR = 5;
/* "ready to publish" = finished and queued. Published items have already gone
   out, so they're not buffer any more. */
const contentBufferCount = (items) => (items || []).filter((c) => c.status === "scheduled").length;
const contentIdeaCount = (items) => (items || []).filter((c) => (c.status || "idea") === "idea").length;
/* a piece is overdue when it committed to a ship-by date that has passed and
   it still hasn't gone out */
const contentOverdue = (c) => !!(c?.shipBy && c.status !== "published" && c.shipBy < today());

/* published count for the week containing a given Monday */
const publishedInWeek = (items, weekStart) =>
  (items || []).filter((c) => c.status === "published" && c.date && weekStartOfDate(c.date) === weekStart).length;
/* how many freeze credits a given calendar month grants and has left. One per
   month, so a single rough week is survivable but a rough month isn't papered
   over. */
const freezesUsedInMonth = (frozenWeeks, ym) => (frozenWeeks || []).filter((w) => w.slice(0, 7) === ym).length;
const canFreezeWeek = (frozenWeeks, weekStart) => freezesUsedInMonth(frozenWeeks, weekStart.slice(0, 7)) < 1;
/* Walks BACKWARD from the current week counting consecutive weeks that either
   hit the target or were frozen. The in-progress week only counts once it's
   already met — it can never break the streak, since it isn't over yet.
   Returns { weeks, brokenAt, frozenUsed } where brokenAt is the first failed
   week start (null if the streak reaches the very first tracked week). */
function computeContentStreak(items, perWeek, frozenWeeks, startBound) {
  if (!perWeek || perWeek <= 0) return { weeks: 0, brokenAt: null, thisWeekMet: false };
  const frozen = new Set(frozenWeeks || []);
  const thisWeek = iso(mondayOfToday());
  const thisWeekMet = publishedInWeek(items, thisWeek) >= perWeek;
  let weeks = thisWeekMet ? 1 : 0;
  let cursor = addDays(thisWeek, -7);
  let brokenAt = null;
  /* cap the walk so a long-lived dataset can't spin: a year of weeks is plenty */
  for (let i = 0; i < 52; i++) {
    if (startBound && cursor < startBound) break;
    const met = publishedInWeek(items, cursor) >= perWeek || frozen.has(cursor);
    if (!met) {
      brokenAt = cursor;
      break;
    }
    weeks++;
    cursor = addDays(cursor, -7);
  }
  return { weeks, brokenAt, thisWeekMet };
}
/* aggregates logged skip reasons over a trailing window so the app can name
   the actual bottleneck instead of just counting misses */
function contentSkipPatterns(log, days) {
  const cutoff = addDays(today(), -(days || 35));
  const byReason = new Map();
  const byStage = new Map();
  let total = 0;
  Object.entries(log || {}).forEach(([date, e]) => {
    if (date < cutoff || !e?.missed || !e?.skipReason) return;
    total++;
    byReason.set(e.skipReason, (byReason.get(e.skipReason) || 0) + 1);
    if (e.stage) byStage.set(e.stage, (byStage.get(e.stage) || 0) + 1);
  });
  const top = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const topStage = [...byStage.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return { total, topReason: top ? { key: top[0], count: top[1] } : null, topStage: topStage ? { stage: topStage[0], count: topStage[1] } : null };
}
/* display labels only — the underlying stored status values (idea/draft/design/
   scheduled/published) never change, so existing content and all filtering
   logic stay exactly as they were. This just changes what's shown on screen. */
const CONTENT_STATUS_LABELS = { idea: "Idea", draft: "Draft/Scripting", design: "Design/Film", scheduled: "Scheduled", published: "Published" };
const contentStatusLabel = (s) => CONTENT_STATUS_LABELS[s] || CONTENT_STATUS_LABELS.idea;
const contentStatusColor = (s) =>
  s === "published" ? C.green : s === "scheduled" ? C.amber : s === "design" ? C.blue : s === "draft" ? C.ink : C.muted;
const CONTENT_TYPES = ["Blog", "Carousel", "Static post", "TikTok video", "Long-form video", "Short-form video", "Newsletter", "Other"];
const CONTENT_PLATFORMS = ["LinkedIn", "Instagram", "TikTok", "X / Twitter", "YouTube", "Facebook", "Blog/Website", "Other"];
const STAGE_IDX = { "": -2, outreach: -1, applied: 0, "followed up": 1, replied: 2, screening: 3, interview: 4, "final round": 5, offer: 6, "bad fit": -3, rejected: -3 };
const statusLabel = (s) => (s ? s : "Not applied yet");
const isOutreach = (a) => a.status === "outreach";
const isBlankStatus = (a) => !a.status;
const isBadFit = (a) => a.status === "bad fit";
const isOpenApp = (a) => !["offer", "rejected", "bad fit"].includes(a.status);
/* has this application EVER reached a given stage? Checks the historical
   milestonesLogged record first — which only ever grows, regardless of later
   status changes — so a real reply/screen/interview that happened stays
   counted even if the application is later marked rejected or bad fit.
   Falls back to the current status for stages outside the milestone list
   (or older data saved before milestonesLogged existed). */
/* ---- furthest stage ever reached ----
   `status` is only where an entry sits NOW. Closing it sets rejected/bad fit,
   which carry no stage of their own, so the status alone can't tell you the
   application got to interview before it died. The furthest stage is therefore
   the max of: where it sits now, every milestone logged on the way, and an
   explicitly recorded reply.

   Reading it as a single index also makes the funnel MONOTONIC: if interview
   was reached then screening and replied were too, by definition. Counting
   them independently produced impossible funnels (1 interview, 0 screens). */
const furthestStageIdx = (a) => {
  let idx = STAGE_IDX[a?.status] ?? -2;
  (a?.milestonesLogged || []).forEach((sName) => {
    const i = STAGE_IDX[sName];
    if (typeof i === "number" && i > idx) idx = i;
  });
  if (a?.gotReply && STAGE_IDX.replied > idx) idx = STAGE_IDX.replied;
  return idx;
};
const reached = (a, stage) => furthestStageIdx(a) >= (STAGE_IDX[stage] ?? 0);

/* ---- "they replied, then rejected me" ----
   Status is a single position, so moving an entry to "rejected" or "bad fit"
   erases the fact that a human ever answered — unless you happened to step
   through "replied" first and logged the milestone. That loses the single most
   diagnostic distinction in the whole funnel:

     · rejected WITH a reply  → your resume/outreach worked. A person read it
       and engaged. The leak is later, in the conversation.
     · rejected with NO reply → nothing got through. The leak is the
       resume/ATS/opening-message layer, exactly as the playbook's Part 4
       diagnosis says.

   `gotReply` records that fact independently of status, so it survives any
   later status change. Works identically on applications and account contacts,
   since both carry the same field. */
const hadReply = (a) => furthestStageIdx(a) >= STAGE_IDX.replied;
/* the interesting case worth its own filter and badge: a real answer that
   still ended in a no */
const isRepliedThenRejected = (a) => !isOpenApp(a) && a?.status !== "offer" && hadReply(a);
/* the other side of the same coin — silence, which points at a different fix */
const isRejectedNoReply = (a) => !isOpenApp(a) && a?.status !== "offer" && !hadReply(a);
/* pure: called on every status change. If an entry is being CLOSED from a stage
   that already implied a reply, latch gotReply so the fact isn't silently lost
   the moment the status moves on. Never un-sets it — clearing a mis-set reply
   is a deliberate manual action, not a side effect of editing something else. */
/* ---- latch history on close ----
   Closing an entry collapses its stage to rejected/bad fit, which would erase
   how far it actually got. So at the moment of closing we write down the
   milestones its prior stage already implied — an entry sitting at "interview"
   banks replied + screening + interview on the way out, even if it was created
   at that stage and never stepped forward through the app.

   Never removes anything: a correction is a deliberate act, not a side effect. */
const latchOnClose = (prevEntry, newStatus) => {
  if (newStatus !== "rejected" && newStatus !== "bad fit") return {};
  const idx = furthestStageIdx(prevEntry);
  const already = prevEntry?.milestonesLogged || [];
  const implied = MILESTONE_STAGES.filter((st) => STAGE_IDX[st] <= idx);
  const merged = Array.from(new Set([...already, ...implied]));
  const out = {};
  if (merged.length > already.length) out.milestonesLogged = merged;
  if (hadReply(prevEntry)) out.gotReply = true;
  return out;
};
/* contact-side equivalents. Contacts use a coarser 5-stage vocabulary, so we
   translate to the application scale before judging — "discovery call" and
   "ongoing" both sit past a reply, and "closed" is the collapse that would
   otherwise lose it. */
const contactHadReply = (c) => {
  if (c?.gotReply) return true;
  const mapped = mapContactStatusToAppStatus(c?.status);
  return mapped !== "rejected" && mapped !== "bad fit" && (STAGE_IDX[mapped] ?? 0) >= STAGE_IDX.replied;
};
const latchContactReply = (prevContact, newStatus) => (newStatus === "closed" && contactHadReply(prevContact) ? { gotReply: true } : {});
const statusColor = (s) =>
  s === "offer" ? C.green : s === "rejected" ? C.muted : s === "bad fit" ? C.red : s === "" ? C.muted : s === "outreach" ? C.blue : ["interview", "final round"].includes(s) ? C.amber : ["replied", "screening"].includes(s) ? C.blue : C.ink;
const outreachKindColor = (k) => (k === "warm" ? C.amber : k === "cold" ? C.blue : C.muted);

/* ---- automatic milestone wins ----
   Any status change that moves a lead FORWARD (closer to the job) auto-logs
   a motivating win to History, once per stage per application — never
   duplicated even if the status bounces around or gets edited repeatedly. */
const MILESTONE_STAGES = ["replied", "screening", "interview", "final round", "offer"];
const MILESTONE_LABEL = { replied: "Reply", screening: "Screening", interview: "Interview", "final round": "Final Round", offer: "Offer" };
const MILESTONE_EMOJI = { replied: "💬", screening: "📞", interview: "🎤", "final round": "🏁", offer: "🏆" };
/* which milestone stages does newStatus newly reach, that oldStatus hadn't already? */
function newlyReachedMilestones(oldStatus, newStatus) {
  if (newStatus === "rejected") return [];
  const oldIdx = STAGE_IDX[oldStatus] ?? -2;
  const newIdx = STAGE_IDX[newStatus] ?? -2;
  if (newIdx <= oldIdx) return [];
  return MILESTONE_STAGES.filter((s) => STAGE_IDX[s] > oldIdx && STAGE_IDX[s] <= newIdx);
}
/* pure: given the application's PRIOR state and its new status, returns
   { milestonesLogged, wins } if anything new was reached, else null */
function computeMilestoneWins(prevApp, newStatus) {
  const oldStatus = prevApp?.status ?? "";
  const already = prevApp?.milestonesLogged || [];
  const newlyReached = newlyReachedMilestones(oldStatus, newStatus).filter((s) => !already.includes(s));
  if (!newlyReached.length) return null;
  const companyName = prevApp?.company || "a company";
  const wins = newlyReached.map((stage) => ({
    id: uid(),
    date: today(),
    category: MILESTONE_LABEL[stage],
    text: `${MILESTONE_EMOJI[stage]} ${MILESTONE_LABEL[stage]} — ${companyName}`,
    linkedAppId: prevApp?.id || null,
  }));
  return { milestonesLogged: [...already, ...newlyReached], wins };
}

/* ---- content publish wins ----
   Content is nurturing, not a conversion tool — the only automatic win here
   is the act of publishing itself (consistency + follow-through), never
   framed as "this will get you a job." Fires once per content item. */
function computeContentPublishWin(prevContent, newStatus) {
  if (newStatus !== "published" || prevContent?.celebratedPublish) return null;
  const title = prevContent?.title || "Untitled";
  const typeNote = prevContent?.type ? ` (${prevContent.type})` : "";
  return {
    win: {
      id: uid(),
      date: today(),
      category: "Published",
      text: `🎉 Published — "${title}"${typeNote}. Showing up consistently is its own win.`,
    },
  };
}
/* fires alongside computeContentPublishWin — separate, count-based milestone:
   first at 3 total published pieces, then every +5 after (3, 8, 13, 18...) */
function computePublishedMilestoneWin(oldCount, newCount) {
  const milestone = publishedMilestoneCrossed(oldCount, newCount);
  if (!milestone) return null;
  return {
    id: uid(),
    date: today(),
    category: "Content Streak",
    text: `🔥 ${milestone} pieces of content published — the consistency is compounding.`,
  };
}

/* ---- goal / campaign planner ---- */
/* an application/outreach counts toward the goal the moment it's real activity —
   the ONLY thing that doesn't count is a "saved for later" lead with no status yet.
   Application and outreach are treated identically: each is worth 1 toward the target. */
const isGoalActivity = (a) => !isBlankStatus(a);
/* links an Account to Applications sharing the same company name (trimmed, case-insensitive) */
const normCompanyName = (s) => (s || "").trim().toLowerCase();
/* ============================================================
   POOL INTEGRATION — the receiving end of Pool Mode

   Pool Mode (a separate parallel build) pushes companies here as
   applications carrying `fromPool: true` and the pool's name. Two things
   follow from that tag:

     · the row is badged, so you can always see which companies arrived from
       a deliberate pool build rather than from ad-hoc browsing
     · POOL PACING MODE becomes possible — a different goal model entirely

   Why a different goal model: the standard goal is "N applications over N
   days", which is unbounded by construction. You can never be ahead, only
   behind. The pool philosophy replaces that with COVERAGE of a closed set:
   a finite, completable target. The daily number stops being a quota you
   invent and becomes a simple consequence of one weekly write budget.
   ============================================================ */
const isFromPool = (a) => !!a?.fromPool;
const DEFAULT_POOL_WEEKLY_WRITE = 8;
const DEFAULT_CYCLE_WEEKS = 6;
const DEFAULT_DISCOVERY_WEEKS = 2;
/* a pool company counts as REACHED on the same terms the rest of the app uses
   for real activity: a genuine status plus a contact date */
const poolCompanyWorked = (a) => !!(a?.status && a?.contacted);
/* ...and DISCOVERED once research produced something usable. Either an explicit
   research date or a hook line counts — Pool Mode pushes both, and a hook typed
   directly in Flight Deck should count the same. */
const poolCompanyDiscovered = (a) => !!(a?.researchedAt || (a?.hook || "").trim());
const discoveryDateOf = (a) => a?.researchedAt || "";

/* ---- pool readiness ----
   Phase belongs to the CALENDAR, not to a company — today is a discovery day
   or a reachout day and every pool member shares that. What varies per company
   is how far along it is:

     parked    → in the pool, no hook yet. Discovery hasn't reached it.
     hooked    → researched, one line written. Sitting in the write queue.
     contacted → has a real status and a contact date. GRADUATED: it now shows
                 in the regular pipeline.

   Graduating is not a move. The record never leaves the pool — `fromPool`
   is permanent, because coverage measures progress against a fixed set. If
   working a company removed it from the pool, "14 of 45 covered" would become
   uncomputable as the pool drained. One record, two views. */
/* ---- unified pool membership ----
   A pool member can be tracked either as an APPLICATION (you're going after a
   specific role) or as an ACCOUNT (you're going after the company, and will
   work several contacts inside it). Both carry `fromPool`, so coverage counts
   them the same way and the Pool tab lists them together — the distinction is
   only about which shape of record fits the target.

   Normalising here means computePoolGoal and the Pool view read one list
   instead of each re-deriving the same thing from two arrays. */
function poolMembers(state, apps) {
  const out = new Map();
  const put = (m) => {
    const cur = out.get(m.key);
    if (!cur) return out.set(m.key, m);
    /* same company tracked both ways — merge rather than double-count */
    out.set(m.key, {
      ...cur,
      worked: cur.worked || m.worked,
      discovered: cur.discovered || m.discovered,
      firstContact: [cur.firstContact, m.firstContact].filter(Boolean).sort()[0] || "",
      addedAt: [cur.addedAt, m.addedAt].filter(Boolean).sort()[0] || "",
      discoveredAt: [cur.discoveredAt, m.discoveredAt].filter(Boolean).sort()[0] || "",
      refs: [...cur.refs, ...m.refs],
    });
  };
  (apps || []).forEach((a) => {
    if (!isFromPool(a) || a.archivedAt || a.tombstoned) return;
    const key = normCompanyName(a.company);
    if (!key) return;
    put({
      key,
      company: a.company,
      kind: "application",
      poolName: a.poolName || "",
      hook: a.hook || "",
      worked: poolCompanyWorked(a),
      discovered: poolCompanyDiscovered(a),
      firstContact: poolCompanyWorked(a) ? a.contacted : "",
      discoveredAt: discoveryDateOf(a),
      addedAt: a.poolAddedAt || "",
      refs: [{ kind: "application", id: a.id, entry: a }],
    });
  });
  (state?.accounts || []).forEach((acc) => {
    if (!isFromPool(acc) || acc.archivedAt || acc.tombstoned) return;
    const key = normCompanyName(acc.company);
    if (!key) return;
    /* an account is WORKED once any of its contacts has real activity */
    const live = (acc.contacts || []).filter((c) => !c.archivedAt && !c.tombstoned && c.status && c.contacted);
    const firstContact = live.map((c) => c.contacted).sort()[0] || "";
    put({
      key,
      company: acc.company,
      kind: "account",
      poolName: acc.poolName || "",
      hook: acc.hook || "",
      worked: live.length > 0,
      discovered: !!(acc.researchedAt || (acc.hook || "").trim()),
      firstContact,
      discoveredAt: acc.researchedAt || "",
      addedAt: acc.poolAddedAt || "",
      refs: [{ kind: "account", id: acc.id, entry: acc }],
    });
  });
  return Array.from(out.values());
}

const poolReadiness = (a) => (poolCompanyWorked(a) ? "contacted" : poolCompanyDiscovered(a) ? "hooked" : "parked");
const memberReadiness = (m) => (m.worked ? "contacted" : m.discovered ? "hooked" : "parked");

/* ---- work items: one row per PERSON ----
   Coverage counts companies — that's what the pool is sized against. But a
   hook is a line about a human ("I saw your post on IT audits"), so an account
   with three contacts needs three hooks, not one shared one. Sharing it is how
   personalisation quietly disappears from a method built on it.

   So members expand into work items: one per live contact for accounts, one
   for an application (it holds a single contact), and one for an account with
   nobody in it yet so the hook has somewhere to live until someone is added.

   Readiness is judged PER PERSON. Writing a hook for Ana moves Ana to "ready
   to write" while her colleague Ben stays in "need a hook" — which is exactly
   the behaviour asked for, and it falls out of the model rather than needing
   special cases.

   Accounts keep an account-level hook as a FALLBACK so nothing written before
   this change vanishes; it simply stops being shared once a contact has its
   own. */
function poolWorkItems(members) {
  const items = [];
  (members || []).forEach((m) => {
    const accRef = m.refs.find((r) => r.kind === "account");
    if (accRef) {
      const acc = accRef.entry;
      const live = (acc.contacts || []).filter((c) => !c.archivedAt && !c.tombstoned);
      if (live.length) {
        live.forEach((c) => {
          items.push({
            key: `${m.key}::${c.id}`,
            member: m,
            company: m.company,
            kind: "contact",
            contactId: c.id,
            contactName: c.name || "",
            contactPosition: c.position || "",
            hook: c.hook || acc.hook || "",
            hookPolished: c.hookPolished || "",
            hookPolishedFrom: c.hookPolishedFrom || "",
            researchedAt: c.researchedAt || acc.researchedAt || "",
            /* this person specifically — a colleague being contacted doesn't
               mean this one has been */
            worked: !!(c.status && c.contacted),
            firstContact: c.status && c.contacted ? c.contacted : "",
            entry: c,
            ref: { kind: "contact", id: acc.id, contactId: c.id, entry: c, account: acc },
          });
        });
        return;
      }
    }
    const ref = m.refs[0];
    const e = ref?.entry || {};
    items.push({
      key: m.key,
      member: m,
      company: m.company,
      kind: ref?.kind || "application",
      contactId: null,
      contactName: e.contact || "",
      contactPosition: e.contactPosition || "",
      hook: e.hook || "",
      hookPolished: e.hookPolished || "",
      hookPolishedFrom: e.hookPolishedFrom || "",
      researchedAt: e.researchedAt || "",
      worked: m.worked,
      firstContact: m.firstContact,
      entry: e,
      ref: { ...ref, contactId: null },
    });
  });
  return items;
}
const workItemReadiness = (w) => (w.worked ? "contacted" : (w.hook || "").trim() ? "hooked" : "parked");
/* ---- cold call outcomes ----
   A call fails in ways an email can't: nobody picks up, a gatekeeper blocks
   you, the number is wrong. Those aren't "no reply" — they mean try another
   time, find another route, or fix the number, and flattening them into the
   email vocabulary throws away the instruction.

   `landed` marks the outcomes where your message actually reached them. Every
   logged call ticks a follow-up by default — dialling is the outreach work, and
   the tick records that you did it — so this flag no longer gates that. It
   drives the wording instead: after a no-answer the modal says plainly that the
   slot is being used on an attempt that didn't connect, so burning a follow-up
   is a choice you make rather than one made for you. */
const CALL_OUTCOMES = [
  { key: "spoke", label: "Spoke with them", tone: "green", landed: true },
  { key: "voicemail", label: "Left a voicemail", tone: "amber", landed: true },
  { key: "callback", label: "Asked to call back", tone: "blue", landed: true },
  { key: "noanswer", label: "No answer", tone: "muted", landed: false },
  { key: "gatekeeper", label: "Blocked by gatekeeper", tone: "amber", landed: false },
  { key: "wrongnumber", label: "Wrong number", tone: "red", landed: false },
  { key: "notinterested", label: "Not interested", tone: "red", landed: true },
  { key: "cannotcontact", label: "Can't be reached", tone: "red", landed: false },
];
const callOutcome = (k) => CALL_OUTCOMES.find((o) => o.key === k) || null;
/* outcomes that end the pursuit — the contact closes so it drops out of due
   lists and the nurture clock instead of sitting there looking live */
const CALL_CLOSES = ["notinterested", "cannotcontact", "wrongnumber"];
/* speaking to someone, or being asked to call back, means a human engaged —
   that's the same signal the email side calls a reply */
const CALL_IS_REPLY = ["spoke", "callback"];

const POOL_READINESS_META = {
  parked: { label: "PARKED", color: "muted", hint: "no hook yet" },
  hooked: { label: "HOOKED", color: "amber", hint: "ready to write" },
  contacted: { label: "GRADUATED", color: "green", hint: "now in the pipeline" },
};
/* The pool is OPEN for additions during discovery weeks and CLOSED during
   reachout weeks — the cycle already encodes the whole open/closed rhythm, so
   there's no separate closure date to keep in sync.

   The lock is deliberately scoped to POOL additions only. Regular "track
   application" stays completely free, because the discipline being enforced is
   about outbound discovery — a referral, an inbound reply or a posting that
   landed in your lap is not discovery, and blocking those would be wrong. */

/* ============================================================
   CYCLE PHASES — discovery timeline vs reachout timeline

   A cycle is N weeks (default 6) anchored to the pool's build/refresh date.
   The first D weeks (default 2) are DISCOVERY: research companies, find
   contacts, write one hook each. The rest is REACHOUT: write to what you
   already loaded. Refreshing the pool restarts the cycle, so a new discovery
   window arrives on its own.

   Why the discovery target is DERIVED, not chosen: discovery week exists to
   load the queue for the whole cycle. So the honest number is

       weekly write budget × reachout weeks

   At 8/week over 4 reachout weeks that's 32 companies to research — roughly
   2.7 hours at five minutes each. Showing that arithmetic is half the point
   of this mode: it makes the trade visible instead of theoretical, so the
   numbers get set from evidence rather than optimism.
   ============================================================ */
function cyclePhase(settings) {
  const cycleWeeks = Math.max(2, +settings?.cycleWeeks || DEFAULT_CYCLE_WEEKS);
  const discoveryWeeks = Math.max(1, Math.min(cycleWeeks - 1, +settings?.discoveryWeeks || DEFAULT_DISCOVERY_WEEKS));
  const reachoutWeeks = cycleWeeks - discoveryWeeks;
  const anchor = settings?.cycleStart || iso(mondayOfToday());
  /* align the anchor to a Monday so weeks-in-cycle never straddles a boundary */
  const start0 = iso(mondayOf(new Date(anchor + "T00:00:00")));
  const t = today();
  const daysIn = Math.max(0, Math.floor((new Date(t + "T00:00:00") - new Date(start0 + "T00:00:00")) / 86400000));
  const cycleIndex = Math.floor(daysIn / (cycleWeeks * 7));
  const cycleStart = addDays(start0, cycleIndex * cycleWeeks * 7);
  const weekInCycle = Math.floor((Math.floor((new Date(t + "T00:00:00") - new Date(cycleStart + "T00:00:00")) / 86400000)) / 7);
  const phase = weekInCycle < discoveryWeeks ? "discovery" : "reachout";
  return {
    cycleWeeks,
    discoveryWeeks,
    reachoutWeeks,
    cycleIndex,
    cycleStart,
    cycleEnd: addDays(cycleStart, cycleWeeks * 7 - 1),
    discoveryEnd: addDays(cycleStart, discoveryWeeks * 7 - 1),
    reachoutStart: addDays(cycleStart, discoveryWeeks * 7),
    weekInCycle,
    phase,
  };
}

/* ---- switch-off rules ----
   1. Past weeks keep the mode they were LIVED under. Switching modes appends a
      segment rather than rewriting history, so a weekly review never claims you
      missed a quota that didn't exist at the time.
   2. Carry zeroes on switch. Debt in one currency ("12 applications behind")
      must not silently convert into the other ("12 hooks behind"); they aren't
      the same work. The reset date bounds every rollover walk.
   3. Funnel metrics stay continuous — replies, screens, interviews and offers
      are mode-agnostic and are never segmented. */
const modeSegments = (settings) => (Array.isArray(settings?.modeHistory) ? settings.modeHistory : []);
const modeOnDate = (settings, date) => {
  const segs = modeSegments(settings)
    .filter((s) => s?.startedAt && s.startedAt <= date)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return segs.length ? segs[segs.length - 1].mode : "standard";
};
/* rollover walks must not reach back past the most recent mode switch */
const carryFloor = (settings) => {
  const segs = modeSegments(settings).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return segs.length ? segs[segs.length - 1].startedAt : "";
};

function computePoolGoal(state, apps) {
  /* NOTE the Number.isFinite check rather than ||: a deliberate 0 means "no
     weekly pacing, just show me coverage", and `0 || DEFAULT` would override it. */
  const raw = state?.settings?.poolWeeklyWrite;
  const weeklyTarget = Math.max(0, Number.isFinite(+raw) ? +raw : DEFAULT_POOL_WEEKLY_WRITE);
  const cyc = cyclePhase(state?.settings);
  const floor = carryFloor(state?.settings);

  /* distinct by company across BOTH shapes — coverage is about companies
     reached, not rows made, and a company tracked as an account counts the
     same as one tracked as an application */
  const members = poolMembers(state, apps);
  const total = members.length;
  const worked = members.filter((m) => m.worked).length;
  const remaining = total - worked;
  const discovered = members.filter((m) => m.discovered).length;
  /* the queue reachout actually draws from: researched but not yet written to */
  const readyToWrite = members.filter((m) => m.discovered && !m.worked).length;

  /* ---- discovery track ----
     Discovery is genuinely TWO jobs, and collapsing them into one number made
     the app claim you'd done nothing after an afternoon of list-building:

       BUILD — find the companies and get them into the pool. Real work, and
               the first thing the philosophy asks for ("40–50, two sittings").
       HOOK  — spend five minutes on each and write one line. This is what
               makes a company writable, so it's what actually loads the
               reachout queue.

     They're counted separately and the daily ask follows whichever is the
     live bottleneck: build until the pool is stocked, then hook. Both are
     discovery, neither is double-counted. */
  const discoveryTargetCycle = weeklyTarget * cyc.reachoutWeeks;
  const discoveredThisCycle = members.filter((m) => m.discoveredAt && m.discoveredAt >= cyc.cycleStart).length;
  const discoveryPerWeek = cyc.discoveryWeeks > 0 ? Math.ceil(discoveryTargetCycle / cyc.discoveryWeeks) : 0;
  const discoveryShortfall = Math.max(0, discoveryTargetCycle - discoveredThisCycle);
  const poolSize = total;
  const buildRemaining = Math.max(0, discoveryTargetCycle - poolSize);
  const needHook = members.filter((m) => !m.discovered).length;
  /* build first, hook second — but once the pool is stocked there's nothing
     left to build, so the ask flips automatically */
  const discoveryMode = buildRemaining > 0 ? "build" : "hook";

  /* ---- this week's target, whichever track is live ---- */
  const mon = iso(mondayOfToday());
  const t = today();
  const inDiscovery = cyc.phase === "discovery";
  /* Rule A: never ask for outreach that isn't loaded. Cap at the real queue and
     report the gap instead of sending you back to discovery mid-cycle. */
  const weekTargetRaw = inDiscovery ? discoveryPerWeek : weeklyTarget;
  const weekTarget = inDiscovery ? weekTargetRaw : Math.min(weekTargetRaw, readyToWrite + members.filter((m) => m.worked && m.firstContact >= mon).length);
  const outOfHooks = !inDiscovery && weekTargetRaw > weekTarget;

  const eventOn = (d) =>
    inDiscovery
      ? discoveryMode === "build"
        ? members.filter((m) => m.addedAt === d).length
        : members.filter((m) => m.discoveredAt === d).length
      : members.filter((m) => m.worked && m.firstContact === d).length;
  const doneThisWeek = inDiscovery
    ? discoveryMode === "build"
      ? members.filter((m) => m.addedAt && m.addedAt >= mon).length
      : members.filter((m) => m.discoveredAt && m.discoveredAt >= mon).length
    : members.filter((m) => m.worked && m.firstContact && m.firstContact >= mon).length;

  /* daily walk inside the week only — Sunday rests, and the walk never reaches
     back past a mode switch (switch-off rule 2) */
  const perDay = weekTarget > 0 ? Math.max(1, Math.ceil(weekTarget / 6)) : 0;
  let dailyCarry = 0;
  let todaysTarget = 0;
  let carryIntoToday = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    if (d > t) break;
    if (floor && d < floor) continue; /* pre-switch days contribute nothing */
    const dow = new Date(d + "T00:00:00").getDay();
    const base = dow === 0 ? 0 : perDay;
    const effective = Math.max(0, base + dailyCarry);
    if (d === t) {
      todaysTarget = effective;
      carryIntoToday = dailyCarry;
    }
    dailyCarry = effective - eventOn(d);
  }
  const doneToday = eventOn(t);

  return {
    ...cyc,
    total,
    worked,
    remaining,
    discovered,
    readyToWrite,
    pct: total ? Math.round((worked / total) * 100) : 0,
    weeklyTarget,
    discoveryTargetCycle,
    discoveredThisCycle,
    discoveryPerWeek,
    discoveryShortfall,
    inDiscovery,
    discoveryMode,
    poolSize,
    buildRemaining,
    needHook,
    outOfHooks,
    weekTarget,
    doneThisWeek,
    perDay,
    todaysTarget,
    carryIntoToday,
    doneToday,
    todayMet: doneToday >= todaysTarget,
    weeksToCover: weeklyTarget > 0 && remaining > 0 ? Math.ceil(remaining / weeklyTarget) : 0,
    /* the arithmetic that makes the trade visible */
    discoveryHoursEstimate: +((discoveryTargetCycle * 5) / 60).toFixed(1),
    poolName: members.find((m) => m.poolName)?.poolName || "",
    members,
  };
}

const relatedApplications = (accountCompany, apps) => {
  const key = normCompanyName(accountCompany);
  if (!key) return [];
  return apps.filter((a) => normCompanyName(a.company) === key);
};

/* ============================================================
   OPPORTUNITY CONVERGENCE — same company + same job title = one thing

   Several pipeline entries can point at the SAME real opportunity: three
   contacts messaged at one company, or an account contact alongside a
   standalone application, all for one job title.

   While those are still at "outreach" or "applied" they are genuinely
   distinct work — three messages sent is three pieces of effort, and each
   rightly counts 1 toward the goal. But the moment a company actually starts
   evaluating you for that role, there is only ONE screening, ONE interview,
   ONE final round, ONE offer, ONE rejection. Counting those per-entry
   inflates both the goal and the funnel.

   So from "screening" onward, every entry sharing a company + job title
   collapses to a SINGLE count in goals and in every funnel metric — while
   outreach and applied stay distinct, exactly as before.
   ============================================================ */
const CONVERGED_STATUSES = ["screening", "interview", "final round", "offer", "rejected", "bad fit"];
const isConvergedStatus = (s) => CONVERGED_STATUSES.includes(s);
const normRoleName = (s) => (s || "").trim().toLowerCase();
/* the identity of a real opportunity: company + job title + attempt number,
   all normalized. Null when company or role is missing — an entry that can't
   be identified never collapses into anything; it always counts on its own.
   The attempt number keeps a REAPPLICATION separate from the original: they
   share a company and role but they are two distinct shots at the job, so a
   new attempt reaching screening must not drag the old rejected entry with it. */
const opportunityKey = (a) => {
  const c = normCompanyName(a?.company);
  const r = normRoleName(a?.role);
  return c && r ? `${c}||${r}||${attemptOf(a)}` : null;
};
/* deterministic pick of which entry in a converged group is THE one that
   counts: earliest contacted date wins (so the count stays in the week the
   work actually started, instead of hopping around as statuses change),
   tie-broken by id so the result never depends on array order. */
const earlierEntry = (a, b) => {
  const da = a?.contacted || "9999-12-31";
  const db = b?.contacted || "9999-12-31";
  if (da !== db) return da < db ? a : b;
  return (a?.id || "") <= (b?.id || "") ? a : b;
};
/* pure: given every pipeline entry, returns only those that should COUNT.
   Converged entries (screening onward) sharing one company+role are reduced
   to a single representative; everything else — outreach, applied, followed
   up, replied, and anything missing a company or role — passes through
   untouched. Used by goals and by every funnel metric, never by the tables
   themselves: the individual entries all remain visible and editable. */
function collapseCountedEntries(apps) {
  const rep = new Map();
  (apps || []).forEach((a) => {
    if (!isConvergedStatus(a?.status)) return;
    const key = opportunityKey(a);
    if (!key) return;
    const cur = rep.get(key);
    if (!cur) return void rep.set(key, a);
    /* The earliest entry stays the one that COUNTS, so the count sits in the
       week the work actually started. But its siblings' history is ABSORBED
       rather than dropped — otherwise an older, emptier row could silently
       discard the sibling that recorded the interview, and the funnel would
       lose a stage that genuinely happened. */
    const base = earlierEntry(a, cur);
    const other = base === a ? cur : a;
    rep.set(key, {
      ...base,
      milestonesLogged: Array.from(new Set([...(base.milestonesLogged || []), ...(other.milestonesLogged || [])])),
      gotReply: !!(base.gotReply || other.gotReply),
    });
  });
  if (!rep.size) return apps || [];
  const mergedById = new Map();
  rep.forEach((v) => mergedById.set(v.id, v));
  return (apps || [])
    .map((a) => {
      if (!isConvergedStatus(a?.status) || !opportunityKey(a)) return a;
      return mergedById.get(a.id) || null; /* absorbed into its group's representative */
    })
    .filter(Boolean);
}

/* pure: when one entry is moved to a converged stage, every other entry for
   the same company + job title is describing that same event — so they're all
   moved to the same status, and any account contact linked to them follows
   suit (mapped into the coarser contact vocabulary). This is what keeps the
   pipeline from showing one company at three different stages for one role.

   Siblings get their milestone RECORD updated so history stays consistent,
   but deliberately emit no win toasts: it was one screening, so it earns one
   celebration — the source entry's — not one per contact. Returns updated
   { applications, accounts, changed }; a no-op for non-converged statuses. */
function propagateConvergedStatus(applications, accounts, sourceApp, newStatus) {
  if (!isConvergedStatus(newStatus)) return { applications, accounts, changed: 0 };
  const key = opportunityKey(sourceApp);
  if (!key) return { applications, accounts, changed: 0 };
  const sourceId = sourceApp?.id;
  const affectedIds = new Set();
  const nextApps = (applications || []).map((a) => {
    if (a.id === sourceId) return a; /* the caller already set this one */
    if (opportunityKey(a) !== key) return a;
    if (a.status === newStatus) return a;
    affectedIds.add(a.id);
    const m = computeMilestoneWins(a, newStatus);
    return {
      ...a,
      status: newStatus,
      contacted: !a.contacted ? sourceApp?.contacted || a.contacted : a.contacted,
      milestonesLogged: m ? m.milestonesLogged : a.milestonesLogged,
      ...latchOnClose(a, newStatus),
    };
  });
  /* linked account contacts follow too — including the source's own, so the
     Accounts view never disagrees with the Pipeline view */
  const contactStatus = mapAppStatusToContactStatus(newStatus);
  const nextAccounts = (accounts || []).map((acc) => {
    let touched = false;
    const contacts = (acc.contacts || []).map((c) => {
      const link = c.linkedApplicationId;
      if (!link || (link !== sourceId && !affectedIds.has(link))) return c;
      if (c.status === contactStatus) return c;
      touched = true;
      return { ...c, status: contactStatus };
    });
    return touched ? { ...acc, contacts } : acc;
  });
  return { applications: nextApps, accounts: nextAccounts, changed: affectedIds.size };
}

/* Aggressiveness controls BOTH how big the daily quota is AND, when ramp-up is
   on, how gently/quickly you build up to it. Chill = lower quota, slow 2-week
   warm-up. Aggressive = higher quota (pushes past the strict math), 3-day ramp. */
const AGGRESSIVENESS = {
  chill: { label: "Chill", emoji: "🌱", quotaMultiplier: 0.8, rampDays: 14, rampStart: 0.3 },
  steady: { label: "Steady", emoji: "⚖️", quotaMultiplier: 1.0, rampDays: 7, rampStart: 0.5 },
  aggressive: { label: "Aggressive", emoji: "🔥", quotaMultiplier: 1.25, rampDays: 3, rampStart: 0.7 },
};
const aggressivenessOf = (goal) => AGGRESSIVENESS[goal?.aggressiveness] || AGGRESSIVENESS.steady;
/* the target for one specific 1-based day-index in the campaign, given ramp settings */
function dailyTargetForDay(goal, dayIndex, fullQuota) {
  if (!goal.rampEnabled) return fullQuota;
  const preset = aggressivenessOf(goal);
  const rampDays = Math.max(1, preset.rampDays);
  if (rampDays === 1 || dayIndex >= rampDays) return fullQuota;
  const startVal = Math.max(1, Math.round(fullQuota * preset.rampStart));
  const frac = (dayIndex - 1) / (rampDays - 1);
  return Math.max(1, Math.round(startVal + (fullQuota - startVal) * frac));
}

/* Spread a signed WEEKLY rollover across a week's day-bases, Monday-first, each
   working day absorbing at most its own base before the rest spills to the next
   day — this is what stops a whole week's miss (or surplus) from dumping onto
   Monday as one spike. Directly implements: "minus on Monday unless it exceeds,
   then minus on Tuesday, and so on" — and the same, mirrored, for a shortfall.
     rollIn > 0  → last week fell SHORT: add to days (a day can at most double,
                   i.e. take +base); overflow spills to the next working day.
     rollIn < 0  → last week OVERachieved: subtract from days (a day can drop to
                   0 at most, i.e. give back -base); overflow spills forward.
   Sundays (base 0) are rest days: they never absorb any rollover. Any remainder
   that can't fit the whole week (|rollIn| bigger than the week's capacity) is
   returned as `leftover` so nothing is silently lost — the caller carries it on. */
function spreadRollover(dayBases, rollIn) {
  let remaining = rollIn;
  const dayTargets = dayBases.map((base) => {
    if (base <= 0) return 0; /* rest day — no target, absorbs nothing */
    if (remaining > 0) {
      const add = Math.min(remaining, base); /* cap: at most double this day */
      remaining -= add;
      return base + add;
    }
    if (remaining < 0) {
      const give = Math.min(base, -remaining); /* cap: down to 0 at most */
      remaining += give;
      return base - give;
    }
    return base;
  });
  return { dayTargets, leftover: remaining };
}

/* Rollover: walks day 1 -> uptoDayIndex, carrying yesterday's shortfall/surplus
   into today. Overachieving reduces tomorrow's target (never below 0);
   falling short adds the remainder on top of tomorrow's base target. Only
   TODAY's number is speculatively exposed on its own — future days aren't
   speculatively adjusted, since their actuals aren't known yet. Also returns
   the full day-by-day breakdown (perDay), which is what lets the weekly view
   be DERIVED from this same walk instead of running its own separate carry
   — the two can never disagree if they're built from the same numbers. */
function computeDailyRollout(goal, apps, fullQuota, uptoDayIndex) {
  const countsByDate = new Map();
  collapseCountedEntries(apps).forEach((a) => {
    if (a.contacted && isGoalActivity(a)) countsByDate.set(a.contacted, (countsByDate.get(a.contacted) || 0) + 1);
  });
  let carry = 0;
  let carryIntoToday = 0;
  let todaysEffective = fullQuota;
  const perDay = [];
  for (let d = 1; d <= uptoDayIndex; d++) {
    const dateObj = new Date(goal.startDate + "T00:00:00");
    dateObj.setDate(dateObj.getDate() + (d - 1));
    const isSunday = dateObj.getDay() === 0;
    const base = isSunday ? 0 : dailyTargetForDay(goal, d, fullQuota);
    const effective = Math.max(0, base + carry);
    if (d === uptoDayIndex) {
      carryIntoToday = carry;
      todaysEffective = effective;
    }
    const dateIso = iso(dateObj);
    const actual = countsByDate.get(dateIso) || 0;
    perDay.push({ dayIndex: d, date: dateIso, base, effective, actual });
    carry = effective - actual; /* positive = shortfall carries forward; negative = surplus banked */
  }
  return { todaysTarget: todaysEffective, carryIntoToday, perDay };
}

/* pure: derive everything about a goal from the goal record + the pipeline */
/* ---- pausing the standard goal ----
   While pool pacing is on, days lived under it are PAUSED for the standard
   goal: they contribute no daily target, consume no rollover carry, and push
   the deadline out by one day each. Nothing is rewritten — `state.goal` is
   untouched and the pause is derived from modeHistory at read time, so
   switching back resumes exactly where you left off instead of dumping weeks
   of accrued debt on you.

   Work done during a pause still counts toward total progress. You don't lose
   credit for applications you sent; only the PACING is suspended. */
const isPausedDay = (settings, date) => !!settings && modeOnDate(settings, date) === "pool";
const countPausedDays = (settings, from, to) => {
  if (!settings || !from || !to) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isPausedDay(settings, d)) n++;
  return n;
};

function computeGoal(goal, apps, st) {
  if (!goal || !goal.target || !goal.days) return null;
  /* Pausing only applies when pool pacing is ACTUALLY driving — mode set to
     pool AND the pool has members. With the mode on but the pool empty, the
     dashboard falls back to this goal, so it must keep owing a real number
     rather than reading 0 because it thinks it's suspended. */
  const settings = st?.settings ? (poolMembers(st, apps).length > 0 ? st.settings : null) : null;
  const preset = aggressivenessOf(goal);
  const fullQuota = Math.max(1, Math.ceil((goal.target / goal.days) * preset.quotaMultiplier));
  const t = today();
  /* the deadline slides by however many days were spent paused, so a pool
     stretch costs you calendar time rather than silently eating your runway */
  const rawDeadline = addDays(goal.startDate, goal.days - 1);
  const pausedSoFar = countPausedDays(settings, goal.startDate, t < rawDeadline ? t : rawDeadline);
  const deadline = addDays(rawDeadline, pausedSoFar);
  const paused = isPausedDay(settings, t);
  const elapsedCalendarDays = Math.min(goal.days, Math.max(0, Math.floor((new Date(t) - new Date(goal.startDate)) / 86400000) + 1));

  /* expected-by-now = sum of each day's scheduled target so far (ramp-aware), skipping Sundays */
  let expectedByNow = 0;
  for (let i = 1; i <= elapsedCalendarDays; i++) {
    const d = new Date(goal.startDate + "T00:00:00");
    d.setDate(d.getDate() + (i - 1));
    if (d.getDay() === 0) continue;
    if (isPausedDay(settings, iso(d))) continue; /* paused: no target was owed */
    expectedByNow += dailyTargetForDay(goal, i, fullQuota);
  }

  /* every "actual" below counts COLLAPSED entries: several contacts chasing
     one company+role converge to a single count once that role reaches
     screening, so the goal reflects real opportunities, not duplicate rows */
  const counted = collapseCountedEntries(apps);
  const actualTotal = counted.filter((a) => a.contacted && a.contacted >= goal.startDate && isGoalActivity(a)).length;
  const actualByNow = counted.filter((a) => a.contacted && a.contacted >= goal.startDate && a.contacted <= t && isGoalActivity(a)).length;
  const actualToday = counted.filter((a) => a.contacted === t && isGoalActivity(a)).length;
  const daysRemaining = Math.max(0, goal.days - elapsedCalendarDays); /* calendar days, same unit as "over N days" */
  const pastDeadline = t > deadline;
  const stillRamping = goal.rampEnabled && elapsedCalendarDays < preset.rampDays;

  /* ============================================================
     TWO-LEVEL ROLLOVER — the whole goal is distributed across the weeks the
     campaign spans, then across Mon–Sat within each week (Sunday = rest, 0):

       LEVEL 1 · DAILY (within a week): each Mon–Sat day carries its own over/
       under into the NEXT day only — +N if short, −N if ahead. Daily carry does
       NOT jump the Sat→Mon boundary; the week hand-off is level 2's job, so a
       rough week never lands on Monday as one spike.

       LEVEL 2 · WEEKLY (between weeks): once a week has FULLY concluded (its
       Saturday is in the past — "only on Saturday"), its net (its fair share +
       what carried in − what was actually done) rolls into the next week and is
       SPREAD via spreadRollover — Monday first, spilling to Tuesday, then
       Wednesday, and so on. Short weeks add (plus), strong weeks subtract
       (minus). An in-progress or future week emits no rollover of its own.
     ============================================================ */

  /* 1. bucket the campaign into Mon–Sat weeks, each carrying its ramp-aware
        per-day base targets (Sundays kept as 0 so the week is always 7 slots) */
  const weekBuckets = new Map();
  let dayCounter = 0;
  for (let d = new Date(goal.startDate + "T00:00:00"); d <= new Date(deadline + "T00:00:00"); d.setDate(d.getDate() + 1)) {
    dayCounter++;
    const wStart = iso(mondayOf(d));
    if (!weekBuckets.has(wStart)) weekBuckets.set(wStart, { weekStart: wStart, label: weekLabel(mondayOf(d)), days: [] });
    const isSunday = d.getDay() === 0;
    const dIso = iso(d);
    const dPaused = isPausedDay(settings, dIso);
    weekBuckets.get(wStart).days.push({
      date: dIso,
      dow: d.getDay(), /* 0=Sun … 6=Sat */
      paused: dPaused,
      /* a paused day owes nothing, exactly like a Sunday */
      base: isSunday || dPaused ? 0 : dailyTargetForDay(goal, dayCounter, fullQuota),
    });
  }

  /* 2. walk the weeks in order, threading the signed weekly rollover through
        spreadRollover. carryIn's sign convention: + = behind coming in, − =
        ahead coming in. Only concluded weeks advance the carry; the moment we
        reach the current (or a future) week, later weeks get a clean carryIn of
        0 — their day targets are the honest spread plan, not a speculative one. */
  const orderedWeeks = Array.from(weekBuckets.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  let rollIn = 0;
  let stoppedCarrying = false;
  const weeks = orderedWeeks.map((w) => {
    const bases = w.days.map((d) => d.base);
    const carryIn = stoppedCarrying ? 0 : rollIn;
    const { dayTargets } = spreadRollover(bases, carryIn);
    const baseSum = bases.reduce((s, b) => s + b, 0);
    const workingDays = bases.filter((b) => b > 0).length;
    const target = dayTargets.reduce((s, b) => s + b, 0);
    const actual = counted.filter((a) => a.contacted && a.contacted >= goal.startDate && weekStartOfDate(a.contacted) === w.weekStart && isGoalActivity(a)).length;
    const weekEnd = addDays(w.weekStart, 5); /* Saturday — week isn't "over" until this has passed */
    const concluded = weekEnd < t;
    const allPaused = w.days.every((d) => d.paused || d.dow === 0);
    if (concluded && !allPaused) {
      /* net handed to next week = fair share + what came in − what got done;
         computed from baseSum+carryIn (not the clamped target) so an oversized
         rollover's un-absorbed remainder rides along and the total reconciles */
      rollIn = baseSum + carryIn - actual;
    } else if (concluded && allPaused) {
      /* a week spent entirely in pool mode passes its carry straight through
         untouched — it owed nothing, so it can neither build nor clear debt */
    } else {
      stoppedCarrying = true;
    }
    const days = w.days.map((d, i) => ({ ...d, target: dayTargets[i] }));
    return { label: w.label, weekStart: w.weekStart, workingDays, baseSum, target, actual, carryIn, days, paused: allPaused };
  });

  const thisWeekStart = iso(mondayOf(new Date(t + "T00:00:00")));
  const thisWeekIdx = weeks.findIndex((w) => w.weekStart === thisWeekStart);

  /* 3. today's number: run LEVEL-1 daily rollover across the current week's
        already-weekly-adjusted day targets. Days before today (and today) roll
        their real over/under forward; future days this week aren't walked (their
        actuals aren't known). Sunday shows 0 — it's a rest day. */
  let todaysTarget, carryIntoToday;
  if (thisWeekIdx !== -1) {
    const wk = weeks[thisWeekIdx];
    let dailyCarry = 0;
    let todaysEffective = null;
    let carryBeforeToday = 0;
    for (const d of wk.days) {
      if (d.date > t) break; /* future day this week — daily carry not known yet */
      if (d.paused) {
        /* suspended: owes nothing and consumes no carry, so the goal picks up
           mid-stride on the day you switch back */
        if (d.date === t) {
          todaysEffective = 0;
          carryBeforeToday = dailyCarry;
        }
        continue;
      }
      const planned = d.target; /* already includes this week's spread weekly rollover */
      const effective = d.dow === 0 ? 0 : Math.max(0, planned + dailyCarry); /* Sunday = rest */
      if (d.date === t) {
        todaysEffective = effective;
        carryBeforeToday = dailyCarry;
      }
      const actualForDay = counted.filter((a) => a.contacted === d.date && isGoalActivity(a)).length;
      dailyCarry = effective - actualForDay;
    }
    todaysTarget = todaysEffective ?? fullQuota;
    carryIntoToday = carryBeforeToday;
  } else {
    /* today falls outside the goal's own span (e.g. goal already ended) —
       fall back to the whole-campaign daily rollout so there's still a
       sensible number rather than nothing */
    const rollout = computeDailyRollout(goal, apps, fullQuota, Math.max(1, elapsedCalendarDays));
    todaysTarget = rollout.todaysTarget;
    carryIntoToday = rollout.carryIntoToday;
  }
  const todayMet = actualToday >= todaysTarget;
  const thisWeek = thisWeekIdx !== -1 ? weeks[thisWeekIdx] : null;

  return {
    fullQuota,
    todaysTarget,
    carryIntoToday,
    actualToday,
    todayMet,
    paused, /* today is being lived under pool pacing — standard goal suspended */
    pausedDays: pausedSoFar,
    rawDeadline,
    stillRamping,
    rampDaysLeft: stillRamping ? Math.max(0, preset.rampDays - elapsedCalendarDays) : 0,
    aggressiveness: preset,
    deadline,
    elapsedCalendarDays,
    expectedByNow,
    actualTotal,
    actualByNow,
    daysRemaining,
    pastDeadline,
    onPace: carryIntoToday <= 0, /* rollover-consistent: the same carry math that already banks/carries daily and weekly surplus is what decides "behind or not" — a naive expectedByNow-vs-actual comparison would ignore any surplus you've already banked */
    pctComplete: Math.min(100, Math.round((actualTotal / goal.target) * 100)),
    weeks,
    thisWeeksTarget: thisWeek?.target ?? null,
    carryIntoThisWeek: thisWeek?.carryIn ?? 0,
    thisWeeksActual: thisWeek?.actual ?? 0,
  };
}

/* ---- milestone celebrations + cycle-completion snapshot ---- */
const MILESTONE_MESSAGES = [
  "You're building real momentum — keep this energy going.",
  "Every number here is proof you're doing the work. Don't stop now.",
  "This is exactly what consistent effort looks like on a graph.",
  "Progress compounds. You're closer than you were yesterday.",
  "The process is working. Trust the numbers, not the mood.",
  "This didn't happen by accident — it happened because you kept feeding the funnel.",
];
/* rest days (Sundays) intentionally have no quota — the message here should
   feel like permission to actually rest, not another thing to perform. Picked
   deterministically from the date so it stays the same all day, but varies
   week to week. */
const REST_DAY_QUOTES = [
  "Rest is not idleness, and to lie sometimes on the grass under trees on a summer day is by no means a waste of time. — John Lubbock",
  "Almost everything will work again if you unplug it for a few minutes, including you. — Anne Lamott",
  "Take rest; a field that has rested gives a bountiful crop. — Ovid",
  "There is virtue in work and there is virtue in rest. Use both and overlook neither. — Alan Cohen",
  "Sometimes the most productive thing you can do is rest.",
  "Rest and self-care are so important. Replenishing your spirit lets you show up fully when it counts. — Eleanor Brown",
  "The time to relax is when you don't have time for it. — Sydney J. Harris",
  "Slow down — everything you're chasing will come around and catch you. — John De Paola",
  "You don't have to be productive every single day. It's OK to rest.",
  "A well-rested mind finds the door that a tired one walks past.",
];
const restDayQuote = (dateStr) => {
  const idx = dateStr.split("").reduce((s, c) => s + c.charCodeAt(0), 0) % REST_DAY_QUOTES.length;
  return REST_DAY_QUOTES[idx];
};
/* pure: builds a full, AI-analyzable snapshot of one completed goal cycle */
function buildCycleSnapshot(s, g, cycleNumber) {
  const apps = s.applications || [];
  const statusCounts = {};
  APP_STATUSES.forEach((st) => {
    statusCounts[st || "(not applied yet)"] = apps.filter((a) => (a.status ?? "") === st).length;
  });
  /* funnel metrics count collapsed entries — one company+role that reached
     screening is one screening, however many contacts were chasing it */
  const counted = collapseCountedEntries(apps);
  const totalApps = counted.filter((a) => !isBlankStatus(a) && !isOutreach(a)).length;
  const totalOutreach = counted.filter((a) => isOutreach(a)).length;
  const replies = counted.filter((a) => reached(a, "replied")).length;
  const screens = counted.filter((a) => reached(a, "screening")).length;
  const interviews = counted.filter((a) => reached(a, "interview")).length;
  const offers = counted.filter((a) => a.status === "offer" || (a.milestonesLogged || []).includes("offer")).length;
  const badFits = counted.filter((a) => isBadFit(a)).length;
  /* the diagnostic split: a no after a real reply points at the conversation,
     a no with total silence points at the resume/ATS/opening-message layer */
  const closedWithReply = counted.filter((a) => isRepliedThenRejected(a)).length;
  const closedNoReply = counted.filter((a) => isRejectedNoReply(a)).length;
  const highConfidence = counted.filter((a) => a.highConfidence).length;
  const topOfFunnel = totalApps + totalOutreach;
  const conversionRatePct = topOfFunnel > 0 ? +((offers / topOfFunnel) * 100).toFixed(1) : 0;

  return {
    id: uid(),
    date: today(),
    category: "Cycle Complete",
    cycleNumber,
    text: `🏁 Cycle ${cycleNumber} complete — goal of ${s.goal.target} applications+outreach reached${offers > 0 ? ` with ${offers} offer${offers === 1 ? "" : "s"}!` : "."}`,
    snapshot: {
      goal: {
        target: s.goal.target,
        days: s.goal.days,
        startDate: s.goal.startDate,
        deadline: g ? g.deadline : null,
        aggressiveness: s.goal.aggressiveness,
        rampEnabled: !!s.goal.rampEnabled,
      },
      funnel: { applications: totalApps, outreach: totalOutreach, replies, screens, interviews, offers, conversionRatePct, badFitCount: badFits, highConfidenceCount: highConfidence, closedWithReply, closedNoReply },
      statusBreakdown: statusCounts,
      pipeline: apps.map((a) => ({
        company: a.company || null,
        role: a.role || null,
        source: a.source || null,
        jobBoardName: a.jobBoardName || null,
        status: a.status || null,
        badReasons: a.badReasons && a.badReasons.length ? a.badReasons : null,
        highConfidence: !!a.highConfidence,
        outreachKind: a.outreachKind || null,
        outreachChannel: a.outreachChannel || null,
        salary: a.salary || null,
        contacted: a.contacted || null,
      })),
      runway: {
        fund: s.runway.fund,
        expenses: s.runway.expenses,
        monthsAtCompletion: s.runway.expenses > 0 ? +(s.runway.fund / s.runway.expenses).toFixed(1) : null,
      },
      emotionalDiary: {
        protocolEntries: (s.emotions || []).map((e) => ({ date: e.date, name: e.name, intensity: e.intensity, claim: e.claim, action: e.action })),
        supportSessions: (s.supportSessions || []).map((sess) => ({
          date: sess.date,
          feeling: sess.feeling,
          intensity: sess.intensity,
          deescalate: sess.deescalate || null,
          reality: sess.reality || null,
          achievements: sess.achievements || null,
          forward: sess.forward || null,
          one_action: sess.one_action || null,
          transcript: sess.script || null,
          isWeeklyVoiceCheckin: sess.kind === "weekly-voice",
        })),
      },
      accomplishmentsLoggedDuringCycle: (s.accomplishments || []).length,
    },
    aiReport: null,
  };
}

/* ---- cross-domain synthesis ----
   Pure, deterministic pattern-noticing across runway, goal pace, emotional
   check-ins, content, and bad-fit reasons. Deliberately NOT an AI call for
   the underlying facts — every number here is computed directly from real
   data, gated behind a minimum sample size, and phrased with fixed language
   ("worth noticing", "coincides with") that never claims causation, never
   issues a directive, and never suggests lowering the compensation floor
   (that decision runs on runway math alone, per the existing rules). An
   optional AI narrative can comment ON TOP of these pre-verified facts, but
   never replaces them or introduces new claims. */
function computeSynthesis(state, apps, zone) {
  const observations = [];

  /* 1. Runway zone vs current goal pace — a snapshot check, not a trend */
  if (state.goal) {
    const runwayTight = zone.name === "TIMELINE COMPRESSES" || zone.name === "DELIBERATE DECISION ZONE";
    const runwayHealthy = zone.name === "FULL LEVERAGE";
    if (runwayTight && state.goal.aggressiveness === "chill") {
      observations.push({
        id: "runway-pace-mismatch",
        icon: "⚠️",
        kind: "watch",
        title: "Runway has tightened, pace hasn't",
        detail: `Your runway zone is "${zone.name}" but your goal is set to Chill pace. Worth checking whether Steady or Aggressive fits your timeline better now — this is about pace, not about lowering the floor.`,
      });
    } else if (runwayHealthy && state.goal.aggressiveness === "aggressive") {
      observations.push({
        id: "runway-pace-room",
        icon: "🌿",
        kind: "info",
        title: "You may have more room than your pace assumes",
        detail: `Runway is at "${zone.name}" — if Aggressive pace feels like a grind, there's room to ease to Steady without real risk to your timeline.`,
      });
    }
  }

  /* 2. Emotional intensity during the active goal window vs. before it started */
  if (state.goal && (state.supportSessions || []).length >= 4) {
    const inCycle = state.supportSessions.filter((s) => s.date >= state.goal.startDate && s.intensity != null);
    const before = state.supportSessions.filter((s) => s.date < state.goal.startDate && s.intensity != null);
    if (inCycle.length >= 2 && before.length >= 2) {
      const avg = (arr) => arr.reduce((sum, x) => sum + (+x.intensity || 0), 0) / arr.length;
      const inAvg = avg(inCycle);
      const beforeAvg = avg(before);
      if (Math.abs(inAvg - beforeAvg) >= 1.5) {
        observations.push({
          id: "intensity-cycle",
          icon: inAvg > beforeAvg ? "📈" : "📉",
          kind: "watch",
          title: inAvg > beforeAvg ? "Intensity is running higher this cycle" : "Intensity is running lower this cycle",
          detail: `Since this goal started, logged emotional intensity has averaged ${inAvg.toFixed(1)}/10, versus ${beforeAvg.toFixed(1)}/10 before it. Worth being aware of — a coincidence in timing, not a diagnosis of why.`,
        });
      }
    }
  }

  /* 3. Content publish dates vs. nearby contact outreach — temporal proximity only, never causal */
  const published = (state.content || []).filter((c) => c.status === "published" && c.date);
  const allContacts = (state.accounts || []).flatMap((a) => a.contacts || []);
  if (published.length >= 1 && allContacts.length >= 1) {
    let nearCount = 0;
    published.forEach((c) => {
      const windowEnd = addDays(c.date, 7);
      if (allContacts.some((ct) => ct.contacted && ct.contacted >= c.date && ct.contacted <= windowEnd)) nearCount++;
    });
    if (nearCount > 0) {
      observations.push({
        id: "content-contact-proximity",
        icon: "📝",
        kind: "positive",
        title: "Contact activity near your published content",
        detail: `${nearCount} of ${published.length} published piece${published.length === 1 ? "" : "s"} had new contact outreach within a week after. Could be coincidence, could be visibility — worth noticing, not a reason to publish for conversion.`,
      });
    }
  }

  /* 4. Bad-fit reason concentration — real repeated signal, gated at 3+ occurrences */
  const allBadReasons = [
    ...apps.filter((a) => a.status === "bad fit").flatMap((a) => a.badReasons || []),
    ...(state.accounts || []).filter((a) => a.status === "bad fit").flatMap((a) => a.badReasons || []),
  ];
  if (allBadReasons.length >= 3) {
    const counts = {};
    allBadReasons.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
    const [topReason, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (topCount / allBadReasons.length >= 0.5) {
      observations.push({
        id: "bad-fit-concentration",
        icon: "📊",
        kind: "watch",
        title: `"${topReason}" keeps coming up`,
        detail: `${topCount} of ${allBadReasons.length} bad-fit taggings cite "${topReason}". That's real, repeated market signal — evidence for negotiating harder or targeting differently, not a reason to lower your floor.`,
      });
    }
  }

  /* 5. Past-cycle benchmark, shown only when there's no active goal to suggest a starting target */
  const pastCycles = (state.accomplishments || []).filter((a) => (a.category === "Past Wins" || a.category === "Cycle Complete") && a.snapshot);
  if (!state.goal && pastCycles.length > 0) {
    const snap = pastCycles[0].snapshot;
    const total = (snap.apps ?? snap.funnel?.applications ?? 0) + (snap.outreach ?? snap.funnel?.outreach ?? 0);
    if (total > 0) {
      observations.push({
        id: "past-cycle-benchmark",
        icon: "📌",
        kind: "info",
        title: "Your own past benchmark",
        detail: `Last time, it took ${total} applications+outreach combined to land an offer. Worth using as a starting point for a new goal target instead of guessing from scratch.`,
      });
    }
  }

  /* 6. Focus-item outcomes — do completed daily-focus suggestions coincide
     with the linked application actually moving forward? Gated at 5+ checked
     outcomes so a couple of coincidences don't masquerade as a trend. Purely
     descriptive: never claims the suggestion caused the movement, since the
     person may well have advanced these regardless of being told to. */
  const checkedOutcomes = (state.accomplishments || []).filter((a) => a.outcomeChecked && a.outcomeAdvanced !== null);
  if (checkedOutcomes.length >= 5) {
    const advanced = checkedOutcomes.filter((a) => a.outcomeAdvanced).length;
    const pct = Math.round((advanced / checkedOutcomes.length) * 100);
    observations.push({
      id: "focus-outcome-rate",
      icon: "📋",
      kind: "info",
      title: "Following the daily focus, checked back later",
      detail: `${advanced} of ${checkedOutcomes.length} completed focus items (${pct}%) saw the linked company move forward within about 10 days after. Worth noticing — not proof the suggestion itself caused it, since you may well have advanced these anyway.`,
    });
  }

  return observations;
}

/* ---- CRM housekeeping agent ----
   Archiving hides an entry from your active view but changes NOTHING about
   its status/contacted date/tags — so goal progress, funnel totals, and
   conversion % (all of which read live from this same data) are completely
   unaffected. Only after 30 MORE untouched days does an archived entry get
   tombstoned: stripped down to just {status, contacted, outreachKind} — the
   only fields any counting logic ever reads — with everything else (company,
   contact, notes, salary, screenshots, etc.) discarded for good. From your
   perspective it's gone; the numbers never move regardless. Applies uniformly
   to every archived entry, with no special-casing by status. */
/* ---- real last-activity date ----
   `contacted` is only the FIRST touch. An entry you diligently followed up on
   last week has real recent activity, and treating it as untouched since the
   original contact date makes the staleness sweep propose archiving your most
   actively-worked leads. So last activity = the latest of:
     · contacted (the first touch)
     · every completed follow-up (doneAt when we have it; otherwise that
       follow-up's scheduled due date, which is close enough for entries
       completed before doneAt stamping existed)
     · every logged touch point date
   Works for both applications and account contacts — they share these fields. */
function lastActivityDate(a) {
  if (!a) return "";
  let latest = a.contacted || "";
  const bump = (d) => {
    if (d && d > latest) latest = d;
  };
  const fus = Array.isArray(a.followUps) ? a.followUps : [];
  fus.forEach((f, i) => {
    if (!f?.done) return;
    bump(f.doneAt || (a.contacted ? followUpDueDate(a.contacted, fus, i) : ""));
  });
  (a.touchpoints || []).forEach((t) => bump(t?.date));
  return latest;
}

const HOUSEKEEPING_STALE_DAYS = 30;

/* ---- auto-archive ----
   An application still sitting at a PRE-REPLY stage 30 days after its last real
   activity has told you what it's going to tell you. Rather than inventing a
   "ghosted" status for it, it just gets filed: archived, CSV-backed, out of the
   funnel — exactly the treatment a closed application gets.

   Deliberately limited to stages before anyone answered:
     · outreach / applied / followed up  → auto-filed. Silence is the outcome.
     · replied and beyond                → NEVER auto-filed. A conversation that
       went quiet deserves a human decision, so those keep going to the
       housekeeping tray for you to judge.
     · blank status                      → NEVER auto-filed. That's the
       saved-for-later shelf; parking something there is intentional.
   Account-linked entries are skipped too — those are managed via their contact. */
const AUTO_ARCHIVE_STATUSES = ["outreach", "applied", "followed up"];
function computeAutoArchivable(state, apps) {
  if (state?.settings?.autoArchiveStale === false) return [];
  const days = Math.max(1, +state?.settings?.autoArchiveDays || HOUSEKEEPING_STALE_DAYS);
  const cutoff = addDays(today(), -days);
  return (apps || []).filter((a) => {
    if (a.archivedAt || a.tombstoned || a.fromAccountContact) return false;
    if (!AUTO_ARCHIVE_STATUSES.includes(a.status)) return false;
    if (hadReply(a)) return false; /* a reply happened at some point — human call */
    const last = lastActivityDate(a);
    return !!last && last <= cutoff;
  });
}
const HOUSEKEEPING_TOMBSTONE_DAYS = 30;
function computeHousekeepingProposals(state, apps) {
  const cutoff = addDays(today(), -HOUSEKEEPING_STALE_DAYS);
  const proposals = [];

  apps.forEach((a) => {
    if (a.archivedAt || a.tombstoned || a.fromAccountContact) return; /* synced entries are managed via their contact, not directly */
    if (!isOpenApp(a)) return; /* closed already — nothing to clean up */
    /* measured from REAL last activity, not the original contact date — an
       entry followed up on recently is being actively worked, not rotting */
    const last = lastActivityDate(a);
    if (!last || last > cutoff) return;
    /* auto-archive handles pre-reply silence on its own; this tray is for the
       entries that need a human call — ones where somebody actually answered */
    if (state?.settings?.autoArchiveStale !== false && AUTO_ARCHIVE_STATUSES.includes(a.status) && !hadReply(a)) return;
    const days = daysSince(last);
    const viaFollowUp = last !== a.contacted;
    proposals.push({
      type: "application",
      id: a.id,
      label: a.company || "Unnamed application",
      detail: `No activity in ${days} days (last${viaFollowUp ? " touch" : ""}: ${last}).`,
    });
  });

  (state.accounts || []).forEach((acc) => {
    (acc.contacts || []).forEach((c) => {
      if (c.archivedAt || c.tombstoned) return;
      if (!isContactOpen(c) || !isContactOutreached(c)) return;
      const last = lastActivityDate(c);
      if (!last || last > cutoff) return;
      const days = daysSince(last);
      const viaFollowUp = last !== c.contacted;
      proposals.push({
        type: "contact",
        accountId: acc.id,
        contactId: c.id,
        label: `${c.name || "Unnamed"} @ ${acc.company || "Unnamed account"}`,
        detail: `No activity in ${days} days (last${viaFollowUp ? " touch" : ""}: ${last}).`,
      });
    });
  });

  return proposals;
}
/* pure: applies the tombstone step to any application/contact whose archive
   window has expired. Called from migrate() so it runs automatically. */
function applyTombstones(state) {
  const cutoff = addDays(today(), -HOUSEKEEPING_TOMBSTONE_DAYS);
  const applications = state.applications.map((a) => {
    if (!a.archivedAt || a.tombstoned || a.archivedAt > cutoff) return a;
    return { id: a.id, status: a.status, contacted: a.contacted, outreachKind: a.outreachKind || "", fromAccountContact: !!a.fromAccountContact, archivedAt: a.archivedAt, tombstoned: true };
  });
  const accounts = state.accounts.map((acc) => ({
    ...acc,
    contacts: (acc.contacts || []).filter((c) => !(c.archivedAt && c.archivedAt <= cutoff)), /* contacts aren't counted directly, so once their window expires they're simply removed — their linked application (if any) already has its own independent archive/tombstone lifecycle */
  }));
  return { ...state, applications, accounts };
}

/* ---- CSV backup, captured at the moment something is archived ----
   Tombstoning strips a record down to bare counting fields 30 days after
   archiving — this is what keeps the full detail (company, contact, notes,
   salary, everything) from being lost for good: a flat row is captured
   HERE, before any stripping ever happens, and only ever cleared when the
   person explicitly deletes the backup themselves. */
const CSV_COLUMNS = ["archivedDate", "type", "company", "role", "contact", "email", "contactPhone", "contactLinkedin", "status", "contacted", "outreachKind", "salary", "source", "touchpoints", "notes"];
const summarizeTouchpoints = (tps) => (tps || []).map((t) => `${t.channel || "?"} (${t.date}${t.note ? `: ${t.note}` : ""})`).join("; ");
function csvRowFromApplication(a) {
  return { archivedDate: today(), type: "application", company: a.company || "", role: a.role || "", contact: a.contact || "", email: a.email || "", contactPhone: a.contactPhone || "", contactLinkedin: a.contactLinkedin || "", status: a.status || "", contacted: a.contacted || "", outreachKind: a.outreachKind || "", salary: a.salary || "", source: a.source || "", touchpoints: summarizeTouchpoints(a.touchpoints), notes: a.notes || "" };
}
function csvRowFromContact(accountCompany, c) {
  return { archivedDate: today(), type: "contact", company: accountCompany || "", role: c.position || "", contact: c.name || "", email: c.email || "", contactPhone: c.phone || "", contactLinkedin: c.linkedin || "", status: c.status || "", contacted: c.contacted || "", outreachKind: c.outreachKind || "", salary: "", source: "", touchpoints: summarizeTouchpoints(c.touchpoints), notes: c.notes || "" };
}
function rowsToCsv(rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((k) => esc(r[k])).join(","))];
  return lines.join("\n");
}
/* ============================================================
   DAILY SNAPSHOTS

   A rolling set of end-of-day copies kept in this browser, separate from both
   the live state and the synced record. They exist for the failure modes the
   sync can't help with: a bad edit propagating to every device, a corrupted
   remote write, or a bulk action that turned out wrong — cases where "restore
   from the server" restores the same damage.

   One per day, taken the first time the app loads on a new day, which captures
   the state as it stood at the END of the previous day. Kept for 14 days, and
   stored under their own key so clearing the app's working state doesn't take
   the history with it. Local-only by design: a snapshot that syncs is a
   snapshot that inherits whatever went wrong remotely.
   ============================================================ */
const SNAP_KEY = "fd-snapshots";
const SNAP_KEEP = 14;
function readSnapshots() {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}
function writeSnapshots(list) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(list.slice(0, SNAP_KEEP)));
    return true;
  } catch (e) {
    /* quota is the realistic failure — drop the oldest and try once more
       rather than losing the whole history */
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify(list.slice(0, Math.max(3, Math.floor(SNAP_KEEP / 2)))));
      return true;
    } catch (e2) {
      return false;
    }
  }
}
/* a snapshot is worth taking only if there's something in it — an empty state
   would otherwise overwrite a good history on a fresh install or failed load */
const snapshotWorthKeeping = (st) => !!st && ((st.applications || []).length > 0 || (st.accounts || []).length > 0 || (st.content || []).length > 0);
const snapshotSummary = (st) => ({
  applications: (st.applications || []).length,
  accounts: (st.accounts || []).length,
  contacts: (st.accounts || []).reduce((n, a) => n + (a.contacts || []).length, 0),
  content: (st.content || []).length,
  copy: (st.copyDrafts || []).length,
});

function triggerCsvDownload(rows, filename) {
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


/* multi-step follow-ups: a.followUps = [{days, done}] counted from `contacted` */
/* ---- job posting freshness ----
   A posting you applied to weeks ago may already be filled or expired, which
   makes a follow-up pointless (or worse, makes you look like you didn't check).
   `postVerified` records the last date you confirmed the posting was still
   live; when it's never been checked we fall back to the contact date, since
   that's the last moment the posting was definitely real. */
const POSTING_STALE_DAYS = 21;
const postingCheckedOn = (a) => a?.postVerified || a?.contacted || "";
const postingNeedsCheck = (a) => {
  if (!a?.postLink) return false; /* nothing to re-check */
  if (!isOpenApp(a) || isBlankStatus(a)) return false;
  const checked = postingCheckedOn(a);
  if (!checked) return false;
  return checked <= addDays(today(), -POSTING_STALE_DAYS);
};

const DEFAULT_FOLLOWUPS = [3, 7, 14]; /* days after the application date: day 3, day 7, day 14 */
/* how many follow-ups count as one day's realistic workload. Used two ways:
   to spread NEW entries off already-loaded days, and to split the due list
   into "today's batch" vs "queued behind it" so the UI never shows a wall. */
const DEFAULT_FOLLOWUP_DAILY_CAP = 8;
const normFollowUps = (a) => {
  if (Array.isArray(a.followUps)) return a.followUps; /* respects both a populated AND a deliberately-cleared [] array */
  if (a.followUpDays != null) return [{ days: +a.followUpDays || 7, done: false }];
  return DEFAULT_FOLLOWUPS.map((d) => ({ days: d, done: false }));
};
/* cumulative due date for the follow-up at `index` — each entry's "days"
   value is the GAP from the PREVIOUS follow-up (or from the application date
   for the very first one), not a fixed offset from the application date on
   its own. So with the default 3/7/14, the due dates land at day 3, day 10
   (3+7), and day 24 (3+7+14) after the application — not independently at
   day 3/7/14. A gap of 1 correctly means "the very next calendar day". */
function followUpDueDate(contacted, fus, index) {
  let totalDays = 0;
  for (let i = 0; i <= index; i++) totalDays += +fus[i]?.days || 0;
  return addDays(contacted, totalDays);
}
/* next pending follow-up → {date, index, total} or null when all done / no contact date */
const nextFollowUp = (a) => {
  if (!a.contacted) return null;
  const fus = normFollowUps(a);
  const i = fus.findIndex((f) => !f.done);
  if (i === -1) return null;
  return { date: followUpDueDate(a.contacted, fus, i), index: i, total: fus.length };
};
const followUpOf = (a) => nextFollowUp(a)?.date || "";

/* ---- follow-up load smoothing ----
   Counts how many OPEN entries already have their next follow-up landing on
   each date. Used to keep a newly-added entry from piling onto a day that's
   already full: batch-adding 20 applications on one Monday otherwise schedules
   20 follow-ups for the same Thursday. */
function followUpLoadByDate(applications, accounts) {
  const load = new Map();
  const add = (d) => {
    if (d) load.set(d, (load.get(d) || 0) + 1);
  };
  (applications || []).forEach((a) => {
    if (a.archivedAt || a.tombstoned || !isOpenApp(a) || isBlankStatus(a)) return;
    add(followUpOf(a));
  });
  (accounts || []).forEach((acc) =>
    (acc.contacts || []).forEach((c) => {
      if (c.archivedAt || c.tombstoned || !isContactOpen(c) || !isContactOutreached(c)) return;
      add(followUpOf(c));
    })
  );
  return load;
}
/* Returns a follow-up array whose FIRST gap is nudged forward just far enough
   that its due date lands on a day under the cap — later gaps are relative to
   it, so the whole chain shifts with it and the intervals you configured are
   preserved exactly. Never pulls a date earlier, never shifts more than a week,
   and no-ops when capping is off or the day already has room. */
function spreadFollowUps(followUps, contacted, load, cap) {
  const fus = (followUps || []).map((f) => ({ ...f }));
  if (!cap || cap <= 0 || !contacted || !fus.length) return fus;
  const baseGap = Math.max(0, +fus[0].days || 0);
  for (let shift = 0; shift <= 7; shift++) {
    const candidate = addDays(contacted, baseGap + shift);
    if ((load.get(candidate) || 0) < cap) {
      fus[0] = { ...fus[0], days: baseGap + shift };
      return fus;
    }
  }
  return fus; /* every nearby day is full — leave it alone rather than push it out indefinitely */
}
/* splits a due list into the batch worth doing today and the rest, so the UI
   can show a realistic ask instead of every overdue item at once */
const splitDueByCap = (list, cap) => (!cap || cap <= 0 || list.length <= cap ? { batch: list, queued: [] } : { batch: list.slice(0, cap), queued: list.slice(cap) });
const isDue = (a) => {
  if (isBlankStatus(a)) return false; /* not applied/reached out yet — nothing to follow up on */
  const n = nextFollowUp(a);
  return !!(n && isOpenApp(a) && n.date <= today());
};

/* ---- daily focus model ---- */
const normFocus = (arr) =>
  (arr || []).map((f) => (typeof f === "string" ? { text: f, key: false, company: "" } : { text: f?.text || "", key: !!f?.key, company: f?.company || "" }));

/* resolves a focus item's named company to a real, currently-tracked
   application — used to snapshot "before" state so a later check can see
   whether it actually moved forward. Never guesses across ambiguous matches;
   an empty/unmatched company simply isn't tracked for outcome purposes. */
function resolveApplicationForCompany(company, apps) {
  if (!company || !company.trim()) return null;
  const q = company.trim().toLowerCase();
  const matches = (apps || []).filter((a) => !a.fromAccountContact && (a.company || "").trim().toLowerCase() === q);
  if (matches.length !== 1) return null; /* no match, or ambiguous (multiple companies with the same name) */
  const app = matches[0];
  return { id: app.id, statusIdx: STAGE_IDX[app.status] ?? -2 };
}

/* Day rollover: archive done items, carry over unfinished ones.
   Returns { coach, archived, shouldGenerate }. Pure function. Completed items
   tied to a specific company get a status snapshot + a future check-back
   date, so a later pass can see whether the suggestion coincided with real
   forward movement — see checkFocusOutcomes. */
function rolloverCoach(c, todayStr, apps) {
  const t = todayStr || today();
  if (!c || !c.daily || !c.dailyDate) return { coach: { ...(c || {}), daily: null, dailyDate: null, dailyDone: [] }, archived: [], shouldGenerate: true };
  if (c.dailyDate === t) return { coach: c, archived: [], shouldGenerate: false };
  const items = normFocus(c.daily.focus);
  const doneIdx = new Set(c.dailyDone || []);
  const archived = items
    .filter((_, i) => doneIdx.has(i))
    .map((it) => {
      const entry = { id: uid(), date: c.dailyDate, text: it.text, category: it.key ? "Key focus" : "Daily focus" };
      const resolved = resolveApplicationForCompany(it.company, apps || []);
      if (resolved) {
        entry.linkedAppId = resolved.id;
        entry.linkedCompany = it.company;
        entry.statusIdxAtCompletion = resolved.statusIdx;
        entry.outcomeCheckDate = addDays(c.dailyDate, 10);
        entry.outcomeChecked = false;
        entry.outcomeAdvanced = null;
      }
      return entry;
    });
  const remaining = items.filter((_, i) => !doneIdx.has(i));
  if (remaining.length === 0) {
    return { coach: { ...c, daily: null, dailyDate: null, dailyDone: [] }, archived, shouldGenerate: true };
  }
  return {
    coach: { ...c, daily: { ...c.daily, focus: remaining, carried: true }, dailyDate: t, dailyDone: [] },
    archived,
    shouldGenerate: false,
  };
}
/* runs alongside migrate() — finds completed focus items whose check-back
   date has arrived, and records whether the linked application actually
   advanced since. Purely descriptive data collection; the conclusions (if
   any) only ever surface through Patterns, with the same hedged, no-causation
   framing as every other observation there. */
function checkFocusOutcomes(state) {
  const t = today();
  let changed = false;
  const appsById = new Map((state.applications || []).map((a) => [a.id, a]));
  const accomplishments = (state.accomplishments || []).map((a) => {
    if (!a.linkedAppId || a.outcomeChecked || !a.outcomeCheckDate || a.outcomeCheckDate > t) return a;
    changed = true;
    const app = appsById.get(a.linkedAppId);
    if (!app) return { ...a, outcomeChecked: true, outcomeAdvanced: null }; /* deleted since — inconclusive, not counted either way */
    const currentIdx = STAGE_IDX[app.status] ?? -2;
    return { ...a, outcomeChecked: true, outcomeAdvanced: currentIdx > a.statusIdxAtCompletion };
  });
  return changed ? { ...state, accomplishments } : state;
}

/* ---- content schedule: which day does which stage happen on ---- */
const CONTENT_SCHEDULE_STAGES = ["idea", "draft", "design", "scheduled"];
const CONTENT_STAGE_LABEL = { idea: "Ideate", draft: "Draft", design: "Design", scheduled: "Schedule / queue" };
const CONTENT_STAGE_VERB = { idea: "Come up with an idea", draft: "Write a draft", design: "Design/produce it", scheduled: "Schedule or queue it to publish" };
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/* which stage(s) are scheduled for a given date, per the weekly schedule */
function stagesForDate(schedule, dateStr) {
  const dow = new Date(dateStr + "T00:00:00").getDay();
  return CONTENT_SCHEDULE_STAGES.filter((stage) => (schedule?.[stage] || []).includes(dow));
}
/* pure: runs alongside migrate(). Ensures today has a log entry if a stage is
   scheduled, and marks yesterday's entry "missed" if it was scheduled but
   never checked done — the actual continue/skip prompt is a runtime UI
   concern (see the useEffect in FlightDeck), this just prepares the data. */
function rollContentScheduleLog(state, todayStr) {
  const t = todayStr || today();
  const yesterday = addDays(t, -1);
  let log = state.contentScheduleLog || {};
  let changed = false;

  const yEntry = log[yesterday];
  if (yEntry && !yEntry.done && !yEntry.missed) {
    log = { ...log, [yesterday]: { ...yEntry, missed: true } };
    changed = true;
  }

  if (!log[t]) {
    const stages = stagesForDate(state.contentSchedule, t);
    if (stages.length) {
      log = { ...log, [t]: { stage: stages[0], done: false, missed: false } };
      changed = true;
    }
  }

  return changed ? { ...state, contentScheduleLog: log } : state;
}
/* published-content milestones: first at 3, then every +5 after (3, 8, 13, 18...) */
function publishedMilestoneCrossed(oldCount, newCount) {
  if (newCount <= oldCount) return null;
  if (oldCount < 3 && newCount >= 3) return 3;
  if (oldCount >= 3) {
    const nextRung = oldCount + (5 - ((oldCount - 3) % 5));
    if (newCount >= nextRung) return nextRung;
  }
  return null;
}

const DEFAULT_STATE = {
  applications: [],
  accounts: [],
  content: [],
  contentGoal: { perWeek: 3, bufferTarget: DEFAULT_CONTENT_BUFFER_TARGET, ideaFloor: DEFAULT_CONTENT_IDEA_FLOOR, frozenWeeks: [] },
  contentSchedule: { idea: [1], draft: [2, 3], design: [4], scheduled: [5] }, /* weekday index: 0=Sun..6=Sat. Default: Mon ideate, Tue/Wed draft, Thu design, Fri schedule/queue */
  contentScheduleLog: {}, /* keyed by date "YYYY-MM-DD" -> { stage, done, missed } */
  funnel: [],
  emotions: [],
  decisions: [],
  accomplishments: [],
  supportSessions: [],
  goal: null,
  cycleCount: 0,
  runway: { fund: 1200000, expenses: 50000 },
  copyDrafts: [],
  settings: { checkinDay: 1, timezoneOffset: 8 },
  lastCheckinMonth: null,
  lastDigestShownDate: null,
  archivedCsvRows: [],
  /* names parked while the pool is closed (reachout weeks). Not pipeline
     entries yet — they cost nothing and count nothing until a discovery week
     pulls them in. This is the pressure valve: ideas keep arriving whether the
     pool is open or not, and blocking them outright just makes you fight the app. */
  poolBench: [],
  /* ---- housekeeping snoozes ----
     Skipping used to live in the modal's own state, so it evaporated the
     moment the modal closed and every skipped entry came straight back on the
     next open. "Skip" has to mean "not now" for longer than the session or
     it's just a way to scroll.

     Stored as { key, until } and re-offered after the snooze window — a stale
     entry you deliberately kept should still resurface eventually, otherwise
     it's silently dropped from the sweep forever. */
  housekeepingSnoozes: [],
  /* ---- deletion tombstones ----
     Sync merges the local and remote copies with a UNION, which can only ever
     ADD records — it has no way to express "this one is gone". So a delete was
     undone by the very next pull: the record still existed remotely (or in a
     save that hadn't landed yet) and the union handed it straight back.
     Recording the id of anything deleted is what makes removal survive a merge.
     Covers applications, accounts, content and individual contacts, since all
     of them carry unique ids. */
  deletedIds: [],
  lastCsvPromptDate: null,
  lastContentScheduleCheckDate: null,
};
const DEFAULT_COACH = { dailyDate: null, daily: null, dailyDone: [], weeklyDate: null, weekly: null };

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/* migrate older saved shapes into v3 */
function migrate(saved) {
  const s = { ...DEFAULT_STATE, ...saved };
  if (!Array.isArray(s.applications)) s.applications = [];
  if (!Array.isArray(s.accounts)) s.accounts = [];
  if (!Array.isArray(s.content)) s.content = [];
  if (!Array.isArray(s.archivedCsvRows)) s.archivedCsvRows = [];
  if (!Array.isArray(s.poolBench)) s.poolBench = [];
  if (!Array.isArray(s.housekeepingSnoozes)) s.housekeepingSnoozes = [];
  s.copyDrafts = Array.isArray(s.copyDrafts) ? s.copyDrafts.map(normCopyDraft) : [];
  /* drop expired snoozes so the list can't grow forever */
  s.housekeepingSnoozes = s.housekeepingSnoozes.filter((x) => x && x.key && x.until && x.until > today());
  if (!Array.isArray(s.deletedIds)) s.deletedIds = [];
  /* tombstones only need to outlive the window in which a stale copy could
     still resurface; 180 days is far beyond that, and pruning keeps the
     synced payload from growing forever */
  s.deletedIds = s.deletedIds.filter((d) => d && d.id && (!d.at || d.at > addDays(today(), -180)));
  /* one-time backfill: pool members created before add-dates were tracked have
     no poolAddedAt, so their build work would read as zero. Stamped once, on
     first load after upgrading — a pool without the date is one that was built
     before this existed, and the alternative is silently discarding real work. */
  const stampPool = (r) => (r && r.fromPool && !r.poolAddedAt ? { ...r, poolAddedAt: today() } : r);
  s.applications = s.applications.map(stampPool);
  s.accounts = (s.accounts || []).map(stampPool);
  if (!s.contentGoal || typeof s.contentGoal !== "object") s.contentGoal = { perWeek: 3 };
  if (typeof s.contentGoal.bufferTarget !== "number") s.contentGoal.bufferTarget = DEFAULT_CONTENT_BUFFER_TARGET;
  if (typeof s.contentGoal.ideaFloor !== "number") s.contentGoal.ideaFloor = DEFAULT_CONTENT_IDEA_FLOOR;
  if (!Array.isArray(s.contentGoal.frozenWeeks)) s.contentGoal.frozenWeeks = [];
  if (!s.contentSchedule || typeof s.contentSchedule !== "object") s.contentSchedule = { idea: [1], draft: [2, 3], design: [4], scheduled: [5] };
  ["idea", "draft", "design", "scheduled"].forEach((k) => {
    if (!Array.isArray(s.contentSchedule[k])) s.contentSchedule[k] = [];
  });
  if (!s.contentScheduleLog || typeof s.contentScheduleLog !== "object") s.contentScheduleLog = {};
  if (!Array.isArray(s.accomplishments)) s.accomplishments = [];
  if (!Array.isArray(s.supportSessions)) s.supportSessions = [];
  if (!s.settings || typeof s.settings !== "object") s.settings = { checkinDay: 1 };
  if (!s.settings.checkinDay) s.settings.checkinDay = 1;
  if (typeof s.settings.timezoneOffset !== "number") s.settings.timezoneOffset = 8;
  if (!Array.isArray(s.settings.followUpDefaults) || !s.settings.followUpDefaults.length)
    s.settings.followUpDefaults = [...DEFAULT_FOLLOWUPS];
  /* max follow-ups to surface as "today's" work. Batch-adding 20 applications
     on one day used to make all 20 follow-ups come due on the same later day —
     a wall of red that trains you to ignore the flag entirely. 0 = no cap. */
  if (typeof s.settings.followUpDailyCap !== "number") s.settings.followUpDailyCap = DEFAULT_FOLLOWUP_DAILY_CAP;
  if (typeof s.settings.autoArchiveStale !== "boolean") s.settings.autoArchiveStale = true;
  if (!s.settings.aiProvider) s.settings.aiProvider = "builtin";
  if (typeof s.settings.aiModel !== "string") s.settings.aiModel = "";
  if (typeof s.settings.aiBaseUrl !== "string") s.settings.aiBaseUrl = "";
  /* who you are, in one paragraph — without this the drafts are generic */
  if (typeof s.settings.aiPitch !== "string") s.settings.aiPitch = "";
  if (typeof s.settings.aiSenderName !== "string") s.settings.aiSenderName = "";
  if (typeof s.settings.aiWebSearch !== "boolean") s.settings.aiWebSearch = true;
  if (typeof s.settings.aiMaxTokens !== "number") s.settings.aiMaxTokens = AI_MAX_TOKENS_DEFAULT;
  if (!s.settings.defaultTouchChannel) s.settings.defaultTouchChannel = DEFAULT_TOUCH_CHANNEL;
  s.settings.draftSections = normDraftSections(s.settings.draftSections);
  if (typeof s.settings.autoArchiveDays !== "number") s.settings.autoArchiveDays = HOUSEKEEPING_STALE_DAYS;
  /* "standard" = the original N-over-N-days quota. "pool" = coverage pacing
     over Pool Mode's closed company set. */
  if (s.settings.goalMode !== "pool") s.settings.goalMode = s.settings.goalMode === "pool" ? "pool" : s.settings.goalMode || "standard";
  if (typeof s.settings.poolWeeklyWrite !== "number") s.settings.poolWeeklyWrite = DEFAULT_POOL_WEEKLY_WRITE;
  if (typeof s.settings.cycleWeeks !== "number") s.settings.cycleWeeks = DEFAULT_CYCLE_WEEKS;
  if (typeof s.settings.discoveryWeeks !== "number") s.settings.discoveryWeeks = DEFAULT_DISCOVERY_WEEKS;
  if (!s.settings.cycleStart) s.settings.cycleStart = iso(mondayOfToday());
  /* switch-off rule 1: mode history is append-only so past weeks keep the mode
     they were lived under. Seed it with whatever mode is current. */
  if (!Array.isArray(s.settings.modeHistory)) s.settings.modeHistory = [{ startedAt: s.settings.cycleStart, mode: s.settings.goalMode || "standard" }];
  s.accounts = s.accounts.map((a) => ({ ...a, contacts: Array.isArray(a.contacts) ? a.contacts : [] }));
  /* one-time cleanup: a past bug dropped linkedApplicationId every time the
     account form reopened, causing outreach on a contact to spawn a fresh
     duplicate application instead of updating the existing linked one. Any
     fromAccountContact application no longer referenced by any contact's
     linkedApplicationId is an orphan (either the true duplicate left behind,
     or a contact that's since been removed) — safe to drop. */
  if (s.applications.some((a) => a.fromAccountContact)) {
    const liveLinkedIds = new Set(s.accounts.flatMap((a) => (a.contacts || []).map((c) => c.linkedApplicationId).filter(Boolean)));
    s.applications = s.applications.filter((a) => !a.fromAccountContact || liveLinkedIds.has(a.id));
  }
  /* legacy single followUpDays → followUps array; records with NO status field
     at all (saved before this feature existed) default to "applied" so old
     data isn't silently reclassified — but a deliberate status: "" (saved
     for later) is left alone */
  s.applications = s.applications.map((a) => {
    const withStatus = a.status === undefined ? { ...a, status: "applied" } : a;
    return Array.isArray(withStatus.followUps) && withStatus.followUps.length
      ? withStatus
      : { ...withStatus, followUps: normFollowUps(withStatus) };
  });
  s.funnel = (s.funnel || []).map((w) => {
    if (Array.isArray(w.applications) && w.applications.length) {
      s.applications = [...w.applications.map((a) => ({ ...a })), ...s.applications];
    }
    const { applications, ...rest } = w;
    return rest;
  });
  return rollContentScheduleLog(checkFocusOutcomes(applyTombstones(s)));
}

/* ---------- merge (two-way sync without data loss) ---------- */
/* union entry lists by id — remote order first, local-only appended; remote wins id collisions */
function unionById(localArr = [], remoteArr = []) {
  const remoteIds = new Set(remoteArr.map((x) => x && x.id));
  return [...remoteArr, ...localArr.filter((x) => x && !remoteIds.has(x.id))];
}
function mergeStates(localS, remoteS) {
  if (!remoteS) return localS;
  if (!localS) return remoteS;
  /* a deletion recorded on EITHER side wins over the other side still holding
     the record — otherwise the union quietly resurrects it */
  const tombs = [...(localS.deletedIds || []), ...(remoteS.deletedIds || [])];
  const gone = new Set(tombs.map((d) => d && d.id).filter(Boolean));
  const alive = (arr) => (arr || []).filter((x) => x && !gone.has(x.id));
  const dedupeTombs = Array.from(new Map(tombs.filter((d) => d && d.id).map((d) => [d.id, d])).values());
  return {
    ...remoteS,
    deletedIds: dedupeTombs,
    applications: alive(unionById(localS.applications, remoteS.applications)),
    /* contacts live inside accounts, so a deleted contact rides back in on its
       parent account unless it's stripped here too */
    accounts: alive(unionById(localS.accounts, remoteS.accounts)).map((acc) => ({
      ...acc,
      contacts: (acc.contacts || []).filter((c) => c && !gone.has(c.id)),
    })),
    content: alive(unionById(localS.content, remoteS.content)),
    contentGoal: remoteS.contentGoal || localS.contentGoal || { perWeek: 3 },
    funnel: alive(unionById(localS.funnel, remoteS.funnel)),
    emotions: alive(unionById(localS.emotions, remoteS.emotions)),
    decisions: alive(unionById(localS.decisions, remoteS.decisions)),
    accomplishments: alive(unionById(localS.accomplishments, remoteS.accomplishments)),
    poolBench: alive(unionById(localS.poolBench, remoteS.poolBench)),
    /* keyed by proposal key, not id — union by key so a snooze made on one
       device isn't undone by a sync from another */
    housekeepingSnoozes: Array.from(
      new Map([...(localS.housekeepingSnoozes || []), ...(remoteS.housekeepingSnoozes || [])].filter((x) => x && x.key).map((x) => [x.key, x])).values()
    ),
    supportSessions: alive(unionById(localS.supportSessions, remoteS.supportSessions)),
    goal: remoteS.goal || localS.goal || null,
    cycleCount: Math.max(localS.cycleCount || 0, remoteS.cycleCount || 0),
    runway: remoteS.runway || localS.runway,
    copyDrafts: alive(unionById(localS.copyDrafts, remoteS.copyDrafts)),
    settings: { ...localS.settings, ...remoteS.settings },
    lastCheckinMonth:
      (remoteS.lastCheckinMonth || "") > (localS.lastCheckinMonth || "")
        ? remoteS.lastCheckinMonth
        : localS.lastCheckinMonth,
  };
}
function mergeCoach(localC, remoteC) {
  if (!remoteC) return localC;
  if (!localC) return remoteC;
  const out = { ...localC };
  const ld = localC.dailyDate || "";
  const rd = remoteC.dailyDate || "";
  if (rd > ld) {
    out.daily = remoteC.daily;
    out.dailyDate = remoteC.dailyDate;
    out.dailyDone = remoteC.dailyDone || [];
  } else if (rd === ld && rd) {
    /* same day on both: one shared list (remote copy), checkmarks united */
    out.daily = remoteC.daily || localC.daily;
    const lLen = normFocus(localC.daily?.focus).length;
    const rLen = normFocus(remoteC.daily?.focus).length;
    out.dailyDone =
      lLen === rLen
        ? Array.from(new Set([...(localC.dailyDone || []), ...(remoteC.dailyDone || [])]))
        : remoteC.dailyDone || [];
    out.dailyDate = rd;
  }
  if ((remoteC.weeklyDate || "") > (localC.weeklyDate || "")) {
    out.weekly = remoteC.weekly;
    out.weeklyDate = remoteC.weeklyDate;
  }
  if ((remoteC.voiceDate || "") > (localC.voiceDate || "")) {
    out.voiceDate = remoteC.voiceDate;
  }
  return out;
}

/* shared blob-to-base64 for the edge function proxy */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}
async function edgeUpload(bucket, path, blob, contentType) {
  const dataBase64 = await blobToBase64(blob);
  const r = await fetch(EDGE_UPLOAD_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "upload", bucket, path, dataBase64, contentType }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`upload ${r.status}: ${t}`);
  }
}
async function edgeDelete(bucket, path) {
  const r = await fetch(EDGE_UPLOAD_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete", bucket, path }),
  });
  if (!r.ok && r.status !== 404) {
    const t = await r.text().catch(() => "");
    throw new Error(`delete ${r.status}: ${t}`);
  }
}

/* ---------- voice audio storage (Supabase Storage) ---------- */
const AUDIO_TTL_DAYS = 365; /* audio kept 12 months from creation, then user is asked */
const audioPublicUrl = (path) => `${SUPA_URL}/storage/v1/object/public/voice-sessions/${path}`;
async function uploadAudio(path, blob) {
  await edgeUpload("voice-sessions", path, blob, "audio/mpeg");
}
async function deleteAudio(path) {
  await edgeDelete("voice-sessions", path);
}
const isExpiredAudio = (s) => !!(s.audioPath && s.audioCreated && addDays(s.audioCreated, AUDIO_TTL_DAYS) <= today());

/* local audio vault (IndexedDB): holds recordings that couldn't reach the
   cloud yet, so re-listening NEVER re-synthesizes (never spends credits) */
function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("flightdeck-audio", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("audio");
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(id, blob) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("audio", "readwrite");
    tx.objectStore("audio").put(blob, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(id) {
  const db = await idb();
  return new Promise((res, rej) => {
    const rq = db.transaction("audio", "readonly").objectStore("audio").get(id);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbDelete(id) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("audio", "readwrite");
    tx.objectStore("audio").delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function uploadAudioWithRetry(path, blob, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await uploadAudio(path, blob);
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return false;
}

/* job-post screenshot storage */
const shotPublicUrl = (path) => `${SUPA_URL}/storage/v1/object/public/job-posts/${path}`;
async function uploadShot(path, file) {
  await edgeUpload("job-posts", path, file, file.type || "image/png");
}

/* ============================================================
   AI OUTREACH DRAFTING

   The hook is one line about the company. Turning it into a first message is
   the slowest part of a reachout session, so this drafts from it.

   KEY STORAGE — read before changing:
   Your settings object is synced to Supabase and merged across devices. An API
   key placed there would be stored in plaintext in a shared record. So the key
   lives ONLY in this browser's localStorage under `fd-ai-key`, is never put in
   state, and never leaves the device except in the call to the provider you
   chose. The trade-off is real and worth knowing: it doesn't follow you to
   another device, and anyone with access to this browser profile can read it.
   The built-in option avoids the question entirely by keeping the key on the
   server, and is the right default for most people.
   ============================================================ */
const AI_KEY_LS = "fd-ai-key";
const readAiKey = () => {
  try {
    return localStorage.getItem(AI_KEY_LS) || "";
  } catch (e) {
    return "";
  }
};
const writeAiKey = (v) => {
  try {
    if (v) localStorage.setItem(AI_KEY_LS, v);
    else localStorage.removeItem(AI_KEY_LS);
  } catch (e) {}
};
const AI_PROVIDERS = {
  builtin: { label: "Built-in", sub: "No key needed — uses Flight Deck's own endpoint", needsKey: false, defaultModel: "" },
  anthropic: { label: "Anthropic", sub: "Your own Claude API key", needsKey: true, defaultModel: "claude-sonnet-4-5" },
  openai: { label: "OpenAI", sub: "Your own OpenAI API key", needsKey: true, defaultModel: "gpt-4o-mini" },
  custom: { label: "Custom", sub: "Any OpenAI-compatible endpoint (OpenRouter, Groq, local…)", needsKey: true, defaultModel: "" },
};

/* Reasoning models (DeepSeek R1, QwQ, and most "thinking" variants on
   OpenRouter) emit their scratchpad inline before the answer. Strip it — you
   asked for an email, not a transcript of the model deciding to write one.

   Handles the truncated case too: an opening tag with no closing tag means the
   response ran out of tokens mid-thought, so everything from that tag on is
   incomplete reasoning and there is no answer to salvage. */
function stripReasoning(raw) {
  let out = String(raw || "");
  out = out.replace(/<(think|thinking|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi, "");
  /* unclosed opener — drop the tail rather than showing half a thought */
  out = out.replace(/<(think|thinking|reasoning|scratchpad)>[\s\S]*$/gi, "");
  /* some models close without opening after a stripped prefix */
  out = out.replace(/^[\s\S]*?<\/(think|thinking|reasoning|scratchpad)>/gi, "");
  out = out.replace(/```[a-z]*\n?|```/gi, "");
  return out.trim();
}

/* one call, four backends, plain text out. Throws with a readable message so
   the UI can show what actually went wrong instead of a spinner that stops.

   max_tokens is generous because reasoning models spend most of their budget
   thinking before they write anything; a tight cap produced responses that
   were ONLY scratchpad, with the email never reaching the page. */
const AI_MAX_TOKENS_DEFAULT = 4000;
const clampTokens = (n) => Math.max(500, Math.min(16000, +n || AI_MAX_TOKENS_DEFAULT));
async function callAI({ provider, model, baseUrl, key, system, user, webSearch, maxTokens }) {
  const cap = clampTokens(maxTokens);
  const prov = provider || "builtin";
  if (prov === "builtin") {
    const res = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: `${system}\n\n${user}` }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return stripReasoning(
      (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    );
  }
  if (!key) throw new Error("No API key saved — add one in Settings.");

  if (prov === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        /* required for calls made straight from a browser */
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || AI_PROVIDERS.anthropic.defaultModel,
        max_tokens: AI_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        /* Anthropic runs this server-side and returns the finished text in one
           response, so no client round-trip is needed. It's the only provider
           here that can actually LOOK — everything else is working from
           training data and must not be asked to "research". */
        ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }] } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Anthropic error ${res.status}`);
    const aText = stripReasoning(
      (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    );
    if (!aText && data.stop_reason === "max_tokens") throw new Error(`Hit the ${cap}-token limit before writing anything. Raise it in Settings, or use a non-reasoning model.`);
    if (!aText) throw new Error("The model returned nothing usable. Try Redraft, or a different model.");
    return aText;
  }

  /* openai and custom share the chat-completions shape */
  const url = (prov === "custom" ? (baseUrl || "").replace(/\/$/, "") : "https://api.openai.com/v1") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model || AI_PROVIDERS.openai.defaultModel,
      max_tokens: cap,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Provider error ${res.status}`);
  /* note: only `content` is read. Providers that expose the scratchpad in a
     separate `reasoning` / `reasoning_content` field are ignored by design. */
  const text = stripReasoning(data.choices?.[0]?.message?.content || "");
  if (!text) {
    const reason = data.choices?.[0]?.finish_reason;
    if (reason === "length") throw new Error(`Hit the ${cap}-token limit before writing anything. Raise it in Settings, or use a non-reasoning model.`);
    throw new Error("The model returned nothing usable. Try Redraft, or a different model.");
  }
  return text;
}

/* The prompt deliberately forbids the padding that makes cold outreach read as
   template — no "hope this finds you well", no flattery preamble. The hook is
   the opening line because that's the whole point of having researched it. */
/* ---- prompt construction ----
   The prompt is BUILT from which sections the model actually owns, rather than
   being a fixed "write an email" instruction with caveats bolted on.

   That distinction caused a real bug: the base rules said "one clear ask at the
   end" and the user message supplied the sender's positioning, so the model
   dutifully wrote an offer and an ask — then the fixed offer and ask were
   appended underneath, and the email said everything twice. Telling a model
   "write a complete email" and "don't write these parts of it" in the same
   breath is a contradiction, and the stronger instruction wins.

   So: a rule only appears if the model is responsible for that part. */
const OUTREACH_BASE = `You draft short, specific outreach emails for a freelance/in-house graphic designer approaching companies about work.`;

const OUTREACH_RULES_ALWAYS = [
  `No "I hope this finds you well", no flattery preamble, no buzzwords.`,
  `Sound like a person writing one email, not a campaign.`,
  `Never fabricate facts about the company, its funding, its people, or its work. If you don't know something, leave it out.`,
];

function outreachRules(secs) {
  const ai = (id) => secs[id]?.mode === "ai";
  const rules = [...OUTREACH_RULES_ALWAYS];
  if (ai("opening")) rules.push(`Open with the specific hook you're given. Never open with "I came across your company" or similar.`);
  if (ai("ask")) rules.push(`End with one clear, low-friction ask (a short call, or a reply if there's a fit).`);
  /* The corresponding NEGATIVE rules matter more than the positive ones — a
     model's default is to produce a whole email, so it has to be told plainly
     where its part stops. */
  if (!ai("ask")) rules.push(`Do NOT write any call to action, closing question, or "would it be useful if…" line. The ask is already written and will follow your text. Your section must stop before it.`);
  if (!ai("offer")) rules.push(`Do NOT describe what the sender does, their services, or their past clients. That is already written and will follow your text.`);
  if (!ai("signoff")) rules.push(`Do NOT sign off, add a name, or close the email. That is already written.`);
  if (!ai("subject")) rules.push(`Do NOT write a subject line.`);
  return rules.map((r) => `- ${r}`).join("\n");
}

/* variant-specific guidance, appended after the rules */
const VARIANT_BLOCKS = {
  plain: "",
  genericSearch: `
The sender has not researched this company yet. Use web search to find ONE specific, recent, verifiable thing about them — a launch, a rebrand, a funding round, a design hire, a redesign — and open with it.

Only use what you actually found in search results. If search returns nothing solid, return the hook line as "Hook: none found" and keep it plain rather than inventing specifics.

Put this as the FIRST line of your reply:
Hook: <the one-line hook you found, or "none found">`,
  genericNoSearch: `
The sender has not researched this company, and you have NO web access — you cannot look anything up.

Do not invent a hook. Do not reference a launch, rebrand, funding round, product, hire, or anything else specific about this company: you have no way to know it, and a wrong detail in the first line is worse than a plain one. Anything you "remember" about this company may be outdated or wrong.

Keep your sections short and plain — a generic email should make no claim to have done homework it hasn't done.`,
  genericPerson: `
The sender has not researched this company, and you have NO web access. What you DO know is who you're writing to and what they do.

Open by addressing them by first name and role, in this shape:
"Hey <first name>, I saw you're the <position> so I had to reach out."
Adapt the wording so it reads naturally, but keep it that short and direct.

Do not invent anything about the company. If no position was supplied, drop that clause rather than guessing at their job.`,
};

function buildOutreachSystem(secs, variant) {
  return [OUTREACH_BASE, "", "Hard rules:", outreachRules(secs), VARIANT_BLOCKS[variant] || "", "", "=== SECTIONS ===", buildSectionInstructions(secs)].filter((x) => x !== null).join("\n");
}

/* the sentinels the hook field understands */
const isGenericHook = (h) => /^generic$/i.test((h || "").trim());
/* "generic person" — no company research, but address a named human by role.
   Weaker than a real hook and stronger than a nameless generic: the recipient
   at least sees you know who they are and what they do. */
const isGenericPersonHook = (h) => /^generic\s+person$/i.test((h || "").trim());

/* every addressable human on a pool member, normalised across both shapes.
   Applications carry a single loose contact field and no position; accounts
   carry a proper contact list. */
function contactsOf(member) {
  const ref = member?.refs?.[0];
  if (!ref) return [];
  const e = ref.entry || {};
  if (ref.kind === "account")
    return (e.contacts || [])
      .filter((c) => !c.archivedAt && !c.tombstoned && (c.name || "").trim())
      .map((c) => ({ id: c.id, name: c.name.trim(), position: (c.position || "").trim() }));
  /* deliberately NOT falling back to e.role — that's the job being applied
     for, not this person's title, and "I saw you're the Senior Designer" to a
     hiring manager is a wrong claim in the opening line */
  return (e.contact || "").trim() ? [{ id: ref.id, name: e.contact.trim(), position: (e.contactPosition || "").trim() }] : [];
}
const firstNameOf = (n) => (n || "").trim().split(/\s+/)[0] || "";

/* ============================================================
   DRAFT SECTIONS — what the AI writes and what it must not touch

   The opening should change every time; the offer and the ask should not.
   Those are the lines worth testing and keeping stable, and a model asked to
   "include this ask" will paraphrase it — helpfully, and differently, every
   single time.

   So fixed sections are never sent through the model as text to reproduce.
   The AI writes only its own sections; the email is assembled here, and your
   wording is inserted byte-for-byte. That's the only way "consistent" actually
   means consistent. The model still SEES your fixed text as context, so its
   sections don't duplicate or contradict the ask.
   ============================================================ */
/* `scope` and `exclude` are sent to the model verbatim. The exclusions exist
   because the section boundaries are genuinely ambiguous to a writer: asked to
   write "why them / why you", almost any model will drift into credentials and
   then finish with a call to action — which is precisely the offer and the ask
   it was told not to touch. Naming the forbidden content per section works far
   better than one general "don't repeat the fixed parts" instruction. */
const DRAFT_SECTION_DEFS = [
  { id: "subject", label: "Subject line", hint: "One line, specific, no clickbait", scope: "A subject line only.", exclude: "No greeting, no body text." },
  {
    id: "opening",
    label: "Opening — the hook",
    hint: "The researched detail. Almost always AI.",
    scope: "The greeting and ONE or TWO sentences about the specific thing you researched.",
    exclude: "Do not describe what the sender does. Do not pitch. Do not ask for anything.",
  },
  {
    id: "bridge",
    label: "Why them / why you",
    hint: "Connects the hook to what you do",
    scope: "ONE sentence connecting the hook to why the sender is reaching out to THIS company.",
    exclude:
      "Do NOT list the sender's services, credentials, past clients or experience — that belongs to the offer. Do NOT propose anything, suggest a call, or end with a question — that belongs to the ask. One sentence, then stop.",
  },
  { id: "offer", label: "What you offer", hint: "Your standing pitch. Usually fixed.", scope: "What the sender does and why it's relevant here.", exclude: "No call to action." },
  { id: "ask", label: "The ask", hint: "The one action you want. Usually fixed.", scope: "One clear, low-friction request.", exclude: "No new claims about the sender." },
  { id: "signoff", label: "Sign-off", hint: "Name, link, portfolio. Almost always fixed.", scope: "Name and contact details.", exclude: "No further pitching." },
];
const DEFAULT_DRAFT_SECTIONS = {
  subject: { mode: "ai", text: "" },
  opening: { mode: "ai", text: "" },
  bridge: { mode: "ai", text: "" },
  offer: { mode: "fixed", text: "" },
  ask: { mode: "fixed", text: "" },
  signoff: { mode: "fixed", text: "" },
};
const normDraftSections = (raw) => {
  const out = {};
  DRAFT_SECTION_DEFS.forEach((d) => {
    const v = raw?.[d.id] || {};
    out[d.id] = { mode: v.mode === "fixed" ? "fixed" : "ai", text: typeof v.text === "string" ? v.text : "" };
  });
  return out;
};
/* a fixed section with no text is simply skipped — an empty slot shouldn't
   leave a gap in the email or a stray blank line */
const activeSections = (secs) => DRAFT_SECTION_DEFS.filter((d) => secs[d.id].mode === "ai" || secs[d.id].text.trim());

/* ---- placeholders in fixed sections ----
   Fixed text is inserted verbatim, which is the point — but "verbatim" made it
   impossible to write one ask that names the company. So a small set of
   [Tokens] are substituted at assembly time, on your device, before the text
   is used. The wording still can't be paraphrased by a model; only these exact
   tokens change.

   Case-insensitive so [company] and [Company] both work, and an unknown token
   is left visibly intact rather than silently blanked — a draft reading
   "[Product]" tells you to fix it, one reading "" does not. */
const DRAFT_TOKENS = [
  { token: "company", label: "[Company]", desc: "The company name" },
  { token: "first name", label: "[First name]", desc: "Contact's first name" },
  { token: "name", label: "[Name]", desc: "Contact's full name" },
  { token: "position", label: "[Position]", desc: "Their job title" },
  { token: "role", label: "[Role]", desc: "The role you're going for" },
  { token: "hook", label: "[Hook]", desc: "Your researched hook line" },
  { token: "industry", label: "[Industry]", desc: "Their industry" },
  { token: "me", label: "[Me]", desc: "Your own name" },
];
function fillTokens(text, vars) {
  if (!text) return "";
  return String(text).replace(/\[([a-z ]+)\]/gi, (whole, key) => {
    const k = key.trim().toLowerCase();
    const v = vars[k];
    /* only substitute when we actually have a value — an empty replacement
       would leave "Hi , I saw" and read as a bug in the email itself */
    return v ? v : whole;
  });
}

/* Builds the instruction for exactly the sections the model is allowed to
   write, using [[markers]] so each can be pulled back out and slotted into
   place. */
function buildSectionInstructions(secs) {
  const aiIds = activeSections(secs).filter((d) => secs[d.id].mode === "ai");
  const fixedIds = activeSections(secs).filter((d) => secs[d.id].mode === "fixed");
  const lines = [];
  lines.push("Write ONLY the sections listed below. Each must start with its marker on its own line.");
  aiIds.forEach((d) => lines.push(`[[${d.id}]]  — ${d.label}: ${d.hint}`));
  if (fixedIds.length) {
    lines.push("");
    /* Showing the fixed text is a trade-off: it stops the model contradicting
       the ask, but it also invites imitation. The framing is therefore
       explicit that this is CONTEXT ONLY, and the negative rules above carry
       the real weight. */
    lines.push("For context only — these parts are ALREADY WRITTEN and will be appended after your sections, word for word. You must not restate, paraphrase, preview or echo any of them. If your draft says anything these already say, delete it:");
    fixedIds.forEach((d) => lines.push(`(${d.label}, already written) ${secs[d.id].text.trim()}`));
    lines.push("");
    lines.push("Write ONLY your own sections. Assume the reader will read yours and then those, in order.");
  }
  lines.push("");
  const bodyIds = aiIds.filter((d) => d.id !== "subject");
  lines.push(`Your sections together should be roughly ${Math.max(30, bodyIds.length * 35)} words — this is a fragment of an email, not a whole one. Output nothing except the marked sections.`);
  return lines.join("\n");
}

/* Pulls the [[marked]] blocks out and assembles the final email in section
   order, substituting your fixed text unchanged. */
/* Prompt rules reduce duplication; they don't guarantee it. This catches what
   slips through by comparing the model's sentences against the fixed text and
   dropping ones that say the same thing. Deliberately conservative — it needs
   a strong content-word overlap, so a shared word or two won't delete a good
   sentence. */
const contentWords = (str) =>
  new Set(
    String(str || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
/* Two thresholds, because certainty varies. Above DROP the sentence is almost
   word-for-word and goes silently. Between SUSPECT and DROP it's a semantic
   restatement — same claim, different words — which is too risky to delete on
   a guess but exactly what you want flagged. A real case: an AI bridge saying
   "I help tech and IT companies develop visual collateral" against a fixed
   offer saying "Creative Specialist... develop their marketing collateral"
   scores 0.50 — obviously duplicated to a reader, invisible to a strict cut. */
const ECHO_DROP = 0.6;
const ECHO_SUSPECT = 0.42;
function dropEchoes(aiText, fixedTexts) {
  const fixedSets = fixedTexts.filter(Boolean).map(contentWords);
  if (!fixedSets.length || !aiText) return { text: aiText, suspect: false };
  const sentences = String(aiText).split(/(?<=[.!?])\s+/);
  let suspect = false;
  const kept = sentences.filter((sent) => {
    const w = contentWords(sent);
    if (w.size < 4) return true; /* too short to judge — keep it */
    let worst = 0;
    fixedSets.forEach((fw) => {
      let hits = 0;
      w.forEach((x) => {
        if (fw.has(x)) hits++;
      });
      worst = Math.max(worst, hits / w.size);
    });
    if (worst >= ECHO_DROP) return false;
    if (worst >= ECHO_SUSPECT) suspect = true;
    return true;
  });
  /* never return nothing — if every sentence looked like an echo, the overlap
     check is more likely wrong than the model */
  return { text: kept.length ? kept.join(" ").trim() : String(aiText).trim(), suspect };
}

function assembleDraft(raw, secs, vars) {
  const got = {};
  const re = /\[\[(\w+)\]\]\s*([\s\S]*?)(?=\n\s*\[\[\w+\]\]|$)/g;
  let m;
  while ((m = re.exec(raw || ""))) got[m[1]] = m[2].trim();
  /* substituted BEFORE comparing: the model writes "Stanfield IT" while the
     fixed text still says "[Company]", so an unfilled comparison scores the
     company name as a difference and understates the overlap every time */
  const fixedTexts = DRAFT_SECTION_DEFS.filter((d) => secs[d.id].mode === "fixed").map((d) => fillTokens(secs[d.id].text.trim(), vars || {}));
  const echoWarnings = [];
  const pick = (id) => {
    if (secs[id].mode === "fixed") return fillTokens(secs[id].text.trim(), vars || {});
    const r = dropEchoes(got[id] || "", fixedTexts);
    if (r.suspect) echoWarnings.push(DRAFT_SECTION_DEFS.find((d) => d.id === id)?.label || id);
    return r.text;
  };
  /* Which AI-mode sections came back empty. Without this the fixed sections
     assemble into something that LOOKS like a finished email — the exact
     failure that made a missing subject and opening look like a normal draft. */
  const missing = DRAFT_SECTION_DEFS.filter((d) => secs[d.id].mode === "ai" && !pick(d.id)).map((d) => d.label);
  const subject = pick("subject");
  const body = DRAFT_SECTION_DEFS.filter((d) => d.id !== "subject")
    .map((d) => pick(d.id))
    .filter(Boolean)
    .join("\n\n");
  /* if the model ignored the markers entirely, fall back to its raw text so a
     usable draft still reaches the screen rather than an empty box */
  if (!subject && !body) return { text: (raw || "").trim(), missing, echoWarnings };
  return { text: `${subject ? `Subject: ${subject}\n\n` : ""}${body}`, missing, echoWarnings };
}

/* ---------- supabase rpc ---------- */
async function rpc(fn, args, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
/* ---------- swipe-to-delete / tap-to-edit row ---------- */
function SwipeRow({ onDelete, onTap, showX, children }) {
  const [dx, setDx] = useState(0);
  const start = useRef(null);
  const moved = useRef(false);

  const onTouchStart = (e) => {
    e.stopPropagation();
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    moved.current = false;
  };
  const onTouchMove = (e) => {
    e.stopPropagation();
    if (!start.current) return;
    const t = e.touches[0];
    const ddx = t.clientX - start.current.x;
    const ddy = t.clientY - start.current.y;
    if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) moved.current = true;
    if (Math.abs(ddy) > Math.abs(ddx)) return;
    if (ddx < 0) setDx(Math.max(ddx, -140));
  };
  const onTouchEnd = (e) => {
    e.stopPropagation();
    if (dx < -80) {
      setDx(0); /* snap back visually; the caller decides what happens next (may ask for confirmation first) */
      onDelete();
    } else {
      setDx(0);
      if (!moved.current && onTap) onTap();
    }
    start.current = null;
  };

  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: 12 }}>
      <div style={{ position: "absolute", inset: 0, background: C.red, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 18, color: "#2b0b0b", fontFamily: sans, fontWeight: 700, fontSize: 13, letterSpacing: "0.08em" }}>
        DELETE
      </div>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={() => {
          if (!moved.current && onTap) onTap();
        }}
        style={{ transform: `translateX(${dx}px)`, transition: start.current ? "none" : "transform 0.18s ease-out", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "12px 14px", paddingRight: showX ? 38 : 14, position: "relative", touchAction: "pan-y", cursor: "pointer" }}
      >
        {showX && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete entry"
            style={{ position: "absolute", top: 8, right: 8, width: 24, height: 24, borderRadius: 12, border: `1px solid ${C.panelEdge}`, background: "transparent", color: C.muted, fontSize: 13, lineHeight: "22px", cursor: "pointer", padding: 0 }}
          >
            ×
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

/* ---------- shared pieces ---------- */
function Label({ children, style }) {
  return (
    <div style={{ fontFamily: sans, fontSize: 10, letterSpacing: "0.18em", color: C.muted, textTransform: "uppercase", marginBottom: 4, ...style }}>
      {children}
    </div>
  );
}

/* small, reusable "copy this to clipboard" icon button with its own brief
   confirmation — no dependency on the app's toast system, so it works
   equally well inside the Modal or the main table views. */
function CopyButton({ text, title = "Copy" }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        (navigator.clipboard?.writeText(text) || Promise.reject()).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {}
        );
      }}
      title={copied ? "Copied!" : title}
      style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1, color: copied ? C.green : C.muted, flexShrink: 0 }}
    >
      {copied ? "✓" : "📋"}
    </button>
  );
}

const PAGE_SIZE = 100;
/* shared pagination control — hidden entirely when everything fits on one
   page, so it never adds clutter to short lists. */
function Pagination({ page, setPage, total, pageSize = PAGE_SIZE }) {
  if (total <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
      <span style={{ fontSize: 12, color: C.muted }}>
        Showing {start}–{end} of {total}
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Btn ghost disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} style={{ padding: "6px 14px", fontSize: 12 }}>
          ‹ Prev
        </Btn>
        <span style={{ fontSize: 12, color: C.muted }}>
          Page {page + 1} of {totalPages}
        </span>
        <Btn ghost disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} style={{ padding: "6px 14px", fontSize: 12 }}>
          Next ›
        </Btn>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  fontSize: 16,
  fontFamily: sans,
  color: C.ink,
  background: C.bg,
  border: `1px solid ${C.panelEdge}`,
  borderRadius: 10,
  padding: "10px 12px",
  outline: "none",
};

function Field({ label, value, onChange, type = "text", placeholder }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Label>{label}</Label>
      <input
        type={type}
        inputMode={type === "number" ? "numeric" : "text"}
        value={value}
        placeholder={placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...inputStyle,
          fontFamily: type === "number" ? mono : sans,
          ...(type === "date" ? { width: "auto", maxWidth: 190, colorScheme: "dark", padding: "9px 10px" } : {}),
        }}
      />
    </div>
  );
}

function TextAreaField({ label, hint, value, onChange, placeholder, rows = 4 }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Label>{label}</Label>
        {hint && <span style={{ fontSize: 10, color: C.muted }}>{hint}</span>}
      </div>
      <textarea
        value={value}
        placeholder={placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: sans, minHeight: rows * 22 }}
      />
    </div>
  );
}

function Btn({ children, onClick, color = C.amber, ghost, disabled, style, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ fontFamily: sans, fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", padding: "10px 16px", borderRadius: 10, border: ghost ? `1px solid ${C.panelEdge}` : "none", background: ghost ? "transparent" : disabled ? C.panelEdge : color, color: ghost ? C.muted : "#141a12", opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer", ...style }}
    >
      {children}
    </button>
  );
}

function Panel({ title, children, style }) {
  return (
    <div style={{ minWidth: 0, ...style }}>
      {title && (
        <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.28em", color: C.amber, margin: "0 2px 10px" }}>{title}</div>
      )}
      {children}
    </div>
  );
}

/* ---------- donut analytics (pure SVG) ---------- */
/* generates a color per index using the golden angle (~137.5°) — this spreads
   hues maximally around the color wheel so no two slices ever land on the
   same (or a visually adjacent) color, no matter how many slices there are.
   A fixed palette would repeat once slices exceed its length (e.g. the
   "Where found" donut, which breaks out individual job board names). */
const donutColor = (i) => `hsl(${((i * 137.508) % 360).toFixed(1)}, 68%, 62%)`;
/* status colors are semantic, not just index-distinct — evenly spaced at
   exactly 36° apart (guaranteeing every pair is at least that far apart)
   and deliberately placed so "applied" sits firmly in green and "bad fit"
   sits firmly in red, on opposite sides of the wheel rather than wherever
   array order happens to put them. */
const STATUS_DONUT_HUE = {
  "bad fit": 0,
  rejected: 36,
  screening: 72,
  interview: 108,
  applied: 144,
  offer: 180,
  outreach: 216,
  "followed up": 252,
  "final round": 288,
  replied: 324,
};
const statusDonutColor = (s) => (s ? `hsl(${STATUS_DONUT_HUE[s]}, 65%, 58%)` : C.muted);
function Donut({ data, centerLabel }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const R = 52, SW = 22, CIRC = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <svg width="140" height="140" viewBox="0 0 140 140" style={{ flexShrink: 0 }}>
        <circle cx="70" cy="70" r={R} fill="none" stroke={C.bg} strokeWidth={SW} />
        {total > 0 &&
          data.map((d, i) => {
            const frac = d.value / total;
            const seg = (
              <circle
                key={d.label}
                cx="70"
                cy="70"
                r={R}
                fill="none"
                stroke={d.color || donutColor(i)}
                strokeWidth={SW}
                strokeDasharray={`${Math.max(frac * CIRC - 1.5, 0)} ${CIRC}`}
                strokeDashoffset={-offset * CIRC}
                transform="rotate(-90 70 70)"
                style={{ transition: "stroke-dasharray 0.4s ease" }}
              />
            );
            offset += frac;
            return seg;
          })}
        <text x="70" y="66" textAnchor="middle" fill={C.ink} fontFamily={mono} fontSize="24" fontWeight="700">
          {total}
        </text>
        <text x="70" y="84" textAnchor="middle" fill={C.muted} fontFamily={sans} fontSize="9" letterSpacing="0.14em">
          {centerLabel}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
        {total === 0 && <div style={{ fontSize: 12, color: C.muted }}>No applications yet — the donut fills as the pipeline grows.</div>}
        {data
          .filter((d) => d.value > 0)
          .map((d) => {
            const i = data.indexOf(d);
            return (
              <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: d.color || donutColor(i), flexShrink: 0 }} />
                <span style={{ color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
                <span style={{ fontFamily: mono, color: C.muted, marginLeft: "auto" }}>
                  {d.value} · {Math.round((d.value / total) * 100)}%
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/* ============================================================ */
export default function FlightDeck() {
  const [state, setState] = useState(DEFAULT_STATE);
  const [coach, setCoach] = useState(DEFAULT_COACH);
  const [mode, setMode] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState(null);
  const [syncModal, setSyncModal] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [focusModalOpen, setFocusModalOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); /* { kind: "application"|"account", id, label } */
  const [duplicateSuggestion, setDuplicateSuggestion] = useState(null); /* { pendingApp, duplicateApp } */
  const [reapplySuggestion, setReapplySuggestion] = useState(null); /* { pendingApp, priorAttempts } */
  const [weeklyModalOpen, setWeeklyModalOpen] = useState(false);
  const [patternsModalOpen, setPatternsModalOpen] = useState(false);
  const [housekeepingOpen, setHousekeepingOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [patternsNarrative, setPatternsNarrative] = useState("");
  const [patternsNarrativeLoading, setPatternsNarrativeLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState("local");
  const [crmView, setCrmView] = useState("applications"); /* toggle inside the CRM tab: applications / accounts / pool */
  const [pipeFilter, setPipeFilter] = useState("active");
  const [pipeSearch, setPipeSearch] = useState("");
  const [accSearch, setAccSearch] = useState("");
  const [accFilter, setAccFilter] = useState("active");
  const [contentSearch, setContentSearch] = useState("");
  const [contentFilter, setContentFilter] = useState("all");
  const [contentView, setContentView] = useState("list");
  const [pipeSourceFilter, setPipeSourceFilter] = useState("");
  const [pipeStatusFilter, setPipeStatusFilter] = useState("");
  const [pipeFilterPanelOpen, setPipeFilterPanelOpen] = useState(false);
  const [accFilterPanelOpen, setAccFilterPanelOpen] = useState(false);
  /* pagination — 100 per page across the CRM's larger lists, reset to page 1
     whenever the underlying filter/search changes so you never land on an
     empty page after narrowing down a list */
  const [pipePage, setPipePage] = useState(0);
  /* Due tab: whether the follow-ups queued behind today's capped batch are
     expanded. Defaults collapsed so the tab opens as a doable list. */
  const [showQueuedDue, setShowQueuedDue] = useState(false);
  /* which pool list is showing. Seeded once from the cycle phase so the tab
     opens on whatever the week is actually asking for, then left alone —
     re-deriving it would yank the view out from under you mid-session. */
  const [poolView, setPoolView] = useState(null);
  const [poolSearch, setPoolSearch] = useState("");
  const [copyFilter, setCopyFilter] = useState("all");
  useEffect(() => setPipePage(0), [pipeFilter, pipeSearch, pipeSourceFilter, pipeStatusFilter]);
  /* bulk selection for converting applications to accounts */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedAppIds, setSelectedAppIds] = useState(() => new Set());
  useEffect(() => {
    setSelectedAppIds(new Set());
  }, [pipeFilter, pipeSearch, pipeSourceFilter, pipeStatusFilter]);
  const toggleAppSelected = (id) =>
    setSelectedAppIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [confirmConvert, setConfirmConvert] = useState(false);
  useEffect(() => setConfirmConvert(false), [selectedAppIds]);
  const [accPage, setAccPage] = useState(0);
  useEffect(() => setAccPage(0), [accFilter, accSearch]);
  const [contentPage, setContentPage] = useState(0);
  useEffect(() => setContentPage(0), [contentFilter, contentSearch]);
  const [donutMode, setDonutMode] = useState("status");
  const [historyGroup, setHistoryGroup] = useState("date");
  const [updatingWinId, setUpdatingWinId] = useState(null);
  const [coachLoading, setCoachLoading] = useState(null);
  const [coachError, setCoachError] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceErr, setVoiceErr] = useState("");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceScript, setVoiceScript] = useState("");
  const voiceUrlRef = useRef(null);
  const [canAutoGen, setCanAutoGen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches
  );
  const undoStack = useRef([]);
  const [undoCount, setUndoCount] = useState(0);
  const swipe = useRef(null);
  const syncKeyRef = useRef(null);
  const saveTimer = useRef(null);
  const dirtyRef = useRef(false);
  const pullingRef = useRef(false);
  const channelRef = useRef(null);
  const [keyVersion, setKeyVersion] = useState(0);
  const runDailyRef = useRef(null);

  /* responsive listener */
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const fn = (e) => setIsDesktop(e.matches);
    mq.addEventListener ? mq.addEventListener("change", fn) : mq.addListener(fn);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", fn) : mq.removeListener(fn));
  }, []);

  /* ---- SYNC-FIRST BOOT ----
     1) read local cache  2) fetch remote (remote wins)
     3) run day rollover (archive done / carry unfinished)
     4) only THEN, and only if remote was reachable, allow auto-generation */
  useEffect(() => {
    (async () => {
      let key = null;
      let localState = DEFAULT_STATE;
      let localCoach = DEFAULT_COACH;
      try {
        key = localStorage.getItem("fd-sync-key");
        if (!key) {
          key =
            "fd_" +
            (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
          localStorage.setItem("fd-sync-key", key);
        }
        const ls = localStorage.getItem("fd-state");
        if (ls) localState = migrate(JSON.parse(ls));
        const lc = localStorage.getItem("fd-coach");
        if (lc) localCoach = { ...DEFAULT_COACH, ...JSON.parse(lc) };
      } catch (e) {
        key = key || "fd_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }
      syncKeyRef.current = key;

      let mergedState = localState;
      let mergedCoach = localCoach;
      let remoteOk = false;
      try {
        const remote = await rpc("fd_get", { k: key });
        remoteOk = true;
        if (remote) {
          if (remote.data) mergedState = mergeStates(localState, migrate(remote.data));
          if (remote.coach) mergedCoach = mergeCoach(localCoach, { ...DEFAULT_COACH, ...remote.coach });
        }
        setSyncStatus("synced");
      } catch (e) {
        setSyncStatus("offline");
      }

      const { coach: rolled, archived, shouldGenerate } = rolloverCoach(mergedCoach, null, mergedState.applications);
      if (archived.length) {
        mergedState = { ...mergedState, accomplishments: [...archived, ...(mergedState.accomplishments || [])] };
      }
      setState(mergedState);
      setCoach(rolled);
      setLoaded(true);
      setCanAutoGen(remoteOk);
      if (shouldGenerate && remoteOk) {
        /* one generation for the whole account today — synced to every device */
        setTimeout(() => runDailyRef.current && runDailyRef.current(), 400);
      }
    })();
  }, []);

  /* ---- daily snapshot ----
     Runs once per day on load, BEFORE the day's edits begin, so what it stores
     is yesterday's finished state rather than a half-edited today. */
  /* mirrored into state so the settings list re-renders after a capture,
     restore or delete without needing the modal reopened */
  const [snapshots, setSnapshots] = useState(() => readSnapshots());
  const snapChecked = useRef(false);
  useEffect(() => {
    if (!loaded || snapChecked.current) return;
    snapChecked.current = true;
    if (!snapshotWorthKeeping(state)) return;
    const list = readSnapshots();
    if (list[0]?.date === today()) return; /* already have one for today */
    const next = [{ date: today(), at: new Date().toISOString(), summary: snapshotSummary(state), data: state }, ...list];
    writeSnapshots(next);
    setSnapshots(readSnapshots());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /* Restoring replaces the working state and pushes it to the server, so every
     device converges on the restored copy. A snapshot of the CURRENT state is
     taken first under a separate marker — restoring the wrong day shouldn't be
     the one action you can't undo. */
  const restoreSnapshot = (snap) => {
    if (!snap?.data) return;
    const list = readSnapshots();
    const withPre = [{ date: today(), at: new Date().toISOString(), summary: snapshotSummary(state), data: state, preRestore: true }, ...list.filter((x) => !(x.date === today() && x.preRestore))];
    writeSnapshots(withPre);
    setSnapshots(readSnapshots());
    setState(migrate(snap.data));
    flash(`↺ Restored ${snap.date} — sync will push it to your other devices`);
  };
  const deleteSnapshot = (date) => {
    writeSnapshots(readSnapshots().filter((x) => x.date !== date));
    flash("Snapshot removed");
  };
  /* Restores from a file. Kept separate from the snapshot list because it's
     the recovery path that still works when this browser has lost everything —
     new device, cleared storage, or a machine that never had the app. */
  const importBackupFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        /* refuse anything that isn't recognisably a Flight Deck export rather
           than replacing your data with whatever JSON was selected */
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.applications)) {
          return flash("That doesn't look like a Flight Deck backup");
        }
        const list = readSnapshots();
        writeSnapshots([{ date: today(), at: new Date().toISOString(), summary: snapshotSummary(state), data: state, preRestore: true }, ...list.filter((x) => !(x.date === today() && x.preRestore))]);
        setSnapshots(readSnapshots());
        setState(migrate(parsed));
        flash("↺ Backup imported — sync will push it to your other devices");
      } catch (e) {
        flash("Couldn't read that file");
      }
    };
    reader.onerror = () => flash("Couldn't read that file");
    reader.readAsText(file);
  };

  /* an off-device copy: the one thing that survives losing the browser */
  const exportSnapshot = (snap) => {
    try {
      const blob = new Blob([JSON.stringify(snap.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `flight-deck-${snap.date}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      flash("Couldn't export");
    }
  };

  /* Export whatever is live right now. The daily snapshots only start
     appearing tomorrow, so without this a fresh install has no way to take a
     backup at the moment you most want one — before a risky change. */
  const exportCurrent = () => exportSnapshot({ date: `${today()}-current`, data: state });

  /* save: local immediately, remote debounced */
  useEffect(() => {
    if (!loaded) return;
    dirtyRef.current = true;
    try {
      localStorage.setItem("fd-state", JSON.stringify(state));
      localStorage.setItem("fd-coach", JSON.stringify(coach));
    } catch (e) {}
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        setSyncStatus("saving");
        await rpc("fd_set", { k: syncKeyRef.current, d: state, c: coach });
        dirtyRef.current = false;
        setSyncStatus("synced");
        /* tell the other devices to pull right now */
        try {
          channelRef.current?.send({ type: "broadcast", event: "changed", payload: { t: Date.now() } });
        } catch (e) {}
      } catch (e) {
        setSyncStatus("offline");
      }
    }, 800);
    return () => saveTimer.current && clearTimeout(saveTimer.current);
  }, [state, coach, loaded]);

  /* LIVE RE-SYNC: when the tab regains focus (and every 60s), pull remote
     changes made on other devices and merge them in. Skipped while local
     changes are still unsaved, so nothing gets stomped mid-edit. */
  const pullRemote = useCallback(async () => {
    if (!loaded || dirtyRef.current || pullingRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    pullingRef.current = true;
    try {
      const remote = await rpc("fd_get", { k: syncKeyRef.current });
      if (remote && !dirtyRef.current) {
        setState((prev) => {
          const merged = remote.data ? mergeStates(prev, migrate(remote.data)) : prev;
          return JSON.stringify(merged) === JSON.stringify(prev) ? prev : merged;
        });
        setCoach((prev) => {
          const merged = remote.coach ? mergeCoach(prev, { ...DEFAULT_COACH, ...remote.coach }) : prev;
          return JSON.stringify(merged) === JSON.stringify(prev) ? prev : merged;
        });
        setSyncStatus("synced");
      }
    } catch (e) {
      /* stay quiet — next cycle will retry */
    }
    pullingRef.current = false;
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const onFocus = () => pullRemote();
    const onVis = () => {
      if (!document.hidden) pullRemote();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(pullRemote, 60000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
    };
  }, [loaded, pullRemote]);

  /* REALTIME: private broadcast channel named by the secret sync code.
     Any device that saves sends a ping; every other device pulls within ~1s.
     The 60s poll and focus pull above remain as fallbacks. */
  useEffect(() => {
    if (!loaded || !syncKeyRef.current) return;
    const ch = supa.channel("fd-" + syncKeyRef.current, { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "changed" }, () => {
      if (dirtyRef.current) {
        /* mid-edit here — retry shortly after our own save lands */
        setTimeout(pullRemote, 2500);
      } else {
        pullRemote();
      }
    });
    ch.subscribe();
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      supa.removeChannel(ch);
    };
  }, [loaded, keyVersion, pullRemote]);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 1600);
  };

  const mutate = useCallback((fn, msg) => {
    setState((prev) => {
      undoStack.current = [JSON.parse(JSON.stringify(prev)), ...undoStack.current].slice(0, 3);
      setUndoCount(undoStack.current.length);
      return fn(prev);
    });
    if (msg) flash(msg);
  }, []);

  const undo = () => {
    if (!undoStack.current.length) return;
    const [last, ...rest] = undoStack.current;
    undoStack.current = rest;
    setUndoCount(rest.length);
    setState(last);
    flash("Undone");
  };

  /* mode swipe (mobile only) */
  const bgStart = (e) => {
    if (isDesktop) return;
    const t = e.touches[0];
    swipe.current = { x: t.clientX, y: t.clientY };
  };
  const bgEnd = (e) => {
    if (isDesktop || !swipe.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.current.x;
    const dy = t.clientY - swipe.current.y;
    swipe.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      setMode((m) => (dx < 0 ? Math.min(m + 1, MODES.length - 1) : Math.max(m - 1, 0)));
    }
  };

  /* ============ DERIVED ============ */
  const apps = state.applications;
  /* sorted most-overdue-first: this list feeds the dashboard card, the digest,
     and the coach briefing, all of which show only the top few — so the oldest
     waiting follow-ups are the ones that need to surface, not whichever
     happened to be added to the pipeline first. */
  const dueList = useMemo(
    () =>
      apps
        .filter((a) => isDue(a) && !a.archivedAt)
        .sort((a, b) => (followUpOf(a) || "9999-12-31").localeCompare(followUpOf(b) || "9999-12-31") || (a.contacted || "").localeCompare(b.contacted || "")),
    [apps]
  );
  const dueContactsCount = useMemo(
    () => (state.accounts || []).reduce((s, a) => s + (a.contacts || []).filter((c) => isContactDue(c) && !c.archivedAt).length, 0),
    [state.accounts]
  );
  /* people whose posting cadence says it's time to engage. Kept separate from
     the follow-up queue on purpose: commenting on someone's post is a
     different action from chasing a reply, and merging them would make the
     due count mean two things at once. */
  /* same effect as the ✓ Engaged button inside the account modal: resets the
     cadence clock and logs a touch point, so engaging also counts as real
     activity and holds off the nurture badge */
  const markEngaged = (accountId, contactId) =>
    mutate(
      (st) => ({
        ...st,
        accounts: (st.accounts || []).map((a) =>
          a.id !== accountId
            ? a
            : {
                ...a,
                contacts: (a.contacts || []).map((c) =>
                  c.id !== contactId
                    ? c
                    : {
                        ...c,
                        lastEngagedAt: today(),
                        touchpoints: [...(c.touchpoints || []), { id: uid(), date: today(), channel: "LinkedIn", note: "Engaged with a post" }],
                        history: withLog(c, [logEntry("touch", "Engaged with a post")]).history,
                      }
                ),
              }
        ),
      }),
      "✓ Engagement logged"
    );

  const engageDueList = useMemo(
    () =>
      (state.accounts || [])
        .flatMap((a) => (a.contacts || []).filter((c) => !c.archivedAt && isEngagementDue(c)).map((c) => ({ ...c, _company: a.company, _accountId: a.id })))
        .sort((a, b) => (engagementDueDate(a) || "9999-12-31").localeCompare(engagementDueDate(b) || "9999-12-31")),
    [state.accounts]
  );
  const totalDueCount = dueList.length + dueContactsCount;
  const housekeepingProposals = useMemo(() => {
    /* a skipped entry stays hidden until its snooze expires, so the badge
       count reflects what's actually waiting on a decision */
    const snoozed = new Set((state.housekeepingSnoozes || []).filter((x) => x.until > today()).map((x) => x.key));
    return computeHousekeepingProposals(state, apps).filter((p) => !snoozed.has(p.type + (p.id || p.contactId)));
  }, [state.applications, state.accounts, state.housekeepingSnoozes]);
  /* default 30 days: long enough that "not now" means something, short enough
     that a genuinely dead entry comes back rather than vanishing */
  const snoozeHousekeeping = (keys, days = 30) =>
    mutate((st) => {
      const until = addDays(today(), days);
      const byKey = new Map((st.housekeepingSnoozes || []).map((x) => [x.key, x]));
      keys.forEach((k) => byKey.set(k, { key: k, until }));
      return { ...st, housekeepingSnoozes: Array.from(byKey.values()) };
    });

  const weekRows = useMemo(() => {
    const map = new Map();
    const ensure = (label, start) => {
      if (!map.has(label))
        map.set(label, {
          id: null,
          week: label,
          weekStart: start || null,
          outreach: 0, /* legacy manual logs, kept for old data */
          legacy: { apps: 0, replies: 0, screens: 0, interviews: 0, offers: 0 },
          d: { apps: 0, outreach: 0, replies: 0, screens: 0, interviews: 0, offers: 0 },
          due: 0,
        });
      return map.get(label);
    };
    (state.funnel || []).forEach((w) => {
      const row = ensure(w.week || "Unlabeled", w.weekStart);
      row.id = w.id;
      row.weekStart = row.weekStart || w.weekStart || null;
      row.outreach += +w.outreach || 0;
      row.legacy.apps += +w.apps || 0;
      row.legacy.replies += +w.replies || 0;
      row.legacy.screens += +w.screens || 0;
      row.legacy.interviews += +w.interviews || 0;
      row.legacy.offers += +w.offers || 0;
    });
    /* one company+role that reached screening is ONE screening no matter how
       many contacts were chasing it — so metrics count collapsed entries.
       Due follow-ups deliberately stay per-entry: those are real, separate
       pieces of work owed to real, separate people. */
    const countedIds = new Set(collapseCountedEntries(apps).map((a) => a.id));
    apps.forEach((a) => {
      if (isBlankStatus(a)) return; /* saved-for-later leads aren't funnel activity yet */
      const ws = weekStartOfDate(a.contacted);
      const label = ws ? weekLabel(new Date(ws + "T00:00:00")) : "No date set";
      const row = ensure(label, ws);
      if (isDue(a)) row.due += 1;
      if (!countedIds.has(a.id)) return; /* duplicate view of an opportunity already counted */
      /* an "outreach" status is a warm outreach, not yet an application */
      if (isOutreach(a)) row.d.outreach += 1;
      else row.d.apps += 1;
      if (reached(a, "replied")) row.d.replies += 1;
      if (reached(a, "screening")) row.d.screens += 1;
      if (reached(a, "interview")) row.d.interviews += 1;
      if (a.status === "offer" || (a.milestonesLogged || []).includes("offer")) row.d.offers += 1;
    });
    return Array.from(map.values()).sort((x, y) => {
      if (x.weekStart && y.weekStart) return y.weekStart.localeCompare(x.weekStart);
      if (x.weekStart) return -1;
      if (y.weekStart) return 1;
      return 0;
    });
  }, [state.funnel, apps]);

  const totals = useMemo(() => {
    const t = { apps: 0, outreach: 0, replies: 0, screens: 0, interviews: 0, offers: 0 };
    weekRows.forEach((r) => {
      t.apps += r.d.apps + r.legacy.apps;
      t.outreach += r.outreach + r.d.outreach;
      t.replies += r.d.replies + r.legacy.replies;
      t.screens += r.d.screens + r.legacy.screens;
      t.interviews += r.d.interviews + r.legacy.interviews;
      t.offers += r.d.offers + r.legacy.offers;
    });
    return t;
  }, [weekRows]);

  const months = state.runway.expenses > 0 ? state.runway.fund / state.runway.expenses : 0;
  const zone =
    months >= 12
      ? { name: "FULL LEVERAGE", color: C.green, note: "Floor holds. Push well above it. Decline below-floor without hesitation." }
      : months >= 6
      ? { name: "FLOOR HOLDS — TIGHTEN", color: C.amber, note: "Hold P95K. Raise volume, go heavier on warm channels." }
      : months >= 3
      ? { name: "TIMELINE COMPRESSES", color: "#FB923C", note: "Floor holds. Accept strong at-floor offers faster. Add interim income." }
      : { name: "DELIBERATE DECISION ZONE", color: C.red, note: "Only zone where lowering the floor is legitimate — written, dated, numbers attached." };

  /* watch goal progress: celebrate every 2.5% milestone (2% for targets beyond
     1000) once the target exceeds 250, and snapshot the whole cycle once the
     goal is fully achieved — regardless of whether it ended in a job or not.
     Runs quietly in the background. Milestones are tracked as integer indices
     (not raw percentages) to avoid floating-point comparison issues with the
     2.5% step. */
  useEffect(() => {
    if (!state.goal) return;
    const g = computeGoal(state.goal, apps, state);
    if (!g) return;
    const already = state.goal.milestonesCelebrated || [];
    let newMilestones = already;
    const newWins = [];

    if (state.goal.target > 250) {
      const increment = state.goal.target > 1000 ? 2 : 2.5;
      const maxIndex = Math.floor(100 / increment);
      const currentIndex = Math.min(maxIndex, Math.floor(g.pctComplete / increment));
      const toAwardIdx = [];
      for (let i = 1; i <= currentIndex; i++) {
        if (!already.includes(i)) toAwardIdx.push(i);
      }
      if (toAwardIdx.length) {
        newMilestones = [...already, ...toAwardIdx];
        toAwardIdx.forEach((i) => {
          const pctValue = +(i * increment).toFixed(1);
          const msg = MILESTONE_MESSAGES[Math.floor(Math.random() * MILESTONE_MESSAGES.length)];
          newWins.push({
            id: uid(),
            date: today(),
            category: "Milestone",
            text: `🎉 ${pctValue}% of your goal complete (${Math.round((state.goal.target * pctValue) / 100)}/${state.goal.target})! ${msg}`,
          });
        });
      }
    }

    const cycleAlreadyDone = !!state.goal.cycleCompleted;
    const shouldSnapshotCycle = g.pctComplete >= 100 && !cycleAlreadyDone;

    if (newWins.length || shouldSnapshotCycle) {
      setState((s) => {
        let nextGoal = { ...s.goal, milestonesCelebrated: newMilestones };
        let nextAccomplishments = newWins.length ? [...newWins, ...s.accomplishments] : s.accomplishments;
        let nextCycleCount = s.cycleCount || 0;
        if (shouldSnapshotCycle && !s.goal.cycleCompleted) {
          nextCycleCount = (s.cycleCount || 0) + 1;
          const gFinal = computeGoal(s.goal, s.applications, s);
          const cycleEntry = buildCycleSnapshot(s, gFinal, nextCycleCount);
          nextAccomplishments = [cycleEntry, ...nextAccomplishments];
          nextGoal = { ...nextGoal, cycleCompleted: true };
        }
        return { ...s, goal: nextGoal, accomplishments: nextAccomplishments, cycleCount: nextCycleCount };
      });
      if (shouldSnapshotCycle) {
        flash("🏁 Goal complete — Cycle snapshot saved to Wins");
        if (state.archivedCsvRows.length) setCsvPromptOpen(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.applications, state.goal, state.archivedCsvRows]);

  /* keep "today" in sync with whatever day-timezone the person has chosen —
     directly in render so there's no one-tick lag waiting for an effect */
  setDayTimezoneOffset(state.settings?.timezoneOffset);

  /* monthly runway check-in */
  const checkinDay = +state.settings?.checkinDay || 1;
  const checkinDue = +today().slice(8, 10) >= checkinDay && state.lastCheckinMonth !== thisMonth();

  /* focus state */
  const focusItems = normFocus(coach.daily?.focus);
  /* the star is dynamic: it always sits on the highest-impact item that
     is NOT yet done, in the coach's priority order. Completing an item
     moves it to the next one automatically. */
  const nextImportantIdx = focusItems.findIndex((_, i) => !(coach.dailyDone || []).includes(i));
  const allFocusDone = focusItems.length > 0 && focusItems.every((_, i) => (coach.dailyDone || []).includes(i));

  /* ---------- coach ---------- */
  const buildContext = () => {
    const weekLines = weekRows
      .slice(0, 8)
      .map(
        (r) =>
          `${r.week}: apps ${r.d.apps + r.legacy.apps}, outreach ${r.outreach}, replies ${r.d.replies + r.legacy.replies}, screens ${r.d.screens + r.legacy.screens}, interviews ${r.d.interviews + r.legacy.interviews}, offers ${r.d.offers + r.legacy.offers}`
      );
    const byStatus = APP_STATUSES.map((s) => `${statusLabel(s)}: ${apps.filter((a) => (a.status ?? "") === s).length}`).join(", ");
    const replySplit = (() => {
      const withReply = apps.filter((a) => !a.archivedAt && isRepliedThenRejected(a)).length;
      const noReply = apps.filter((a) => !a.archivedAt && isRejectedNoReply(a)).length;
      if (!withReply && !noReply) return "No closed entries yet.";
      return `Closed outcomes: ${withReply} replied-then-rejected (a human engaged — top of funnel WORKED), ${noReply} closed with no reply ever (nothing got through). Whichever dominates names the layer to fix.`;
    })();
    const emos = state.emotions
      .slice(0, 6)
      .map((x) => `${x.date} ${x.name || "?"} (${x.intensity || "?"}/10) claim:"${x.claim || ""}" action:"${x.action || "none"}"`);
    const wins = (state.accomplishments || [])
      .filter((a) => a.outcomeUpdate?.sentiment !== "negative") /* an outcome that later turned negative (rejected/bad fit) stays acknowledged in History, but stops being cited as current momentum */
      .slice(0, 10)
      .map((a) => `${a.date}: ${a.text}${a.category ? ` [${a.category}]` : ""}${a.outcomeUpdate?.sentiment === "positive" && a.outcomeUpdate?.note ? ` (update: ${a.outcomeUpdate.note})` : ""}`);
    const pastWins = (state.accomplishments || [])
      .filter((a) => a.category === "Past Wins" && a.snapshot)
      .map((a) => {
        const s = a.snapshot;
        const label = [s.role, s.company].filter(Boolean).join(" at ") || "a past role";
        return `${a.date} — landed ${label}: took ${s.apps} apps, ${s.outreach} outreach, ${s.replies} replies, ${s.screens} screens, ${s.interviews} interviews for ${s.offers} offer(s) (warm ${s.warm}/cold ${s.cold}, runway was ${s.runwayMonths}mo).`;
      });
    const goalLine = (() => {
      if (!state.goal) return "No goal currently set.";
      const g = computeGoal(state.goal, apps, state);
      if (!g) return "No goal currently set.";
      const rampNote = state.goal.rampEnabled
        ? g.stillRamping
          ? ` Ramping up (${g.aggressiveness.label} style): today's target is ${g.todaysTarget}/day, building to ${g.fullQuota}/day over the next ${g.rampDaysLeft} day(s).`
          : ` Ramp-up complete, holding at full pace (${g.fullQuota}/day).`
        : ` Flat pace, no ramp-up.`;
      const carryNote =
        g.carryIntoToday > 0
          ? ` Yesterday's shortfall of ${g.carryIntoToday} carried over — today's target is boosted accordingly.`
          : g.carryIntoToday < 0
          ? ` Overachieved yesterday by ${Math.abs(g.carryIntoToday)} — today's target is reduced accordingly.`
          : "";
      return `Active goal: ${state.goal.target} applications+outreach combined (each counts as 1) over ${state.goal.days} days, deadline ${g.deadline}, aggressiveness ${g.aggressiveness.label}, full daily quota ${g.fullQuota}.${rampNote}${carryNote} Today's actual target (after rollover): ${g.todaysTarget}, done so far today: ${g.actualToday}. Progress: ${g.actualTotal}/${state.goal.target} (${g.pctComplete}%) — ${g.pastDeadline ? "deadline passed" : g.onPace ? "on pace (rollover-adjusted, so any banked surplus already counts)" : `behind by ${g.carryIntoToday}, after rollover`}.`;
    })();
    const sessions = (state.supportSessions || [])
      .slice(0, 6)
      .map((s) => `${s.date} "${s.feeling || "?"}" intensity ${s.intensity || "?"}/10`);
    const contentLine = (() => {
      const items = state.content || [];
      if (!items.length) return "No content tracked yet.";
      const thisWeekStart = iso(mondayOfToday());
      const doneThisWeek = items.filter((c) => c.date && weekStartOfDate(c.date) === thisWeekStart && c.status === "published").length;
      const perWeek = state.contentGoal?.perWeek || 0;
      const published = items.filter((c) => c.status === "published").length;
      const recent = items
        .slice(0, 5)
        .map((c) => `${c.title || "Untitled"} [${c.status || "idea"}${c.type ? `, ${c.type}` : ""}]`)
        .join("; ");
      return `Content: ${doneThisWeek}/${perWeek} this week, ${published} published total. Recent: ${recent}. ${(() => {
        const buffer = contentBufferCount(items);
        const ideas = contentIdeaCount(items);
        const bt = state.contentGoal?.bufferTarget ?? DEFAULT_CONTENT_BUFFER_TARGET;
        const fl = state.contentGoal?.ideaFloor ?? DEFAULT_CONTENT_IDEA_FLOOR;
        const st = computeContentStreak(items, perWeek, state.contentGoal?.frozenWeeks || []);
        const pat = contentSkipPatterns(state.contentScheduleLog, 35);
        const overdue = items.filter(contentOverdue).length;
        return `Commitment signals: ready-to-publish buffer ${buffer}/${bt}, idea bank ${ideas}/${fl}, streak ${st.weeks} week(s)${overdue ? `, ${overdue} piece(s) past their ship-by date` : ""}.${
          pat.total >= 3 && pat.topReason ? ` Skip pattern over 5 weeks: ${pat.total} missed days, most often "${skipReasonLabel(pat.topReason.key)}" (${pat.topReason.count}x).` : ""
        } If the buffer is empty or the idea bank is below its floor, that's the actionable constraint — name it rather than telling them to try harder. A skip reason of "job search took priority" is CORRECT prioritisation and must never be treated as a failure.`;
      })()} Content is nurturing/staying visible to your network — NOT a job-search conversion tactic. Never frame it as "this will get you interviews"; the goal is consistency and genuine presence, full stop.`;
    })();
    const now = new Date(today() + "T00:00:00");
    return [
      `Today: ${now.toDateString()}.`,
      `Runway: ${months.toFixed(1)} months (zone: ${zone.name}). Fund P${state.runway.fund}, expenses P${state.runway.expenses}/mo.`,
      `Funnel totals (derived live from pipeline): apps ${totals.apps}, outreach ${totals.outreach}, replies ${totals.replies}, screens ${totals.screens}, interviews ${totals.interviews}, offers ${totals.offers}.`,
      `Outreach split (tags kept even after status advances): warm ${apps.filter((a) => a.outreachKind === "warm").length}, cold ${apps.filter((a) => a.outreachKind === "cold").length}, still-untagged-in-outreach ${apps.filter((a) => isOutreach(a) && !a.outreachKind).length}. Warm converts 4-10x better than cold.`,
      `Pipeline by status: ${byStatus}.`,
      replySplit,
      `Follow-ups DUE today or overdue: ${dueList.length}${dueList.length ? " — " + dueList.slice(0, 6).map((a) => `${a.company || "unnamed"} (contacted ${a.contacted}, status ${a.status})`).join("; ") : ""}.`,
      goalLine,
      contentLine,
      `Past wins (historical benchmark from previous successful searches, if any):\n${pastWins.join("\n") || "none recorded yet"}`,
      `Recent accomplishments (completed focus items — acknowledge momentum):\n${wins.join("\n") || "none yet"}`,
      `Emotional support sessions (date, feeling, intensity — watch for patterns/trends):\n${sessions.join("\n") || "none yet"}`,
      `Recent weeks (newest first):\n${weekLines.join("\n") || "none yet"}`,
      `Recent emotion-protocol entries (newest first):\n${emos.join("\n") || "none logged yet"}`,
    ].join("\n\n");
  };

  const RULES = `You are the coaching layer inside "Flight Deck", a personal job-search tracker for a graphic designer in the Philippines targeting remote roles at AU/CA/US/UK companies.
Non-negotiable playbook rules you must coach within:
- The P95,000/month salary floor holds. NEVER suggest lowering it unless runway is under 3 months, and even then only as a written deliberate decision.
- Weekly benchmarks: 8-10 tailored applications + 20-25 warm outreaches. Warm/referral channels convert 4-10x better than cold applications.
- Funnel diagnosis: no replies = fix resume/portfolio layer; screens but no interviews = fix screening-call prep; interviews but no offers = fix interview stage.
- Closed entries are split into "replied then rejected" vs "closed with no reply ever". This is the sharpest diagnostic available: a pile of no-reply closes means the resume/ATS/opening-message layer is the leak, while rejections that came AFTER a real reply mean the top of funnel is working and the leak is in the conversation. Use whichever dominates to name ONE specific fix. Never read "replied then rejected" as failure — it is evidence the outreach worked.
- Follow-ups that are due should usually be today's first action items - name the specific companies.
- Rejection at ~95% of cold applications is the statistical norm, not a verdict. Decisions come from tracker numbers, never from moods.
- Emotions: each logged emotion should convert to exactly ONE small action. High intensity (8+) = body regulation first.
- If an active goal is set, use its stated "today's target" (which may still be ramping up) and deadline instead of the generic weekly benchmark for volume advice — prioritize hitting today's specific number and flag clearly if behind pace.
- If past wins exist, treat their snapshot numbers as this person's own proven benchmark (e.g. "last time it took you N applications") rather than generic statistics — it's more convincing evidence than population averages.
- Content (blog posts, videos, carousels, etc.) is a SEPARATE track from the job search — it exists purely for meaningful nurturing and staying visible to their network, NOT as a lead-generation or conversion tactic. Never suggest content "to get more interviews" or tie its success to job-search metrics. If mentioning content at all, frame it around consistency and genuine presence, and only bring it up when it's actually relevant (e.g. behind on the weekly content goal) — don't force it into every briefing.
- When connecting patterns across different tracked domains (runway, goal pace, emotional intensity, content, bad-fit reasons), always frame it as an observed coincidence or correlation worth being aware of — never as causation, a verdict, or a diagnosis. Never use any cross-domain pattern to suggest lowering the compensation floor; that decision runs strictly on runway math per the existing rules, regardless of what any other signal shows.
Tone: direct, warm, concrete, zero fluff, zero generic motivation. Reference their actual numbers and company names.`;

  const callClaude = async (task, format) => {
    const res = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `${RULES}\n\n=== CURRENT DATA ===\n${buildContext()}\n\n=== TASK ===\n${task}\n\nRespond with ONLY valid JSON, no markdown fences, no preamble, exactly this shape:\n${format}`,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  };

  /* analyzes a FROZEN historical cycle snapshot (not live state) — one button press */
  const generateCycleReport = async (entryId, snapshot) => {
    mutate((s) => ({ ...s, accomplishments: s.accomplishments.map((a) => (a.id === entryId ? { ...a, aiReportLoading: true } : a)) }));
    try {
      const prompt = `You are analyzing a completed job-search cycle for a graphic designer targeting remote roles at AU/CA/US/UK companies. This is a frozen snapshot of one full cycle (goal reached), not live data. Produce a direct, evidence-based report: what worked, what leaked, specific numbers-backed observations (cite the actual figures below), whether warm vs cold outreach or any particular source performed best, any emotional patterns worth noting, and 3-5 concrete recommendations for the next cycle. No generic advice — every claim should trace back to a number in this snapshot.

SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}

Respond with ONLY valid JSON, no markdown fences, no preamble, exactly this shape:
{"summary": "...", "whatWorked": "...", "whatLeaked": "...", "emotionalPatterns": "...", "recommendations": ["...", "..."]}`;
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const report = JSON.parse(text.replace(/```json|```/g, "").trim());
      mutate(
        (s) => ({ ...s, accomplishments: s.accomplishments.map((a) => (a.id === entryId ? { ...a, aiReport: report, aiReportLoading: false } : a)) }),
        "Cycle report generated"
      );
    } catch (e) {
      mutate((s) => ({ ...s, accomplishments: s.accomplishments.map((a) => (a.id === entryId ? { ...a, aiReportLoading: false } : a)) }));
      flash("Couldn't generate the report — check connection and retry.");
    }
  };

  /* optional reflective narrative ON TOP OF the pre-computed, already-true
     synthesis observations — the prompt forbids introducing any new
     correlation, claim, or number not already present in the list, and
     forbids ever suggesting the compensation floor be lowered. This keeps
     the model's role strictly to framing/tone, never to fact-finding. */
  const generatePatternsNarrative = async (observations) => {
    setPatternsNarrativeLoading(true);
    try {
      const prompt = `Below is a list of pre-computed, already-verified observations from a job search tracker. Each one is a real correlation or coincidence in the person's own data — you are NOT being asked to find patterns, only to write a short (2-4 sentence), warm, grounded reflection connecting the ones given. Hard rules: reference ONLY the observations listed below, do not introduce any new correlation, claim, or number that isn't already stated here; never claim causation (frame everything as "worth noticing" or "coincides with", matching the tone already used); never suggest lowering the compensation floor under any circumstance — if runway or bad-fit signals come up, treat them as pace or targeting questions only, never floor questions. If the list is empty, just say things look steady right now, briefly.

OBSERVATIONS:
${JSON.stringify(observations, null, 2)}

Respond with ONLY valid JSON, no markdown fences, no preamble, exactly this shape:
{"narrative": "..."}`;
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setPatternsNarrative(parsed.narrative || "");
    } catch (e) {
      flash("Couldn't reach the coach — check connection and retry.");
    }
    setPatternsNarrativeLoading(false);
  };

  /* job post parser — extracts structured fields from raw pasted text into a
     draft the person still reviews and saves themselves; never auto-creates
     an application on its own. */
  const parseJobPostText = async ({ url, text }) => {
    const extractionRules = `Return ONLY valid JSON, no markdown fences, no preamble, exactly this shape:
{"company": "...", "role": "...", "salary": "...", "source": "...", "jobBoardName": "...", "postLink": "...", "notes": "..."}

Rules:
- "source" must be exactly one of: LinkedIn, Instagram, Facebook, Referral, Job board, Company site, X / Twitter, Other — or "" if genuinely unclear.
- "jobBoardName" is only set if source is "Job board" and a specific board is named or clearly inferable (e.g. Onlinejobs.ph, Upwork, Indeed) — otherwise "".
- "postLink" is the URL of the posting itself if one is known — otherwise "".
- "salary" exactly as written in the post if a figure or range is mentioned, otherwise "".
- "notes" is a 1-2 sentence factual summary of key requirements/responsibilities — never opinion, never "".
- If any field can't be determined, use an empty string. Never guess or invent a value that isn't actually supported by what you found.`;

    const prompt = url
      ? `Fetch and read the job posting at this URL, then extract structured information from its actual content: ${url}\n\nIf the page can't be fetched directly, use web search to find the posting's content (or close paraphrases of it, e.g. cached/aggregator copies) and extract from that instead. Set "postLink" to "${url}" regardless.\n\n${extractionRules}`
      : `Extract structured job posting information from the following raw, possibly messy pasted text (likely copied from LinkedIn, Indeed, a job board, or similar).\n\n${extractionRules}\n\nTEXT:\n${text}`;

    const body = { prompt };
    if (url) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

    const res = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const textOut = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return JSON.parse(textOut.replace(/```json|```/g, "").trim());
  };

  const runDaily = async () => {
    setCoachLoading("daily");
    setCoachError("");
    try {
      const daily = await callClaude(
        "Give today's focus: a MAXIMUM of 3 things to do TODAY (specific and finishable today; due follow-ups by company name usually come first, then volume/quality work sized to where the funnel leaks, then any unfinished emotion-log action). ORDER the items from HIGHEST to LOWEST impact on landing the job — item 1 must be the single highest-leverage job-search action right now (application, outreach, follow-up, or interview prep), never content. Set key=true on item 1 only. This order matters: as items get completed, the app will highlight whichever remaining item is next in this priority order, so order them exactly by true impact, not by convenience or sequence. If a focus item is about a SPECIFIC company already in the pipeline (a follow-up, a reply to send, etc.), include that exact company name in \"company\" so the app can track whether it actually moved forward later — leave \"company\" empty for general/volume items that aren't about one specific company. If they are meaningfully behind their weekly content goal, content CAN be one of the up-to-3 items — framed purely as consistency/staying visible, never as something that helps land the job — but it should rarely if ever be item 1. Also give one sentence on why based on the numbers, one thing to watch (or empty string), and one grounding reminder in evidence-file style.",
        `{"focus": [{"text": "...", "key": false, "company": ""}, {"text": "...", "key": true, "company": "Acme Corp"}], "why": "...", "watch": "...", "reminder": "..."}`
      );
      const items = normFocus(daily.focus).slice(0, 3);
      if (items.length && !items.some((i) => i.key)) items[0].key = true;
      setCoach((p) => ({ ...p, daily: { ...daily, focus: items, carried: false }, dailyDate: today(), dailyDone: [] }));
    } catch (e) {
      setCoachError(e.message && e.message.includes("ANTHROPIC") ? e.message : "Couldn't reach the coach. Check connection (or the ANTHROPIC_API_KEY on Netlify) and retry.");
    }
    setCoachLoading(null);
  };
  runDailyRef.current = runDaily;

  const runWeekly = async () => {
    setCoachLoading("weekly");
    setCoachError("");
    try {
      const weekly = await callClaude(
        "Run the Friday weekly review: a one-line verdict (on-track / off-track and why), funnel diagnosis (which stage leaks most vs benchmarks and the fix), pipeline hygiene (stale applications, follow-up discipline, status mix), emotional pattern analysis from the protocol log, acknowledgment of accomplishments, 2-4 priorities for next week, a floor check (does P95K hold given runway - it should unless runway is critically low), and a brief content note (consistency toward the weekly content goal, framed purely as nurturing/visibility — explicitly NOT tied to job-search outcomes; if no content is tracked, leave this empty).",
        `{"verdict": "...", "funnel": "...", "pipeline": "...", "emotions": "...", "content": "...", "next_week": ["..."], "floor": "..."}`
      );
      setCoach((p) => ({ ...p, weekly, weeklyDate: today() }));
    } catch (e) {
      setCoachError(e.message && e.message.includes("ANTHROPIC") ? e.message : "Couldn't reach the coach. Check connection (or the ANTHROPIC_API_KEY on Netlify) and retry.");
    }
    setCoachLoading(null);
  };

  /* emotional support: settle -> reality -> achievements -> forward -> one action */
  const runSupport = async (feeling, intensity) => {
    const task = `The user pressed the Emotional Support button. They wrote: "${(feeling || "").replace(/"/g, "'")}" with intensity ${intensity || "?"}/10.
Respond in five parts:
1. deescalate — Validate the feeling briefly and ground them in the body (slow 4-in/6-out breathing; the wave passes in minutes if not re-fed). No judgment, no rushing, no problem-solving yet.
2. reality — Bring them back to reality with LOGICAL, EVIDENCE-BACKED reasoning: contrast what the feeling is claiming against what the actual numbers say (runway months, pipeline counts, benchmark conversion rates). Name the specific numbers. The feeling is real; its claims are testable and usually false.
3. achievements — Remind them of their SPECIFIC achievements from the accomplishments list and pipeline progress above (name real items/companies). This is their own documented track record, proof of capability — not flattery.
4. forward — Speak to the importance of their will to get out of this situation and the better future it is building toward: every application, follow-up, and completed focus item is compounding evidence and skill. Ground it in their trajectory data, not wishful thinking. Convince with sound reasoning, not cheerleading.
5. one_action — Exactly ONE small regulating action doable in the next 10 minutes.
If their words suggest crisis, self-harm, or hopelessness beyond normal job-search stress: keep everything gentle, skip parts 2-4 (put a caring sentence in each instead), and make one_action reaching out to a trusted person or professional support.`;
    return callClaude(task, `{"deescalate": "...", "reality": "...", "achievements": "...", "forward": "...", "one_action": "..."}`);
  };

  /* weekly VOICE check-in: coach writes a spoken script from real context,
     ElevenLabs speaks it; transcript saved to the support diary */
  const runVoiceCheckin = async () => {
    setVoiceBusy(true);
    setVoiceErr("");
    try {
      const out = await callClaude(
        `Write a WEEKLY EMOTIONAL CHECK-IN as a spoken-word script (it will be converted to voice audio). 250-350 words. Written for the ear: short sentences, warm steady tone, no lists, no headers, no markdown, no stage directions — just flowing speech.
Structure the arc: (1) a brief settling opening — one slow breath together; (2) the week in reality — their actual numbers this week vs benchmarks, honestly but kindly; (3) their track record — name 2-3 specific recent accomplishments or pipeline wins from the data; (4) acknowledge their emotional pattern this week from the sessions/protocol entries, normalizing it; (5) the will and the better future — every tracked action is compounding, grounded in their trajectory; (6) close with exactly one small action for the coming week and a calm sign-off.`,
        `{"script": "..."}`
      );
      const script = (out.script || "").trim();
      if (!script) throw new Error("empty script");
      /* synthesize */
      const res = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: script }),
      });
      if (!res.ok) {
        let msg = "Voice synthesis failed.";
        try {
          const j = await res.json();
          if (j.error) msg = j.error;
        } catch (e) {}
        /* keep the script even if audio fails */
        setVoiceScript(script);
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (voiceUrlRef.current) URL.revokeObjectURL(voiceUrlRef.current);
      const url = URL.createObjectURL(blob);
      voiceUrlRef.current = url;
      setVoiceUrl(url);
      setVoiceScript(script);
      setCoach((p) => ({ ...p, voiceDate: today() }));
      /* save audio: cloud first (with retries); if unreachable, keep it in the
         on-device vault and auto-upload later — NEVER re-synthesize */
      const sessionId = uid();
      const path = `${syncKeyRef.current}/${sessionId}.mp3`;
      let audioFields = {};
      if (await uploadAudioWithRetry(path, blob)) {
        audioFields = { audioPath: path, audioCreated: today() };
      } else {
        try {
          await idbPut(sessionId, blob);
          audioFields = { audioLocal: true, audioCreated: today() };
        } catch (e) {}
      }
      mutate(
        (s) => ({
          ...s,
          supportSessions: [
            { id: sessionId, date: today(), kind: "weekly-voice", feeling: "🎙 Weekly voice check-in", intensity: "", script, ...audioFields },
            ...(s.supportSessions || []),
          ],
        }),
        audioFields.audioPath
          ? "Voice check-in saved — audio archived to cloud"
          : audioFields.audioLocal
          ? "Saved — audio kept on this device, will upload when online"
          : "Voice check-in saved (transcript only)"
      );
    } catch (e) {
      setVoiceErr(e.message || "Couldn't create the voice session.");
    }
    setVoiceBusy(false);
  };

  /* 12-MONTH AUDIO RETENTION: on open, find archived audio past its
     retention date and ASK — download or delete. Nothing is removed silently. */
  const [expiryOpen, setExpiryOpen] = useState(false);
  const expiryChecked = useRef(false);
  useEffect(() => {
    if (!loaded || expiryChecked.current) return;
    expiryChecked.current = true;
    if ((state.supportSessions || []).some(isExpiredAudio)) setExpiryOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const digestChecked = useRef(false);
  useEffect(() => {
    if (!loaded || digestChecked.current) return;
    digestChecked.current = true;
    if (state.lastDigestShownDate === today()) return;
    const g = state.goal ? computeGoal(state.goal, apps, state) : null;
    const patterns = computeSynthesis(state, apps, zone);
    if (totalDueCount === 0 && !g && patterns.length === 0) return; /* nothing worth a digest today */
    setDigestOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  const dismissDigest = () => {
    setDigestOpen(false);
    mutate((s) => ({ ...s, lastDigestShownDate: today() }));
  };

  /* content schedule: if yesterday's scheduled task was left unchecked, ask
     once whether to carry it into today or let it go — never silently
     re-prompt once resolved */
  const [missedContentPrompt, setMissedContentPrompt] = useState(null);
  const missedContentChecked = useRef(false);
  useEffect(() => {
    if (!loaded || missedContentChecked.current) return;
    missedContentChecked.current = true;
    const yesterday = addDays(today(), -1);
    const entry = state.contentScheduleLog?.[yesterday];
    if (entry && entry.missed && !entry.resolved) setMissedContentPrompt({ date: yesterday, stage: entry.stage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  const resolveMissedContent = (choice, reason) => {
    if (!missedContentPrompt) return;
    const { date, stage } = missedContentPrompt;
    mutate((s) => {
      /* recording WHY is the point: a skip is no longer free and silent, and
         the reasons aggregate into a diagnosis of what's actually blocking */
      const log = { ...s.contentScheduleLog, [date]: { ...s.contentScheduleLog[date], resolved: true, skipReason: reason || s.contentScheduleLog[date]?.skipReason || "" } };
      if (choice === "continue") {
        const t = today();
        log[t] = { stage, done: false, missed: false, carriedFrom: date };
      }
      return { ...s, contentScheduleLog: log };
    });
    setMissedContentPrompt(null);
  };

  /* spends this month's single freeze credit on a given week, so one bad week
     doesn't wipe out a long streak. Deliberately manual — the freeze is a
     decision you make, not something the app grants silently. */
  const freezeContentWeek = (weekStart) =>
    mutate((s) => {
      const frozen = s.contentGoal?.frozenWeeks || [];
      if (frozen.includes(weekStart) || !canFreezeWeek(frozen, weekStart)) return s;
      return { ...s, contentGoal: { ...s.contentGoal, frozenWeeks: [...frozen, weekStart] } };
    }, "❄️ Week frozen — streak protected");
  const setContentBufferTarget = (n) =>
    mutate((s) => ({ ...s, contentGoal: { ...s.contentGoal, bufferTarget: Math.max(0, Math.round(+n || 0)) } }));
  const setContentIdeaFloor = (n) =>
    mutate((s) => ({ ...s, contentGoal: { ...s.contentGoal, ideaFloor: Math.max(0, Math.round(+n || 0)) } }));

  /* every 28 days (or whenever a goal cycle completes — see the milestone
     effect below), remind the person their archive backup exists and is
     worth downloading. Purely a reminder — Download/Delete always live in
     Settings regardless. */
  const [csvPromptOpen, setCsvPromptOpen] = useState(false);
  const csvPromptChecked = useRef(false);
  useEffect(() => {
    if (!loaded || csvPromptChecked.current) return;
    csvPromptChecked.current = true;
    if (!state.archivedCsvRows.length) return;
    const dueForPrompt = !state.lastCsvPromptDate || state.lastCsvPromptDate <= addDays(today(), -28);
    if (dueForPrompt) setCsvPromptOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  const snoozeCsvPrompt = () => {
    setCsvPromptOpen(false);
    mutate((s) => ({ ...s, lastCsvPromptDate: today() }));
  };

  /* ---- daily auto-archive sweep ----
     Runs once per day after load. Files stale pre-reply applications the same
     way a closed one is filed: CSV row written first, archivedAt stamped,
     `autoArchived` flagged so the archive view can show WHY it left and offer
     a one-click restore. Never touches anything that got a reply. */
  const autoArchiveChecked = useRef(false);
  useEffect(() => {
    if (!loaded || autoArchiveChecked.current) return;
    autoArchiveChecked.current = true;
    if (state.lastAutoArchiveDate === today()) return;
    const stale = computeAutoArchivable(state, apps);
    if (!stale.length) {
      mutate((s) => ({ ...s, lastAutoArchiveDate: today() }));
      return;
    }
    const ids = new Set(stale.map((a) => a.id));
    const days = Math.max(1, +state.settings?.autoArchiveDays || HOUSEKEEPING_STALE_DAYS);
    mutate((s) => ({
      ...s,
      lastAutoArchiveDate: today(),
      archivedCsvRows: [...stale.map((a) => csvRowFromApplication(a)), ...(s.archivedCsvRows || [])],
      applications: s.applications.map((a) => (ids.has(a.id) ? { ...a, archivedAt: today(), autoArchived: true } : a)),
    }));
    setTimeout(() => flash(`🗄 Filed ${stale.length} application${stale.length === 1 ? "" : "s"} with no answer in ${days}+ days — see the Archived filter to restore`), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const clearAudioFields = (id) =>
    mutate(
      (s) => ({
        ...s,
        supportSessions: s.supportSessions.map((x) => {
          if (x.id !== id) return x;
          const { audioPath, audioCreated, audioLocal, ...rest } = x;
          return rest;
        }),
      })
    );

  const expiryDelete = async (session) => {
    try {
      await deleteAudio(session.audioPath);
    } catch (e) {}
    clearAudioFields(session.id);
    flash("Audio deleted — transcript kept");
  };

  const expiryDownload = async (session) => {
    try {
      const r = await fetch(audioPublicUrl(session.audioPath));
      if (!r.ok) throw new Error("fetch failed");
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `voice-checkin-${session.date || "session"}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      try {
        await deleteAudio(session.audioPath);
      } catch (e) {}
      clearAudioFields(session.id);
      flash("Downloaded — removed from cloud");
    } catch (e) {
      flash("Download failed — audio kept in cloud");
    }
  };

  /* auto-upload any vaulted audio once the cloud is reachable again */
  const retryingRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const retryPendingAudio = useCallback(async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    try {
      const pending = (stateRef.current.supportSessions || []).filter((s) => s.audioLocal && !s.audioPath);
      for (const s of pending) {
        const blob = await idbGet(s.id).catch(() => null);
        if (!blob) continue;
        const path = `${syncKeyRef.current}/${s.id}.mp3`;
        if (await uploadAudioWithRetry(path, blob, 1)) {
          setState((prev) => ({
            ...prev,
            supportSessions: prev.supportSessions.map((x) =>
              x.id === s.id ? { ...x, audioPath: path, audioLocal: undefined } : x
            ),
          }));
          await idbDelete(s.id).catch(() => {});
        }
      }
    } catch (e) {}
    retryingRef.current = false;
  }, []);
  useEffect(() => {
    if (!loaded) return;
    retryPendingAudio();
    const t = setInterval(retryPendingAudio, 120000);
    const onFocus = () => retryPendingAudio();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [loaded, retryPendingAudio]);

  /* ---------- mutations ---------- */
  const setAppStatus = (id, status) => {
    let winMsg = "";
    let syncMsg = "";
    mutate(
      (s) => {
        let addWins = [];
        let updatedSource = null;
        let applications = s.applications.map((a) => {
          if (a.id !== id) return a;
          const wasBlank = !a.status;
          const m = computeMilestoneWins(a, status);
          if (m) addWins = m.wins;
          updatedSource = {
            ...a,
            status,
            contacted: wasBlank && status && !a.contacted ? today() : a.contacted,
            milestonesLogged: m ? m.milestonesLogged : a.milestonesLogged,
            /* preserve "a human actually answered" across the close */
            ...latchOnClose(a, status),
            /* and record the move itself, so the history isn't LinkedIn-only */
            history: [logEntry("status", `Status → ${statusLabel(status) || "not set"}`), ...(a.history || [])].slice(0, 200),
          };
          return updatedSource;
        });
        if (addWins.length) winMsg = addWins.map((w) => w.text).join(" · ");
        /* screening onward is a company-level event for that job title — bring
           every sibling entry and linked contact to the same status */
        let accounts = s.accounts;
        if (updatedSource) {
          const prop = propagateConvergedStatus(applications, accounts, updatedSource, status);
          applications = prop.applications;
          accounts = prop.accounts;
          if (prop.changed) syncMsg = `🔗 ${prop.changed} other entr${prop.changed === 1 ? "y" : "ies"} for this role set to "${status}" — counted once`;
        }
        return { ...s, applications, accounts, accomplishments: addWins.length ? [...addWins, ...s.accomplishments] : s.accomplishments };
      },
      "Status updated — funnel recalculated"
    );
    if (winMsg) setTimeout(() => flash(winMsg), 400); /* surface the win after the status toast */
    else if (syncMsg) setTimeout(() => flash(syncMsg), 400);
  };

  /* excel-style inline cell commit */
  const updateAppField = (id, field, value) =>
    mutate((s) => {
      const applications = s.applications.map((a) => (a.id === id ? { ...a, [field]: value } : a));
      let accounts = s.accounts;
      /* every field the contact also holds must ride along — ticking a
         follow-up inline creates a touch point on the application, and if only
         `followUps` syncs, that touch point never reaches the contact and gets
         wiped the next time the account side saves */
      const MIRRORED = ["followUps", "touchpoints", "gotReply", "liStatus", "liStatusAt", "history", "notes", "hook", "researchedAt"];
      if (MIRRORED.includes(field)) {
        const app = s.applications.find((a) => a.id === id);
        if (app?.fromAccountContact) {
          const copy = Array.isArray(value) ? value.map((x) => (x && typeof x === "object" ? { ...x } : x)) : value;
          accounts = s.accounts.map((acc) => ({
            ...acc,
            contacts: (acc.contacts || []).map((c) => (c.linkedApplicationId === id ? { ...c, [field]: copy } : c)),
          }));
        }
      }
      return { ...s, applications, accounts };
    });
  const updateAccountField = (id, field, value) =>
    mutate((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === id ? { ...a, [field]: value } : a)) }));
  const updateContentField = (id, field, value) => {
    let winMsg = "";
    mutate((s) => {
      let addWin = null;
      let extraWin = null;
      const oldPublishedCount = s.content.filter((c) => c.status === "published").length;
      const content = s.content.map((c) => {
        if (c.id !== id) return c;
        if (field === "status") {
          const m = computeContentPublishWin(c, value);
          if (m) {
            addWin = m.win;
            return { ...c, [field]: value, celebratedPublish: true };
          }
        }
        return { ...c, [field]: value };
      });
      if (field === "status") {
        const newPublishedCount = content.filter((c) => c.status === "published").length;
        extraWin = computePublishedMilestoneWin(oldPublishedCount, newPublishedCount);
      }
      const newWins = [addWin, extraWin].filter(Boolean);
      if (newWins.length) winMsg = newWins.map((w) => w.text).join(" · ");
      return { ...s, content, accomplishments: newWins.length ? [...newWins, ...s.accomplishments] : s.accomplishments };
    });
    if (winMsg) setTimeout(() => flash(winMsg), 400);
  };
  /* board view's move-forward/back buttons — just another way to change
     status, so it reuses updateContentField's existing win-detection rather
     than duplicating it */
  const moveContentStage = (id, direction) => {
    const item = state.content.find((c) => c.id === id);
    if (!item) return;
    const curIdx = CONTENT_STATUSES.indexOf(item.status || "idea");
    const nextIdx = curIdx + direction;
    if (nextIdx < 0 || nextIdx >= CONTENT_STATUSES.length) return;
    updateContentField(id, "status", CONTENT_STATUSES[nextIdx]);
  };
  const setContentGoalPerWeek = (n) =>
    mutate((s) => ({ ...s, contentGoal: { ...s.contentGoal, perWeek: Math.max(0, Math.round(+n || 0)) } }));

  /* jumps from a synced application's "Source: Accounts" badge straight to
     the linked account, in the Accounts tab, modal already open */
  /* Opens the account's own modal WITHOUT moving you to the Accounts tab.
     Switching views meant closing the modal dropped you somewhere you hadn't
     asked to be, and you'd have to navigate back to the application list you
     were working through. The modal is the destination; the tab isn't. */
  const openLinkedAccount = (app) => {
    const acc = state.accounts.find((a) => normCompanyName(a.company) === normCompanyName(app.company));
    if (!acc) return flash("No account tracked for this company yet");
    setModal({ kind: "account", entry: acc });
  };

  /* jumps the other way: from an account's "N linked" cell straight into the
     Applications view, filtered to just that company's entries. Uses "all" so
     closed/bad-fit entries stay visible — the point is to see everything this
     account is connected to, not just the open ones — and clears the source
     and status filters so nothing silently hides a row. */
  const openRelatedApplications = (company) => {
    const name = (company || "").trim();
    if (!name) return;
    setMode(2);
    setCrmView("applications");
    setPipeFilter("all");
    setPipeSourceFilter("");
    setPipeStatusFilter("");
    setPipeSearch(name);
    setPipePage(0);
  };

  /* opens one specific application/outreach entry directly in its own modal —
     used by the related-applications list inside the account modal */
  /* mirror of openLinkedAccount: opening ONE application from an account's
     related list shouldn't relocate you either. Only the list-showing jumps
     (openRelatedApplications) change the view, because a list has nowhere else
     to appear. */
  const openApplicationEntry = (app) => {
    if (!app) return;
    setModal({ kind: "application", entry: app });
  };

  /* ---- pool actions ----
     Adding to the pool is allowed during DISCOVERY weeks and intercepted to the
     bench during REACHOUT weeks. The cycle encodes the whole open/closed rhythm,
     so there's no separate closure date to drift out of sync. Scoped to the Pool
     tab only — "+ Track application" stays free, because a referral or an inbound
     posting isn't outbound discovery. */
  /* Pool-created records must be indistinguishable from ones made through
     "+ Track application" / "+ Track account" — same fields, same defaults.
     The follow-up schedule matters most: a pool entry created with an empty
     followUps array would graduate into the pipeline and then NEVER appear in
     the due queue, because normFollowUps treats [] as "no schedule". Blank
     status keeps it out of the queue until it's really contacted anyway. */
  const blankPoolApplication = (company, extra) => ({
    id: uid(),
    company,
    role: "",
    website: "",
    source: "",
    jobBoardName: "",
    postLink: "",
    postVerified: "",
    postShot: "",
    screenshotLink: "",
    salary: "",
    contact: "",
    email: "",
    contactLinkedin: "",
    contactPhone: "",
    contacted: "",
    followUps: (state.settings?.followUpDefaults || DEFAULT_FOLLOWUPS).map((d) => ({ days: d, done: false, doneAt: "" })),
    status: "",
    outreachKind: "",
    outreachChannel: "",
    badReasons: [],
    highConfidence: false,
    gotReply: false,
    milestonesLogged: [],
    notes: "",
    custom: [],
    touchpoints: [],
    liStatus: "",
    liStatusAt: "",
    history: [],
    fromPool: true,
    poolAddedAt: today(),
    ...extra,
  });
  const blankPoolAccount = (company, extra) => ({
    id: uid(),
    company,
    website: "",
    industry: "",
    headcount: "",
    status: "",
    highConfidence: false,
    badReasons: [],
    notes: "",
    /* one empty contact row, exactly like the standard account form starts with */
    contacts: [{ id: uid(), name: "", position: "", email: "", phone: "", linkedin: "", notes: "", status: "", outreachKind: "", contacted: "", followUps: [], touchpoints: [], followUpChannel: "", liStatus: "", liStatusAt: "", history: [], linkedApplicationId: null }],
    fromPool: true,
    poolAddedAt: today(),
    ...extra,
  });

  const addToPool = (nameRaw, hook, kind) => {
    const name = (nameRaw || "").trim();
    if (!name) return;
    const key = normCompanyName(name);
    const phase = cyclePhase(state.settings);
    const already =
      apps.some((a) => isFromPool(a) && !a.archivedAt && normCompanyName(a.company) === key) ||
      (state.accounts || []).some((acc) => isFromPool(acc) && !acc.archivedAt && normCompanyName(acc.company) === key);
    if (already) return flash("Already in the pool");
    if ((state.poolBench || []).some((b) => normCompanyName(b.company) === key)) return flash("Already on the bench");
    if (phase.phase !== "discovery") {
      mutate((s) => ({ ...s, poolBench: [{ id: uid(), company: name, addedAt: today(), kind: kind || "application" }, ...(s.poolBench || [])] }), "🪑 Parked on the bench");
      return;
    }
    const h = (hook || "").trim();
    const poolName = `Cycle ${phase.cycleIndex + 1}`;
    if (kind === "account") {
      mutate((s) => ({ ...s, accounts: [blankPoolAccount(name, { hook: h, researchedAt: h ? today() : "", poolName }), ...s.accounts] }), "🎯 Added to pool as an account");
      return;
    }
    mutate((s) => ({ ...s, applications: [blankPoolApplication(name, { hook: h, researchedAt: h ? today() : "", poolName }), ...s.applications] }), "🎯 Added to pool");
  };
  /* opens the standard Application or Account form, pre-tagged as a pool
     member. Going straight to the real form means a pool record is created by
     exactly the same code path as any other — no parallel half-record that
     drifts out of sync with the standard one. */
  const openPoolForm = (kind) => {
    const phase = cyclePhase(state.settings);
    if (phase.phase !== "discovery") return flash("Pool is closed — park it on the bench instead");
    setModal({
      kind: kind === "account" ? "account" : "application",
      entry: null,
      prefill: { fromPool: true, poolName: `Cycle ${phase.cycleIndex + 1}` },
    });
  };
  /* pulls bench names into the pool — only meaningful once a discovery week
     has come round, which is exactly when the cycle reopens */
  const pullFromBench = (ids) => {
    const phase = cyclePhase(state.settings);
    if (phase.phase !== "discovery") return flash("Pool opens again in the next discovery week");
    mutate((s) => {
      const take = (s.poolBench || []).filter((b) => ids.includes(b.id));
      if (!take.length) return s;
      const existing = new Set([
        ...s.applications.filter((a) => isFromPool(a)).map((a) => normCompanyName(a.company)),
        ...(s.accounts || []).filter((a) => isFromPool(a)).map((a) => normCompanyName(a.company)),
      ]);
      const fresh = take.filter((b) => !existing.has(normCompanyName(b.company)));
      const poolName = `Cycle ${phase.cycleIndex + 1}`;
      /* the bench remembers which shape you meant when you parked it */
      const newApps = fresh.filter((b) => (b.kind || "application") !== "account").map((b) => blankPoolApplication(b.company, { hook: "", researchedAt: "", poolName }));
      const newAccts = fresh.filter((b) => (b.kind || "application") === "account").map((b) => blankPoolAccount(b.company, { hook: "", researchedAt: "", poolName }));
      return {
        ...s,
        poolBench: (s.poolBench || []).filter((b) => !ids.includes(b.id)),
        applications: [...newApps, ...s.applications],
        accounts: [...newAccts, ...(s.accounts || [])],
      };
    }, "🎯 Pulled into the pool");
  };
  const removeFromBench = (id) => mutate((s) => ({ ...s, poolBench: (s.poolBench || []).filter((b) => b.id !== id), deletedIds: tombstones(s, [id]) }), "Removed from bench");
  /* writing the hook IS the discovery event — stamping researchedAt is what
     makes it count toward discovery-week progress */
  /* Writes the hook where the work item actually lives. A `contact` item writes
     to that person, so saving Ana's hook moves Ana to "ready to write" and
     leaves Ben in "need a hook". Everything else writes to the record itself. */
  const setPoolHook = (ref, hook) => {
    const stamp = (o) => ({ ...o, hook, researchedAt: hook.trim() ? o.researchedAt || today() : "" });
    mutate((s) => {
      if (ref.kind === "contact")
        return {
          ...s,
          accounts: (s.accounts || []).map((a) => (a.id !== ref.id ? a : { ...a, contacts: (a.contacts || []).map((c) => (c.id === ref.contactId ? stamp(c) : c)) })),
        };
      if (ref.kind === "account") return { ...s, accounts: (s.accounts || []).map((a) => (a.id === ref.id ? stamp(a) : a)) };
      return { ...s, applications: s.applications.map((a) => (a.id === ref.id ? stamp(a) : a)) };
    });
  };

  /* ============================================================
     POOL VIEW — the discovery half of the CRM.

     Only appears when pool pacing is on. Shows the closed set of companies
     you're working through, split by readiness rather than by phase (phase is
     a property of today, shown once in the header). Graduated companies stay
     counted here but are shown as a link into the pipeline, not as rows —
     they're being worked over there now.
     ============================================================ */
  /* tags an EXISTING account or application as a pool member, so companies
     you were already tracking can join the closed set instead of having to be
     re-typed. Untagging leaves the record completely intact — it just stops
     counting toward coverage. */
  const togglePoolMembership = (kind, id) => {
    const phase = cyclePhase(state.settings);
    mutate((s) => {
      const stamp = (r) =>
        r.fromPool
          ? { ...r, fromPool: false, poolName: "" }
          : { ...r, fromPool: true, poolName: r.poolName || `Cycle ${phase.cycleIndex + 1}`, poolAddedAt: r.poolAddedAt || today() };
      return kind === "account"
        ? { ...s, accounts: (s.accounts || []).map((a) => (a.id === id ? stamp(a) : a)) }
        : { ...s, applications: s.applications.map((a) => (a.id === id ? stamp(a) : a)) };
    }, "Pool membership updated");
  };

  /* removes a member from the pool. A lead that was never worked exists only
     because of the pool, so it's deleted outright; anything with real history
     is merely untagged, because deleting recorded work would be the wrong
     kind of tidy. */
  const removePoolMember = (item) => {
    /* removal is company-level — the pool tracks companies, so pulling one
       person out of a 3-contact account isn't a thing you can do here */
    const member = item.member || item;
    const ref = member.refs?.[0] || item.ref;
    if (!ref) return;
    /* a "contact" ref points at a person inside an account, so for removal
       purposes it IS the account — collapse it before deciding */
    const kind = ref.kind === "contact" ? "account" : ref.kind;
    const e = ref.kind === "contact" ? ref.account : ref.entry;
    const untouched = kind === "account" ? !(e.contacts || []).some((c) => c.status || c.contacted) && !e.notes : !e.status && !e.contacted && !e.notes;
    if (!untouched) {
      togglePoolMembership(kind, ref.id);
      return flash("Removed from pool — the record is kept");
    }
    mutate((s) =>
      kind === "account"
        ? { ...s, accounts: (s.accounts || []).filter((a) => a.id !== ref.id), deletedIds: tombstones(s, [ref.id, ...((e.contacts || []).map((c) => c.id))]) }
        : { ...s, applications: s.applications.filter((a) => a.id !== ref.id), deletedIds: tombstones(s, [ref.id]) },
      "Removed from pool"
    );
  };

  /* ---- outreach drafting ----
     Runs on ONE pool member at a time, from its hook. Deliberately not a bulk
     "draft all" button: forty near-identical AI emails is exactly the campaign
     the hook exists to avoid, and the drafts are meant to be edited before
     sending. The result is saved on the record so reopening doesn't re-bill
     the API for the same thing. */
  const [draftModal, setDraftModal] = useState(null); /* { member, text, loading, error } */
  const [bulkDraft, setBulkDraft] = useState(null); /* { total, done, current, errors, running } */
  const bulkStop = useRef(false);

  /* One generator, used by both the single ✍ button and the bulk run, so a
     bulk draft is never a lower-grade version of a manual one. */
  const generateDraft = async (item, chosenContact) => {
    const ref = item.ref || item.refs?.[0];
    const hook = (item.hook || "").trim();
    const personMode = isGenericPersonHook(hook);
    const generic = isGenericHook(hook) || personMode;
    const canSearch = state.settings?.aiProvider === "anthropic" && state.settings?.aiWebSearch !== false;
    const secs = normDraftSections(state.settings?.draftSections);
    const e = item.entry || ref.entry;
    /* the item already names one person, so the draft is addressed to them
       rather than to a list of everyone at the company */
    const contacts = item.contactName ? [{ name: item.contactName, position: item.contactPosition }] : [];
    const who = contacts.length ? contacts.map((c) => `${c.name || "unnamed"}${c.position ? ` (${c.position})` : ""}`).join(", ") : "";
    const target = personMode ? chosenContact || contacts[0] : null;
    const lines = [
      `Company: ${item.company}`,
      generic ? "" : `Hook (the specific thing you researched): ${hook}`,
      /* named explicitly so the model uses the real first name rather than a
         placeholder, and drops the role clause when there isn't one */
      target ? `Write to this person — first name: ${firstNameOf(target.name)}${target.position ? `, position: ${target.position}` : ", position: not known"}` : "",
      item.kind === "application" && e.role ? `Role being applied for: ${e.role}` : "",
      who ? `Contact(s) at the company: ${who}` : "",
      e.industry ? `Industry: ${e.industry}` : "",
      e.notes ? `Other notes: ${String(e.notes).slice(0, 400)}` : "",
      "",
      /* The pitch is only supplied when the model actually writes the offer.
         Handing it over while the offer section is fixed is what produced
         drafts that pitched the sender twice. */
      secs.offer?.mode === "ai"
        ? `About the sender: ${state.settings?.aiPitch || "A graphic designer looking for in-house or contract work. No positioning paragraph was provided, so keep claims about the sender minimal rather than inventing specifics."}`
        : "Do not introduce the sender or describe their services — that is already written and follows your text.",
    ].filter(Boolean);
    const raw = await callAI({
      provider: state.settings?.aiProvider,
      model: state.settings?.aiModel,
      baseUrl: state.settings?.aiBaseUrl,
      key: readAiKey(),
      system: buildOutreachSystem(secs, personMode ? "genericPerson" : generic ? (canSearch ? "genericSearch" : "genericNoSearch") : "plain"),
      user: lines.join("\n"),
      webSearch: generic && canSearch && !personMode,
      maxTokens: state.settings?.aiMaxTokens,
    });
    const m = raw.match(/^\s*Hook:\s*(.+)$/im);
    const foundHook = m && !/^none found$/i.test(m[1].trim()) ? m[1].trim() : "";
    const vars = {
      company: item.company || "",
      /* the work item already names one person, so tokens resolve to them */
      "first name": firstNameOf(target?.name || item.contactName || ""),
      name: (target?.name || item.contactName || "").trim(),
      position: (target?.position || item.contactPosition || "").trim(),
      role: ref.kind === "application" ? (e.role || "").trim() : "",
      hook: generic ? "" : hook,
      industry: (e.industry || "").trim(),
      me: (state.settings?.aiSenderName || "").trim(),
    };
    const { text, missing, echoWarnings } = assembleDraft(raw.replace(/^\s*Hook:.*$/im, "").trim(), secs, vars);
    return { text, missing, echoWarnings, foundHook, generic, personMode, target, searched: generic && canSearch && !personMode };
  };

  /* the draft belongs to the PERSON it was written for, so two contacts at the
     same company each keep their own */
  const saveDraftToRecord = (ref, text) =>
    mutate((st) => {
      if (ref.kind === "contact")
        return {
          ...st,
          accounts: (st.accounts || []).map((a) =>
            a.id !== ref.id ? a : { ...a, contacts: (a.contacts || []).map((c) => (c.id === ref.contactId ? { ...c, outreachDraft: text } : c)) }
          ),
        };
      if (ref.kind === "account") return { ...st, accounts: (st.accounts || []).map((a) => (a.id === ref.id ? { ...a, outreachDraft: text } : a)) };
      return { ...st, applications: st.applications.map((a) => (a.id === ref.id ? { ...a, outreachDraft: text } : a)) };
    });

  /* ---- bulk drafting ----
     Sequential on purpose. Parallel requests trip provider rate limits, and
     more importantly a queue you can WATCH is a queue you can stop when the
     first two come back wrong — which is the actual failure mode of drafting
     forty emails at once. Skips anything already drafted so a re-run costs
     nothing, and never touches a company without a hook. */
  const runBulkDraft = async (items, opts = {}) => {
    /* force: a retry pass over entries that already saved a bad draft, which
       the normal run deliberately skips */
    const queue = items.filter((m) => (m.hook || "").trim() && (opts.force || !m.entry?.outreachDraft));
    if (!queue.length) return flash("Everything hooked already has a draft");
    bulkStop.current = false;
    setBulkDraft({ total: queue.length, done: 0, current: queue[0].company, errors: [], running: true });
    const errors = [];
    for (let i = 0; i < queue.length; i++) {
      if (bulkStop.current) break;
      const item = queue[i];
      const who = item.contactName ? `${item.contactName} · ${item.company}` : item.company;
      setBulkDraft((b) => ({ ...b, done: i, current: who }));
      try {
        /* each row is already one person, so there's no "which contact" guess
           left for a batch to get wrong */
        if (isGenericPersonHook(item.hook) && !item.contactName.trim()) {
          errors.push({ key: item.key, company: who, text: "skipped — no named contact to write to", retry: false });
          continue;
        }
        const { text, missing, echoWarnings } = await generateDraft(item, item.contactName ? { name: item.contactName, position: item.contactPosition } : null);
        saveDraftToRecord(item.ref, text);
        if (echoWarnings && echoWarnings.length) errors.push({ key: item.key, company: who, text: `${echoWarnings.join(", ")} may repeat your fixed text`, retry: true });
        /* retry:true marks the ones a second attempt could actually fix */
        if (missing.length) errors.push({ key: item.key, company: who, text: `missing ${missing.join(", ")}`, retry: true });
      } catch (err) {
        errors.push({ key: item.key, company: who, text: err?.message || "failed", retry: true });
      }
      /* a breath between calls keeps provider rate limits happy */
      if (i < queue.length - 1 && !bulkStop.current) await new Promise((r) => setTimeout(r, 700));
    }
    setBulkDraft((b) => ({ ...b, done: b ? b.total : 0, current: "", errors, running: false, stopped: bulkStop.current }));
  };

  const draftOutreach = async (item, opts = {}) => {
    const ref = item.ref || item.refs?.[0];
    if (!ref) return;
    const hook = (item.hook || "").trim();
    if (!hook) return flash("Write the hook first, or type \u201cgeneric\u201d to let the AI handle it");
    const existing = item.entry?.outreachDraft;
    if (existing && !opts.regenerate) return setDraftModal({ member: item, text: existing, loading: false, error: "" });

    /* "generic person" needs a human to address — and a work item already IS
       one person, so there's nothing left to pick. The old contact chooser only
       existed because a row could stand for a whole account. */
    if (isGenericPersonHook(hook) && !opts.contact) {
      if (!item.contactName.trim()) return flash("This row has no named contact — add one on the account first");
      opts = { ...opts, contact: { name: item.contactName, position: item.contactPosition } };
    }

    setDraftModal({ member: item, text: "", loading: true, error: "" });
    try {
      const { text, missing, echoWarnings, foundHook, generic, searched, personMode, target } = await generateDraft(item, opts.contact);
      setDraftModal({ member: item, text, loading: false, error: "", foundHook, searched, generic, missing, echoWarnings, personMode, target });
      saveDraftToRecord(ref, text);
    } catch (err) {
      setDraftModal({ member: item, text: "", loading: false, error: err?.message || "Draft failed", generic: isGenericHook(hook) || isGenericPersonHook(hook) });
    }
  };

  /* opens whichever record backs this member — application or account */
  const openPoolMember = (m) => {
    /* work items carry their own ref; a contact ref opens the parent ACCOUNT,
       since that's where the contact is edited */
    const ref = m.ref || m.refs?.[0];
    if (!ref) return;
    if (ref.kind === "contact") return setModal({ kind: "account", entry: ref.account });
    setModal({ kind: ref.kind, entry: ref.entry });
  };

  const renderPool = () => {
    const pg = computePoolGoal(state, apps);
    const phase = pg.phase;
    const open = phase === "discovery";
    /* discovery week is about producing hooks; reachout week is about spending
       them, so each opens on the list you'd otherwise have to go find. Derived
       rather than set during render — assigning state mid-render is the kind of
       thing that works until it doesn't. */
    const view = poolView || (open ? "parked" : "hooked");
    const allMembers = poolMembers(state, apps);
    /* Search spans company, hook and contact names — at 45 companies you often
       remember the person or the angle rather than the company name.
       The chip COUNTS stay unfiltered on purpose: they're the state of the
       pool, and having them shrink as you type would hide how much is left. */
    const q = poolSearch.trim().toLowerCase();
    /* the LISTS work per person, so search matches per person too — the company
       name, that person's own hook, or their name and title */
    const matches = (w) => {
      if (!q) return true;
      if ((w.company || "").toLowerCase().includes(q)) return true;
      if ((w.hook || "").toLowerCase().includes(q)) return true;
      return `${w.contactName} ${w.contactPosition}`.toLowerCase().includes(q);
    };
    const allWork = poolWorkItems(allMembers);
    const work = allWork.filter(matches);
    /* coverage still counts COMPANIES; only the working lists are per person */
    const members = allMembers.filter((m) => work.some((w) => w.member.key === m.key));
    const byReadiness = { parked: [], hooked: [], contacted: [] };
    work.forEach((w) => byReadiness[workItemReadiness(w)].push(w));
    const byReadinessAll = { parked: [], hooked: [], contacted: [] };
    allWork.forEach((w) => byReadinessAll[workItemReadiness(w)].push(w));
    const allBench = state.poolBench || [];
    const bench = q ? allBench.filter((b) => (b.company || "").toLowerCase().includes(q)) : allBench;

    const readinessBadge = (r) => {
      const meta = POOL_READINESS_META[r];
      const col = meta.color === "green" ? C.green : meta.color === "amber" ? C.amber : C.muted;
      return (
        <span style={{ fontFamily: mono, fontSize: 9, letterSpacing: 0.4, color: col, border: `1px solid ${col}`, borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>{meta.label}</span>
      );
    };

    return (
      <>
        <div style={{ background: open ? "rgba(96,165,250,0.08)" : C.panel, border: `1px solid ${open ? C.blue : C.panelEdge}`, borderRadius: 14, padding: "13px 16px", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: open ? C.blue : C.ink }}>
              {open ? "🔍 Discovery week — pool is open" : "🔒 Reachout week — pool is closed"}
            </span>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.muted, border: `1px solid ${C.panelEdge}`, borderRadius: 20, padding: "3px 9px" }}>
              WK {pg.weekInCycle + 1}/{pg.cycleWeeks}
            </span>
          </div>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
            {open
              ? pg.discoveryMode === "build"
                ? `Build the pool first: ${pg.poolSize} of ${pg.discoveryTargetCycle} in, ${pg.buildRemaining} to go. Then write one hook each. Reachout starts ${pg.reachoutStart}.`
                : `Pool built. Now the hooks: ${pg.discoveredThisCycle} of ${pg.discoveryTargetCycle} written, ${pg.needHook} to go. Reachout starts ${pg.reachoutStart}.`
              : `Finding companies isn't this week's job. New names go to the bench and get pulled in when discovery reopens ${addDays(pg.cycleEnd, 1)}.`}
          </div>
          <div style={{ height: 8, background: C.bg, borderRadius: 4, marginTop: 10, overflow: "hidden", border: `1px solid ${C.panelEdge}` }}>
            <div style={{ height: "100%", width: `${pg.pct}%`, background: pg.pct === 100 ? C.green : C.blue, borderRadius: 4 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 6 }}>
            <span>
              <strong style={{ color: C.ink }}>{pg.total} in the pool</strong> · {pg.worked} contacted · {byReadiness.hooked.length} ready to write · {byReadiness.parked.length} need a hook
            </span>
            <span style={{ fontFamily: mono }}>{pg.remaining === 0 ? "all contacted" : `${pg.remaining} to contact`}</span>
          </div>
        </div>

        <div style={{ position: "relative", marginBottom: 10 }}>
          <input
            value={poolSearch}
            onChange={(e) => setPoolSearch(e.target.value)}
            placeholder="🔎 Search company, hook, or contact…"
            style={{ ...inputStyle, padding: "10px 30px 10px 12px" }}
          />
          {poolSearch && (
            <button
              onClick={() => setPoolSearch("")}
              aria-label="Clear search"
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", color: C.muted, fontSize: 16, cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}
            >
              ×
            </button>
          )}
        </div>

        {/* ---- segmented list ----
            A 45-company pool made every section a scroll: hooked entries sat
            below the un-hooked ones and the bench was at the very bottom, so
            reaching the thing you wanted meant passing everything you didn't.
            One list at a time, with the counts always visible up top. */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {[
            ["parked", `Need a hook (${byReadinessAll.parked.length})`, C.amber],
            ["hooked", `✍ Ready to write (${byReadinessAll.hooked.length})`, C.blue],
            ["contacted", `✓ Graduated (${byReadinessAll.contacted.length})`, C.green],
            ["bench", `🪑 Bench (${allBench.length})`, C.muted],
          ].map(([key, label, col]) => (
            <button
              key={key}
              onClick={() => setPoolView(key)}
              style={{
                fontFamily: sans,
                fontSize: 12,
                fontWeight: 700,
                padding: "7px 11px",
                borderRadius: 20,
                border: `1px solid ${view === key ? col : C.panelEdge}`,
                background: view === key ? `${col}1f` : "transparent",
                color: view === key ? col : C.muted,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {view !== "bench" && view !== "contacted" && (
          <PoolAdd
            open={open}
            onAddApplication={() => openPoolForm("application")}
            onAddAccount={() => openPoolForm("account")}
            onPark={(n) => addToPool(n, "", "application")}
          />
        )}

        {q && members.length === 0 && bench.length === 0 && (
          <div style={{ color: C.muted, fontSize: 13, padding: "16px 4px", textAlign: "center", lineHeight: 1.6 }}>
            Nothing in the pool matches &ldquo;{poolSearch}&rdquo;.
          </div>
        )}
        {q && members.length > 0 && byReadiness[view === "bench" ? "parked" : view].length === 0 && view !== "bench" && (
          <div style={{ color: C.muted, fontSize: 13, padding: "14px 4px", textAlign: "center", lineHeight: 1.6 }}>
            No matches in this list — {["parked", "hooked", "contacted"].filter((k) => k !== view && byReadiness[k].length).map((k) => `${byReadiness[k].length} in ${{ parked: "Need a hook", hooked: "Ready to write", contacted: "Graduated" }[k]}`).join(", ") || "try another tab"}.
          </div>
        )}

        {view === "parked" &&
          (byReadiness.parked.length ? (
            byReadiness.parked.map((m) => (
              <PoolRow key={m.key} item={m} badge={readinessBadge("parked")} onHook={setPoolHook} onOpen={openPoolMember} onRemove={removePoolMember} onDraft={draftOutreach} />
            ))
          ) : (
            <div style={{ color: C.muted, fontSize: 13, padding: "16px 4px", textAlign: "center", lineHeight: 1.6 }}>
              {members.length ? "Every company in the pool has a hook. That's a write session waiting for you." : "The pool is empty — add the companies you'll work through this cycle."}
            </div>
          ))}

        {view === "hooked" && (() => {
          const undrafted = byReadiness.hooked.filter((m) => !m.entry?.outreachDraft);
          const b = bulkDraft;
          if (b && b.running)
            return (
              <div style={{ background: "rgba(96,165,250,0.08)", border: `1px solid ${C.blue}`, borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>
                  Drafting {b.done + 1} of {b.total}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{b.current}</div>
                <div style={{ height: 6, background: C.bg, borderRadius: 3, marginTop: 8, overflow: "hidden", border: `1px solid ${C.panelEdge}` }}>
                  <div style={{ height: "100%", width: `${Math.round((b.done / b.total) * 100)}%`, background: C.blue, borderRadius: 3, transition: "width 0.3s ease" }} />
                </div>
                <Btn ghost onClick={() => (bulkStop.current = true)} style={{ marginTop: 10, width: "100%" }}>
                  Stop after this one
                </Btn>
              </div>
            );
          return (
            <>
              {b && !b.running && (() => {
                /* only the faults a second attempt could actually fix. Keys are
                   re-resolved against the CURRENT pool rather than reusing the
                   stale member objects captured during the run. */
                const retryKeys = new Set(b.errors.filter((e) => e.retry).map((e) => e.key));
                /* full pool, not the filtered view — a search left in the box
                   must not silently shrink what gets retried */
                const retryable = byReadinessAll.hooked.filter((m) => retryKeys.has(m.key));
                return (
                  <div style={{ background: C.panel, border: `1px solid ${b.errors.length ? C.amber : C.green}`, borderRadius: 12, padding: "11px 14px", marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: b.errors.length ? C.amber : C.green }}>
                      {b.stopped ? "Stopped" : "Done"} — {b.done} drafted
                      {b.errors.length ? `, ${b.errors.length} with problems` : ""}
                    </div>
                    {b.errors.slice(0, 6).map((e, i) => (
                      <div key={i} style={{ fontSize: 11, color: e.retry ? C.amber : C.muted, marginTop: 4, lineHeight: 1.45 }}>
                        • <strong>{e.company}</strong> — {e.text}
                      </div>
                    ))}
                    {b.errors.length > 6 && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>+ {b.errors.length - 6} more</div>}
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <Btn ghost onClick={() => setBulkDraft(null)} style={{ flex: 1, padding: "7px 11px", fontSize: 12 }}>
                        Dismiss
                      </Btn>
                      {retryable.length > 0 && (
                        <Btn color={C.amber} onClick={() => runBulkDraft(retryable, { force: true })} style={{ flex: 2, padding: "7px 11px", fontSize: 12 }}>
                          ↻ Redraft {retryable.length}
                        </Btn>
                      )}
                    </div>
                    {b.errors.some((e) => !e.retry) && retryable.length > 0 && (
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.45 }}>
                        Grey notes above aren&apos;t faults — those drafts are fine and are left alone.
                      </div>
                    )}
                  </div>
                );
              })()}
              {undrafted.length > 0 && (
                <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "11px 14px", marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5 }}>
                    <strong>{undrafted.length}</strong> hooked {undrafted.length === 1 ? "company has" : "companies have"} no draft yet.
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 3 }}>
                    Runs one at a time so you can watch the first few and stop if they come back wrong. Each still needs opening and editing before it goes anywhere — these
                    are drafts, and a batch of them is worth less than three you actually rewrote.
                  </div>
                  <Btn onClick={() => runBulkDraft(byReadiness.hooked)} style={{ width: "100%", marginTop: 10 }}>
                    ✍ Draft {q ? `these ${undrafted.length}` : `all ${undrafted.length}`}
                  </Btn>
                  {q && <div style={{ fontSize: 11, color: C.amber, lineHeight: 1.5, marginTop: 6 }}>Filtered by &ldquo;{poolSearch}&rdquo; — only matching companies will be drafted.</div>}
                </div>
              )}
              {byReadiness.hooked.length ? (
            byReadiness.hooked.map((m) => (
              <PoolRow key={m.key} item={m} badge={readinessBadge("hooked")} onHook={setPoolHook} onOpen={openPoolMember} onRemove={removePoolMember} onDraft={draftOutreach} onCopy={copyPoolOutreach} polishing={polishing} onRepolish={repolishHook} />
            ))
              ) : (
                <div style={{ color: C.muted, fontSize: 13, padding: "16px 4px", textAlign: "center", lineHeight: 1.6 }}>
                  Nothing hooked and unwritten yet. Write hooks in &ldquo;Need a hook&rdquo; and they land here.
                </div>
              )}
            </>
          );
        })()}

        {view === "contacted" &&
          (byReadiness.contacted.length ? (
            <>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.55, marginBottom: 10 }}>
                Contacted, so they&apos;re being worked in the pipeline now. Still counted here — coverage measures a fixed set.
              </div>
              {byReadiness.contacted.map((m) => (
                <div
                  key={m.key}
                  onClick={() => openPoolMember(m)}
                  style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", marginBottom: 6, cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ marginRight: 5, fontSize: 12 }}>{m.kind === "account" ? "🏢" : "📋"}</span>
                      {m.company}
                    </div>
                    {m.hook && <div style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 1.4 }}>{m.hook}</div>}
                  </div>
                  <span style={{ fontFamily: mono, fontSize: 10, color: C.green, flexShrink: 0 }}>{m.firstContact || "contacted"}</span>
                </div>
              ))}
              <Btn
                ghost
                onClick={() => {
                  setCrmView("applications");
                  setPipeFilter("fromPool");
                  setPipePage(0);
                }}
                style={{ width: "100%", marginTop: 8 }}
              >
                Open these in the pipeline →
              </Btn>
            </>
          ) : (
            <div style={{ color: C.muted, fontSize: 13, padding: "16px 4px", textAlign: "center", lineHeight: 1.6 }}>
              Nobody contacted from this pool yet. Reachout weeks are where this fills up.
            </div>
          ))}

        {view === "bench" && (
          <>
            {bench.length > 0 && open && (
              <Btn color={C.amber} onClick={() => pullFromBench(bench.slice(0, 5).map((b) => b.id))} style={{ width: "100%", marginBottom: 10 }}>
                Pull {Math.min(5, bench.length)} into the pool
              </Btn>
            )}
            {bench.length === 0 ? (
              <div style={{ color: C.muted, fontSize: 13, padding: "16px 4px", textAlign: "center", lineHeight: 1.6 }}>
                Empty. When a company catches your eye during a reachout week, it lands here instead of breaking the pool — captured without acting on it.
              </div>
            ) : (
              bench.map((b, i) => (
                <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.panel, border: `1px solid ${i < 5 && open ? C.amber : C.panelEdge}`, borderRadius: 10, padding: "9px 11px", marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 14 }}>
                      <span style={{ marginRight: 5, fontSize: 12 }}>{(b.kind || "application") === "account" ? "🏢" : "📋"}</span>
                      {b.company}
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>
                      parked {b.addedAt}
                      {i < 5 && open ? " · next in" : ""}
                    </div>
                  </div>
                  <Btn ghost onClick={() => removeFromBench(b.id)} style={{ padding: "5px 9px", fontSize: 12 }}>
                    ×
                  </Btn>
                </div>
              ))
            )}
          </>
        )}
      </>
    );
  };

  /* bulk-converts selected standalone applications into accounts. Applications
     already synced FROM an account (fromAccountContact) are silently skipped —
     they're already an account relationship, there's nothing to convert. Each
     new account is immediately run through the normal sync pathway so it gets
     a properly linked application right away, and the original standalone
     entry is removed (replaced by the newly-synced one, not duplicated). */
  const convertApplicationsToAccounts = (ids) => {
    let convertedCount = 0;
    mutate((s) => {
      let applications = s.applications.slice();
      const accounts = [];
      const convertedIds = [];
      ids.forEach((id) => {
        const app = applications.find((a) => a.id === id);
        if (!app || app.fromAccountContact) return; /* already account-linked — nothing to convert */
        applications = applications.filter((a) => a.id !== id);
        convertedIds.push(id); /* the original row is gone — record it */
        const newAccount = convertApplicationToAccount(app);
        const synced = syncContactsToApplications(newAccount.company, newAccount.website, [], newAccount.contacts, applications);
        applications = synced.applications;
        accounts.push({ ...newAccount, contacts: synced.contacts });
        convertedCount++;
      });
      return { ...s, applications, accounts: [...accounts, ...s.accounts], deletedIds: tombstones(s, convertedIds) };
    }, "Converted to Accounts");
    return convertedCount;
  };

  /* nudges a brand-new entry's follow-up chain off days that are already at
     the daily cap, so adding a batch of applications doesn't schedule the
     whole batch's follow-ups onto one date */
  const smoothedFollowUps = (s, data) =>
    spreadFollowUps(data.followUps, data.contacted, followUpLoadByDate(s.applications, s.accounts), s.settings?.followUpDailyCap ?? DEFAULT_FOLLOWUP_DAILY_CAP);

  /* the user chose to merge a detected same-company-same-role duplicate into
     an account, rather than keep it as a second standalone application. */
  const resolveDuplicateAsMerge = () => {
    if (!duplicateSuggestion) return;
    const { pendingApp, duplicateApp } = duplicateSuggestion;
    mutate((s) => {
      const applications = s.applications.filter((a) => a.id !== duplicateApp.id);
      const mergedAwayId = duplicateApp.id; /* folded into an account — must not come back */
      const mergedAccounts = mergeApplicationIntoAccount(duplicateApp, pendingApp, s.accounts);
      const q = normCompanyName(duplicateApp.company);
      const affectedAccount = mergedAccounts.find((acc) => normCompanyName(acc.company) === q);
      const oldAccountContacts = s.accounts.find((acc) => normCompanyName(acc.company) === q)?.contacts || [];
      const synced = syncContactsToApplications(affectedAccount.company, affectedAccount.website, oldAccountContacts, affectedAccount.contacts, applications);
      const accounts = mergedAccounts.map((acc) => (acc.id === affectedAccount.id ? { ...acc, contacts: synced.contacts } : acc));
      return { ...s, applications: synced.applications, accounts, deletedIds: tombstones(s, [mergedAwayId, ...(synced.removedIds || [])]) };
    }, "Merged into Account");
    setDuplicateSuggestion(null);
    flash("🏢 Merged into Account");
  };
  /* the user chose to keep it as a genuinely separate application (e.g.
     reapplying after a rejection) — proceeds exactly like a normal save */
  const resolveDuplicateAsSeparate = () => {
    if (!duplicateSuggestion) return;
    const { pendingApp } = duplicateSuggestion;
    mutate((s) => {
      const m = computeMilestoneWins({ status: "", milestonesLogged: [] }, pendingApp.status);
      const applications = [{ id: uid(), ...pendingApp, followUps: smoothedFollowUps(s, pendingApp), milestonesLogged: m ? m.milestonesLogged : undefined }, ...s.applications];
      return { ...s, applications, accomplishments: m ? [...m.wins, ...s.accomplishments] : s.accomplishments };
    }, "Application added — funnel updated");
    setDuplicateSuggestion(null);
  };

  /* the user confirmed this is a reapplication — it saves as its own entry,
     numbered as the next attempt for that company+role. The attempt number is
     what keeps it from converging with the earlier closed attempt later on. */
  const resolveAsReapply = () => {
    if (!reapplySuggestion) return;
    const { pendingApp } = reapplySuggestion;
    mutate((s) => {
      const attempt = nextAttemptNumber(pendingApp.company, pendingApp.role, s.applications);
      const m = computeMilestoneWins({ status: "", milestonesLogged: [] }, pendingApp.status);
      const applications = [{ id: uid(), ...pendingApp, attempt, followUps: smoothedFollowUps(s, pendingApp), milestonesLogged: m ? m.milestonesLogged : undefined }, ...s.applications];
      return { ...s, applications, accomplishments: m ? [...m.wins, ...s.accomplishments] : s.accomplishments };
    }, "Reapplication tracked");
    setReapplySuggestion(null);
    flash("↻ Tagged as a reapplication");
  };
  /* the user said it isn't a reapplication (e.g. the old row was a mistake, or
     it's a genuinely different posting that happens to share a title) — saves
     as a plain new entry at attempt 1 */
  const resolveReapplyAsNew = () => {
    if (!reapplySuggestion) return;
    const { pendingApp } = reapplySuggestion;
    mutate((s) => {
      const m = computeMilestoneWins({ status: "", milestonesLogged: [] }, pendingApp.status);
      const applications = [{ id: uid(), ...pendingApp, followUps: smoothedFollowUps(s, pendingApp), milestonesLogged: m ? m.milestonesLogged : undefined }, ...s.applications];
      return { ...s, applications, accomplishments: m ? [...m.wins, ...s.accomplishments] : s.accomplishments };
    }, "Application added — funnel updated");
    setReapplySuggestion(null);
  };
  /* manual toggle from the application row — lets an entry be tagged (or
     untagged) as a reapplication after the fact, without redoing the form */
  const toggleReapplyTag = (id) =>
    mutate((s) => {
      const app = s.applications.find((a) => a.id === id);
      if (!app) return s;
      const attempt = isReapply(app) ? 1 : nextAttemptNumber(app.company, app.role, s.applications.filter((a) => a.id !== id));
      return { ...s, applications: s.applications.map((a) => (a.id === id ? { ...a, attempt } : a)) };
    }, "Reapply tag updated");

  const toggleContentScheduleDone = (dateStr) =>
    mutate((s) => {
      const entry = s.contentScheduleLog?.[dateStr];
      if (!entry) return s;
      return { ...s, contentScheduleLog: { ...s.contentScheduleLog, [dateStr]: { ...entry, done: !entry.done } } };
    });

  /* records how an application/outreach win's outcome actually turned out —
     the win itself (its original text/date/category) is never touched, this
     only ever adds metadata alongside it. A negative update stops the coach
     from citing it as current momentum (see buildContext); it stays fully
     visible in History either way. */
  const setWinOutcomeUpdate = (winId, sentiment, note) =>
    mutate((s) => ({
      ...s,
      accomplishments: s.accomplishments.map((a) => (a.id === winId ? { ...a, outcomeUpdate: { sentiment, note: note || "", updatedAt: today() } } : a)),
    }));

  /* housekeeping: archive hides an entry from the active view without
     touching status/contacted/tags, so nothing it feeds (goal, funnel,
     conversion) ever moves. A background migration step tombstones it after
     30 more untouched days — see applyTombstones. Before that ever happens,
     a full-detail snapshot is captured into the CSV backup below, so nothing
     is really lost even once the record itself gets stripped down. */
  /* restores an archived entry. Auto-filing without an undo would be a trap —
     a rule that files things for you must be reversible in one click. */
  const unarchiveApplication = (id) =>
    mutate((s) => ({ ...s, applications: s.applications.map((x) => (x.id === id ? { ...x, archivedAt: null, autoArchived: false } : x)) }), "Restored to the pipeline");

  const archiveApplication = (id) =>
    mutate((s) => {
      const a = s.applications.find((x) => x.id === id);
      const row = a ? csvRowFromApplication(a) : null;
      return {
        ...s,
        applications: s.applications.map((x) => (x.id === id ? { ...x, archivedAt: today() } : x)),
        archivedCsvRows: row ? [...s.archivedCsvRows, row] : s.archivedCsvRows,
      };
    }, "Archived");
  const archiveContact = (accountId, contactId) =>
    mutate((s) => {
      const acc = s.accounts.find((a) => a.id === accountId);
      const c = acc?.contacts.find((x) => x.id === contactId);
      const row = c ? csvRowFromContact(acc.company, c) : null;
      return {
        ...s,
        accounts: s.accounts.map((a) =>
          a.id === accountId ? { ...a, contacts: (a.contacts || []).map((x) => (x.id === contactId ? { ...x, archivedAt: today() } : x)) } : a
        ),
        archivedCsvRows: row ? [...s.archivedCsvRows, row] : s.archivedCsvRows,
      };
    }, "Archived");

  /* delete confirmation — asks first, deletes only once confirmed. Scoped to
     Applications and Accounts, both of which can hold a lot of accumulated
     detail (contacts, follow-ups, notes) worth double-checking before losing. */
  const askDeleteApplication = (a) =>
    setConfirmDelete({
      kind: "application",
      id: a.id,
      label: a.company || "this application",
      note: a.fromAccountContact ? "This came from an account contact — deleting it will also reset that contact back to \"not contacted yet\" (status, date, and follow-ups cleared)." : null,
    });
  const askDeleteAccount = (acc) => setConfirmDelete({ kind: "account", id: acc.id, label: acc.company || "this account" });
  /* records ids as deleted so the removal survives the next sync merge */
  const tombstones = (s, ids) => [...ids.filter(Boolean).map((id) => ({ id, at: today() })), ...(s.deletedIds || [])];

  const executeConfirmedDelete = () => {
    if (!confirmDelete) return;
    const { kind, id, label } = confirmDelete;
    if (kind === "application") {
      mutate((s) => {
        const deletedApp = s.applications.find((a) => a.id === id);
        const accounts =
          deletedApp && deletedApp.fromAccountContact
            ? s.accounts.map((acc) => ({
                ...acc,
                contacts: (acc.contacts || []).map((c) =>
                  c.linkedApplicationId === id
                    ? { ...c, status: "", contacted: "", outreachKind: "", followUps: [], linkedApplicationId: null }
                    : c
                ),
              }))
            : s.accounts;
        if (deletedApp && deletedApp.postShot) edgeDelete("job-posts", deletedApp.postShot).catch(() => {});
        return { ...s, applications: s.applications.filter((x) => x.id !== id), accounts, deletedIds: tombstones(s, [id]) };
      }, `Deleted ${label}`);
    } else if (kind === "account") {
      mutate((s) => {
        const acc = s.accounts.find((x) => x.id === id);
        const linkedIds = new Set((acc?.contacts || []).map((c) => c.linkedApplicationId).filter(Boolean));
        if (linkedIds.size) {
          s.applications.forEach((a) => {
            if (linkedIds.has(a.id) && a.postShot) edgeDelete("job-posts", a.postShot).catch(() => {});
          });
        }
        return {
          ...s,
          accounts: s.accounts.filter((x) => x.id !== id),
          applications: linkedIds.size ? s.applications.filter((a) => !linkedIds.has(a.id)) : s.applications,
          /* the account, every linked application, and every contact inside it */
          deletedIds: tombstones(s, [id, ...linkedIds, ...(acc?.contacts || []).map((c) => c.id)]),
        };
      }, `Deleted ${label}`);
    }
    setConfirmDelete(null);
  };

  const saveModal = (data) => {
    const { kind, entry } = modal;
    if (kind === "application") {
      if (!entry) {
        const dup = findDuplicateApplication(data.company, data.role, state.applications);
        if (dup) {
          setModal(null); /* close the "track application" form — the suggestion modal takes over from here */
          setDuplicateSuggestion({ pendingApp: data, duplicateApp: dup });
          return; /* don't save yet — wait for the user's choice */
        }
        /* no OPEN entry, but a closed one for the same company+role means this
           is very likely a reapplication — ask rather than assume, since it
           could also just be a stale row worth leaving alone */
        const prior = findPriorAttempts(data.company, data.role, state.applications, null);
        if (prior.length) {
          setModal(null);
          setReapplySuggestion({ pendingApp: data, priorAttempts: prior });
          return;
        }
      }
      let winMsg = "";
      mutate(
        (s) => {
          let addWins = [];
          let applications;
          if (entry) {
            applications = s.applications.map((a) => {
              if (a.id !== entry.id) return a;
              const m = computeMilestoneWins(a, data.status);
              if (m) addWins = m.wins;
              /* the modal's "how far did this get?" control is authoritative —
                 it's the only way to correct an entry closed without stepping
                 through the stages. Forward-transition milestones and the
                 close-latch are then applied on top of the corrected value. */
              const statusMoved = data.status !== a.status;
              const formMs = Array.isArray(data.milestonesLogged) ? data.milestonesLogged : a.milestonesLogged || [];
              const baseMs = Array.from(new Set([...(m ? m.milestonesLogged : []), ...formMs]));
              const latched = latchOnClose({ ...a, milestonesLogged: baseMs, gotReply: data.gotReply }, data.status);
              return {
                ...a,
                ...data,
                milestonesLogged: latched.milestonesLogged || baseMs,
                ...(latched.gotReply ? { gotReply: true } : {}),
                history: statusMoved ? [logEntry("status", `Status → ${statusLabel(data.status) || "not set"}`), ...(data.history || a.history || [])].slice(0, 200) : data.history || a.history || [],
              };
            });
          } else {
            /* brand-new entry created directly at an advanced status (rare, but possible) */
            const m = computeMilestoneWins({ status: "", milestonesLogged: [] }, data.status);
            if (m) addWins = m.wins;
            applications = [{ id: uid(), ...data, followUps: smoothedFollowUps(s, data), milestonesLogged: m ? m.milestonesLogged : undefined }, ...s.applications];
          }
          if (addWins.length) winMsg = addWins.map((w) => w.text).join(" · ");
          /* this application is linked to an account contact — keep the
             contact's own copy of follow-ups in sync, so the account's next
             save doesn't silently revert whatever changed here (checking a
             follow-up done, adding/removing one, editing its day count) */
          let accounts = s.accounts;
          /* ---- keep the linked contact in step ----
             The contact→application direction already copied follow-ups AND
             touch points, but coming back only follow-ups made the trip. So a
             touch point logged from the pipeline never reached the contact —
             its history timeline missed it, its last-activity date stayed
             stale (starting the nurture clock early), and the next edit on the
             account side copied the shorter list back over the top, deleting
             it outright. Same fields both ways is the only version that
             doesn't lose data. */
          if (entry?.fromAccountContact) {
            const syncedFollowUps = Array.isArray(data.followUps) ? data.followUps.map((f) => ({ ...f })) : null;
            const syncedTouchpoints = Array.isArray(data.touchpoints) ? data.touchpoints.map((t) => ({ ...t })) : null;
            accounts = s.accounts.map((acc) => ({
              ...acc,
              contacts: (acc.contacts || []).map((c) =>
                c.linkedApplicationId !== entry.id
                  ? c
                  : {
                      ...c,
                      ...(syncedFollowUps ? { followUps: syncedFollowUps } : {}),
                      ...(syncedTouchpoints ? { touchpoints: syncedTouchpoints } : {}),
                      /* the person-level fields the pipeline can also change */
                      ...(typeof data.gotReply === "boolean" ? { gotReply: data.gotReply } : {}),
                      ...(data.liStatus !== undefined ? { liStatus: data.liStatus, liStatusAt: data.liStatusAt || c.liStatusAt } : {}),
                      ...(Array.isArray(data.history) ? { history: data.history.map((h) => ({ ...h })) } : {}),
                    }
              ),
            }));
          }
          /* screening onward is a company-level event for that job title —
             bring every sibling entry and linked contact to the same status */
          const source = applications.find((a) => (entry ? a.id === entry.id : a.company === data.company && a.role === data.role && a.status === data.status));
          if (source) {
            const prop = propagateConvergedStatus(applications, accounts, source, data.status);
            applications = prop.applications;
            accounts = prop.accounts;
          }
          return { ...s, applications, accounts, accomplishments: addWins.length ? [...addWins, ...s.accomplishments] : s.accomplishments };
        },
        entry ? "Application updated" : "Application added — funnel updated"
      );
      if (winMsg) setTimeout(() => flash(winMsg), 400);
    } else if (kind === "account") {
      let winMsg = "";
      mutate((s) => {
        const oldContacts = entry?.contacts || [];
        const oldAppsById = new Map(s.applications.map((a) => [a.id, a]));
        const { contacts: newContacts, applications: syncedApps, removedIds: syncRemoved } = syncContactsToApplications(data.company, data.website, oldContacts, data.contacts || [], s.applications);
        /* contacts removed from the account in this save */
        const keptContactIds = new Set((data.contacts || []).map((c) => c.id));
        const removedContactIds = (oldContacts || []).filter((c) => !keptContactIds.has(c.id)).map((c) => c.id);

        /* any application present before sync but gone after (a contact was removed
           from the account) may have had a screenshot attached — clean it up so it
           doesn't sit orphaned in Storage forever */
        const syncedIds = new Set(syncedApps.map((a) => a.id));
        oldAppsById.forEach((a, aid) => {
          if (a.fromAccountContact && a.postShot && !syncedIds.has(aid)) edgeDelete("job-posts", a.postShot).catch(() => {});
        });

        let addWins = [];
        const finalApps = syncedApps.map((a) => {
          if (!a.fromAccountContact) return a;
          const prev = oldAppsById.get(a.id) || { status: "", milestonesLogged: [] };
          const m = computeMilestoneWins(prev, a.status);
          if (m) {
            addWins = [...addWins, ...m.wins];
            return { ...a, milestonesLogged: m.milestonesLogged };
          }
          return { ...a, milestonesLogged: prev.milestonesLogged || [] };
        });

        let accounts = entry
          ? s.accounts.map((acc) => (acc.id === entry.id ? { ...acc, ...data, contacts: newContacts } : acc))
          : [{ id: uid(), ...data, contacts: newContacts }, ...s.accounts];

        /* a contact moved to "discovery call"/"ongoing"/"closed" maps to a
           converged application status — so the same company+role convergence
           applies from this side too, keeping Accounts and Pipeline agreed */
        let propagatedApps = finalApps;
        finalApps.forEach((a) => {
          if (!a.fromAccountContact || !isConvergedStatus(a.status)) return;
          const prev = oldAppsById.get(a.id);
          if (prev && prev.status === a.status) return; /* nothing newly changed here */
          const src = propagatedApps.find((x) => x.id === a.id) || a;
          const prop = propagateConvergedStatus(propagatedApps, accounts, src, a.status);
          propagatedApps = prop.applications;
          accounts = prop.accounts;
        });

        /* capture a CSV backup row for any contact newly archived via the
           form's manual archive button (before it ever reaches tombstoning) */
        const oldContactsById = new Map(oldContacts.map((c) => [c.id, c]));
        const newCsvRows = newContacts
          .filter((c) => c.archivedAt && !oldContactsById.get(c.id)?.archivedAt)
          .map((c) => csvRowFromContact(data.company, c));

        if (addWins.length) winMsg = addWins.map((w) => w.text).join(" · ");
        return {
          ...s,
          accounts,
          applications: propagatedApps,
          deletedIds: syncRemoved.length || removedContactIds.length ? tombstones(s, [...syncRemoved, ...removedContactIds]) : s.deletedIds,
          accomplishments: addWins.length ? [...addWins, ...s.accomplishments] : s.accomplishments,
          archivedCsvRows: newCsvRows.length ? [...s.archivedCsvRows, ...newCsvRows] : s.archivedCsvRows,
        };
      }, entry ? "Account updated" : "Account tracked");
      if (!entry) setCrmView("accounts"); /* land on the Accounts table after creating one */
      if (winMsg) setTimeout(() => flash(winMsg), 400);
    } else if (kind === "content") {
      let winMsg = "";
      mutate((s) => {
        let addWin = null;
        let content;
        const oldPublishedCount = s.content.filter((c) => c.status === "published").length;
        if (entry) {
          content = s.content.map((c) => {
            if (c.id !== entry.id) return c;
            const m = computeContentPublishWin(c, data.status);
            if (m) addWin = m.win;
            return { ...c, ...data, celebratedPublish: m ? true : c.celebratedPublish };
          });
        } else {
          const m = computeContentPublishWin({}, data.status);
          if (m) addWin = m.win;
          content = [{ id: uid(), ...data, celebratedPublish: m ? true : false }, ...s.content];
        }
        const newPublishedCount = content.filter((c) => c.status === "published").length;
        const extraWin = computePublishedMilestoneWin(oldPublishedCount, newPublishedCount);
        const newWins = [addWin, extraWin].filter(Boolean);
        if (newWins.length) winMsg = newWins.map((w) => w.text).join(" · ");
        return { ...s, content, accomplishments: newWins.length ? [...newWins, ...s.accomplishments] : s.accomplishments };
      }, entry ? "Content updated" : "Content added");
      if (winMsg) setTimeout(() => flash(winMsg), 400);
    } else if (kind === "decision") {
      mutate(
        (s) => ({
          ...s,
          decisions: entry
            ? s.decisions.map((x) => (x.id === entry.id ? { ...x, ...data } : x))
            : [{ id: uid(), date: today(), ...data }, ...s.decisions],
        }),
        entry ? "Decision updated" : "Decision logged"
      );
    } else if (kind === "accomplishment") {
      mutate(
        (s) => ({
          ...s,
          accomplishments: entry
            ? s.accomplishments.map((x) => (x.id === entry.id ? { ...x, ...data } : x))
            : [{ id: uid(), ...data }, ...s.accomplishments],
        }),
        entry ? "Accomplishment updated" : "Accomplishment logged"
      );
    } else if (kind === "copyDraft") {
      saveCopyDraft(data);
      setModal(null);
      return;
    } else if (kind === "runway") {
      mutate(
        (s) => ({
          ...s,
          runway: { fund: +data.fund || 0, expenses: +data.expenses || 0 },
          lastCheckinMonth: thisMonth(),
        }),
        "Runway recalculated — check-in recorded"
      );
    } else if (kind === "checkinDay") {
      /* the key is deliberately kept OUT of the synced state object */
      if (typeof data.aiKey === "string") writeAiKey(data.aiKey.trim());
      mutate(
        (s) => ({
          ...s,
          settings: {
            ...s.settings,
            checkinDay: Math.min(28, Math.max(1, +data.day || 1)),
            followUpDefaults: (data.followUpDefaults || [])
              .map((d) => Math.max(0, +d || 0))
              .filter((d) => d > 0)
              .slice(0, 10) || DEFAULT_FOLLOWUPS,
            timezoneOffset: typeof data.timezoneOffset === "number" ? data.timezoneOffset : 8,
            followUpDailyCap: Math.max(0, Math.min(99, +data.followUpDailyCap || 0)),
            aiProvider: data.aiProvider || "builtin",
            aiModel: data.aiModel || "",
            aiBaseUrl: data.aiBaseUrl || "",
            aiPitch: data.aiPitch || "",
            aiSenderName: data.aiSenderName || "",
            aiWebSearch: data.aiWebSearch !== false,
            aiMaxTokens: clampTokens(data.aiMaxTokens),
            defaultTouchChannel: data.defaultTouchChannel || DEFAULT_TOUCH_CHANNEL,
            draftSections: normDraftSections(data.draftSections),
            autoArchiveStale: data.autoArchiveStale !== false,
            autoArchiveDays: Math.max(7, Math.min(365, +data.autoArchiveDays || HOUSEKEEPING_STALE_DAYS)),
            goalMode: data.goalMode === "pool" ? "pool" : "standard",
            poolWeeklyWrite: Math.max(0, Math.min(99, +data.poolWeeklyWrite || 0)),
            cycleWeeks: Math.max(2, Math.min(26, +data.cycleWeeks || DEFAULT_CYCLE_WEEKS)),
            discoveryWeeks: Math.max(1, Math.min(Math.max(2, Math.min(26, +data.cycleWeeks || DEFAULT_CYCLE_WEEKS)) - 1, +data.discoveryWeeks || DEFAULT_DISCOVERY_WEEKS)),
            cycleStart: data.cycleStart || s.settings?.cycleStart || iso(mondayOfToday()),
            /* switch-off rules 1 + 2: on a real mode change, append a segment
               dated TODAY. Past weeks keep their original mode, and because
               every rollover walk stops at the newest segment start, the old
               mode's carry can never leak into the new one's currency. */
            modeHistory: (() => {
              const nextMode = data.goalMode === "pool" ? "pool" : "standard";
              const prev = Array.isArray(s.settings?.modeHistory) ? s.settings.modeHistory : [];
              const currentMode = prev.length ? prev[prev.length - 1].mode : "standard";
              if (nextMode === currentMode) return prev;
              return [...prev, { startedAt: today(), mode: nextMode }];
            })(),
          },
          contentGoal: {
            ...s.contentGoal,
            bufferTarget: Math.max(0, Math.min(99, +data.contentBufferTarget || 0)),
            ideaFloor: Math.max(0, Math.min(99, +data.contentIdeaFloor || 0)),
          },
          contentSchedule: {
            idea: Array.isArray(data.contentSchedule?.idea) ? data.contentSchedule.idea : [],
            draft: Array.isArray(data.contentSchedule?.draft) ? data.contentSchedule.draft : [],
            design: Array.isArray(data.contentSchedule?.design) ? data.contentSchedule.design : [],
            scheduled: Array.isArray(data.contentSchedule?.scheduled) ? data.contentSchedule.scheduled : [],
          },
        }),
        "Settings updated"
      );
    } else if (kind === "goal") {
      const target = Math.max(1, Math.round(+data.target || 0));
      const days = Math.max(1, Math.round(+data.days || 0));
      mutate(
        (s) => ({
          ...s,
          goal: {
            target,
            days,
            startDate: data.startDate || today(),
            aggressiveness: AGGRESSIVENESS[data.aggressiveness] ? data.aggressiveness : "steady",
            rampEnabled: !!data.rampEnabled,
          },
        }),
        entry ? "Goal updated" : "Goal set"
      );
    } else if (kind === "winSnapshot") {
      const warm = apps.filter((a) => a.outreachKind === "warm").length;
      const cold = apps.filter((a) => a.outreachKind === "cold").length;
      const snapshot = {
        apps: totals.apps,
        outreach: totals.outreach,
        replies: totals.replies,
        screens: totals.screens,
        interviews: totals.interviews,
        offers: totals.offers,
        warm,
        cold,
        runwayMonths: +months.toFixed(1),
        company: data.company || "",
        role: data.role || "",
      };
      const label = [data.role, data.company].filter(Boolean).join(" at ") || "new role";
      const text = `🏆 Landed ${label} — ${totals.apps} apps, ${totals.outreach} outreach, ${totals.replies} replies, ${totals.screens} screens, ${totals.interviews} interviews, ${totals.offers} offer${totals.offers === 1 ? "" : "s"}.`;
      mutate(
        (s) => ({
          ...s,
          accomplishments: [{ id: uid(), date: data.date || today(), category: "Past Wins", text, snapshot }, ...s.accomplishments],
        }),
        "🏆 Win snapshot saved"
      );
    }
    setModal(null);
  };

  const switchSyncKey = async (k) => {
    const key = k.trim();
    if (key.length < 20) {
      flash("Sync code too short");
      return;
    }
    try {
      const remote = await rpc("fd_get", { k: key });
      syncKeyRef.current = key;
      localStorage.setItem("fd-sync-key", key);
      /* MERGE this device's data with the other device's — nothing is lost */
      let nextState = state;
      let nextCoach = coach;
      if (remote) {
        if (remote.data) nextState = mergeStates(state, migrate(remote.data));
        if (remote.coach) {
          const { coach: rolled, archived } = rolloverCoach(mergeCoach(coach, { ...DEFAULT_COACH, ...remote.coach }), null, nextState.applications);
          nextCoach = rolled;
          if (archived.length) nextState = { ...nextState, accomplishments: [...archived, ...(nextState.accomplishments || [])] };
        }
      }
      setState(nextState);
      setCoach(nextCoach);
      /* push the merged result right away so BOTH devices converge */
      try {
        await rpc("fd_set", { k: key, d: nextState, c: nextCoach });
        dirtyRef.current = false;
        setSyncStatus("synced");
      } catch (e) {}
      setKeyVersion((v) => v + 1); /* rejoin realtime channel under the new code */
      setTimeout(() => {
        try {
          channelRef.current?.send({ type: "broadcast", event: "changed", payload: { t: Date.now() } });
        } catch (e) {}
      }, 1000);
      flash(remote ? "Devices merged & synced" : "New code — current data will save to it");
      setSyncModal(false);
    } catch (e) {
      flash("Couldn't reach sync server");
    }
  };

  /* ============ SECTION RENDERERS ============ */

  /* ---- outreach discipline metrics ----
     These answer a different question from the funnel. The funnel says how
     many replies you got; these say whether you actually worked the leads —
     the most common reason a search underperforms isn't the message, it's
     stopping after one touch. */
  const outreachStats = useMemo(() => {
    const leads = apps.filter((a) => !a.archivedAt && !a.tombstoned && a.contacted && !isBlankStatus(a));
    const contacts = (state.accounts || []).flatMap((acc) => (acc.contacts || []).filter((c) => !c.archivedAt && c.contacted && c.status));
    const everyone = [...leads, ...contacts];
    /* "No follow-up needed" clears the schedule, so an empty followUps array is
       a deliberate opt-out — not a lead you neglected. Counting those would
       punish you for correctly deciding a lead doesn't need chasing, and would
       make the average unfixable: no amount of follow-up work moves a
       denominator full of leads that shouldn't be followed up. Every entry
       starts with a seeded schedule, so empty only ever means cleared. */
    const optedOut = everyone.filter((x) => (x.followUps || []).length === 0).length;
    const all = everyone.filter((x) => (x.followUps || []).length > 0);
    const doneFus = all.reduce((n, x) => n + (x.followUps || []).filter((f) => f.done).length, 0);
    const avgFollowUps = all.length ? doneFus / all.length : 0;
    /* a lead sitting at one touch with nothing done is the leak — but only
       among leads that are actually meant to be followed up */
    const oneAndDone = all.filter((x) => (x.followUps || []).filter((f) => f.done).length === 0 && isOpenApp(x)).length;

    const liAll = [...apps, ...contacts].filter((x) => !x.archivedAt && (x.linkedin || x.contactLinkedin) && x.liStatus);
    const requested = liAll.filter((x) => ["requested", "connected", "declined", "withdrawn"].includes(x.liStatus)).length;
    const accepted = liAll.filter((x) => x.liStatus === "connected").length;
    const pending = liAll.filter((x) => x.liStatus === "requested").length;
    const liRate = requested ? Math.round((accepted / requested) * 100) : null;

    return { leads: all.length, optedOut, avgFollowUps, oneAndDone, requested, accepted, pending, liRate };
  }, [apps, state.accounts]);

  const renderDashboard = () => {
    const g = computeGoal(state.goal, apps, state);
    const poolMode = state.settings?.goalMode === "pool";
    const pg = poolMode ? computePoolGoal(state, apps) : null;
    /* shown when pool pacing is OFF: keeps the timeline visible as context so
       switching back doesn't mean rebuilding your configuration */
    const advisoryPhase = !poolMode && state.settings?.cycleStart ? cyclePhase(state.settings) : null;
    const isRestDay = new Date(today() + "T00:00:00").getDay() === 0;
    return (
    <>
      {/* today's goal — featured front and center, not buried in the Goal tab.
          Sundays are a rest day with no quota at all, so this takes priority
          over both the active-goal and no-goal states — it's not something
          to push through, it's permission to actually stop. */}
      {isRestDay ? (
        <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: "22px 20px", marginBottom: 14, textAlign: "center" }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>🌤️</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Take a break today</div>
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, fontStyle: "italic", maxWidth: 380, margin: "0 auto" }}>{restDayQuote(today())}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>No quota today — Sundays are for rest, not the funnel.</div>
        </div>
      ) : poolMode && pg && pg.total > 0 ? (
        /* ---- POOL PACING · phase-aware ----
           Discovery weeks ask for research; reachout weeks ask for messages.
           Follow-ups are deliberately untouched by either — they live in their
           own queue and keep running straight through discovery week. */
        <div
          onClick={() => setMode(1)}
          style={{ background: C.panel, border: `1px solid ${pg.todayMet ? C.green : pg.inDiscovery ? C.blue : C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14, cursor: "pointer" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Label>
              {pg.inDiscovery ? (pg.discoveryMode === "build" ? "🔍 Discovery week — build the pool" : "🔍 Discovery week — hook them, don't send") : "✉️ Reachout week — write to your queue"}
            </Label>
            <span style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: pg.inDiscovery ? C.blue : C.green, border: `1px solid ${C.panelEdge}`, borderRadius: 20, padding: "3px 9px" }}>
              WK {pg.weekInCycle + 1}/{pg.cycleWeeks}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
            <div style={{ fontFamily: mono, fontSize: 40, fontWeight: 800, color: pg.todayMet ? C.green : pg.inDiscovery ? C.blue : C.amber, lineHeight: 1.1 }}>
              {pg.doneToday} / {pg.todaysTarget}
            </div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.4 }}>
              {pg.inDiscovery ? (pg.discoveryMode === "build" ? "companies to add today" : "companies to hook today") : "companies to write today"}
              <br />
              {pg.doneThisWeek}/{pg.weekTarget} this week
            </div>
          </div>
          {pg.carryIntoToday !== 0 && (
            <div style={{ fontSize: 11, color: pg.carryIntoToday > 0 ? C.red : C.green, marginTop: 6 }}>
              {pg.carryIntoToday > 0 ? `⬆ +${pg.carryIntoToday} carried from earlier this week` : `⬇ ${Math.abs(pg.carryIntoToday)} banked — lighter today`}
            </div>
          )}

          {pg.inDiscovery ? (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.55 }}>
              {pg.discoveryMode === "build"
                ? `Pool: ${pg.poolSize}/${pg.discoveryTargetCycle} companies in — ${pg.buildRemaining} more to find, then hook them one by one. `
                : `Pool built (${pg.poolSize}). Hooks: ${pg.discoveredThisCycle}/${pg.discoveryTargetCycle} written, ${pg.needHook} to go (~5 min each). `}
              No outreach quota this week — but follow-ups still run, and anything you do send still logs.
            </div>
          ) : (
            <div style={{ fontSize: 11, color: pg.outOfHooks ? C.amber : C.muted, marginTop: 8, lineHeight: 1.55 }}>
              {pg.outOfHooks
                ? `⚠ Out of hooks — only ${pg.readyToWrite} researched and unwritten, so today's ask is capped. Discovery under-delivered by ${pg.discoveryShortfall} this cycle; size the next one from that.`
                : `${pg.readyToWrite} researched and ready to write. Next discovery week starts ${new Date(addDays(pg.cycleEnd, 1) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}.`}
            </div>
          )}

          <div style={{ height: 8, background: C.bg, borderRadius: 4, marginTop: 10, overflow: "hidden", border: `1px solid ${C.panelEdge}` }}>
            <div style={{ height: "100%", width: `${pg.pct}%`, background: pg.pct === 100 ? C.green : C.blue, borderRadius: 4, transition: "width 0.3s ease" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 6 }}>
            <span>
              {pg.total} in pool · {pg.worked} contacted
              {pg.poolName ? ` · ${pg.poolName}` : ""}
            </span>
            <span style={{ fontFamily: mono }}>{pg.remaining === 0 ? "all contacted" : `${pg.remaining} to contact`}</span>
          </div>
        </div>
      ) : state.goal && g ? (
        <div
          onClick={() => setMode(1)}
          style={{ background: C.panel, border: `1px solid ${g.todayMet ? C.green : C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14, cursor: "pointer" }}
        >
          {/* switch-off rule: the timelines survive the toggle but stop BINDING.
              With pool pacing off the quota is your normal single number — the
              phase is shown as context only, never as a second target. */}
          {advisoryPhase && (
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}`, lineHeight: 1.5 }}>
              {advisoryPhase.phase === "discovery" ? "🔍" : "✉️"} Cycle week {advisoryPhase.weekInCycle + 1}/{advisoryPhase.cycleWeeks} —{" "}
              {advisoryPhase.phase === "discovery" ? "a discovery stretch" : "a reachout stretch"} by your timeline. Not binding while pool pacing is off.
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Label>🎯 Today's goal — applications + outreach</Label>
            <span style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: C.amber, border: `1px solid ${C.panelEdge}`, borderRadius: 20, padding: "3px 9px" }}>
              {g.aggressiveness.emoji} {g.aggressiveness.label}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
            <div style={{ fontFamily: mono, fontSize: 40, fontWeight: 800, color: g.todayMet ? C.green : C.amber, lineHeight: 1.1 }}>
              {g.actualToday} / {g.todaysTarget}
            </div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.4 }}>
              {g.todayMet ? "✓ hit today's target" : "to do today"}
              {g.stillRamping && !g.todayMet && (
                <>
                  <br />
                  🌱 ramping to {g.fullQuota}/day
                </>
              )}
            </div>
          </div>
          {g.carryIntoToday !== 0 && (
            <div style={{ fontSize: 11, color: g.carryIntoToday > 0 ? C.red : C.green, marginTop: 6 }}>
              {g.carryIntoToday > 0
                ? `⬆ +${g.carryIntoToday} carried over from yesterday's shortfall`
                : `⬇ ${Math.abs(g.carryIntoToday)} banked from yesterday's overachievement — lighter today`}
            </div>
          )}
          <div style={{ height: 8, background: C.bg, borderRadius: 4, marginTop: 10, overflow: "hidden", border: `1px solid ${C.panelEdge}` }}>
            <div
              style={{
                height: "100%",
                width: `${g.todaysTarget > 0 ? Math.min(100, (g.actualToday / g.todaysTarget) * 100) : 0}%`,
                background: g.todayMet ? C.green : C.amber,
                borderRadius: 4,
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Overall: {g.actualTotal}/{state.goal.target} ({g.pctComplete}%) · deadline {g.deadline} · tap for full plan
          </div>
        </div>
      ) : (
        <div
          onClick={() => setMode(1)}
          style={{ background: C.panel, border: `1px dashed ${C.panelEdge}`, borderRadius: 14, padding: "12px 16px", marginBottom: 14, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <div style={{ fontSize: 13, color: C.muted }}>🎯 No goal set yet — tap to set a target and see today's number here</div>
          <span style={{ color: C.amber, fontSize: 12, fontWeight: 700 }}>Set goal →</span>
        </div>
      )}

      {/* today's focus, weekly review, & patterns — popup modules, right below Today's Goal */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button
          onClick={() => setFocusModalOpen(true)}
          style={{ flex: 1, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "14px 10px", cursor: "pointer", textAlign: "left" }}
        >
          <div style={{ fontSize: 20, marginBottom: 4 }}>📋</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Today's Focus</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {coach.daily ? `${focusItems.filter((_, i) => (coach.dailyDone || []).includes(i)).length}/${focusItems.length} done` : "Tap to generate"}
          </div>
        </button>
        <button
          onClick={() => setWeeklyModalOpen(true)}
          style={{ flex: 1, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "14px 10px", cursor: "pointer", textAlign: "left" }}
        >
          <div style={{ fontSize: 20, marginBottom: 4 }}>📊</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Weekly Review</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {coach.weeklyDate ? `Last run ${coach.weeklyDate}` : "Run every Friday"}
          </div>
        </button>
        <button
          onClick={() => setPatternsModalOpen(true)}
          style={{ flex: 1, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "14px 10px", cursor: "pointer", textAlign: "left" }}
        >
          <div style={{ fontSize: 20, marginBottom: 4 }}>🧭</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Patterns</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {(() => {
              const n = computeSynthesis(state, apps, zone).length;
              return n > 0 ? `${n} to see` : "All quiet";
            })()}
          </div>
        </button>
      </div>

      {/* instrument strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        {[
          ["ACTIVE", apps.filter(isOpenApp).length, C.ink],
          ["DUE ⚑", totalDueCount, totalDueCount ? C.red : C.ink],
          ["OFFERS", totals.offers, totals.offers > 0 ? C.green : C.ink],
          ["RUNWAY", months.toFixed(1) + "mo", zone.color],
        ].map(([k, v, col]) => (
          <div
            key={k}
            /* Runway lost its own tab but not its job — it still sets the zone
               the whole app reads, and the playbook makes decisions from it.
               So the card stays and became the way to edit it. */
            onClick={k === "RUNWAY" ? () => setModal({ kind: "runway", entry: { fund: state.runway.fund, expenses: state.runway.expenses } }) : undefined}
            title={k === "RUNWAY" ? "Update your runway numbers" : undefined}
            style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 12px", cursor: k === "RUNWAY" ? "pointer" : "default" }}
          >
            <div style={{ fontSize: 9, letterSpacing: "0.16em", color: C.muted }}>{k}</div>
            <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: col }}>{v}</div>
          </div>
        ))}
      </div>

      {/* ---- outreach discipline ----
          Sits above the funnel because it explains it: a low reply rate with
          0.4 follow-ups per lead is a persistence problem, not a copy problem,
          and those two get confused constantly. */}
      {/* hidden when every lead opted out — a 0.0 average across an empty
          denominator reads as failure rather than "nothing to measure" */}
      {outreachStats.leads > 0 && (
        <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <Label>Outreach discipline</Label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
            <div style={{ flex: "1 1 118px" }}>
              <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color: outreachStats.avgFollowUps >= 2 ? C.green : outreachStats.avgFollowUps >= 1 ? C.amber : C.red }}>
                {outreachStats.avgFollowUps.toFixed(1)}
              </div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>
                follow-ups per lead
                <div style={{ fontFamily: mono, fontSize: 9 }}>across {outreachStats.leads}</div>
              </div>
            </div>
            <div style={{ flex: "1 1 118px" }}>
              <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color: outreachStats.oneAndDone > outreachStats.leads / 2 ? C.red : C.ink }}>{outreachStats.oneAndDone}</div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>open, never followed up</div>
            </div>
            <div style={{ flex: "1 1 118px" }}>
              <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color: outreachStats.liRate === null ? C.muted : outreachStats.liRate >= 40 ? C.green : C.amber }}>
                {outreachStats.liRate === null ? "—" : `${outreachStats.liRate}%`}
              </div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>
                LinkedIn accepted
                {outreachStats.requested > 0 && (
                  <span style={{ fontFamily: mono }}>
                    {" "}
                    ({outreachStats.accepted}/{outreachStats.requested})
                  </span>
                )}
              </div>
            </div>
            {outreachStats.pending > 0 && (
              <div style={{ flex: "1 1 118px" }}>
                <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color: C.amber }}>{outreachStats.pending}</div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>requests pending</div>
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 10 }}>
            {outreachStats.avgFollowUps < 1
              ? "Under one follow-up per lead. Most replies come from the second or third touch, so this is the cheapest thing to change."
              : outreachStats.avgFollowUps < 2
              ? "Roughly one follow-up each. Two or three is where reply rates usually move."
              : "Leads are being worked properly — a weak reply rate here points at the copy, not the persistence."}
            {outreachStats.optedOut > 0 && (
              <>
                {" "}
                <span style={{ color: C.muted }}>
                  {outreachStats.optedOut} marked &ldquo;no follow-up needed&rdquo; {outreachStats.optedOut === 1 ? "is" : "are"} left out of these numbers.
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* donut analytics — by status, by source, or warm/cold outreach */}
      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
          <Label>Pipeline analytics</Label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              ["status", "By status"],
              ["source", "Where found"],
              ["outreach", "Warm vs cold"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setDonutMode(k)}
                style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 20, border: `1px solid ${donutMode === k ? C.amber : C.panelEdge}`, background: donutMode === k ? "rgba(245,185,66,0.12)" : "transparent", color: donutMode === k ? C.amber : C.muted, cursor: "pointer" }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <Donut
          centerLabel={donutMode === "status" ? "BY STATUS" : donutMode === "source" ? "BY SOURCE" : "OUTREACH"}
          data={
            donutMode === "status"
              ? /* stage counts collapse converged duplicates — one company+role
                   at screening is one screening slice, not one per contact */
                (() => {
                  const counted = collapseCountedEntries(apps);
                  return APP_STATUSES.map((s) => ({ label: statusLabel(s), value: counted.filter((a) => (a.status ?? "") === s).length, color: statusDonutColor(s) }));
                })()
              : donutMode === "source"
              ? (() => {
                  const buckets = new Map();
                  const bump = (label) => buckets.set(label, (buckets.get(label) || 0) + 1);
                  apps.forEach((a) => {
                    if (a.source === "Job board") {
                      bump(a.jobBoardName ? a.jobBoardName : "Job board (unspecified)");
                    } else if (a.source === "Accounts") {
                      bump("Accounts");
                    } else if (a.source && APP_SOURCES.includes(a.source)) {
                      bump(a.source);
                    } else {
                      bump("Not set");
                    }
                  });
                  return Array.from(buckets.entries()).map(([label, value]) => ({ label, value }));
                })()
              : [
                  { label: "Warm", value: apps.filter((a) => a.outreachKind === "warm").length },
                  { label: "Cold", value: apps.filter((a) => a.outreachKind === "cold").length },
                  { label: "Untagged (in outreach)", value: apps.filter((a) => isOutreach(a) && !a.outreachKind).length },
                ]
          }
        />
        {donutMode === "source" && (
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Job board entries are broken out by the specific board you named (e.g. Onlinejobs.ph, Upwork) instead of a generic "Job board" bucket.
          </div>
        )}
        {donutMode === "outreach" && (
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Outreached account contacts are included automatically (they sync into the pipeline). Warm/cold tags are kept even after status moves on. "Untagged" is only entries still sitting in outreach status. Warm converts 4–10x better than cold.
          </div>
        )}
      </div>

      {/* funnel tracker — fully derived from the pipeline, lives on the Dashboard now */}
      <div style={{ marginBottom: 14 }}>
        <Label>Funnel (auto from Pipeline)</Label>
        <div style={{ marginTop: 8 }}>{renderFunnelSection()}</div>
      </div>

      {/* due follow-ups queue */}
      {engageDueList.length > 0 && (
        <div style={{ background: "rgba(96,165,250,0.07)", border: `1px solid ${C.blue}`, borderRadius: 14, padding: "12px 16px", marginBottom: 14 }}>
          <Label>💬 Engage — {engageDueList.length} due</Label>
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
            Comment on something they posted. Cheaper than a follow-up and it keeps you visible between messages.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {engageDueList.slice(0, 5).map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, alignItems: "center" }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <strong>{c.name || "Unnamed"}</strong>
                  <span style={{ color: C.muted }}> · {c._company}</span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  {engagementOverdueDays(c) > 0 && <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>{engagementOverdueDays(c)}d</span>}
                  {c.linkedin && (
                    <a
                      href={c.linkedin.startsWith("http") ? c.linkedin : "https://" + c.linkedin}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: C.blue, fontSize: 12, textDecoration: "none" }}
                    >
                      open →
                    </a>
                  )}
                  {/* clearing it from here is the point — going to their profile
                      and then having to open the account to record it is the
                      friction that leaves this list permanently full */}
                  <Btn color={C.green} onClick={() => markEngaged(c._accountId, c.id)} style={{ padding: "4px 9px", fontSize: 11 }}>
                    ✓ Engaged
                  </Btn>
                </span>
              </div>
            ))}
            {engageDueList.length > 5 && <div style={{ fontSize: 11, color: C.muted }}>+ {engageDueList.length - 5} more in Accounts → Engage</div>}
          </div>
        </div>
      )}

      {dueList.length > 0 && (() => {
        /* show a realistic ask, not the whole backlog. dueList is sorted
           oldest-first, so the batch is genuinely the highest-priority slice —
           and naming the rest as "queued" rather than "overdue" keeps a big
           backlog from reading as failure every single morning. */
        const cap = state.settings?.followUpDailyCap ?? DEFAULT_FOLLOWUP_DAILY_CAP;
        const { batch, queued } = splitDueByCap(dueList, cap);
        return (
          <div style={{ background: "rgba(248,113,113,0.07)", border: `1px solid ${C.red}`, borderRadius: 14, padding: "12px 16px", marginBottom: 14 }}>
            <Label>
              ⚑ Follow-ups — {batch.length} for today{queued.length ? ` · ${queued.length} queued` : ""}
            </Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {batch.slice(0, 6).map((a) => (
                <div key={a.id} onClick={() => setModal({ kind: "application", entry: a })} style={{ display: "flex", justifyContent: "space-between", gap: 8, cursor: "pointer", fontSize: 13 }}>
                  <span style={{ fontWeight: 700 }}>{a.company || "Unnamed"}</span>
                  <span style={{ fontFamily: mono, fontSize: 11, color: C.red, flexShrink: 0 }}>due {followUpOf(a)}</span>
                </div>
              ))}
              {batch.length > 6 && <div style={{ fontSize: 11, color: C.muted }}>+ {batch.length - 6} more in today's batch</div>}
              {queued.length > 0 && (
                <div style={{ fontSize: 11, color: C.muted, borderTop: `1px solid ${C.panelEdge}`, paddingTop: 6, marginTop: 2 }}>
                  {queued.length} more waiting behind these — clear today's {batch.length} first. Oldest are at the top.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {coachError && (
        <div style={{ marginTop: 12, background: "rgba(248,113,113,0.08)", border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 12px", fontSize: 13, color: C.red }}>
          {coachError}
        </div>
      )}
    </>
    );
  };

  const renderHistory = () => {
    const items = (state.accomplishments || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const groups = new Map();
    items.forEach((a) => {
      const key = historyGroup === "category" ? a.category || "Uncategorized" : a.date || "No date";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    });
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              ["date", "By date"],
              ["category", "By category"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setHistoryGroup(k)}
                style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 20, border: `1px solid ${historyGroup === k ? C.amber : C.panelEdge}`, background: historyGroup === k ? "rgba(245,185,66,0.12)" : "transparent", color: historyGroup === k ? C.amber : C.muted, cursor: "pointer" }}
              >
                {l}
              </button>
            ))}
          </div>
          <Btn onClick={() => setModal({ kind: "accomplishment", entry: null })}>+ Log a win</Btn>
        </div>

        <div
          onClick={() => setModal({ kind: "winSnapshot", entry: null })}
          style={{ background: "rgba(74,222,128,0.08)", border: `1px solid ${C.green}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14, cursor: "pointer" }}
        >
          <div style={{ fontWeight: 800, fontSize: 13, color: C.green }}>🏆 I landed the job — snapshot this search</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>
            Saves your current apps/outreach/replies/screens/interviews/offers as a permanent record under Past Wins — a benchmark for next time.
          </div>
        </div>

        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
          Completed focus items land here automatically at the start of the next day. The coach remembers these — your evidence file of momentum. Read this list when the belief resurfaces.
        </div>

        {items.length === 0 && (
          <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
            Nothing archived yet. Check off today's focus items — they become permanent accomplishments here tomorrow.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {Array.from(groups.entries()).map(([g, list]) => (
            <div key={g}>
              <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.2em", color: C.amber, marginBottom: 6, textTransform: "uppercase" }}>{g}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {list.map((a) => {
                  const isPastWin = a.category === "Past Wins" && a.snapshot;
                  const isMilestone = Object.values(MILESTONE_LABEL).includes(a.category) || a.category === "Published";
                  const isAppMilestone = Object.values(MILESTONE_LABEL).includes(a.category); /* Reply/Screening/Interview/Final Round/Offer — application/outreach specific, unlike Published */
                  const isGoalMilestone = a.category === "Milestone";
                  const isCycle = a.category === "Cycle Complete" && a.snapshot;
                  return (
                    <SwipeRow
                      key={a.id}
                      showX={isDesktop}
                      onTap={() => setModal({ kind: "accomplishment", entry: a })}
                      onDelete={() => mutate((s) => ({ ...s, accomplishments: s.accomplishments.filter((x) => x.id !== a.id) }), "Accomplishment deleted")}
                    >
                      {isCycle ? (
                        <div style={{ margin: "-12px -14px", padding: "12px 14px", background: "rgba(125,176,247,0.08)", borderLeft: `3px solid ${C.blue}`, borderRadius: 12 }}>
                          <div style={{ fontSize: 13, lineHeight: 1.5, fontWeight: 700, color: C.blue }}>{a.text}</div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{a.date}</div>
                          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8 }}>
                            {a.aiReportLoading ? (
                              <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, letterSpacing: "0.1em" }}>ANALYZING THE CYCLE…</div>
                            ) : a.aiReport ? (
                              <details>
                                <summary style={{ fontSize: 12, color: C.blue, cursor: "pointer" }}>View AI report</summary>
                                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                                  {[
                                    ["SUMMARY", a.aiReport.summary],
                                    ["WHAT WORKED", a.aiReport.whatWorked],
                                    ["WHAT LEAKED", a.aiReport.whatLeaked],
                                    ["EMOTIONAL PATTERNS", a.aiReport.emotionalPatterns],
                                  ].map(
                                    ([k, v]) =>
                                      v && (
                                        <div key={k}>
                                          <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.16em", color: C.muted, marginBottom: 2 }}>{k}</div>
                                          <div style={{ fontSize: 12, lineHeight: 1.55, wordBreak: "break-word" }}>{v}</div>
                                        </div>
                                      )
                                  )}
                                  {Array.isArray(a.aiReport.recommendations) && a.aiReport.recommendations.length > 0 && (
                                    <div>
                                      <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.16em", color: C.muted, marginBottom: 2 }}>RECOMMENDATIONS</div>
                                      {a.aiReport.recommendations.map((r, i) => (
                                        <div key={i} style={{ fontSize: 12, lineHeight: 1.6, wordBreak: "break-word" }}>
                                          {i + 1}. {r}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  <Btn ghost onClick={() => generateCycleReport(a.id, a.snapshot)} style={{ padding: "6px 10px", fontSize: 11, marginTop: 4 }}>
                                    ↻ Regenerate
                                  </Btn>
                                </div>
                              </details>
                            ) : (
                              <Btn onClick={() => generateCycleReport(a.id, a.snapshot)} color={C.blue} style={{ padding: "7px 12px", fontSize: 11 }}>
                                📄 Generate AI Report
                              </Btn>
                            )}
                          </div>
                        </div>
                      ) : isPastWin ? (
                        <div style={{ margin: "-12px -14px", padding: "12px 14px", background: "rgba(74,222,128,0.07)", borderLeft: `3px solid ${C.green}`, borderRadius: 12 }}>
                          <div style={{ fontSize: 13, lineHeight: 1.5, fontWeight: 700, color: C.green }}>{a.text}</div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{a.date}</div>
                        </div>
                      ) : isGoalMilestone ? (
                        <div style={{ margin: "-12px -14px", padding: "12px 14px", background: "rgba(245,185,66,0.08)", borderLeft: `3px solid ${C.amber}`, borderRadius: 12 }}>
                          <div style={{ fontSize: 13, lineHeight: 1.5, fontWeight: 700, color: C.amber }}>{a.text}</div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{a.date}</div>
                        </div>
                      ) : isMilestone ? (
                        <div style={{ margin: "-12px -14px", padding: "12px 14px", background: "rgba(245,185,66,0.08)", borderLeft: `3px solid ${C.amber}`, borderRadius: 12 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <div style={{ fontSize: 13, lineHeight: 1.5, fontWeight: 700, color: C.amber }}>{a.text}</div>
                            <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.1em", color: C.amber, flexShrink: 0, textTransform: "uppercase" }}>
                              {historyGroup === "category" ? "" : a.category}
                            </div>
                          </div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{a.date} · {a.category === "Published" ? "content, out in the world" : "auto-detected forward progress"}</div>

                          {a.outcomeUpdate && (
                            <div style={{ fontSize: 11, color: a.outcomeUpdate.sentiment === "negative" ? C.red : C.green, marginTop: 6, lineHeight: 1.5 }}>
                              ↳ Update ({a.outcomeUpdate.updatedAt}): {a.outcomeUpdate.sentiment === "negative" ? "Didn't work out since" : "Still positive"}
                              {a.outcomeUpdate.note ? ` — ${a.outcomeUpdate.note}` : ""}
                            </div>
                          )}

                          {isAppMilestone && (
                            <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8 }}>
                              {updatingWinId === a.id ? (
                                <WinUpdateForm
                                  onCancel={() => setUpdatingWinId(null)}
                                  onSave={(sentiment, note) => {
                                    setWinOutcomeUpdate(a.id, sentiment, note);
                                    setUpdatingWinId(null);
                                  }}
                                />
                              ) : (
                                <Btn ghost onClick={() => setUpdatingWinId(a.id)} style={{ padding: "5px 10px", fontSize: 11 }}>
                                  {a.outcomeUpdate ? "Edit update" : "Update"}
                                </Btn>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ fontSize: 13, lineHeight: 1.5 }}>✓ {a.text}</div>
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, flexShrink: 0 }}>
                            {historyGroup === "category" ? a.date : a.category}
                          </div>
                        </div>
                      )}
                    </SwipeRow>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  };
  /* shared table styling/helpers — used by both the Applications and Accounts views */
  const th = { textAlign: "left", fontFamily: sans, fontSize: 10, letterSpacing: "0.14em", color: C.muted, textTransform: "uppercase", padding: "8px 10px", borderBottom: `1px solid ${C.panelEdge}`, whiteSpace: "nowrap" };
  const td = { padding: "10px 10px", borderBottom: `1px solid ${C.panelEdge}`, fontSize: 13, verticalAlign: "middle" };
  const selMini = { fontSize: 13, fontFamily: sans, background: "transparent", border: "1px solid transparent", borderRadius: 6, padding: "3px 2px", outline: "none" };
  /* excel-style inline cell: uncontrolled, commits on blur/Enter, no popup needed */
  const cellInput = (a, field, opts = {}) => (
    <input
      key={a.id + field + String(a[field] ?? "")}
      defaultValue={a[field] ?? ""}
      type={opts.type || "text"}
      placeholder={opts.ph || "—"}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        e.target.style.border = "1px solid transparent";
        const v = e.target.value;
        if (v !== (a[field] ?? "")) (opts.onCommit || updateAppField)(a.id, field, v);
      }}
      style={{ width: "100%", minWidth: opts.w || 90, boxSizing: "border-box", fontSize: 13, fontFamily: opts.mono ? mono : sans, background: "transparent", border: "1px solid transparent", borderRadius: 6, color: C.ink, padding: "4px 6px", outline: "none" }}
      onFocus={(e) => (e.target.style.border = `1px solid ${C.blue}`)}
    />
  );
  /* small clickable icon-link that opens a URL-ish field without blocking editing */
  const openLink = (url, opts = {}) => {
    if (!url) return null;
    const href = opts.mailto ? `mailto:${url}` : url.startsWith("http") ? url : `https://${url}`;
    return (
      <a
        href={href}
        target={opts.mailto ? undefined : "_blank"}
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        title={opts.title || "Open"}
        style={{ color: C.blue, fontSize: 13, textDecoration: "none", flexShrink: 0, lineHeight: 1 }}
      >
        {opts.icon || "↗"}
      </a>
    );
  };

  const renderPipeline = () => {
    const filters = [
      { key: "active", label: `Active (${apps.filter((a) => isOpenApp(a) && !a.archivedAt).length})` },
      { key: "highConfidence", label: `⭐ High confidence (${apps.filter((a) => a.highConfidence && !a.archivedAt).length})` },
      { key: "blank", label: `◻ Saved for later (${apps.filter((a) => isBlankStatus(a) && !a.archivedAt).length})` },
      {
        key: "due",
        label: (() => {
          const cap = state.settings?.followUpDailyCap ?? DEFAULT_FOLLOWUP_DAILY_CAP;
          return cap > 0 && dueList.length > cap ? `⚑ Due (${cap} of ${dueList.length})` : `⚑ Due (${dueList.length})`;
        })(),
      },
      { key: "checkPost", label: `⚠ Check posting (${apps.filter((a) => postingNeedsCheck(a) && !a.archivedAt).length})` },
      { key: "fromPool", label: `🎯 From pool (${apps.filter((a) => isFromPool(a) && !a.archivedAt).length})` },
      {
        key: "liPending",
        label: `in ${apps.filter((a) => !a.archivedAt && liStaleDays({ linkedin: a.contactLinkedin, liStatus: a.liStatus, liStatusAt: a.liStatusAt }) > 0).length} pending`,
      },
      { key: "badFit", label: `🚫 Bad fit (${apps.filter((a) => isBadFit(a) && !a.archivedAt).length})` },
      { key: "repliedRejected", label: `✉ Replied, then no (${apps.filter((a) => isRepliedThenRejected(a) && !a.archivedAt).length})` },
      { key: "noReply", label: `🔇 Closed, no reply (${apps.filter((a) => isRejectedNoReply(a) && !a.archivedAt).length})` },
      { key: "closed", label: `Closed (${apps.filter((a) => !isOpenApp(a) && !a.archivedAt).length})` },
      { key: "all", label: `All (${apps.filter((a) => !a.archivedAt).length})` },
      { key: "archived", label: `🗄 Archived (${apps.filter((a) => !!a.archivedAt).length})` },
    ];
    const shown = apps
      .filter((a) => (pipeFilter === "archived" ? !!a.archivedAt : !a.archivedAt))
      .filter((a) =>
        pipeFilter === "due"
          ? isDue(a)
          : pipeFilter === "checkPost"
          ? postingNeedsCheck(a)
          : pipeFilter === "fromPool"
          ? isFromPool(a)
          : pipeFilter === "liPending"
          ? liStaleDays({ linkedin: a.contactLinkedin, liStatus: a.liStatus, liStatusAt: a.liStatusAt }) > 0
          : pipeFilter === "blank"
          ? isBlankStatus(a)
          : pipeFilter === "active"
          ? isOpenApp(a)
          : pipeFilter === "closed"
          ? !isOpenApp(a)
          : pipeFilter === "repliedRejected"
          ? isRepliedThenRejected(a)
          : pipeFilter === "noReply"
          ? isRejectedNoReply(a)
          : pipeFilter === "highConfidence"
          ? !!a.highConfidence
          : pipeFilter === "badFit"
          ? isBadFit(a)
          : true
      )
      .filter((a) => !pipeSourceFilter || a.source === pipeSourceFilter)
      .filter((a) => !pipeStatusFilter || (a.status ?? "") === pipeStatusFilter)
      .filter((a) => {
        if (!pipeSearch.trim()) return true;
        const q = pipeSearch.trim().toLowerCase();
        return [a.company, a.contact, a.email, a.contactPhone, a.contactLinkedin, a.notes, a.jobBoardName, a.website, a.role]
          .filter(Boolean)
          .some((f) => f.toLowerCase().includes(q));
      })
      .slice()
      /* the Due filter is a work queue, not a browse view — the most overdue
         follow-up has been waiting longest, so it goes first. Every other
         filter keeps the default newest-contacted-first ordering. */
      .sort((a, b) =>
        pipeFilter === "due"
          ? (followUpOf(a) || "9999-12-31").localeCompare(followUpOf(b) || "9999-12-31") ||
            (a.contacted || "").localeCompare(b.contacted || "")
          : pipeFilter === "checkPost"
          ? /* longest-unverified first — same work-queue logic as Due */
            (postingCheckedOn(a) || "9999-12-31").localeCompare(postingCheckedOn(b) || "9999-12-31")
          : (b.contacted || "").localeCompare(a.contacted || "")
      );

    /* ---- Due filter load smoothing ----
       Same principle as the Dashboard card: the Due tab is a work queue, and a
       21-row wall of red trains you to ignore it. The list is already sorted
       most-overdue-first, so the first `cap` rows are genuinely the right ones
       to do today. The rest stay one tap away rather than hidden — the work
       isn't being deleted, just deferred out of today's ask. */
    const dueCap = state.settings?.followUpDailyCap ?? DEFAULT_FOLLOWUP_DAILY_CAP;
    const dueSplit = pipeFilter === "due" ? splitDueByCap(shown, dueCap) : { batch: shown, queued: [] };
    const dueQueuedIds = new Set(dueSplit.queued.map((a) => a.id));
    const visible = pipeFilter === "due" && dueSplit.queued.length > 0 && !showQueuedDue ? dueSplit.batch : shown;
    const shownPage = visible.slice(pipePage * PAGE_SIZE, (pipePage + 1) * PAGE_SIZE);

    const totalContacts = (state.accounts || []).reduce((s, a) => s + (a.contacts || []).length, 0);
    const realApplicationsCount = apps.filter((a) => !a.fromAccountContact && !a.archivedAt).length;

    return (
      <>
        {/* quick-glance counts — applications, contacts, due, accounts at a glance */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
          {[
            ["APPLICATIONS", realApplicationsCount, C.ink],
            ["CONTACTS", totalContacts, C.ink],
            ["DUE ⚑", totalDueCount, totalDueCount > 0 ? C.red : C.ink],
            ["ACCOUNTS", (state.accounts || []).length, C.ink],
          ].map(([k, v, col]) => (
            <div key={k} style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 12px" }}>
              <div style={{ fontSize: 9, letterSpacing: "0.14em", color: C.muted }}>{k}</div>
              <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: col }}>{v}</div>
            </div>
          ))}
        </div>
        {/* the other half of the same caption: this row is the WORKING view, so
            it hides archived. Naming the gap here means neither number can
            quietly look wrong when they disagree. */}
        {(() => {
          const archivedCount = apps.filter((a) => a.archivedAt).length;
          if (!archivedCount) return null;
          return (
            <div style={{ fontSize: 11, color: C.muted, marginTop: -8, marginBottom: 12, lineHeight: 1.5 }}>
              Excludes {archivedCount} archived {archivedCount === 1 ? "entry" : "entries"} — still counted in your funnel and goal, which is why those read higher.
            </div>
          );
        })()}

        {/* ---- CRM action bar ----
            On mobile the two things you actually come here to do — log an
            application, log an account — are pinned to the top so they stay
            reachable while scrolling a long list, and everything secondary
            collapses to an icon. Desktop keeps the roomier labelled row. */}
        {!isDesktop && (
          <div
            style={{
              /* floats just above the bottom tab bar (~49px + safe area), so
                 both primary actions stay under your thumb no matter how far
                 down the list you've scrolled. Below the nav's z-index so the
                 two can never fight. */
              position: "fixed",
              left: 0,
              right: 0,
              bottom: "calc(env(safe-area-inset-bottom, 0px) + 56px)",
              zIndex: 30,
              display: "flex",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 560,
                margin: "0 16px",
                display: "flex",
                gap: 8,
                pointerEvents: "auto",
                background: "rgba(14,20,32,0.92)",
                backdropFilter: "blur(10px)",
                border: `1px solid ${C.panelEdge}`,
                borderRadius: 14,
                padding: 6,
                boxSizing: "border-box",
                boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
              }}
            >
              <Btn onClick={() => setModal({ kind: "application", entry: null })} style={{ flex: 1, padding: "12px 8px", fontSize: 13, whiteSpace: "nowrap" }}>
                + Application
              </Btn>
              <Btn color={C.amber} onClick={() => setModal({ kind: "account", entry: null })} style={{ flex: 1, padding: "12px 8px", fontSize: 13, whiteSpace: "nowrap" }}>
                + Account
              </Btn>
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              ["applications", `📋 Applications (${realApplicationsCount})`],
              ["accounts", `🏢 Accounts (${(state.accounts || []).length})`],
              /* the Pool tab exists only while pool pacing is on — with the mode
                 off there is no closed set to work through, so an empty tab
                 would just be noise */
              ...(state.settings?.goalMode === "pool" ? [["pool", `🎯 Pool (${poolMembers(state, apps).length})`]] : []),
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setCrmView(k)}
                style={{ fontFamily: sans, fontSize: 12, fontWeight: 700, padding: "7px 14px", borderRadius: 20, border: `1px solid ${crmView === k ? C.amber : C.panelEdge}`, background: crmView === k ? "rgba(245,185,66,0.12)" : "transparent", color: crmView === k ? C.amber : C.muted, cursor: "pointer" }}
              >
                {l}
              </button>
            ))}
          </div>
          {/* on mobile this claims its own full-width line so the inline search
              has room to stretch beside the icons */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", ...(isDesktop ? {} : { flex: "1 1 100%" }) }}>
            {/* on mobile these live in the floating bar at the bottom instead */}
            {isDesktop && <Btn onClick={() => setModal({ kind: "application", entry: null })}>+ Track application</Btn>}
            {isDesktop && (
              <Btn color={C.amber} onClick={() => setModal({ kind: "account", entry: null })}>
                + Track account
              </Btn>
            )}
            {isDesktop && (
              <Btn ghost onClick={() => setModal({ kind: "parseJobPost", entry: null })}>
                🔗 Parse job post
              </Btn>
            )}
            {/* search rides in the same row as the icons on mobile — the CRM
                is mostly a lookup surface, so it earns its place up here
                without costing a whole extra row */}
            {!isDesktop && crmView === "applications" && (
              <div style={{ position: "relative", flex: 1, minWidth: 110 }}>
                <input
                  value={pipeSearch}
                  onChange={(e) => setPipeSearch(e.target.value)}
                  placeholder="🔎 Search…"
                  style={{ ...inputStyle, padding: "9px 26px 9px 10px", fontSize: 13, width: "100%", boxSizing: "border-box" }}
                />
                {pipeSearch && (
                  <button
                    onClick={() => setPipeSearch("")}
                    aria-label="Clear search"
                    style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", color: C.muted, fontSize: 15, cursor: "pointer", padding: "2px 5px", lineHeight: 1 }}
                  >
                    ×
                  </button>
                )}
              </div>
            )}
            {!isDesktop && (
              <button
                onClick={() => setModal({ kind: "parseJobPost", entry: null })}
                title="Parse a job post link"
                aria-label="Parse a job post link"
                style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, borderRadius: 10, width: 38, height: 38, cursor: "pointer", fontSize: 14, color: C.muted, flexShrink: 0 }}
              >
                🔗
              </button>
            )}
            {!isDesktop && (
              <button
                onClick={() => setHousekeepingOpen(true)}
                title="CRM Housekeeping"
                aria-label="CRM Housekeeping"
                style={{ position: "relative", background: "transparent", border: `1px solid ${C.panelEdge}`, borderRadius: 10, width: 38, height: 38, cursor: "pointer", fontSize: 14, color: C.muted, flexShrink: 0 }}
              >
                🧹
                {housekeepingProposals.length > 0 && (
                  <span style={{ position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, background: C.red, color: "#2b0b0b", fontFamily: mono, fontSize: 9, fontWeight: 800, lineHeight: "16px", padding: "0 4px" }}>
                    {housekeepingProposals.length}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={() => setHousekeepingOpen(true)}
              title="CRM Housekeeping"
              style={{
                display: isDesktop ? "block" : "none",
                position: "relative",
                background: "transparent",
                border: `1px solid ${C.panelEdge}`,
                borderRadius: 10,
                width: 42,
                height: 42,
                cursor: "pointer",
                fontSize: 16,
                color: C.muted,
                flexShrink: 0,
              }}
            >
              🧹
              {housekeepingProposals.length > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    minWidth: 16,
                    height: 16,
                    borderRadius: 8,
                    background: C.red,
                    color: "#2b0b0b",
                    fontFamily: mono,
                    fontSize: 9,
                    fontWeight: 800,
                    lineHeight: "16px",
                    padding: "0 4px",
                  }}
                >
                  {housekeepingProposals.length}
                </span>
              )}
            </button>
            {crmView === "applications" && (
              <Btn
                ghost
                onClick={() => {
                  setSelectMode((m) => !m);
                  setSelectedAppIds(new Set());
                }}
                style={isDesktop ? undefined : { padding: "8px 12px", fontSize: 12 }}
              >
                {selectMode ? (isDesktop ? "Cancel select" : "✕") : isDesktop ? "☑ Select" : "☑"}
              </Btn>
            )}
          </div>
        </div>

        {crmView === "pool" && state.settings?.goalMode === "pool" ? (
          renderPool()
        ) : crmView === "accounts" ? (
          renderAccounts()
        ) : (
          <>
        {/* on mobile the search sits inline with the icon row above, so it
            isn't rendered again here — one less full-width row to scroll past */}
        {isDesktop && (
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              value={pipeSearch}
              onChange={(e) => setPipeSearch(e.target.value)}
              placeholder="🔎 Search company, contact, email, notes…"
              style={{ ...inputStyle, flex: 1 }}
            />
            {pipeSearch && (
              <Btn ghost onClick={() => setPipeSearch("")} style={{ padding: "10px 14px" }}>
                Clear
              </Btn>
            )}
          </div>
        )}

        {selectMode && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: C.panel, border: `1px solid ${C.amber}`, borderRadius: 10, padding: "10px 14px", marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: C.ink }}>
              {selectedAppIds.size} selected
              {[...selectedAppIds].some((id) => apps.find((a) => a.id === id)?.fromAccountContact) && (
                <span style={{ color: C.muted, fontSize: 11 }}> (Accounts-sourced ones will be skipped)</span>
              )}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn ghost onClick={() => setSelectedAppIds(new Set())} style={{ padding: "8px 12px", fontSize: 12 }} disabled={selectedAppIds.size === 0}>
                Clear
              </Btn>
              {confirmConvert ? (
                <Btn
                  color={C.amber}
                  onClick={() => {
                    const n = convertApplicationsToAccounts([...selectedAppIds]);
                    setSelectedAppIds(new Set());
                    setSelectMode(false);
                    setConfirmConvert(false);
                    flash(`🏢 Converted ${n} to Account${n === 1 ? "" : "s"}`);
                  }}
                  style={{ padding: "8px 12px", fontSize: 12 }}
                >
                  Confirm convert?
                </Btn>
              ) : (
                <Btn onClick={() => setConfirmConvert(true)} disabled={selectedAppIds.size === 0} style={{ padding: "8px 12px", fontSize: 12 }}>
                  🏢 Convert to Accounts
                </Btn>
              )}
            </div>
          </div>
        )}

        {pipeFilter === "due" && dueSplit.queued.length > 0 && (
          <div style={{ background: "rgba(248,113,113,0.07)", border: `1px solid ${C.red}`, borderRadius: 12, padding: "10px 14px", marginBottom: 10 }}>
            <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5 }}>
              <strong>{dueSplit.batch.length} for today</strong> · {dueSplit.queued.length} queued behind them
            </div>
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 2 }}>
              Sorted longest-waiting first, capped at your {dueCap}/day setting. Clear today's {dueSplit.batch.length} and the rest move up tomorrow.
            </div>
            <button
              onClick={() => {
                setShowQueuedDue((v) => !v);
                setPipePage(0);
              }}
              style={{ marginTop: 8, background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 9, padding: "6px 11px", fontSize: 12, cursor: "pointer" }}
            >
              {showQueuedDue ? `Hide the ${dueSplit.queued.length} queued` : `Show all ${shown.length}`}
            </button>
          </div>
        )}

        {isDesktop ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {filters.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => {
                      setPipeFilter(f.key);
                      setShowQueuedDue(false);
                      setPipePage(0);
                    }}
                    style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 20, border: `1px solid ${pipeFilter === f.key ? C.amber : C.panelEdge}`, background: pipeFilter === f.key ? "rgba(245,185,66,0.12)" : "transparent", color: pipeFilter === f.key ? C.amber : C.muted, cursor: "pointer" }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <select
                value={pipeSourceFilter}
                onChange={(e) => setPipeSourceFilter(e.target.value)}
                style={{ ...selMini, border: `1px solid ${pipeSourceFilter ? C.amber : C.panelEdge}`, color: pipeSourceFilter ? C.amber : C.muted, padding: "6px 10px", borderRadius: 20 }}
              >
                <option value="">Filter: any source</option>
                {APP_SOURCES.map((s) => (
                  <option key={s} value={s} style={{ background: C.panel, color: C.ink }}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={pipeStatusFilter}
                onChange={(e) => setPipeStatusFilter(e.target.value)}
                style={{ ...selMini, border: `1px solid ${pipeStatusFilter ? C.amber : C.panelEdge}`, color: pipeStatusFilter ? C.amber : C.muted, padding: "6px 10px", borderRadius: 20 }}
              >
                <option value="">Filter: any status</option>
                {APP_STATUSES.map((s) => (
                  <option key={s || "blank"} value={s} style={{ background: C.panel, color: C.ink }}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
              {(pipeSourceFilter || pipeStatusFilter) && (
                <Btn
                  ghost
                  onClick={() => {
                    setPipeSourceFilter("");
                    setPipeStatusFilter("");
                  }}
                  style={{ padding: "6px 12px", fontSize: 11 }}
                >
                  Clear filters
                </Btn>
              )}
            </div>
          </>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <button
              onClick={() => setPipeFilterPanelOpen(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontFamily: sans,
                fontSize: 12,
                fontWeight: 700,
                padding: "8px 14px",
                borderRadius: 20,
                border: `1px solid ${pipeSourceFilter || pipeStatusFilter ? C.amber : C.panelEdge}`,
                background: "transparent",
                color: pipeSourceFilter || pipeStatusFilter ? C.amber : C.muted,
                cursor: "pointer",
              }}
            >
              ⚡ {filters.find((f) => f.key === pipeFilter)?.label || "Filter"}
              {(pipeSourceFilter || pipeStatusFilter) && <span style={{ fontFamily: mono, fontSize: 9 }}>+more</span>}
            </button>

            {pipeFilterPanelOpen && (
              <div
                onClick={() => setPipeFilterPanelOpen(false)}
                style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 55 }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: "100%", maxWidth: 560, maxHeight: "75vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderTopLeftRadius: 20, borderTopRightRadius: 20, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
                >
                  <div style={{ padding: "18px 20px 10px", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>Filters</div>
                    <button onClick={() => setPipeFilterPanelOpen(false)} style={{ background: "transparent", border: "none", color: C.muted, fontSize: 20, cursor: "pointer" }}>×</button>
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px" }}>
                    <Label>Show</Label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                      {filters.map((f) => (
                        <button
                          key={f.key}
                          onClick={() => {
                            setPipeFilter(f.key);
                            setShowQueuedDue(false);
                            setPipeFilterPanelOpen(false);
                          }}
                          style={{
                            textAlign: "left",
                            fontFamily: sans,
                            fontSize: 13,
                            fontWeight: pipeFilter === f.key ? 700 : 500,
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: `1px solid ${pipeFilter === f.key ? C.amber : C.panelEdge}`,
                            background: pipeFilter === f.key ? "rgba(245,185,66,0.1)" : "transparent",
                            color: pipeFilter === f.key ? C.amber : C.ink,
                            cursor: "pointer",
                          }}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>

                    <Label>Source</Label>
                    <select
                      value={pipeSourceFilter}
                      onChange={(e) => setPipeSourceFilter(e.target.value)}
                      style={{ ...inputStyle, marginBottom: 12 }}
                    >
                      <option value="">Any source</option>
                      {APP_SOURCES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>

                    <Label>Status</Label>
                    <select
                      value={pipeStatusFilter}
                      onChange={(e) => setPipeStatusFilter(e.target.value)}
                      style={{ ...inputStyle, marginBottom: 16 }}
                    >
                      <option value="">Any status</option>
                      {APP_STATUSES.map((s) => (
                        <option key={s || "blank"} value={s}>{statusLabel(s)}</option>
                      ))}
                    </select>

                    {(pipeSourceFilter || pipeStatusFilter) && (
                      <Btn
                        ghost
                        onClick={() => {
                          setPipeSourceFilter("");
                          setPipeStatusFilter("");
                        }}
                        style={{ width: "100%" }}
                      >
                        Clear source/status filters
                      </Btn>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {shown.length === 0 && (
          <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
            {apps.length === 0
              ? "No applications tracked yet. Every company you add here updates the funnel numbers automatically."
              : "Nothing matches this search/filter."}
          </div>
        )}

        {shown.length > 0 && isDesktop && (
          <div
            className="desktop-scroll-x"
            style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12 }}
          >
            <datalist id="jobboard-suggestions">
              {JOB_BOARD_OPTIONS.filter((b) => b !== "Other").map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1700 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 34, position: "sticky", left: 0, zIndex: 3, background: C.panel }}>⭐</th>
                  <th style={{ ...th, position: "sticky", left: 34, zIndex: 3, background: C.panel, boxShadow: `2px 0 0 ${C.panelEdge}` }}>Company / Website</th>
                  <th style={th}>Role</th>
                  <th style={th}>Source / Board</th>
                  <th style={th}>Contact</th>
                  <th style={th}>Email</th>
                  <th style={th}>Post link</th>
                  <th style={th}>Screenshot / Link</th>
                  <th style={th}>Salary / offer</th>
                  <th style={th}>Status</th>
                  <th style={th}>Contacted</th>
                  <th style={th}>Follow-up</th>
                  <th style={th}>Notes</th>
                  <th style={{ ...th, width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {shownPage.map((a) => {
                  const nf = nextFollowUp(a);
                  const due = isDue(a);
                  const fus = normFollowUps(a);
                  const doneCount = fus.filter((x) => x.done).length;
                  /* queued-behind-today rows are dimmed and lose the red wash:
                     still fully editable, just not part of today's ask */
                  const queued = dueQueuedIds.has(a.id);
                  return (
                    <tr key={a.id} style={{ opacity: queued ? 0.45 : 1, background: queued ? "transparent" : due ? "rgba(248,113,113,0.06)" : a.highConfidence ? "rgba(245,185,66,0.05)" : "transparent" }}>
                      <td style={{ ...td, textAlign: "center", position: "sticky", left: 0, zIndex: 2, background: C.panel }} onClick={(e) => e.stopPropagation()}>
                        {selectMode ? (
                          <input
                            type="checkbox"
                            checked={selectedAppIds.has(a.id)}
                            disabled={a.fromAccountContact}
                            onChange={() => toggleAppSelected(a.id)}
                            title={a.fromAccountContact ? "Already linked to an account — nothing to convert" : "Select for bulk convert"}
                            style={{ width: 16, height: 16, cursor: a.fromAccountContact ? "not-allowed" : "pointer", opacity: a.fromAccountContact ? 0.3 : 1 }}
                          />
                        ) : (
                          <button
                            onClick={() => updateAppField(a.id, "highConfidence", !a.highConfidence)}
                            title={a.highConfidence ? "High confidence — click to unmark" : "Mark as high confidence"}
                            style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 16, color: a.highConfidence ? C.amber : C.panelEdge, padding: 0 }}
                          >
                            {a.highConfidence ? "⭐" : "☆"}
                          </button>
                        )}
                      </td>
                      <td style={{ ...td, borderLeft: due ? `3px solid ${C.red}` : "3px solid transparent", minWidth: 170, position: "sticky", left: 34, zIndex: 2, background: C.panel, boxShadow: `2px 0 0 ${C.panelEdge}` }}>
                        {cellInput(a, "company", { ph: "Company" })}
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(a, "website", { ph: "website.com" })}
                          {a.website && openLink(a.website, { title: "Open website" })}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 130 }}>
                        {cellInput(a, "role", { ph: "Role applied for" })}
                        {a.archivedAt && pipeFilter === "archived" && (
                          <div style={{ marginTop: 3 }}>
                            {a.autoArchived && (
                              <div style={{ fontFamily: mono, fontSize: 9, color: C.muted, letterSpacing: 0.4, marginBottom: 2 }}>🗄 NO ANSWER · FILED {a.archivedAt}</div>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                unarchiveApplication(a.id);
                              }}
                              style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, borderRadius: 5, color: C.blue, fontFamily: mono, fontSize: 9, padding: "1px 5px", cursor: "pointer", letterSpacing: 0.4 }}
                            >
                              ↩ RESTORE
                            </button>
                          </div>
                        )}
                        {isFromPool(a) && (
                          <div
                            title={`Came from ${a.poolName || "a pool build"} in Pool Mode`}
                            style={{ marginTop: 3, display: "inline-block", background: "rgba(74,222,128,0.12)", border: `1px solid ${C.green}`, borderRadius: 5, color: C.green, fontFamily: mono, fontSize: 9, padding: "1px 5px", letterSpacing: 0.4 }}
                          >
                            🎯 POOL{a.poolName ? ` · ${a.poolName}` : ""}
                          </div>
                        )}
                        {isReapply(a) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleReapplyTag(a.id);
                            }}
                            title={`Reapplication — attempt #${attemptOf(a)}. Click to remove the tag.`}
                            style={{
                              marginTop: 3,
                              background: "rgba(245,185,66,0.12)",
                              border: `1px solid ${C.amber}`,
                              borderRadius: 5,
                              color: C.amber,
                              fontFamily: mono,
                              fontSize: 9,
                              padding: "1px 5px",
                              cursor: "pointer",
                              letterSpacing: 0.4,
                            }}
                          >
                            ↻ REAPPLY #{attemptOf(a)}
                          </button>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 130 }} onClick={(e) => e.stopPropagation()}>
                        {a.fromAccountContact ? (
                          <button
                            onClick={() => openLinkedAccount(a)}
                            title="Open the linked account"
                            style={{ background: "transparent", border: "none", fontFamily: mono, fontSize: 11, color: C.blue, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                          >
                            🏢 Accounts
                          </button>
                        ) : (
                          <>
                            <select
                              value={a.source || ""}
                              onChange={(e) => updateAppField(a.id, "source", e.target.value)}
                              style={{ ...selMini, color: a.source ? C.ink : C.muted, width: "100%" }}
                            >
                              <option value="">—</option>
                              {APP_SOURCES.map((s) => (
                                <option key={s} value={s} style={{ background: C.panel }}>
                                  {s}
                                </option>
                              ))}
                            </select>
                            {a.source === "Job board" && (
                              <input
                                key={a.id + "board" + (a.jobBoardName || "")}
                                list="jobboard-suggestions"
                                defaultValue={a.jobBoardName || ""}
                                placeholder="Which board?"
                                onBlur={(e) => {
                                  e.target.style.border = "1px solid transparent";
                                  if (e.target.value !== (a.jobBoardName || "")) updateAppField(a.id, "jobBoardName", e.target.value);
                                }}
                                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                                style={{ width: "100%", boxSizing: "border-box", fontSize: 12, fontFamily: mono, color: C.blue, background: "transparent", border: "1px solid transparent", borderRadius: 6, padding: "3px 4px", outline: "none", marginTop: 2 }}
                                onFocus={(e) => (e.target.style.border = `1px solid ${C.blue}`)}
                              />
                            )}
                          </>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 130 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(a, "contact", { ph: "Name" })}
                          <CopyButton text={a.email} title="Copy email" />
                          {a.contactLinkedin && (
                            <a
                              href={a.contactLinkedin.startsWith("http") ? a.contactLinkedin : `https://${a.contactLinkedin}`}
                              target="_blank"
                              rel="noreferrer"
                              title="Open LinkedIn profile"
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: C.blue, textDecoration: "none", flexShrink: 0 }}
                            >
                              🔗
                            </a>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setModal({ kind: "application", entry: a });
                          }}
                          title="Edit touch points"
                          style={{ background: "transparent", border: "none", color: C.blue, fontFamily: mono, fontSize: 9, marginTop: 2, padding: 0, cursor: "pointer", textDecoration: "underline" }}
                        >
                          {(a.touchpoints || []).length > 0 ? `💬 ${a.touchpoints.length} touch pt${a.touchpoints.length === 1 ? "" : "s"}` : "+ add a touch point"}
                        </button>
                      </td>
                      <td style={{ ...td, minWidth: 150 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(a, "email", { ph: "email@…" })}
                          {a.email && openLink(a.email, { mailto: true, icon: "✉", title: "Email" })}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(a, "postLink", { ph: "https://…" })}
                          {a.postLink && openLink(a.postLink, { title: "Open job post" })}
                        {postingNeedsCheck(a) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              updateAppField(a.id, "postVerified", today());
                              flash("✓ Posting confirmed live today");
                            }}
                            title={`Posting not confirmed live in ${daysSince(postingCheckedOn(a))} days — open the link to check, then click to mark it verified today.`}
                            style={{ marginTop: 3, display: "block", background: "rgba(245,185,66,0.12)", border: `1px solid ${C.amber}`, borderRadius: 5, color: C.amber, fontFamily: mono, fontSize: 9, padding: "1px 5px", cursor: "pointer", letterSpacing: 0.4 }}
                          >
                            ⚠ CHECK POST · {daysSince(postingCheckedOn(a))}d
                          </button>
                        )}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 150 }} onClick={(e) => e.stopPropagation()}>
                        {a.postShot ? (
                          <a href={shotPublicUrl(a.postShot)} target="_blank" rel="noreferrer" style={{ color: C.blue, fontSize: 12, textDecoration: "none" }}>
                            🖼 view upload
                          </a>
                        ) : (
                          <>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              {cellInput(a, "screenshotLink", { ph: "Drive/Photos link…" })}
                              {a.screenshotLink && (
                                <a href={a.screenshotLink.startsWith("http") ? a.screenshotLink : "https://" + a.screenshotLink} target="_blank" rel="noreferrer" title="Open link" style={{ color: C.blue, fontSize: 13, flexShrink: 0, textDecoration: "none" }}>
                                  🔗
                                </a>
                              )}
                            </div>
                            <button
                              onClick={() => setModal({ kind: "application", entry: a })}
                              title="Attach a screenshot instead (upload or paste)"
                              style={{ background: "transparent", border: "none", color: C.muted, fontSize: 10, cursor: "pointer", padding: "2px 0", textDecoration: "underline" }}
                            >
                              or upload instead
                            </button>
                          </>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 110 }}>{cellInput(a, "salary", { ph: "₱ / $", mono: true })}</td>
                      <td style={{ ...td, minWidth: 140 }} onClick={(e) => e.stopPropagation()}>
                        <select
                          value={a.status ?? ""}
                          onChange={(e) => setAppStatus(a.id, e.target.value)}
                          style={{ ...selMini, fontFamily: mono, background: C.bg, color: statusColor(a.status), border: `1px solid ${C.panelEdge}`, padding: "4px 6px", width: "100%" }}
                        >
                          {APP_STATUSES.map((s) => (
                            <option key={s || "blank"} value={s}>
                              {statusLabel(s)}
                            </option>
                          ))}
                        </select>
                        {liStaleDays({ linkedin: a.contactLinkedin, liStatus: a.liStatus, liStatusAt: a.liStatusAt }) > 0 && (
                          <div
                            title="LinkedIn request has been pending 7+ days — resolve it or it stays looking live"
                            style={{ marginTop: 4, display: "inline-block", border: `1px solid ${C.red}`, borderRadius: 5, color: C.red, fontFamily: mono, fontSize: 9, padding: "1px 5px", letterSpacing: 0.4 }}
                          >
                            in · {liStaleDays({ linkedin: a.contactLinkedin, liStatus: a.liStatus, liStatusAt: a.liStatusAt })}d PENDING
                          </div>
                        )}
                        {!isOpenApp(a) && a.status !== "offer" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              updateAppField(a.id, "gotReply", !a.gotReply);
                            }}
                            title={
                              hadReply(a)
                                ? "A human replied before this closed — click to correct"
                                : "No reply ever came — click if they actually did reply"
                            }
                            style={{
                              marginTop: 4,
                              display: "block",
                              background: hadReply(a) ? "rgba(96,165,250,0.12)" : "transparent",
                              border: `1px solid ${hadReply(a) ? C.blue : C.panelEdge}`,
                              borderRadius: 5,
                              color: hadReply(a) ? C.blue : C.muted,
                              fontFamily: mono,
                              fontSize: 9,
                              padding: "1px 5px",
                              cursor: "pointer",
                              letterSpacing: 0.4,
                            }}
                          >
                            {hadReply(a) ? "✉ REPLIED" : "🔇 NO REPLY"}
                          </button>
                        )}
                        {a.status === "outreach" && (
                          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                            <select
                              value={a.outreachKind || ""}
                              onChange={(e) => updateAppField(a.id, "outreachKind", e.target.value)}
                              style={{ ...selMini, fontSize: 10, color: a.outreachKind ? outreachKindColor(a.outreachKind) : C.muted, flex: 1, padding: "2px" }}
                            >
                              <option value="">kind</option>
                              {OUTREACH_KINDS.map((k) => (
                                <option key={k} value={k}>
                                  {k}
                                </option>
                              ))}
                            </select>
                            <select
                              value={a.outreachChannel || ""}
                              onChange={(e) => updateAppField(a.id, "outreachChannel", e.target.value)}
                              style={{ ...selMini, fontSize: 10, color: a.outreachChannel ? C.ink : C.muted, flex: 1, padding: "2px" }}
                            >
                              <option value="">via</option>
                              {OUTREACH_CHANNELS.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {a.status === "bad fit" && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                            {(a.badReasons || []).length > 0 ? (
                              (a.badReasons || []).map((r) => (
                                <span key={r} style={{ fontFamily: mono, fontSize: 8, letterSpacing: "0.04em", color: C.red, background: "rgba(248,113,113,0.1)", borderRadius: 8, padding: "2px 6px", whiteSpace: "nowrap" }}>
                                  {r}
                                </span>
                              ))
                            ) : (
                              <button
                                onClick={() => setModal({ kind: "application", entry: a })}
                                style={{ background: "transparent", border: "none", color: C.muted, fontSize: 9, textDecoration: "underline", cursor: "pointer", padding: 0 }}
                              >
                                add reason
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <input
                          key={a.id + "contacted" + (a.contacted || "")}
                          type="date"
                          defaultValue={a.contacted || ""}
                          onChange={(e) => updateAppField(a.id, "contacted", e.target.value)}
                          style={{ fontSize: 13, fontFamily: mono, background: "transparent", border: "1px solid transparent", borderRadius: 6, color: C.muted, padding: "4px 2px", outline: "none", colorScheme: "dark" }}
                        />
                      </td>
                      <td
                        style={{ ...td, fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", color: due ? C.red : nf ? C.muted : C.green }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ cursor: "pointer" }} onClick={() => setModal({ kind: "application", entry: a })} title="Click to edit the follow-up schedule">
                            {nf ? `${nf.date} (${doneCount}/${fus.length})${due ? " ⚑" : ""}` : fus.length ? `all done (${fus.length})` : "—"}
                          </span>
                          {fus.length > 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                updateAppField(a.id, "followUps", []);
                                flash("Follow-ups cleared");
                              }}
                              title="No follow-up needed — clear all"
                              style={{ background: "transparent", border: "none", color: C.muted, fontSize: 12, cursor: "pointer", padding: 0, lineHeight: 1, flexShrink: 0 }}
                            >
                              🚫
                            </button>
                          )}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>{cellInput(a, "notes", { ph: "notes…" })}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => askDeleteApplication(a)}
                          title="Delete"
                          style={{ width: 24, height: 24, borderRadius: 12, border: `1px solid ${C.panelEdge}`, background: "transparent", color: C.muted, fontSize: 13, lineHeight: "22px", cursor: "pointer", padding: 0 }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {visible.length > 0 && isDesktop && <Pagination page={pipePage} setPage={setPipePage} total={visible.length} />}

        {shown.length > 0 && !isDesktop && (
          <div
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12 }}
          >
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 30 }}>⭐</th>
                  <th style={th}>Company</th>
                  <th style={th}>Source</th>
                  <th style={th}>Post</th>
                  <th style={th}>Salary / offer</th>
                  <th style={th}>Status</th>
                  <th style={th}>Contacted</th>
                  <th style={th}>Follow-up</th>
                  <th style={{ ...th, width: 66 }}></th>
                </tr>
              </thead>
              <tbody>
                {shownPage.map((a) => {
                  const nf = nextFollowUp(a);
                  const due = isDue(a);
                  const fus = normFollowUps(a);
                  const doneCount = fus.filter((x) => x.done).length;
                  const queued = dueQueuedIds.has(a.id);
                  return (
                    <tr key={a.id} onClick={() => setModal({ kind: "application", entry: a })} style={{ cursor: "pointer", opacity: queued ? 0.45 : 1, background: queued ? "transparent" : due ? "rgba(248,113,113,0.06)" : "transparent" }}>
                      <td style={{ ...td, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                        {selectMode ? (
                          <input
                            type="checkbox"
                            checked={selectedAppIds.has(a.id)}
                            disabled={a.fromAccountContact}
                            onChange={() => toggleAppSelected(a.id)}
                            style={{ width: 16, height: 16, cursor: a.fromAccountContact ? "not-allowed" : "pointer", opacity: a.fromAccountContact ? 0.3 : 1 }}
                          />
                        ) : (
                          <button
                            onClick={() => updateAppField(a.id, "highConfidence", !a.highConfidence)}
                            style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 15, color: a.highConfidence ? C.amber : C.panelEdge, padding: 0 }}
                          >
                            {a.highConfidence ? "⭐" : "☆"}
                          </button>
                        )}
                      </td>
                      <td style={{ ...td, fontWeight: 700, borderLeft: due ? `3px solid ${C.red}` : "3px solid transparent", minWidth: 150 }}>
                        {a.company || "Unnamed"}
                        {a.role && <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{a.role}</div>}
                        {a.archivedAt && pipeFilter === "archived" && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              unarchiveApplication(a.id);
                            }}
                            style={{ display: "inline-block", marginTop: 3, marginRight: 4, border: `1px solid ${C.panelEdge}`, borderRadius: 5, color: C.blue, fontFamily: mono, fontSize: 9, fontWeight: 400, padding: "1px 5px", letterSpacing: 0.4 }}
                          >
                            ↩ RESTORE{a.autoArchived ? " · no answer" : ""}
                          </span>
                        )}
                        {isFromPool(a) && (
                          <span style={{ display: "inline-block", marginTop: 3, marginRight: 4, background: "rgba(74,222,128,0.12)", border: `1px solid ${C.green}`, borderRadius: 5, color: C.green, fontFamily: mono, fontSize: 9, fontWeight: 400, padding: "1px 5px", letterSpacing: 0.4 }}>
                            🎯 POOL
                          </span>
                        )}
                        {isReapply(a) && (
                          <span
                            style={{
                              display: "inline-block",
                              marginTop: 3,
                              background: "rgba(245,185,66,0.12)",
                              border: `1px solid ${C.amber}`,
                              borderRadius: 5,
                              color: C.amber,
                              fontFamily: mono,
                              fontSize: 9,
                              fontWeight: 400,
                              padding: "1px 5px",
                              letterSpacing: 0.4,
                            }}
                          >
                            ↻ REAPPLY #{attemptOf(a)}
                          </span>
                        )}
                        {a.website && (
                          <a
                            href={a.website.startsWith("http") ? a.website : "https://" + a.website}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: C.blue, fontSize: 11, textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}
                          >
                            ↗ {a.website.replace(/^https?:\/\//, "")}
                          </a>
                        )}
                      </td>
                      <td style={td} onClick={(e) => a.fromAccountContact && e.stopPropagation()}>
                        {a.fromAccountContact ? (
                          <button
                            onClick={() => openLinkedAccount(a)}
                            style={{ background: "transparent", border: "none", fontSize: 12, color: C.blue, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                          >
                            🏢 Accounts
                          </button>
                        ) : (
                          <span style={{ fontSize: 12, color: a.source ? C.ink : C.muted }}>{a.source || "—"}</span>
                        )}
                        {a.source === "Job board" && a.jobBoardName && (
                          <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.06em", color: C.blue, marginTop: 3 }}>{a.jobBoardName}</div>
                        )}
                      </td>
                      <td style={td}>
                        {a.postLink ? (
                          <a href={a.postLink.startsWith("http") ? a.postLink : "https://" + a.postLink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: C.blue, fontSize: 12, textDecoration: "none" }}>
                            🔗 link
                          </a>
                        ) : a.postShot ? (
                          <a href={shotPublicUrl(a.postShot)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: C.blue, fontSize: 12, textDecoration: "none" }}>
                            🖼 shot
                          </a>
                        ) : a.screenshotLink ? (
                          <a href={a.screenshotLink.startsWith("http") ? a.screenshotLink : "https://" + a.screenshotLink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: C.blue, fontSize: 12, textDecoration: "none" }}>
                            🔗 shot link
                          </a>
                        ) : (
                          <span style={{ color: C.muted, fontSize: 12 }}>—</span>
                        )}
                        {postingNeedsCheck(a) && (
                          <div style={{ marginTop: 3, color: C.amber, fontFamily: mono, fontSize: 9, letterSpacing: 0.4 }}>⚠ CHECK POST · {daysSince(postingCheckedOn(a))}d</div>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 110 }}>
                        <span style={{ fontFamily: mono, fontSize: 12, color: a.salary ? C.ink : C.muted }}>{a.salary || "—"}</span>
                      </td>
                      <td style={td} onClick={(e) => e.stopPropagation()}>
                        <select
                          value={a.status ?? ""}
                          onChange={(e) => setAppStatus(a.id, e.target.value)}
                          style={{ fontSize: 16, fontFamily: mono, background: C.bg, color: statusColor(a.status), border: `1px solid ${C.panelEdge}`, borderRadius: 8, padding: "4px 6px", outline: "none" }}
                        >
                          {APP_STATUSES.map((s) => (
                            <option key={s || "blank"} value={s}>
                              {statusLabel(s)}
                            </option>
                          ))}
                        </select>
                        {a.outreachKind && (
                          <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.1em", color: outreachKindColor(a.outreachKind), marginTop: 4, textTransform: "uppercase" }}>
                            {a.outreachKind}{a.outreachChannel ? ` · ${a.outreachChannel}` : ""}
                          </div>
                        )}
                        {a.status === "bad fit" && (a.badReasons || []).length > 0 && (
                          <div style={{ fontFamily: mono, fontSize: 9, color: C.red, marginTop: 4 }}>{(a.badReasons || []).join(", ")}</div>
                        )}
                        {!isOpenApp(a) && a.status !== "offer" && (
                          <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: 0.4, color: hadReply(a) ? C.blue : C.muted, marginTop: 4 }}>
                            {hadReply(a) ? "✉ REPLIED" : "🔇 NO REPLY"}
                          </div>
                        )}
                        {liStaleDays({ linkedin: a.contactLinkedin, liStatus: a.liStatus, liStatusAt: a.liStatusAt }) > 0 && (
                          <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: 0.4, color: C.red, marginTop: 4 }}>
                            in · {liStaleDays({ linkedin: a.contactLinkedin, liStatus: a.liStatus, liStatusAt: a.liStatusAt })}d PENDING
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        <span style={{ fontFamily: mono, fontSize: 12, color: C.muted }}>{a.contacted || "—"}</span>
                      </td>
                      <td style={{ ...td, fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", color: due ? C.red : nf ? C.muted : C.green }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span>{nf ? `${nf.date} (${doneCount}/${fus.length})${due ? " ⚑" : ""}` : fus.length ? `all done (${fus.length})` : "—"}</span>
                          {fus.length > 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                updateAppField(a.id, "followUps", []);
                                flash("Follow-ups cleared");
                              }}
                              title="No follow-up needed — clear all"
                              style={{ background: "transparent", border: "none", color: C.muted, fontSize: 12, cursor: "pointer", padding: 0, lineHeight: 1, flexShrink: 0 }}
                            >
                              🚫
                            </button>
                          )}
                        </div>
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => askDeleteApplication(a)}
                          title="Delete"
                          style={{ width: 24, height: 24, borderRadius: 12, border: `1px solid ${C.panelEdge}`, background: "transparent", color: C.muted, fontSize: 13, lineHeight: "22px", cursor: "pointer", padding: 0 }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {visible.length > 0 && !isDesktop && <Pagination page={pipePage} setPage={setPipePage} total={visible.length} />}
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          {isDesktop
            ? "Full spreadsheet — click any cell to edit, Enter or click away to save. 📎 attach handles screenshots; the follow-up column opens the schedule editor."
            : "Tap a row to edit · status changes update the Funnel instantly."}
        </div>
          </>
        )}
      </>
    );
  };

  const renderAccounts = () => {
    const accounts = state.accounts || [];
    const accFilters = [
      { key: "active", label: `Active (${accounts.filter(isAccountOpen).length})` },
      { key: "highConfidence", label: `⭐ High confidence (${accounts.filter((a) => a.highConfidence).length})` },
      { key: "notContacted", label: `◻ Not contacted yet (${accounts.flatMap(liveContacts).filter(isContactBlankStatus).length})` },
      { key: "untouched", label: `🕳 No one reached (${accounts.filter((a) => isAccountOpen(a) && isAccountUntouched(a)).length})` },
      { key: "engageDue", label: `💬 Engage (${accounts.flatMap(liveContacts).filter(isEngagementDue).length})` },
      { key: "nurture", label: `🌱 Nurture (${accounts.flatMap(liveContacts).filter((c) => nurtureState(c) === "nurture").length})` },
      { key: "coldGone", label: `❄ Gone cold (${accounts.flatMap(liveContacts).filter((c) => nurtureState(c) === "stale").length})` },
      { key: "outreachedContacts", label: `Outreached contacts (${accounts.filter((a) => (a.contacts || []).some((c) => isContactOutreached(c) && !c.archivedAt)).length})` },
      { key: "dueContacts", label: `⚑ Due contacts (${accounts.filter((a) => (a.contacts || []).some((c) => isContactDue(c) && !c.archivedAt)).length})` },
      { key: "closed", label: `Closed (${accounts.filter((a) => a.status === "closed").length})` },
      { key: "badFit", label: `🚫 Bad fit (${accounts.filter((a) => a.status === "bad fit").length})` },
      { key: "all", label: `All (${accounts.length})` },
    ];
    const shownAccounts = accounts
      .filter((acc) =>
        accFilter === "active"
          ? isAccountOpen(acc)
          : accFilter === "highConfidence"
          ? !!acc.highConfidence
          : accFilter === "notContacted"
          ? liveContacts(acc).some(isContactBlankStatus)
          : accFilter === "untouched"
          ? isAccountOpen(acc) && isAccountUntouched(acc)
          : accFilter === "engageDue"
          ? liveContacts(acc).some(isEngagementDue)
          : accFilter === "nurture"
          ? liveContacts(acc).some((c) => nurtureState(c) === "nurture")
          : accFilter === "coldGone"
          ? liveContacts(acc).some((c) => nurtureState(c) === "stale")
          : accFilter === "outreachedContacts"
          ? (acc.contacts || []).some((c) => isContactOutreached(c) && !c.archivedAt)
          : accFilter === "dueContacts"
          ? (acc.contacts || []).some((c) => isContactDue(c) && !c.archivedAt)
          : accFilter === "closed"
          ? acc.status === "closed"
          : accFilter === "badFit"
          ? acc.status === "bad fit"
          : true
      )
      .filter((acc) => {
        if (!accSearch.trim()) return true;
        const q = accSearch.trim().toLowerCase();
        const contactMatch = (acc.contacts || []).some((c) => [c.name, c.email, c.position, c.linkedin].filter(Boolean).some((f) => f.toLowerCase().includes(q)));
        return [acc.company, acc.website, acc.industry, acc.notes].filter(Boolean).some((f) => f.toLowerCase().includes(q)) || contactMatch;
      })
      .slice()
      /* when filtering to accounts with due contacts, order companies by their
         most overdue contact so the queue reads oldest-first; otherwise
         alphabetical for browsing */
      .sort((a, b) => {
        if (accFilter !== "dueContacts") return (a.company || "").localeCompare(b.company || "");
        const soonest = (acc) =>
          (acc.contacts || [])
            .filter((c) => isContactDue(c) && !c.archivedAt)
            .map((c) => followUpOf(c) || "9999-12-31")
            .sort()[0] || "9999-12-31";
        return soonest(a).localeCompare(soonest(b)) || (a.company || "").localeCompare(b.company || "");
      });
    const shownAccountsPage = shownAccounts.slice(accPage * PAGE_SIZE, (accPage + 1) * PAGE_SIZE);

    const rowsDesktop = shownAccounts.length > 0 && isDesktop;
    const rowsMobile = shownAccounts.length > 0 && !isDesktop;
    const isContactFilterView = ["outreachedContacts", "dueContacts", "notContacted", "nurture", "coldGone", "engageDue"].includes(accFilter);

    /* flat contact list for the Outreached/Due filters — shows people, not company rows */
    const flatContacts = isContactFilterView
      ? accounts
          .flatMap((acc) => (acc.contacts || []).filter((c) => !c.archivedAt).map((c) => ({ ...c, _company: acc.company || "Unnamed", _accountId: acc.id })))
          .filter((c) =>
            accFilter === "outreachedContacts"
              ? isContactOutreached(c)
              : accFilter === "notContacted"
              ? isContactBlankStatus(c)
              : accFilter === "engageDue"
              ? isEngagementDue(c)
              : accFilter === "nurture"
              ? nurtureState(c) === "nurture"
              : accFilter === "coldGone"
              ? nurtureState(c) === "stale"
              : isContactDue(c)
          )
          .filter((c) => {
            if (!accSearch.trim()) return true;
            const q = accSearch.trim().toLowerCase();
            return [c.name, c.email, c.position, c._company, c.linkedin].filter(Boolean).some((f) => f.toLowerCase().includes(q));
          })
          /* Due contacts is a work queue too — most overdue first. The
             Outreached list stays alphabetical by company for browsing. */
          .sort((a, b) =>
            accFilter === "dueContacts"
              ? (followUpOf(a) || "9999-12-31").localeCompare(followUpOf(b) || "9999-12-31") || a._company.localeCompare(b._company)
              : accFilter === "engageDue"
              ? /* longest-overdue first — same work-queue logic as follow-ups */
                (engagementDueDate(a) || "9999-12-31").localeCompare(engagementDueDate(b) || "9999-12-31") || a._company.localeCompare(b._company)
              : a._company.localeCompare(b._company)
          )
      : [];
    const flatContactsPage = flatContacts.slice(accPage * PAGE_SIZE, (accPage + 1) * PAGE_SIZE);

    return (
      <>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            value={accSearch}
            onChange={(e) => setAccSearch(e.target.value)}
            placeholder="🔎 Search company, contact name, email…"
            style={{ ...inputStyle, flex: 1 }}
          />
          {accSearch && (
            <Btn ghost onClick={() => setAccSearch("")} style={{ padding: "10px 14px" }}>
              Clear
            </Btn>
          )}
        </div>

        {isDesktop ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {accFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setAccFilter(f.key)}
                style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 20, border: `1px solid ${accFilter === f.key ? C.amber : C.panelEdge}`, background: accFilter === f.key ? "rgba(245,185,66,0.12)" : "transparent", color: accFilter === f.key ? C.amber : C.muted, cursor: "pointer" }}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <button
              onClick={() => setAccFilterPanelOpen(true)}
              style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: sans, fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 20, border: `1px solid ${C.panelEdge}`, background: "transparent", color: C.muted, cursor: "pointer" }}
            >
              🔍 {accFilters.find((f) => f.key === accFilter)?.label || "Filter"}
            </button>

            {accFilterPanelOpen && (
              <div
                onClick={() => setAccFilterPanelOpen(false)}
                style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 55 }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: "100%", maxWidth: 560, maxHeight: "75vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderTopLeftRadius: 20, borderTopRightRadius: 20, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
                >
                  <div style={{ padding: "18px 20px 10px", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>Filters</div>
                    <button onClick={() => setAccFilterPanelOpen(false)} style={{ background: "transparent", border: "none", color: C.muted, fontSize: 20, cursor: "pointer" }}>×</button>
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px", display: "flex", flexDirection: "column", gap: 6 }}>
                    {accFilters.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => {
                          setAccFilter(f.key);
                          setAccFilterPanelOpen(false);
                        }}
                        style={{
                          textAlign: "left",
                          fontFamily: sans,
                          fontSize: 13,
                          fontWeight: accFilter === f.key ? 700 : 500,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: `1px solid ${accFilter === f.key ? C.amber : C.panelEdge}`,
                          background: accFilter === f.key ? "rgba(245,185,66,0.1)" : "transparent",
                          color: accFilter === f.key ? C.amber : C.ink,
                          cursor: "pointer",
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {isContactFilterView ? (
          <>
            {flatContacts.length === 0 && (
              <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
                {accFilter === "outreachedContacts"
                  ? "No contacts outreached yet."
                  : accFilter === "notContacted"
                  ? "Everyone on your accounts has been contacted. Add contacts to an account to build the queue back up."
                  : "No contacts due for follow-up."}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {flatContactsPage.map((c) => {
                const acc = accounts.find((a) => a.id === c._accountId);
                const nf = nextFollowUp(c);
                const fus = normFollowUps(c);
                const doneCount = fus.filter((x) => x.done).length;
                const due = isContactDue(c);
                return (
                  <div
                    key={c.id}
                    onClick={() => acc && setModal({ kind: "account", entry: acc })}
                    style={{ background: C.panel, border: `1px solid ${due ? C.red : C.panelEdge}`, borderRadius: 12, padding: "12px 14px", cursor: "pointer" }}
                  >
                    <div style={{ fontStyle: "italic", fontWeight: 700, fontSize: 12, color: C.amber, marginBottom: 4 }}>@{c._company}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{c.name || "Unnamed"}</div>
                        <CopyButton text={c.email} title="Copy email" />
                      </div>
                      {c.status && (
                        <span style={{ fontFamily: mono, fontSize: 10, color: contactStatusColor(c.status), textTransform: "uppercase", flexShrink: 0 }}>
                          {contactStatusLabel(c.status)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                      {[c.position, c.email, c.phone].filter(Boolean).join(" · ") || "—"}
                    </div>
                    <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
                      {c.outreachKind && (
                        <span style={{ fontFamily: mono, fontSize: 10, color: outreachKindColor(c.outreachKind), textTransform: "uppercase" }}>{c.outreachKind}</span>
                      )}
                      {fus.length > 0 && (
                        <span style={{ fontFamily: mono, fontSize: 11, color: due ? C.red : nf ? C.muted : C.green }}>
                          {nf ? `Next: ${nf.date} (${doneCount}/${fus.length})${due ? " ⚑" : ""}` : `all done (${fus.length})`}
                        </span>
                      )}
                      {c.linkedin && (
                        <a
                          href={c.linkedin.startsWith("http") ? c.linkedin : `https://${c.linkedin}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open LinkedIn profile"
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: C.blue, fontSize: 11, textDecoration: "none" }}
                        >
                          🔗 LinkedIn
                        </a>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (acc) setModal({ kind: "account", entry: acc });
                        }}
                        title="Edit touch points"
                        style={{ background: "transparent", border: "none", color: C.blue, fontFamily: mono, fontSize: 10, padding: 0, cursor: "pointer", textDecoration: "underline" }}
                      >
                        {(c.touchpoints || []).length > 0 ? `💬 ${c.touchpoints.length}` : "+ add a touch point"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <Pagination page={accPage} setPage={setAccPage} total={flatContacts.length} />
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>Tap a contact to open their account and edit details.</div>
          </>
        ) : (
          <>
        {shownAccounts.length === 0 && (
          <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
            {accounts.length === 0
              ? "No accounts tracked yet. Use the + Account button to build a company-level relationship record — multiple contacts, one place."
              : "Nothing matches this search/filter."}
          </div>
        )}

        {rowsDesktop && (
          <div className="desktop-scroll-x" style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1150 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 34, position: "sticky", left: 0, zIndex: 3, background: C.panel }}>⭐</th>
                  <th style={{ ...th, position: "sticky", left: 34, zIndex: 3, background: C.panel, boxShadow: `2px 0 0 ${C.panelEdge}` }}>Company / Website</th>
                  <th style={th}>Industry</th>
                  <th style={th}>Status</th>
                  <th style={th}>Contacts</th>
                  <th style={th}>Related applications</th>
                  <th style={th}>Notes</th>
                  <th style={{ ...th, width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {shownAccountsPage.map((acc) => {
                  const contacts = (acc.contacts || []).filter((c) => !c.archivedAt);
                  const related = relatedApplications(acc.company, apps);
                  const anyDue = contacts.some(isContactDue);
                  const outreachedCount = contacts.filter(isContactOutreached).length;
                  return (
                    <tr key={acc.id} style={{ background: anyDue ? "rgba(248,113,113,0.06)" : acc.highConfidence ? "rgba(245,185,66,0.05)" : "transparent" }}>
                      <td style={{ ...td, textAlign: "center", position: "sticky", left: 0, zIndex: 2, background: C.panel }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => updateAccountField(acc.id, "highConfidence", !acc.highConfidence)}
                          title={acc.highConfidence ? "High confidence — click to unmark" : "Mark as high confidence"}
                          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 16, color: acc.highConfidence ? C.amber : C.panelEdge, padding: 0 }}
                        >
                          {acc.highConfidence ? "⭐" : "☆"}
                        </button>
                      </td>
                      <td style={{ ...td, minWidth: 180, borderLeft: anyDue ? `3px solid ${C.red}` : "3px solid transparent", position: "sticky", left: 34, zIndex: 2, background: C.panel, boxShadow: `2px 0 0 ${C.panelEdge}` }}>
                        {cellInput(acc, "company", { ph: "Company", onCommit: updateAccountField })}
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(acc, "website", { ph: "website.com", onCommit: updateAccountField })}
                          {acc.website && openLink(acc.website, { title: "Open website" })}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 120 }}>
                        {cellInput(acc, "industry", { ph: "Industry", onCommit: updateAccountField })}
                        {cellInput(acc, "headcount", { ph: "Headcount", onCommit: updateAccountField })}
                      </td>
                      <td style={{ ...td, minWidth: 110 }} onClick={(e) => e.stopPropagation()}>
                        <select
                          value={acc.status || ""}
                          onChange={(e) => updateAccountField(acc.id, "status", e.target.value)}
                          style={{ ...selMini, fontFamily: mono, background: C.bg, color: accountStatusColor(acc.status), border: `1px solid ${C.panelEdge}`, padding: "4px 6px", width: "100%" }}
                        >
                          {ACCOUNT_STATUSES.map((s) => (
                            <option key={s || "blank"} value={s}>{accountStatusLabel(s)}</option>
                          ))}
                        </select>
                        {acc.status === "bad fit" && (acc.badReasons || []).length > 0 && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                            {acc.badReasons.map((r) => (
                              <span key={r} style={{ fontFamily: mono, fontSize: 8, color: C.red, background: "rgba(248,113,113,0.1)", borderRadius: 8, padding: "2px 6px", whiteSpace: "nowrap" }}>{r}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 190, cursor: "pointer" }} onClick={() => setModal({ kind: "account", entry: acc })}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: contacts.length ? C.ink : C.muted }}>
                          {contacts.length ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"}` : "🕳 no contacts yet"}
                          {anyDue && <span style={{ color: C.red, marginLeft: 6 }}>⚑ due</span>}
                          {(() => {
                            /* the quietly-stuck case: contacts exist but none has been
                               reached, so the account looks tracked while going nowhere */
                            const untouched = contacts.filter(isContactBlankStatus).length;
                            return untouched > 0 ? <span style={{ color: C.amber, marginLeft: 6, fontWeight: 400 }}>◻ {untouched} not contacted</span> : null;
                          })()}
                        </div>
                        {contacts.map((c) => (
                          <div key={c.id} style={{ fontSize: 11, color: C.muted, marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {c.name || "Unnamed"}{c.position ? ` · ${c.position}` : ""}
                              {c.status && <span style={{ color: contactStatusColor(c.status), marginLeft: 4 }}>· {c.status}</span>}
                            </span>
                            <CopyButton text={c.email} title="Copy email" />
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setModal({ kind: "account", entry: acc });
                              }}
                              title="Edit touch points"
                              style={{ background: "transparent", border: "none", color: C.blue, fontFamily: mono, fontSize: 9, flexShrink: 0, padding: 0, cursor: "pointer", textDecoration: "underline", whiteSpace: "nowrap" }}
                            >
                              {(c.touchpoints || []).length > 0 ? `💬 ${c.touchpoints.length}` : "+ touch point"}
                            </button>
                            {c.linkedin && (
                              <a
                                href={c.linkedin.startsWith("http") ? c.linkedin : `https://${c.linkedin}`}
                                target="_blank"
                                rel="noreferrer"
                                title="Open LinkedIn profile"
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: C.blue, textDecoration: "none", flexShrink: 0 }}
                              >
                                🔗
                              </a>
                            )}
                          </div>
                        ))}
                        {outreachedCount > 0 && (
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.blue, marginTop: 4 }}>{outreachedCount} outreached</div>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 150 }} onClick={(e) => e.stopPropagation()}>
                        {related.length === 0 ? (
                          <span style={{ color: C.muted, fontSize: 12 }}>—</span>
                        ) : (
                          <button
                            onClick={() => openRelatedApplications(acc.company)}
                            title={`Show ${acc.company || "this account"}'s applications & outreach in the Applications view`}
                            style={{ background: "transparent", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontSize: 12, width: "100%" }}
                          >
                            <span style={{ color: C.blue, fontWeight: 700, textDecoration: "underline" }}>{related.length} linked →</span>
                            <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                              {related
                                .slice(0, 3)
                                .map((r) => statusLabel(r.status))
                                .join(", ")}
                              {related.length > 3 ? "…" : ""}
                            </div>
                          </button>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 150 }}>{cellInput(acc, "notes", { ph: "notes…", onCommit: updateAccountField })}</td>
                      <td style={td} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => askDeleteAccount(acc)}
                          title="Delete"
                          style={{ width: 24, height: 24, borderRadius: 12, border: `1px solid ${C.panelEdge}`, background: "transparent", color: C.muted, fontSize: 13, lineHeight: "22px", cursor: "pointer", padding: 0 }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rowsDesktop && <Pagination page={accPage} setPage={setAccPage} total={shownAccounts.length} />}

        {rowsMobile && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {shownAccountsPage.map((acc) => {
              const contacts = (acc.contacts || []).filter((c) => !c.archivedAt);
              const related = relatedApplications(acc.company, apps);
              const anyDue = contacts.some(isContactDue);
              const outreachedCount = contacts.filter(isContactOutreached).length;
              return (
                <SwipeRow
                  key={acc.id}
                  showX={false}
                  onTap={() => setModal({ kind: "account", entry: acc })}
                  onDelete={() => askDeleteAccount(acc)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {acc.highConfidence && <span style={{ color: C.amber }}>⭐</span>}
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{acc.company || "Unnamed"}</div>
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 11, color: anyDue ? C.red : C.muted, flexShrink: 0 }}>
                      {contacts.length ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"}` : "🕳 no contacts yet"}{anyDue ? " ⚑" : ""}
                      {contacts.filter(isContactBlankStatus).length > 0 && (
                        <span style={{ color: C.amber }}> · ◻ {contacts.filter(isContactBlankStatus).length} not contacted</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
                    {acc.industry && <span style={{ fontSize: 12, color: C.muted }}>{acc.industry}</span>}
                    {acc.headcount && <span style={{ fontSize: 12, color: C.muted }}>· {acc.headcount}</span>}
                    {acc.status && <span style={{ fontFamily: mono, fontSize: 10, color: accountStatusColor(acc.status), textTransform: "uppercase" }}>{accountStatusLabel(acc.status)}</span>}
                  </div>
                  {contacts.map((c) => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.ink, marginTop: 4 }}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.name || "Unnamed"}{c.position ? ` · ${c.position}` : ""}
                        {c.status && <span style={{ color: contactStatusColor(c.status), marginLeft: 4 }}>· {c.status}</span>}
                      </span>
                      <CopyButton text={c.email} title="Copy email" />
                      {(c.touchpoints || []).length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setModal({ kind: "account", entry: acc });
                          }}
                          title="Edit touch points"
                          style={{ background: "transparent", border: "none", color: C.blue, fontFamily: mono, fontSize: 9, flexShrink: 0, padding: 0, cursor: "pointer", textDecoration: "underline" }}
                        >
                          💬 {c.touchpoints.length}
                        </button>
                      )}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    {outreachedCount > 0 && <span style={{ fontSize: 11, color: C.blue }}>{outreachedCount} outreached</span>}
                    {related.length > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation(); /* don't also open the account modal */
                          openRelatedApplications(acc.company);
                        }}
                        style={{ background: "transparent", border: "none", padding: 0, fontSize: 11, color: C.blue, textDecoration: "underline", cursor: "pointer" }}
                      >
                        {related.length} related app{related.length === 1 ? "" : "s"} →
                      </button>
                    )}
                  </div>
                </SwipeRow>
              );
            })}
          </div>
        )}
        {rowsMobile && <Pagination page={accPage} setPage={setAccPage} total={shownAccounts.length} />}

        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          {isDesktop ? "Click any cell to edit · click Contacts to manage the full contact list." : "Tap a row to manage contacts and details."} Related applications link automatically by company name — click the linked count to jump to them.
        </div>
          </>
        )}
      </>
    );
  };

  const renderContent = () => {
    const items = state.content || [];
    const perWeek = state.contentGoal?.perWeek || 0;
    const thisWeekStart = iso(mondayOfToday());
    const thisWeekLabel = weekLabel(mondayOfToday());
    const doneThisWeek = items.filter((c) => c.date && weekStartOfDate(c.date) === thisWeekStart && c.status === "published").length;
    const weekMet = perWeek > 0 && doneThisWeek >= perWeek;

    const shown = items
      .filter((c) => contentFilter === "all" || (c.status || "idea") === contentFilter)
      .filter((c) => {
        if (!contentSearch.trim()) return true;
        const q = contentSearch.trim().toLowerCase();
        return [c.title, c.type, c.link, c.assetsLink, c.hook, c.outline, c.draft, c.notes, ...(c.platforms || [])].filter(Boolean).some((f) => f.toLowerCase().includes(q));
      })
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const shownPage = shown.slice(contentPage * PAGE_SIZE, (contentPage + 1) * PAGE_SIZE);

    const todaysEntry = state.contentScheduleLog?.[today()] || null;

    return (
      <>
        {/* today's content focus — the single task for today, per the schedule set in Settings */}
        {todaysEntry && (
          <div style={{ background: C.panel, border: `1px solid ${todaysEntry.done ? C.green : C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
            <Label>📌 Today's content focus</Label>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 10 }}>
              <div>
                <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink }}>{CONTENT_STAGE_LABEL[todaysEntry.stage]}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{CONTENT_STAGE_VERB[todaysEntry.stage]}</div>
              </div>
              <button
                onClick={() => toggleContentScheduleDone(today())}
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: todaysEntry.done ? "rgba(74,222,128,0.15)" : "transparent",
                  border: `1px solid ${todaysEntry.done ? C.green : C.panelEdge}`,
                  color: todaysEntry.done ? C.green : C.muted,
                  borderRadius: 10,
                  padding: "8px 14px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {todaysEntry.done ? "✓ Done" : "☐ Mark done"}
              </button>
            </div>
          </div>
        )}

        {/* weekly content goal */}
        <div style={{ background: C.panel, border: `1px solid ${weekMet ? C.green : C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Label>📝 Content goal — {thisWeekLabel}</Label>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
            <div style={{ fontFamily: mono, fontSize: 36, fontWeight: 800, color: weekMet ? C.green : C.amber, lineHeight: 1.1 }}>
              {doneThisWeek} / {perWeek}
            </div>
            <div style={{ fontSize: 13, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
              content this week
              <input
                type="number"
                defaultValue={perWeek}
                onBlur={(e) => e.target.value !== String(perWeek) && setContentGoalPerWeek(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                title="Edit weekly target"
                style={{ width: 44, fontSize: 13, fontFamily: mono, background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 6, padding: "3px 6px", color: C.ink, outline: "none" }}
              />
              /wk
            </div>
          </div>
          {perWeek > 0 && (
            <div style={{ height: 8, background: C.bg, borderRadius: 4, marginTop: 10, overflow: "hidden", border: `1px solid ${C.panelEdge}` }}>
              <div style={{ height: "100%", width: `${Math.min(100, (doneThisWeek / perWeek) * 100)}%`, background: weekMet ? C.green : C.amber, borderRadius: 4, transition: "width 0.3s ease" }} />
            </div>
          )}
        </div>

        {/* ---- commitment strip: the leading indicators ----
            The weekly count above only tells you you've failed after the fact.
            These three tell you BEFORE: what's banked, what streak is at risk,
            and whether the idea well has run dry. */}
        {(() => {
          const bufferTarget = state.contentGoal?.bufferTarget ?? DEFAULT_CONTENT_BUFFER_TARGET;
          const ideaFloor = state.contentGoal?.ideaFloor ?? DEFAULT_CONTENT_IDEA_FLOOR;
          const frozenWeeks = state.contentGoal?.frozenWeeks || [];
          const buffer = contentBufferCount(items);
          const ideas = contentIdeaCount(items);
          const streak = computeContentStreak(items, perWeek, frozenWeeks);
          const lastWeek = addDays(thisWeekStart, -7);
          const lastWeekPublished = publishedInWeek(items, lastWeek);
          const lastWeekMissed = perWeek > 0 && lastWeekPublished < perWeek && !frozenWeeks.includes(lastWeek);
          const freezeAvailable = canFreezeWeek(frozenWeeks, lastWeek);
          const overdueCount = items.filter(contentOverdue).length;
          const patterns = contentSkipPatterns(state.contentScheduleLog, 35);
          const cell = (label, value, sub, color) => (
            <div style={{ flex: 1, minWidth: 96, background: C.panel, border: `1px solid ${color || C.panelEdge}`, borderRadius: 12, padding: "10px 12px" }}>
              <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.14em", color: C.muted, textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color: color || C.ink, lineHeight: 1.25, marginTop: 2 }}>{value}</div>
              <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.4, marginTop: 2 }}>{sub}</div>
            </div>
          );
          return (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {cell(
                  "❄️ Streak",
                  `${streak.weeks} wk${streak.weeks === 1 ? "" : "s"}`,
                  streak.weeks > 0 ? "consecutive weeks on target" : "hit this week's target to start one",
                  streak.weeks > 0 ? C.green : C.panelEdge
                )}
                {cell(
                  "📦 Ready to publish",
                  `${buffer} / ${bufferTarget}`,
                  buffer >= bufferTarget ? "banked — a missed day costs nothing" : buffer === 0 ? "nothing banked. This is the real risk." : "below your buffer",
                  buffer >= bufferTarget ? C.green : buffer === 0 ? C.red : C.amber
                )}
                {cell(
                  "💡 Idea bank",
                  `${ideas} / ${ideaFloor}`,
                  ideas >= ideaFloor ? "well stocked" : "running dry — ideate before drafting",
                  ideas >= ideaFloor ? C.green : C.amber
                )}
              </div>

              {/* the freeze offer — only surfaced when there's actually a week to save */}
              {lastWeekMissed && streak.weeks === 0 && freezeAvailable && (
                <div style={{ marginTop: 8, background: "rgba(96,165,250,0.08)", border: `1px solid ${C.blue}`, borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ fontSize: 12, color: C.ink, lineHeight: 1.5 }}>
                    Last week came in at {lastWeekPublished}/{perWeek}. You have one freeze left this month — spend it to protect the streak.
                  </div>
                  <button
                    onClick={() => freezeContentWeek(lastWeek)}
                    style={{ marginTop: 8, background: "transparent", border: `1px solid ${C.blue}`, color: C.blue, borderRadius: 10, padding: "7px 12px", fontSize: 12, cursor: "pointer" }}
                  >
                    ❄️ Freeze {weekLabel(new Date(lastWeek + "T00:00:00"))}
                  </button>
                </div>
              )}

              {overdueCount > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: C.red }}>
                  ⚠ {overdueCount} piece{overdueCount === 1 ? "" : "s"} past its ship-by date — ship it or move the date on purpose.
                </div>
              )}

              {/* diagnosis, not guilt: name the pattern and what it implies */}
              {patterns.total >= 3 && patterns.topReason && (
                <div style={{ marginTop: 8, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.14em", color: C.muted, marginBottom: 4 }}>SKIP PATTERN · LAST 5 WEEKS</div>
                  <div style={{ fontSize: 12, color: C.ink, lineHeight: 1.5 }}>
                    {patterns.total} missed day{patterns.total === 1 ? "" : "s"}, most often: <strong>{skipReasonLabel(patterns.topReason.key)}</strong> ({patterns.topReason.count}×)
                    {patterns.topStage ? ` · usually on ${CONTENT_STAGE_LABEL[patterns.topStage.stage]?.toLowerCase() || patterns.topStage.stage} day` : ""}.
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                    {CONTENT_SKIP_REASONS.find((r) => r.key === patterns.topReason.key)?.fix}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            value={contentSearch}
            onChange={(e) => setContentSearch(e.target.value)}
            placeholder="🔎 Search title, type, platform…"
            style={{ ...inputStyle, flex: 1 }}
          />
          {contentSearch && (
            <Btn ghost onClick={() => setContentSearch("")} style={{ padding: "10px 14px" }}>
              Clear
            </Btn>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {isDesktop ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["all", ...CONTENT_STATUSES].map((s) => (
                <button
                  key={s}
                  onClick={() => setContentFilter(s)}
                  style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 20, border: `1px solid ${contentFilter === s ? C.amber : C.panelEdge}`, background: contentFilter === s ? "rgba(245,185,66,0.12)" : "transparent", color: contentFilter === s ? C.amber : C.muted, cursor: "pointer" }}
                >
                  {s === "all" ? `All (${items.length})` : `${contentStatusLabel(s)} (${items.filter((c) => (c.status || "idea") === s).length})`}
                </button>
              ))}
            </div>
          ) : (
            <select
              value={contentFilter}
              onChange={(e) => setContentFilter(e.target.value)}
              style={{ ...selMini, fontSize: 13, padding: "8px 10px", background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, color: C.ink, textTransform: "capitalize" }}
            >
              {["all", ...CONTENT_STATUSES].map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? `All (${items.length})` : `${contentStatusLabel(s)} (${items.filter((c) => (c.status || "idea") === s).length})`}
                </option>
              ))}
            </select>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              onClick={() => setContentView("list")}
              title="List view"
              style={{ padding: "8px 12px", borderRadius: 10, border: `1px solid ${contentView === "list" ? C.amber : C.panelEdge}`, background: contentView === "list" ? "rgba(245,185,66,0.12)" : "transparent", color: contentView === "list" ? C.amber : C.muted, cursor: "pointer", fontSize: 13 }}
            >
              ☰
            </button>
            <button
              onClick={() => setContentView("board")}
              title="Board view"
              style={{ padding: "8px 12px", borderRadius: 10, border: `1px solid ${contentView === "board" ? C.amber : C.panelEdge}`, background: contentView === "board" ? "rgba(245,185,66,0.12)" : "transparent", color: contentView === "board" ? C.amber : C.muted, cursor: "pointer", fontSize: 13 }}
            >
              ▦
            </button>
            <Btn onClick={() => setModal({ kind: "content", entry: null })}>+ Add content</Btn>
          </div>
        </div>

        {contentView === "board" ? (
          <ContentBoard
            items={shown}
            onOpen={(c) => setModal({ kind: "content", entry: c })}
            onMove={moveContentStage}
            onDropStage={(id, stage) => updateContentField(id, "status", stage)}
            isDesktop={isDesktop}
            openLink={openLink}
            onAddToStage={(stage) => setModal({ kind: "content", entry: null, prefill: { status: stage } })}
          />
        ) : (
          <>

        {shown.length === 0 && (
          <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
            {items.length === 0 ? "No content tracked yet. Add your first piece — blog, video, carousel, whatever you're making." : "Nothing matches this search/filter."}
          </div>
        )}

        {shown.length > 0 && isDesktop && (
          <div className="desktop-scroll-x" style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1100 }}>
              <thead>
                <tr>
                  <th style={th}>Title</th>
                  <th style={th}>Status</th>
                  <th style={th}>Type</th>
                  <th style={th}>Platforms</th>
                  <th style={th}>Link</th>
                  <th style={th}>Date</th>
                  <th style={th}>Brain dump</th>
                  <th style={{ ...th, width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {shownPage.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...td, minWidth: 170 }}>{cellInput(c, "title", { ph: "Title", onCommit: updateContentField })}</td>
                    <td style={{ ...td, minWidth: 110 }} onClick={(e) => e.stopPropagation()}>
                      <select
                        value={c.status || "idea"}
                        onChange={(e) => updateContentField(c.id, "status", e.target.value)}
                        style={{ ...selMini, fontFamily: mono, background: C.bg, color: contentStatusColor(c.status), border: `1px solid ${C.panelEdge}`, padding: "4px 6px", width: "100%" }}
                      >
                        {CONTENT_STATUSES.map((s) => (
                          <option key={s} value={s}>{contentStatusLabel(s)}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...td, minWidth: 130 }} onClick={(e) => e.stopPropagation()}>
                      <select
                        value={c.type || ""}
                        onChange={(e) => updateContentField(c.id, "type", e.target.value)}
                        style={{ ...selMini, color: c.type ? C.ink : C.muted, width: "100%" }}
                      >
                        <option value="">—</option>
                        {CONTENT_TYPES.map((ty) => (
                          <option key={ty} value={ty} style={{ background: C.panel }}>{ty}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...td, minWidth: 160 }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                        {CONTENT_PLATFORMS.map((p) => {
                          const active = (c.platforms || []).includes(p);
                          return (
                            <button
                              key={p}
                              onClick={() => {
                                const next = active ? (c.platforms || []).filter((x) => x !== p) : [...(c.platforms || []), p];
                                updateContentField(c.id, "platforms", next);
                              }}
                              style={{ fontSize: 9, fontFamily: mono, padding: "2px 6px", borderRadius: 8, border: `1px solid ${active ? C.blue : C.panelEdge}`, background: active ? "rgba(125,176,247,0.14)" : "transparent", color: active ? C.blue : C.muted, cursor: "pointer" }}
                            >
                              {p}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td style={{ ...td, minWidth: 120 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {cellInput(c, "link", { ph: "https://…", onCommit: updateContentField })}
                        {c.link && openLink(c.link, { title: "Open published content" })}
                        {c.assetsLink && openLink(c.assetsLink, { title: "Open video/photo assets", icon: "📁" })}
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                      <input
                        key={c.id + "date" + (c.date || "")}
                        type="date"
                        defaultValue={c.date || ""}
                        onChange={(e) => updateContentField(c.id, "date", e.target.value)}
                        style={{ fontSize: 13, fontFamily: mono, background: "transparent", border: "1px solid transparent", borderRadius: 6, color: C.muted, padding: "4px 2px", outline: "none", colorScheme: "dark" }}
                      />
                    </td>
                    <td style={{ ...td, minWidth: 160, cursor: "pointer" }} onClick={() => setModal({ kind: "content", entry: c })}>
                      {(() => {
                        const combined = [c.hook, c.outline, c.draft, c.notes].filter(Boolean).join(" ");
                        if (!combined) {
                          return <span style={{ color: C.muted, fontSize: 12 }}>+ add notes</span>;
                        }
                        const preview = combined.slice(0, 60) + (combined.length > 60 ? "…" : "");
                        return (
                          <div>
                            <span style={{ fontSize: 12, color: C.ink }}>📝 {preview}</span>
                            <div style={{ fontFamily: mono, fontSize: 9, color: C.muted, marginTop: 2 }}>
                              {[c.hook && "hook", c.outline && "outline", c.draft && "draft", c.notes && "notes"].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                    <td style={td} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => mutate((s) => ({ ...s, content: s.content.filter((x) => x.id !== c.id) }), "Content deleted")}
                        title="Delete"
                        style={{ width: 24, height: 24, borderRadius: 12, border: `1px solid ${C.panelEdge}`, background: "transparent", color: C.muted, fontSize: 13, lineHeight: "22px", cursor: "pointer", padding: 0 }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 0 && isDesktop && <Pagination page={contentPage} setPage={setContentPage} total={shown.length} />}

        {shown.length > 0 && !isDesktop && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {shownPage.map((c) => (
              <SwipeRow
                key={c.id}
                showX={false}
                onTap={() => setModal({ kind: "content", entry: c })}
                onDelete={() => mutate((s) => ({ ...s, content: s.content.filter((x) => x.id !== c.id) }), "Content deleted")}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{c.title || "Untitled"}</div>
                  <span style={{ fontFamily: mono, fontSize: 10, color: contentStatusColor(c.status), textTransform: "uppercase", flexShrink: 0 }}>
                    {contentStatusLabel(c.status)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                  {[c.type, (c.platforms || []).join(", ")].filter(Boolean).join(" · ") || "—"}
                </div>
                {c.date && <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 4 }}>{c.date}</div>}
                {(c.link || c.assetsLink) && (
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    {c.link && openLink(c.link, { title: "Open published content" })}
                    {c.assetsLink && openLink(c.assetsLink, { title: "Open video/photo assets", icon: "📁" })}
                  </div>
                )}
                {(() => {
                  const sections = [c.hook && "hook", c.outline && "outline", c.draft && "draft", c.notes && "notes"].filter(Boolean);
                  return sections.length > 0 ? (
                    <div style={{ fontFamily: mono, fontSize: 10, color: C.blue, marginTop: 4 }}>📝 {sections.join(" · ")}</div>
                  ) : null;
                })()}
              </SwipeRow>
            ))}
          </div>
        )}
        {shown.length > 0 && !isDesktop && <Pagination page={contentPage} setPage={setContentPage} total={shown.length} />}

        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          {isDesktop ? "Click any cell to edit · click platform tags to toggle them." : "Tap a card to edit."}
        </div>
          </>
        )}
      </>
    );
  };

  const renderFunnelSection = () => (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
        {[
          ["APPS", totals.apps],
          ["OUTREACH", totals.outreach],
          ["REPLIES", totals.replies],
          ["SCREENS", totals.screens],
          ["INTERVIEWS", totals.interviews],
          ["OFFERS", totals.offers],
        ].map(([k, v]) => (
          <div key={k} style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, letterSpacing: "0.16em", color: C.muted }}>{k}</div>
            <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 700, color: k === "OFFERS" && v > 0 ? C.green : C.ink }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.muted, margin: "-6px 0 12px", lineHeight: 1.55 }}>
        Fully automatic from the Pipeline — set an entry's status to &ldquo;outreach&rdquo; to count it there instead of Apps.
        {(() => {
          /* The funnel deliberately INCLUDES archived entries while the pipeline
             filters and header cards exclude them, so the two disagree. That's
             correct — you really did send those applications, and dropping them
             would shrink the denominator while keeping the replies, quietly
             inflating your reply rate as more work gets filed. Saying so beats
             leaving you to discover the gap. */
          const archivedCount = apps.filter((a) => a.archivedAt).length;
          if (!archivedCount) return null;
          return (
            <>
              {" "}
              <span style={{ color: C.amber }}>
                Includes {archivedCount} archived {archivedCount === 1 ? "entry" : "entries"}
              </span>{" "}
              — you sent them, so they stay in the denominator. Pipeline counts and filters exclude archived, so those numbers will read lower.
            </>
          );
        })()}
      </div>

      {/* conversion: application/outreach -> closed deal. Synced account-contact
          entries already live in `apps`/`totals`, so no manual merging needed here —
          just a transparency line showing how much of the total came from contacts. */}
      {(() => {
        const topOfFunnel = totals.apps + totals.outreach;
        const fromContacts = apps.filter((a) => a.fromAccountContact).length;
        const pct = (num, den) => (den > 0 ? ((num / den) * 100).toFixed(1) : "0.0");
        const stages = [
          ["Apps+Outreach → Replies", totals.replies, topOfFunnel],
          ["Replies → Screens", totals.screens, totals.replies],
          ["Screens → Interviews", totals.interviews, totals.screens],
          ["Interviews → Offers", totals.offers, totals.interviews],
        ];
        return (
          <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <Label>Conversion — apps/outreach → offer</Label>
              <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color: totals.offers > 0 ? C.green : C.ink }}>
                {pct(totals.offers, topOfFunnel)}%
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2, marginBottom: 10 }}>
              {totals.offers} offer{totals.offers === 1 ? "" : "s"} from {topOfFunnel} total sent{fromContacts > 0 ? ` (${fromContacts} from account contacts)` : ""}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {stages.map(([label, num, den]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: C.muted }}>{label}</span>
                  <span style={{ fontFamily: mono, color: den > 0 ? C.ink : C.muted }}>
                    {den > 0 ? `${pct(num, den)}%` : "—"} <span style={{ color: C.muted }}>({num}/{den})</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </>
  );

  const renderGoal = () => {
    const g = computeGoal(state.goal, apps, state);
    const poolActive = state.settings?.goalMode === "pool";
    const pg = poolActive ? computePoolGoal(state, apps) : null;
    return (
      <>
        {/* ---- pool plan ----
            Shown above the standard goal, never instead of it. The standard
            goal stays below, intact and editable — switching modes changes
            which plan is DRIVING, not which one exists. */}
        {poolActive && pg && (
          <div style={{ background: C.panel, border: `1px solid ${pg.inDiscovery ? C.blue : C.green}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <Label>🎯 Pool plan — driving your numbers</Label>
              <span style={{ fontFamily: mono, fontSize: 10, color: C.muted, border: `1px solid ${C.panelEdge}`, borderRadius: 20, padding: "3px 9px" }}>
                WK {pg.weekInCycle + 1}/{pg.cycleWeeks}
              </span>
            </div>

            {pg.total === 0 ? (
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
                No companies in the pool yet, so your standard goal below is still running the show. Add companies in the CRM's Pool tab and this takes over.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
                  <div style={{ fontFamily: mono, fontSize: 32, fontWeight: 800, color: pg.todayMet ? C.green : pg.inDiscovery ? C.blue : C.amber, lineHeight: 1.1 }}>
                    {pg.doneToday} / {pg.todaysTarget}
                  </div>
                  <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.4 }}>
                    {pg.inDiscovery ? (pg.discoveryMode === "build" ? "to add today" : "to hook today") : "to write today"}
                    <br />
                    {pg.doneThisWeek}/{pg.weekTarget} this week
                  </div>
                </div>

                {/* the cycle laid out week by week — makes the rhythm legible
                    instead of something you have to infer from a date */}
                <div style={{ display: "flex", gap: 3, marginBottom: 6 }}>
                  {Array.from({ length: pg.cycleWeeks }).map((_, i) => {
                    const isDisc = i < pg.discoveryWeeks;
                    const isNow = i === pg.weekInCycle;
                    return (
                      <div
                        key={i}
                        title={`Week ${i + 1} — ${isDisc ? "discovery" : "reachout"}`}
                        style={{
                          flex: 1,
                          height: 22,
                          borderRadius: 4,
                          background: isDisc ? "rgba(96,165,250,0.25)" : "rgba(74,222,128,0.18)",
                          border: `1px solid ${isNow ? C.ink : "transparent"}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: mono,
                          fontSize: 9,
                          color: isNow ? C.ink : C.muted,
                          fontWeight: isNow ? 800 : 400,
                        }}
                      >
                        {isDisc ? "🔍" : "✉"}
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.55, marginBottom: 10 }}>
                  {pg.discoveryWeeks} discovery {pg.discoveryWeeks === 1 ? "week" : "weeks"} then {pg.reachoutWeeks} reachout — cycle {pg.cycleIndex + 1}, started {pg.cycleStart}.
                  Discovery is two jobs: build the pool to {pg.discoveryTargetCycle} ({pg.poolSize} in so far), then write a hook for each (~{pg.discoveryHoursEstimate}h total).
                  Reachout then writes {pg.weeklyTarget}/wk.
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, borderTop: `1px solid ${C.panelEdge}`, fontSize: 12 }}>
                  <span style={{ color: C.muted }}>
                    <strong style={{ color: C.ink }}>{pg.total} in pool</strong> · {pg.worked} contacted · {pg.readyToWrite} ready to write
                  </span>
                  <span style={{ fontFamily: mono, color: C.muted }}>{pg.remaining === 0 ? "covered" : `${pg.remaining} left`}</span>
                </div>
                {pg.outOfHooks && (
                  <div style={{ fontSize: 11, color: C.amber, marginTop: 8, lineHeight: 1.5 }}>
                    ⚠ Out of hooks — today's ask is capped at what's actually researched. Discovery under-delivered by {pg.discoveryShortfall} this cycle.
                  </div>
                )}
                <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                  No week-to-week debt in this mode — a closed pool already bounds the work.
                </div>
              </>
            )}
          </div>
        )}

        {/* the standard goal, preserved. Nothing about it is deleted or
            rewritten while pool pacing runs — it's suspended, and its deadline
            slides by however long the pause lasts. */}
        {poolActive && state.goal && g && (
          <div style={{ background: "rgba(135,152,176,0.06)", border: `1px dashed ${C.panelEdge}`, borderRadius: 14, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 4 }}>⏸ Standard goal — paused, not lost</div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              {state.goal.target} over {state.goal.days} days is untouched and still {g.pctComplete}% complete ({g.actualTotal}/{state.goal.target}). It owes you nothing while
              pool pacing runs — no daily quota, no rollover debt building up.
              {g.pausedDays > 0 && (
                <>
                  {" "}
                  Paused {g.pausedDays} day{g.pausedDays === 1 ? "" : "s"} so far, so the deadline has moved from {g.rawDeadline} to <strong>{g.deadline}</strong>.
                </>
              )}{" "}
              Switch back in Settings and it resumes mid-stride.
            </div>
          </div>
        )}

        {!state.goal && (
          <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🎯</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>No goal set</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 16 }}>
              Set a target — e.g. 500 applications + outreach over 90 days — and this splits it into a daily
              quota, a deadline, and a Mon–Sat weekly schedule. Applications and outreach count equally, 1
              each, toward the same number.
            </div>
            <Btn onClick={() => setModal({ kind: "goal", entry: null })}>+ Set a goal</Btn>
          </div>
        )}

        {state.goal && g && (
          <>
            <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Label>
                  {state.goal.target} applications + outreach over {state.goal.days} days
                </Label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: C.amber, border: `1px solid ${C.panelEdge}`, borderRadius: 20, padding: "3px 9px" }}>
                    {g.aggressiveness.emoji} {g.aggressiveness.label}
                  </span>
                  <Btn ghost onClick={() => setModal({ kind: "goal", entry: state.goal })} style={{ padding: "6px 10px", fontSize: 11 }}>
                    Edit
                  </Btn>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
                <div style={{ fontFamily: mono, fontSize: 44, fontWeight: 800, color: C.amber, lineHeight: 1.1 }}>
                  {g.todaysTarget}
                </div>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.4 }}>
                  today's target
                  <br />
                  {g.stillRamping ? `ramping to ${g.fullQuota}/day` : "at full pace"}
                </div>
              </div>
              {g.stillRamping && (
                <div style={{ fontSize: 11, color: C.green, marginTop: 4 }}>
                  🌱 Warming up — {g.rampDaysLeft} day{g.rampDaysLeft === 1 ? "" : "s"} left until full pace ({g.fullQuota}/day).
                </div>
              )}
              {g.carryIntoToday !== 0 && (
                <div style={{ fontSize: 11, color: g.carryIntoToday > 0 ? C.red : C.green, marginTop: 4 }}>
                  {g.carryIntoToday > 0
                    ? `⬆ +${g.carryIntoToday} carried over from yesterday's shortfall`
                    : `⬇ ${Math.abs(g.carryIntoToday)} banked from yesterday's overachievement — lighter today`}
                </div>
              )}

              <div style={{ height: 10, background: C.bg, borderRadius: 5, marginTop: 12, overflow: "hidden", border: `1px solid ${C.panelEdge}` }}>
                <div style={{ height: "100%", width: `${g.pctComplete}%`, background: g.onPace ? C.green : C.amber, borderRadius: 5, transition: "width 0.4s ease" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12 }}>
                <span style={{ color: C.muted }}>
                  {g.actualTotal} / {state.goal.target} ({g.pctComplete}%)
                </span>
                <span style={{ fontFamily: mono, color: g.onPace ? C.green : C.red }}>
                  {g.pastDeadline ? "DEADLINE PASSED" : g.onPace ? "● ON PACE" : `○ BEHIND (${g.carryIntoToday} short, after rollover)`}
                </span>
              </div>
              {/* same reasoning as the funnel: archived work still counts here,
                  because you did it. Progress that vanished when an entry was
                  filed would be a worse lie than a number that needs a caption. */}
              {(() => {
                const archivedCount = apps.filter((a) => a.archivedAt && !isBlankStatus(a)).length;
                if (!archivedCount) return null;
                return (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
                    Counts {archivedCount} archived {archivedCount === 1 ? "entry" : "entries"} — filing an application doesn&apos;t undo the work of sending it.
                  </div>
                );
              })()}

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.panelEdge}` }}>
                <div>
                  <div style={{ fontSize: 9, letterSpacing: "0.14em", color: C.muted }}>DEADLINE</div>
                  <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 700 }}>{g.deadline}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, letterSpacing: "0.14em", color: C.muted }}>DAYS REMAINING</div>
                  <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 700, color: g.daysRemaining <= 7 ? C.amber : C.ink }}>
                    {g.pastDeadline ? 0 : g.daysRemaining}
                  </div>
                </div>
              </div>
            </div>

            <Label>Weekly schedule (Mon–Sat)</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {g.weeks.map((w) => {
                const wOnPace = w.actual >= w.target || w.weekStart > today();
                return (
                  <div key={w.label} style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 14px", opacity: w.paused ? 0.55 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>
                        {w.label}
                        {w.paused && <span style={{ fontFamily: mono, fontSize: 9, color: C.muted, marginLeft: 6, letterSpacing: 0.4 }}>⏸ POOL</span>}
                      </div>
                      <div style={{ fontFamily: mono, fontSize: 11, color: w.paused ? C.muted : wOnPace ? C.green : C.amber }}>
                        {w.paused ? `${w.actual} logged · no quota` : `${w.actual} / ${w.target}`}
                      </div>
                    </div>
                    {w.carryIn !== 0 && (
                      <div style={{ fontSize: 10, color: w.carryIn > 0 ? C.red : C.green, marginTop: 2 }}>
                        {w.carryIn > 0 ? `⬆ +${w.carryIn} carried over from last week's shortfall` : `⬇ ${-w.carryIn} banked from last week's overachievement`}
                      </div>
                    )}
                    <div style={{ height: 5, background: C.bg, borderRadius: 3, marginTop: 6, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${w.target > 0 ? Math.min(100, (w.actual / w.target) * 100) : 0}%`, background: wOnPace ? C.green : C.amber, borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 14 }}>
              <Btn
                ghost
                onClick={() => mutate((s) => ({ ...s, goal: null }), "Goal cleared")}
                style={{ width: "100%", color: C.red }}
              >
                Clear goal
              </Btn>
            </div>
          </>
        )}
      </>
    );
  };

  const renderEmotions = () => (
    <>
      {/* emotional support — only on request */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <Btn onClick={() => setSupportOpen(true)} color={C.blue} style={{ flex: 1 }}>
          🛟 Emotional support
        </Btn>
      </div>

      {/* weekly VOICE check-in */}
      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Label>
            🎙 Weekly voice check-in
            {coach.voiceDate ? ` — last ${coach.voiceDate}` : ""}
            {!coach.voiceDate || addDays(coach.voiceDate, 7) <= today() ? "  ·  DUE" : ""}
          </Label>
          <Btn onClick={runVoiceCheckin} disabled={voiceBusy} color={C.blue} style={{ padding: "6px 12px", fontSize: 11 }}>
            {voiceBusy ? "Creating…" : "Create session"}
          </Btn>
        </div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
          A spoken session built from your actual week — numbers, wins, emotional patterns — settle, reality, track record, forward, one action. Transcript saves to your diary below.
        </div>
        {voiceBusy && (
          <div style={{ color: C.muted, fontFamily: mono, fontSize: 12, padding: "12px 0 0", letterSpacing: "0.15em" }}>
            WRITING & RECORDING YOUR SESSION…
          </div>
        )}
        {voiceUrl && !voiceBusy && (
          <audio controls src={voiceUrl} style={{ width: "100%", marginTop: 12 }} />
        )}
        {voiceScript && !voiceBusy && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ fontSize: 12, color: C.muted, cursor: "pointer" }}>Transcript</summary>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: C.ink, marginTop: 6, whiteSpace: "pre-wrap" }}>{voiceScript}</div>
          </details>
        )}
        {voiceErr && (
          <div style={{ marginTop: 10, fontSize: 12, color: C.red, lineHeight: 1.5 }}>{voiceErr}</div>
        )}
      </div>

      {/* support diary */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "4px 0 10px" }}>
        <Label>🛟 Support diary — {isDesktop ? "click" : "tap"} a session to reread the advice</Label>
        {(() => {
          const withI = (state.supportSessions || []).map((s) => +s.intensity).filter((n) => n > 0);
          if (withI.length < 2) return null;
          const recent = withI.slice(0, 3);
          const prior = withI.slice(3, 6);
          const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
          const r = avg(recent);
          const trend = prior.length ? (r < avg(prior) - 0.4 ? "▼ easing" : r > avg(prior) + 0.4 ? "▲ rising" : "▬ steady") : "▬";
          const col = trend.startsWith("▼") ? C.green : trend.startsWith("▲") ? C.red : C.muted;
          return (
            <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: col }}>
              AVG {r.toFixed(1)}/10 · {trend}
            </div>
          );
        })()}
      </div>

      {(state.supportSessions || []).length === 0 && (
        <div style={{ color: C.muted, fontSize: 13, padding: "12px 4px", textAlign: "center" }}>
          No sessions yet. Every 🛟 Emotional support session and 🎙 weekly check-in saves here automatically — a diary of advice you can reread anytime.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(state.supportSessions || []).map((s) => {
          const isWeekly = s.kind === "weekly-voice" || (s.feeling || "").includes("Weekly voice check-in");
          return (
            <SwipeRow
              key={s.id}
              showX={isDesktop}
              onTap={async () => {
                let localUrl = null;
                if (!s.audioPath && s.audioLocal) {
                  const blob = await idbGet(s.id).catch(() => null);
                  if (blob) localUrl = URL.createObjectURL(blob);
                }
                setModal({ kind: "session", entry: s, localUrl });
              }}
              onDelete={() => {
                mutate((st) => ({ ...st, supportSessions: st.supportSessions.filter((y) => y.id !== s.id) }), "Session deleted");
                if (s.audioPath) deleteAudio(s.audioPath).catch(() => {});
                if (s.audioLocal) idbDelete(s.id).catch(() => {});
              }}
            >
              <div
                style={
                  isWeekly
                    ? { margin: "-12px -14px", padding: "12px 14px", background: "rgba(125,176,247,0.08)", borderLeft: `3px solid ${C.blue}`, borderRadius: 12 }
                    : undefined
                }
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isWeekly ? C.blue : C.ink }}>
                    {isWeekly ? "🎙 Weekly check-in" : `🛟 ${s.feeling || "Support session"}`}
                  </div>
                  {s.intensity !== "" && s.intensity != null && (
                    <div style={{ fontFamily: mono, fontSize: 12, color: (+s.intensity || 0) >= 8 ? C.red : C.amber, flexShrink: 0 }}>
                      {s.intensity}/10
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.one_action || (isWeekly ? "Tap to listen / read transcript" : "")}
                </div>
                <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{s.date}</div>
              </div>
            </SwipeRow>
          );
        })}
      </div>
    </>
  );

  /* ---- copy library actions ---- */
  const saveCopyDraft = (draft) =>
    mutate((st) => {
      const d = normCopyDraft(draft);
      const exists = (st.copyDrafts || []).some((x) => x.id === d.id);
      return { ...st, copyDrafts: exists ? st.copyDrafts.map((x) => (x.id === d.id ? d : x)) : [d, ...(st.copyDrafts || [])] };
    }, "Copy saved");
  const deleteCopyDraft = (id) =>
    mutate((st) => ({ ...st, copyDrafts: (st.copyDrafts || []).filter((x) => x.id !== id), deletedIds: tombstones(st, [id]) }), "Copy deleted");
  const gradeCopyDraft = (id, grade) =>
    mutate((st) => ({ ...st, copyDrafts: (st.copyDrafts || []).map((x) => (x.id === id ? { ...x, grade: x.grade === grade ? 0 : grade } : x)) }));
  /* every use is counted, which is what makes "best" mean something over time */
  const markCopyUsed = (id) =>
    mutate((st) => ({ ...st, copyDrafts: (st.copyDrafts || []).map((x) => (x.id === id ? { ...x, timesUsed: (x.timesUsed || 0) + 1, lastUsedAt: today() } : x)) }));

  const [copyBusy, setCopyBusy] = useState("");
  /* fills a library draft with THIS lead's details and puts it on the
     clipboard. Falls back to a clear message rather than copying an empty
     string, which would look like it worked. */
  /* ---- copying library drafts onto a lead ----
     One shared path for every entry point. With a single saved draft it copies
     straight away; with several it opens a picker, because silently choosing
     for you defeats the purpose of keeping variants — you can't A/B anything
     if the app always picks the same one. */
  const [copyPicker, setCopyPicker] = useState(null); /* { purpose, options, vars, label } */
  const putOnClipboard = (draft, vars, purpose) => {
    const filled = fillTokens(draft.body, vars);
    (navigator.clipboard?.writeText(filled) || Promise.reject()).then(
      () => {
        markCopyUsed(draft.id);
        flash(`⧉ Copied "${draft.title || copyPurposeLabel(purpose)}"`);
      },
      () => flash("Couldn't reach the clipboard")
    );
  };
  const copyDraftFor = (purpose, vars, label) => {
    const options = (state.copyDrafts || []).filter((d) => d.purpose === purpose).sort(rankCopy);
    if (!options.length) return flash(`No "${copyPurposeLabel(purpose)}" copy saved yet — add one in Copy`);
    if (options.length === 1) return putOnClipboard(options[0], vars, purpose);
    setCopyPicker({ purpose, options, vars, label });
  };
  /* the token values a lead can supply, in one place so the follow-up row and
     the pool row can't drift apart */
  const copyVarsFrom = (o) => ({
    company: o.company || "",
    "first name": firstNameOf(o.contact || ""),
    name: (o.contact || "").trim(),
    position: (o.position || "").trim(),
    role: (o.role || "").trim(),
    hook: (o.hook || "").trim(),
    industry: (o.industry || "").trim(),
    me: (state.settings?.aiSenderName || "").trim(),
  });
  const copyFollowUpDraft = (index, formData) =>
    copyDraftFor(
      purposeForFollowUp(index),
      copyVarsFrom({ ...formData, position: formData.contactPosition }),
      `${formData.company || "this lead"} · follow-up ${index + 1}`
    );
  /* ---- hook refinement ----
     The hook is written to be researched in five minutes, not to be read: "IT
     audit post", "rebrand shipped". Dropping that raw into a [Hook] token
     produces "I saw IT audit post", which is worse than no hook at all.

     So it's polished into one natural sentence before use — and CACHED against
     the exact hook text it came from. Re-copying the same company costs
     nothing; editing the hook invalidates the cache and it re-polishes. Falls
     back to the raw hook whenever AI isn't available, because a rough opening
     still beats a failed copy. */
  const [polishing, setPolishing] = useState("");
  const polishedHookFor = async (item) => {
    const raw = (item.hook || "").trim();
    if (!raw || isGenericHook(raw) || isGenericPersonHook(raw)) return "";
    const ref = item.ref || item.refs?.[0];
    const e = ref?.entry || {};
    if (e.hookPolished && e.hookPolishedFrom === raw) return e.hookPolished;
    try {
      setPolishing(item.key);
      const text = await callAI({
        provider: state.settings?.aiProvider,
        model: state.settings?.aiModel,
        baseUrl: state.settings?.aiBaseUrl,
        key: readAiKey(),
        maxTokens: state.settings?.aiMaxTokens,
        system: `You turn a researcher's shorthand note into ONE natural opening sentence for a cold email.

Rules:
- Output exactly one sentence. No greeting, no sign-off, no quotes, no preamble.
- Use ONLY what the note says. Never add a date, a number, a product name, a person or any detail the note doesn't contain — you have no other knowledge of this company.
- If the note is too vague to make a specific sentence, write a plainer one rather than inventing detail.
- Write it so it can follow "Hi Ana," naturally.`,
        /* the person is named so the polished line can be about THEIR post
           rather than a vague company-level observation */
        user: `Company: ${item.company}${item.contactName ? `\nWriting to: ${item.contactName}${item.contactPosition ? `, ${item.contactPosition}` : ""}` : ""}\nResearch note: ${raw}`,
      });
      const line = String(text || "").split("\n").filter(Boolean)[0]?.replace(/^["']|["']$/g, "").trim() || "";
      if (line) {
        const stampPolish = (o) => ({ ...o, hookPolished: line, hookPolishedFrom: raw });
        mutate((st) => {
          if (ref.kind === "contact")
            return {
              ...st,
              accounts: (st.accounts || []).map((a) =>
                a.id !== ref.id ? a : { ...a, contacts: (a.contacts || []).map((c) => (c.id === ref.contactId ? stampPolish(c) : c)) }
              ),
            };
          if (ref.kind === "account") return { ...st, accounts: (st.accounts || []).map((a) => (a.id === ref.id ? stampPolish(a) : a)) };
          return { ...st, applications: st.applications.map((a) => (a.id === ref.id ? stampPolish(a) : a)) };
        });
      }
      setPolishing("");
      return line || raw;
    } catch (err) {
      setPolishing("");
      /* a rough hook is still better than nothing landing on the clipboard */
      return raw;
    }
  };

  /* clears the cache and regenerates — used when the polished line missed */
  const repolishHook = (item) => {
    const ref = item.ref || item.refs?.[0];
    if (!ref) return;
    const clear = (o) => ({ ...o, hookPolished: "", hookPolishedFrom: "" });
    mutate((st) => {
      if (ref.kind === "contact")
        return { ...st, accounts: (st.accounts || []).map((a) => (a.id !== ref.id ? a : { ...a, contacts: (a.contacts || []).map((c) => (c.id === ref.contactId ? clear(c) : c)) })) };
      if (ref.kind === "account") return { ...st, accounts: (st.accounts || []).map((a) => (a.id === ref.id ? clear(a) : a)) };
      return { ...st, applications: st.applications.map((a) => (a.id === ref.id ? clear(a) : a)) };
    });
    /* pass a copy with the cache already blanked so the regenerate doesn't
       read the stale value it just cleared */
    setTimeout(() => polishedHookFor({ ...item, hookPolished: "", hookPolishedFrom: "" }), 60);
  };

  /* pool: first contact copy, addressed to THIS person */
  const copyPoolOutreach = async (item) => {
    const e = item.entry || {};
    const hook = (await polishedHookFor(item)) || item.hook;
    return copyDraftFor(
      "outreach",
      copyVarsFrom({
        company: item.company,
        contact: item.contactName,
        position: item.contactPosition,
        role: e.role,
        hook,
        industry: item.ref?.kind === "contact" ? item.ref.account?.industry : e.industry,
      }),
      item.contactName ? `${item.contactName} · ${item.company}` : item.company
    );
  };
  const aiWriteCopy = async (purpose) => {
    setCopyBusy(purpose);
    try {
      const p = COPY_PURPOSES.find((x) => x.key === purpose);
      /* written as a TEMPLATE, not a one-off: tokens stay in place so the same
         draft works for every lead it's later applied to */
      const text = await callAI({
        provider: state.settings?.aiProvider,
        model: state.settings?.aiModel,
        baseUrl: state.settings?.aiBaseUrl,
        key: readAiKey(),
        maxTokens: state.settings?.aiMaxTokens,
        system: `You write short, reusable outreach email templates for a freelance/in-house designer.

Rules:
- This is a TEMPLATE for many companies, not one email. Use these placeholders literally where they belong: [Company], [First name], [Position], [Hook], [Me].
- 60-110 words. No "I hope this finds you well", no flattery preamble, no buzzwords.
- One clear, low-friction ask.
- Never invent facts about any company.

Return exactly:
Subject: <subject line>

<body>`,
        user: `Purpose: ${p?.label} — ${p?.hint}
About the sender: ${state.settings?.aiPitch || "A graphic designer looking for in-house or contract work."}
${purpose.startsWith("followup") ? "This is a follow-up to an earlier unanswered message. Do not repeat the original pitch — change the angle and keep it shorter than a first contact." : ""}
${purpose === "reconnect" ? "This lead went quiet months ago. Treat it as a fresh, low-pressure restart rather than another chase." : ""}`,
      });
      saveCopyDraft({ title: `${p?.label} draft`, body: text, purpose, source: "ai" });
    } catch (e) {
      flash(e?.message || "Couldn't write that");
    }
    setCopyBusy("");
  };

  const renderCopy = () => {
    const drafts = (state.copyDrafts || []).slice().sort(rankCopy);
    const byPurpose = COPY_PURPOSES.map((p) => ({ ...p, items: drafts.filter((d) => d.purpose === p.key) }));
    const shown = copyFilter === "all" ? byPurpose : byPurpose.filter((g) => g.key === copyFilter);
    return (
      <>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55, marginBottom: 12 }}>
          Reusable email copy, graded by how it performs. Follow-up rows in the CRM pull from here, so grading a draft actually changes what you send next.
          Placeholders like <span style={{ fontFamily: mono, color: C.blue }}>[Company]</span> are filled in when you use one.
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {[["all", `All (${drafts.length})`], ...COPY_PURPOSES.map((p) => [p.key, `${p.label} (${drafts.filter((d) => d.purpose === p.key).length})`])].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setCopyFilter(k)}
              style={{
                fontFamily: sans,
                fontSize: 11,
                fontWeight: 700,
                padding: "6px 10px",
                borderRadius: 20,
                cursor: "pointer",
                border: `1px solid ${copyFilter === k ? C.amber : C.panelEdge}`,
                background: copyFilter === k ? "rgba(245,185,66,0.12)" : "transparent",
                color: copyFilter === k ? C.amber : C.muted,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {shown.map((g) => (
          <div key={g.key} style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div>
                <Label>{g.label}</Label>
                <div style={{ fontSize: 11, color: C.muted, marginTop: -2 }}>{g.hint}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Btn ghost onClick={() => setModal({ kind: "copyDraft", entry: null, prefill: { purpose: g.key } })} style={{ padding: "6px 10px", fontSize: 11 }}>
                  + Write
                </Btn>
                <Btn onClick={() => aiWriteCopy(g.key)} disabled={copyBusy === g.key} style={{ padding: "6px 10px", fontSize: 11 }}>
                  {copyBusy === g.key ? "…" : "✍ AI"}
                </Btn>
              </div>
            </div>

            {g.items.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted, padding: "10px 2px", lineHeight: 1.5 }}>Nothing saved yet.</div>
            ) : (
              g.items.map((d) => (
                <CopyDraftCard
                  key={d.id}
                  draft={d}
                  onGrade={gradeCopyDraft}
                  onEdit={() => setModal({ kind: "copyDraft", entry: d })}
                  onDelete={() => deleteCopyDraft(d.id)}
                  onUsed={() => markCopyUsed(d.id)}
                />
              ))
            )}
          </div>
        ))}
      </>
    );
  };

  /* the Runway section was retired; its numbers live on the dashboard card,
     which opens the same editor. Nothing about the data changed. */
  const SECTIONS = { DASHBOARD: renderDashboard, GOAL: renderGoal, PIPELINE: renderPipeline, CONTENT: renderContent, EMOTIONS: renderEmotions, COPY: renderCopy, HISTORY: renderHistory };

  if (!loaded)
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontFamily: mono, fontSize: 13, letterSpacing: "0.2em" }}>
        SYNCING INSTRUMENTS…
      </div>
    );

  return (
    <div
      onTouchStart={bgStart}
      onTouchEnd={bgEnd}
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.ink,
        fontFamily: sans,
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 18px)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 18px)",
        paddingLeft: "calc(env(safe-area-inset-left, 0px) + 16px)",
        paddingRight: "calc(env(safe-area-inset-right, 0px) + 16px)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        ::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; -ms-overflow-style: none; }
        input, textarea, select { font-size: 16px !important; max-width: 100%; box-sizing: border-box; }
        input[type="date"] { width: auto; }
        input[type="date"]::-webkit-calendar-picker-indicator { padding: 3px; margin-left: 4px; }
        input[type="date"]::-webkit-datetime-edit { padding: 0; }
        html, body { margin: 0; padding: 0; background: ${C.bg}; overflow-x: hidden; }
        button { -webkit-tap-highlight-color: transparent; }
        /* desktop spreadsheets (CRM applications/accounts, Content) show a real
           horizontal scrollbar — wide tables need a visible, draggable handle,
           unlike the rest of the app which stays scrollbar-free */
        .desktop-scroll-x { scrollbar-width: thin; scrollbar-color: ${C.panelEdge} transparent; -ms-overflow-style: auto; }
        .desktop-scroll-x::-webkit-scrollbar { display: block; height: 10px; }
        .desktop-scroll-x::-webkit-scrollbar-track { background: transparent; }
        .desktop-scroll-x::-webkit-scrollbar-thumb { background: ${C.panelEdge}; border-radius: 6px; }
        .desktop-scroll-x::-webkit-scrollbar-thumb:hover { background: ${C.muted}; }
        @media (hover: hover) {
          button:hover { filter: brightness(1.12); }
          tbody tr:hover { background: rgba(125,176,247,0.05) !important; }
        }
      `}</style>

      <div style={{ width: "100%", maxWidth: isDesktop ? (["PIPELINE", "CONTENT"].includes(MODES[mode]) ? 1800 : 900) : 560, margin: "0 auto", flex: 1, display: "flex", flexDirection: "column", transition: "max-width 0.2s ease" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.3em", color: C.amber }}>FLIGHT DECK</div>
            <div style={{ fontSize: isDesktop ? 24 : 20, fontWeight: 800, letterSpacing: "-0.01em", marginTop: 2 }}>
              {TITLES[MODES[mode]]}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn ghost onClick={() => setModal({ kind: "checkinDay", entry: { day: checkinDay, timezoneOffset: state.settings?.timezoneOffset, contentSchedule: state.contentSchedule } })} title="Settings" style={{ padding: "10px 12px" }}>
              ⚙
            </Btn>
            <Btn ghost onClick={() => setSyncModal(true)} title="Sync across devices" style={{ padding: "10px 12px" }}>
              ⇅
            </Btn>
            <Btn ghost disabled={undoCount === 0} onClick={undo} style={{ color: undoCount ? C.blue : C.muted }}>
              ↩ Undo{undoCount ? ` (${undoCount})` : ""}
            </Btn>
          </div>
        </div>

        {/* desktop: top tab navigation (mirrors the mobile bottom bar, one mode at a time) */}
        {isDesktop && (
          <div style={{ display: "flex", gap: 6, margin: "16px 0 4px", borderBottom: `1px solid ${C.panelEdge}`, paddingBottom: 10 }}>
            {NAV_ITEMS.map(([icon, label, i]) => {
              const badge = i === 2 ? totalDueCount : 0;
              return (
              <button
                key={label}
                onClick={() => setMode(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  background: mode === i ? "rgba(245,185,66,0.12)" : "transparent",
                  border: `1px solid ${mode === i ? C.amber : "transparent"}`,
                  borderRadius: 20,
                  padding: "8px 16px",
                  cursor: "pointer",
                  color: mode === i ? C.amber : C.muted,
                  fontFamily: sans,
                  fontSize: 13,
                  fontWeight: mode === i ? 800 : 600,
                  position: "relative",
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1, opacity: mode === i ? 1 : 0.75 }}>{icon}</span>
                {label}
                {badge > 0 && (
                  <span style={{ minWidth: 16, height: 16, borderRadius: 8, background: C.red, color: "#2b0b0b", fontFamily: mono, fontSize: 9, fontWeight: 800, lineHeight: "16px", padding: "0 4px" }}>
                    {badge}
                  </span>
                )}
              </button>
              );
            })}
          </div>
        )}

        {/* mobile: content area (tab bar is fixed at bottom) */}
        {!isDesktop && <div style={{ height: 6 }} />}

        {/* content — one mode at a time on both mobile and desktop; Pipeline gets full width via the wrapper above */}
        <div style={{ flex: 1, marginTop: isDesktop ? 14 : 0 }}>
          {isDesktop ? (
            <Panel title={`◈ ${TITLES[MODES[mode]].toUpperCase()}`}>{SECTIONS[MODES[mode]]()}</Panel>
          ) : (
            SECTIONS[MODES[mode]]()
          )}
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "center", gap: 16, alignItems: "center", marginTop: 16, paddingBottom: isDesktop ? 0 : MODES[mode] === "PIPELINE" ? 142 : 74 }}>
          <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.15em", color: syncStatus === "synced" ? C.green : syncStatus === "saving" ? C.amber : C.muted }}>
            {syncStatus === "synced" ? "● SYNCED" : syncStatus === "saving" ? "◌ SAVING" : "○ LOCAL ONLY"}
          </div>
        </div>
      </div>

      {/* mobile bottom tab bar — tap any mode directly (swipe still works) */}
      {!isDesktop && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(14,20,32,0.96)",
            backdropFilter: "blur(10px)",
            borderTop: `1px solid ${C.panelEdge}`,
            display: "flex",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
            zIndex: 40,
          }}
        >
          {NAV_ITEMS.map(([icon, label, i]) => {
            const badge = i === 2 ? totalDueCount : 0;
            return (
            <button
              key={label}
              onClick={() => setMode(i)}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                padding: "9px 0 7px",
                cursor: "pointer",
                color: mode === i ? C.amber : C.muted,
                position: "relative",
              }}
            >
              <div style={{ fontSize: 19, lineHeight: 1, opacity: mode === i ? 1 : 0.7 }}>{icon}</div>
              <div style={{ fontFamily: sans, fontSize: 9, letterSpacing: "0.06em", marginTop: 3, fontWeight: mode === i ? 800 : 600 }}>{label}</div>
              {badge > 0 && (
                <div style={{ position: "absolute", top: 4, left: "50%", marginLeft: 8, minWidth: 15, height: 15, borderRadius: 8, background: C.red, color: "#2b0b0b", fontFamily: mono, fontSize: 9, fontWeight: 800, lineHeight: "15px", padding: "0 3px" }}>
                  {badge}
                </div>
              )}
            </button>
            );
          })}
        </div>
      )}

      {/* toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: `calc(env(safe-area-inset-bottom, 0px) + ${isDesktop ? 24 : MODES[mode] === "PIPELINE" ? 132 : 84}px)`, left: "50%", transform: "translateX(-50%)", background: C.panelEdge, color: C.ink, fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 20, zIndex: 60 }}>
          {toast}
        </div>
      )}

      {modal && modal.kind !== "parseJobPost" && (
        <Modal
          key={modal.kind + "-" + (modal.entry?.id || "new")}
          modal={{ ...modal, followUpDefaults: state.settings?.followUpDefaults, followUpDailyCap: state.settings?.followUpDailyCap, autoArchiveStale: state.settings?.autoArchiveStale, autoArchiveDays: state.settings?.autoArchiveDays, aiProvider: state.settings?.aiProvider, aiModel: state.settings?.aiModel, aiBaseUrl: state.settings?.aiBaseUrl, aiPitch: state.settings?.aiPitch, aiSenderName: state.settings?.aiSenderName, aiWebSearch: state.settings?.aiWebSearch, aiMaxTokens: state.settings?.aiMaxTokens, defaultTouchChannel: state.settings?.defaultTouchChannel, draftSections: state.settings?.draftSections, contentBufferTarget: state.contentGoal?.bufferTarget, contentIdeaFloor: state.contentGoal?.ideaFloor, goalMode: state.settings?.goalMode, poolCycleName: `Cycle ${cyclePhase(state.settings).cycleIndex + 1}`, poolWeeklyWrite: state.settings?.poolWeeklyWrite, cycleWeeks: state.settings?.cycleWeeks, discoveryWeeks: state.settings?.discoveryWeeks, cycleStart: state.settings?.cycleStart, syncKey: syncKeyRef.current, archivedCsvCount: state.archivedCsvRows.length }}
          onClose={() => setModal(null)}
          onSave={saveModal}
          totals={totals}
          apps={apps}
          onDownloadCsv={() => {
            triggerCsvDownload(state.archivedCsvRows, `flight-deck-archive-${today()}.csv`);
            mutate((s) => ({ ...s, lastCsvPromptDate: today() }));
          }}
          onDeleteCsvRows={() => mutate((s) => ({ ...s, archivedCsvRows: [] }), "Archive backup cleared")}
          onOpenApplication={openApplicationEntry}
          onCopyDraft={copyFollowUpDraft}
          isDesktop={isDesktop}
          snapshots={snapshots}
          onRestoreSnapshot={restoreSnapshot}
          onExportSnapshot={exportSnapshot}
          onExportCurrent={exportCurrent}
          onImportBackup={importBackupFile}
          onDeleteSnapshot={(d) => {
            deleteSnapshot(d);
            setSnapshots(readSnapshots());
          }}
        />
      )}
      {modal && modal.kind === "parseJobPost" && (
        <ParseJobPostModal
          onClose={() => setModal(null)}
          onParse={parseJobPostText}
          onParsed={(prefill) => setModal({ kind: "application", entry: null, prefill })}
        />
      )}
      {syncModal && <SyncModal currentKey={syncKeyRef.current} onClose={() => setSyncModal(false)} onSwitch={switchSyncKey} flash={flash} />}
      {expiryOpen && (
        <AudioExpiryModal
          sessions={(state.supportSessions || []).filter(isExpiredAudio)}
          onDownload={expiryDownload}
          onDelete={expiryDelete}
          onClose={() => setExpiryOpen(false)}
        />
      )}
      {supportOpen && (
        <SupportModal
          onClose={() => setSupportOpen(false)}
          runSupport={runSupport}
          onSaveSession={(session) =>
            mutate((s) => ({ ...s, supportSessions: [{ id: uid(), date: today(), ...session }, ...(s.supportSessions || [])] }), "Session saved to diary")
          }
        />
      )}
      {focusModalOpen && (
        <TodaysFocusModal
          onClose={() => setFocusModalOpen(false)}
          coach={coach}
          setCoach={setCoach}
          coachLoading={coachLoading}
          runDaily={runDaily}
          focusItems={focusItems}
          nextImportantIdx={nextImportantIdx}
          allFocusDone={allFocusDone}
          canAutoGen={canAutoGen}
        />
      )}
      {weeklyModalOpen && (
        <WeeklyReviewModal
          onClose={() => setWeeklyModalOpen(false)}
          coach={coach}
          coachLoading={coachLoading}
          runWeekly={runWeekly}
        />
      )}
      {patternsModalOpen && (
        <PatternsModal
          onClose={() => {
            setPatternsModalOpen(false);
            setPatternsNarrative("");
          }}
          observations={computeSynthesis(state, apps, zone)}
          narrative={patternsNarrative}
          narrativeLoading={patternsNarrativeLoading}
          onAskCoach={generatePatternsNarrative}
        />
      )}
      {housekeepingOpen && (
        <HousekeepingModal
          onClose={() => setHousekeepingOpen(false)}
          proposals={housekeepingProposals}
          onArchive={(p) => (p.type === "application" ? archiveApplication(p.id) : archiveContact(p.accountId, p.contactId))}
          onArchiveAll={(list) => list.forEach((p) => (p.type === "application" ? archiveApplication(p.id) : archiveContact(p.accountId, p.contactId)))}
          onSnooze={(keys) => snoozeHousekeeping(keys)}
        />
      )}
      {digestOpen && (
        <MorningDigestModal
          onClose={dismissDigest}
          dueCount={totalDueCount}
          goalInfo={state.goal ? computeGoal(state.goal, apps, state) : null}
          topPattern={computeSynthesis(state, apps, zone)[0] || null}
        />
      )}
      {csvPromptOpen && (
        <CsvBackupPromptModal
          onClose={snoozeCsvPrompt}
          count={state.archivedCsvRows.length}
          onDownload={() => {
            triggerCsvDownload(state.archivedCsvRows, `flight-deck-archive-${today()}.csv`);
            mutate((s) => ({ ...s, lastCsvPromptDate: today() }));
          }}
        />
      )}
      {missedContentPrompt && (
        <MissedContentModal
          onClose={() => {}}
          stage={missedContentPrompt.stage}
          onContinue={(reason) => resolveMissedContent("continue", reason)}
          onSkip={(reason) => resolveMissedContent("skip", reason)}
        />
      )}
      {duplicateSuggestion && (
        <DuplicateSuggestionModal
          pendingApp={duplicateSuggestion.pendingApp}
          duplicateApp={duplicateSuggestion.duplicateApp}
          onMerge={resolveDuplicateAsMerge}
          onKeepSeparate={resolveDuplicateAsSeparate}
          onClose={resolveDuplicateAsSeparate}
        />
      )}
      {copyPicker && (
        <CopyPickerModal
          purpose={copyPicker.purpose}
          options={copyPicker.options}
          label={copyPicker.label}
          onClose={() => setCopyPicker(null)}
          onPick={(d) => {
            putOnClipboard(d, copyPicker.vars, copyPicker.purpose);
            setCopyPicker(null);
          }}
        />
      )}
      {draftModal && (
        <DraftModal
          member={draftModal.member}
          text={draftModal.text}
          loading={draftModal.loading}
          error={draftModal.error}
          missing={draftModal.missing}
          echoWarnings={draftModal.echoWarnings}
          pickContacts={draftModal.pickContacts}
          personMode={draftModal.personMode}
          target={draftModal.target}
          onPickContact={(c) => draftOutreach(draftModal.member, { regenerate: true, contact: c })}
          foundHook={draftModal.foundHook}
          searched={draftModal.searched}
          generic={draftModal.generic}
          onClose={() => setDraftModal(null)}
          onRegenerate={() => draftOutreach(draftModal.member, { regenerate: true })}
          onSaveHook={(h) => {
            /* the modal now always carries a work item, so its own ref is the
               right target — the found hook lands on that person */
            const ref = draftModal.member.ref || draftModal.member.refs?.[0];
            if (ref) setPoolHook(ref, h);
            setDraftModal((d) => (d ? { ...d, foundHook: "" } : d));
            flash("Hook saved");
          }}
        />
      )}
      {reapplySuggestion && (
        <ReapplySuggestionModal
          pendingApp={reapplySuggestion.pendingApp}
          priorAttempts={reapplySuggestion.priorAttempts}
          onConfirm={resolveAsReapply}
          onKeepNew={resolveReapplyAsNew}
          onClose={resolveReapplyAsNew}
        />
      )}
      {confirmDelete && (
        <ConfirmDeleteModal
          label={confirmDelete.label}
          note={confirmDelete.note}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={executeConfirmedDelete}
        />
      )}
    </div>
  );
}
/* ---------- edit modal (centered) ---------- */
function Modal({ modal, onClose, onSave, totals, apps, onDownloadCsv, onDeleteCsvRows, onOpenApplication, onCopyDraft, isDesktop, snapshots, onRestoreSnapshot, onExportSnapshot, onDeleteSnapshot, onExportCurrent, onImportBackup }) {
  const { kind, entry } = modal;
  const [f, setF] = useState(() => {
    if (kind === "application") {
      const pre = modal.prefill || {};
      return {
        company: entry?.company || pre.company || "",
        role: entry?.role || pre.role || "",
        website: entry?.website || "",
        source: entry?.source || pre.source || "",
        jobBoardName: entry?.jobBoardName || pre.jobBoardName || "",
        postLink: entry?.postLink || pre.postLink || "",
        postVerified: entry?.postVerified || "",
        postShot: entry?.postShot || "",
        screenshotLink: entry?.screenshotLink || "",
        salary: entry?.salary || pre.salary || "",
        contact: entry?.contact || "",
        contactPosition: entry?.contactPosition || "",
        email: entry?.email || "",
        contactLinkedin: entry?.contactLinkedin || "",
        contactPhone: entry?.contactPhone || "",
        contacted: entry?.contacted || "",
        followUps: entry
          ? normFollowUps(entry).map((f) => ({ ...f }))
          : (modal.followUpDefaults || DEFAULT_FOLLOWUPS).map((d) => ({ days: d, done: false })),
        status: entry ? entry.status || "applied" : "",
        outreachKind: entry?.outreachKind || "",
        outreachChannel: entry?.outreachChannel || "",
        badReasons: entry?.badReasons ? [...entry.badReasons] : [],
        highConfidence: entry?.highConfidence || false,
        gotReply: entry?.gotReply || false,
        milestonesLogged: entry?.milestonesLogged ? [...entry.milestonesLogged] : [],
        liStatus: entry?.liStatus || "",
        liStatusAt: entry?.liStatusAt || "",
        history: Array.isArray(entry?.history) ? entry.history.map((h) => ({ ...h })) : [],
        fromPool: entry?.fromPool ?? pre.fromPool ?? false,
        poolName: entry?.poolName ?? pre.poolName ?? "",
        hook: entry?.hook ?? pre.hook ?? "",
        researchedAt: entry?.researchedAt ?? pre.researchedAt ?? "",
        attempt: attemptOf(entry || {}),
        notes: entry?.notes || pre.notes || "",
        custom: entry?.custom ? entry.custom.map((c) => ({ ...c })) : [],
        touchpoints: entry?.touchpoints ? entry.touchpoints.map((t) => ({ ...t })) : [],
      };
    }
    if (kind === "decision") return { note: entry?.note || "" };
    if (kind === "session") return {};
    if (kind === "accomplishment")
      return { text: entry?.text || "", date: entry?.date || today(), category: entry?.category || "Daily focus" };
    if (kind === "checkinDay")
      return {
        day: entry?.day ?? 1,
        followUpDefaults: (modal.followUpDefaults || DEFAULT_FOLLOWUPS).map(String),
        followUpDailyCap: String(modal.followUpDailyCap ?? DEFAULT_FOLLOWUP_DAILY_CAP),
        aiProvider: modal.aiProvider || "builtin",
        aiModel: modal.aiModel || "",
        aiBaseUrl: modal.aiBaseUrl || "",
        aiPitch: modal.aiPitch || "",
        aiSenderName: modal.aiSenderName || "",
        aiKey: readAiKey(),
        aiWebSearch: modal.aiWebSearch !== false,
        aiMaxTokens: String(modal.aiMaxTokens ?? AI_MAX_TOKENS_DEFAULT),
        defaultTouchChannel: modal.defaultTouchChannel || DEFAULT_TOUCH_CHANNEL,
        draftSections: normDraftSections(modal.draftSections),
        autoArchiveStale: modal.autoArchiveStale !== false,
        autoArchiveDays: String(modal.autoArchiveDays ?? HOUSEKEEPING_STALE_DAYS),
        goalMode: modal.goalMode === "pool" ? "pool" : "standard",
        poolWeeklyWrite: String(modal.poolWeeklyWrite ?? DEFAULT_POOL_WEEKLY_WRITE),
        cycleWeeks: String(modal.cycleWeeks ?? DEFAULT_CYCLE_WEEKS),
        discoveryWeeks: String(modal.discoveryWeeks ?? DEFAULT_DISCOVERY_WEEKS),
        cycleStart: modal.cycleStart || "",
        contentBufferTarget: String(modal.contentBufferTarget ?? DEFAULT_CONTENT_BUFFER_TARGET),
        contentIdeaFloor: String(modal.contentIdeaFloor ?? DEFAULT_CONTENT_IDEA_FLOOR),
        timezoneOffset: entry?.timezoneOffset ?? 8,
        contentSchedule: entry?.contentSchedule
          ? { idea: [...entry.contentSchedule.idea], draft: [...entry.contentSchedule.draft], design: [...entry.contentSchedule.design], scheduled: [...entry.contentSchedule.scheduled] }
          : { idea: [1], draft: [2, 3], design: [4], scheduled: [5] },
      };
    if (kind === "goal")
      return {
        target: entry?.target ?? 500,
        days: entry?.days ?? 90,
        startDate: entry?.startDate || today(),
        aggressiveness: entry?.aggressiveness || "steady",
        rampEnabled: entry?.rampEnabled || false,
      };
    if (kind === "winSnapshot") return { company: "", role: "", date: today() };
    if (kind === "account") {
      const pre = modal.prefill || {};
      return {
        company: entry?.company || pre.company || "",
        website: entry?.website || "",
        industry: entry?.industry || "",
        headcount: entry?.headcount || "",
        status: entry?.status || "",
        highConfidence: entry?.highConfidence || false,
        badReasons: entry?.badReasons ? [...entry.badReasons] : [],
        notes: entry?.notes || "",
        /* pool fields ride along so an account created from the Pool tab is a
           first-class pool member, countable in coverage */
        hook: entry?.hook ?? pre.hook ?? "",
        researchedAt: entry?.researchedAt ?? pre.researchedAt ?? "",
        liStatus: entry?.liStatus || "",
        liStatusAt: entry?.liStatusAt || "",
        history: Array.isArray(entry?.history) ? entry.history.map((h) => ({ ...h })) : [],
        fromPool: entry?.fromPool ?? pre.fromPool ?? false,
        poolName: entry?.poolName ?? pre.poolName ?? "",
        contacts: entry?.contacts
          ? entry.contacts.map((c) => ({
              id: c.id || uid(),
              name: c.name || "",
              position: c.position || "",
              email: c.email || "",
              phone: c.phone || "",
              linkedin: c.linkedin || "",
              notes: c.notes || "",
              status: c.status || "",
              outreachKind: c.outreachKind || "",
              contacted: c.contacted || "",
              followUps: Array.isArray(c.followUps) ? c.followUps.map((f) => ({ ...f })) : [],
              touchpoints: Array.isArray(c.touchpoints) ? c.touchpoints.map((t) => ({ ...t })) : [],
              followUpChannel: c.followUpChannel || "",
              liStatus: c.liStatus || "",
              liStatusAt: c.liStatusAt || "",
              socialActive: !!c.socialActive,
              postFrequency: c.postFrequency || "",
              socialSince: c.socialSince || "",
              lastEngagedAt: c.lastEngagedAt || "",
              history: Array.isArray(c.history) ? c.history.map((h) => ({ ...h })) : [],
              linkedApplicationId: c.linkedApplicationId || null,
            }))
          : [{ id: uid(), name: "", position: "", email: "", phone: "", linkedin: "", notes: "", status: "", outreachKind: "", contacted: "", followUps: [], touchpoints: [], followUpChannel: "", liStatus: "", liStatusAt: "", history: [], linkedApplicationId: null }],
      };
    }
    if (kind === "copyDraft")
      return {
        id: entry?.id || uid(),
        title: entry?.title || "",
        body: entry?.body || "",
        purpose: entry?.purpose || modal.prefill?.purpose || "outreach",
        grade: entry?.grade || 0,
        source: entry?.source || "user",
        createdAt: entry?.createdAt || today(),
        timesUsed: entry?.timesUsed || 0,
        lastUsedAt: entry?.lastUsedAt || "",
      };
    if (kind === "content")
      return {
        title: entry?.title || "",
        status: entry?.status || modal.prefill?.status || "idea",
        type: entry?.type || "",
        platforms: entry?.platforms ? [...entry.platforms] : [],
        link: entry?.link || "",
        assetsLink: entry?.assetsLink || "",
        date: entry?.date || today(),
        shipBy: entry?.shipBy || "",
        hook: entry?.hook || "",
        outline: entry?.outline || "",
        draft: entry?.draft || "",
        notes: entry?.notes || "",
      };
    return { fund: entry?.fund ?? "", expenses: entry?.expenses ?? "" };
  });
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const [shotBusy, setShotBusy] = useState(false);
  const [historyContact, setHistoryContact] = useState(null);
  const [callContact, setCallContact] = useState(null); /* { contact, index } */
  const [confirmClearCsv, setConfirmClearCsv] = useState(false);
  const [shotErr, setShotErr] = useState("");
  const [customBoard, setCustomBoard] = useState(
    () => kind === "application" && !!entry?.jobBoardName && !JOB_BOARD_OPTIONS.includes(entry.jobBoardName)
  );

  /* shared upload path for both the file picker AND clipboard paste */
  const handleShotFile = async (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setShotErr("Image too large (max 5MB).");
      return;
    }
    setShotBusy(true);
    setShotErr("");
    try {
      const extFromName = file.name && file.name.includes(".") ? file.name.split(".").pop() : "";
      const extFromType = file.type && file.type.includes("/") ? file.type.split("/")[1] : "";
      const ext = (extFromName || extFromType || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "png";
      const prefix = modal.syncKey || `fallback-${uid()}${uid()}`; /* never a guessable literal, even if syncKey is somehow missing */
      const p = `${prefix}/${uid()}-${Date.now()}.${ext}`;
      await uploadShot(p, file);
      set("postShot")(p);
    } catch (err) {
      setShotErr(`Upload failed: ${err && err.message ? err.message.slice(0, 120) : "check connection and retry."}`);
    }
    setShotBusy(false);
  };

  /* Ctrl+V anywhere in this modal captures a pasted image (desktop) */
  useEffect(() => {
    if (kind !== "application" || f.postShot) return;
    const onPaste = (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            handleShotFile(file);
          }
          break;
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });


  const selectStyle = { ...inputStyle, appearance: "none" };

  const titles = {
    application: entry ? "Edit application" : "Track an application",
    decision: entry ? "Edit decision" : "Written decision",
    session: "Support session — reread",
    accomplishment: entry ? "Edit accomplishment" : "Log a win",
    checkinDay: "Settings — check-in & follow-ups",
    goal: entry ? "Edit goal" : "Set a goal",
    winSnapshot: "🏆 Snapshot this win",
    account: entry ? "Edit account" : "Track an account",
    content: entry ? "Edit content" : "Add content",
    runway: "Update runway numbers",
    copyDraft: entry ? "Edit copy" : "New copy",
  };

  /* ---- dismiss without losing work ----
     The overlay used to call onClose directly, so tapping outside threw away
     everything typed since opening — brutal for the content modal, where the
     notes and draft fields hold the most work and the least urgency to press
     Save. Now an outside tap COMMITS instead.

     Two guards keep that from being its own problem: nothing happens unless
     the form actually changed, and a brand-new entry is only created if it has
     something identifying in it, so a stray tap can't litter the list with
     blank records. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState("");
  const initialRef = useRef(null);
  useEffect(() => {
    if (initialRef.current === null) initialRef.current = JSON.stringify(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isDirty = () => initialRef.current !== null && initialRef.current !== JSON.stringify(f);
  /* enough substance to be worth creating as a new record */
  const hasSubstance = () => {
    if (kind === "content") return !!(f.title || "").trim() || !!(f.notes || "").trim() || !!(f.draft || "").trim() || !!(f.outline || "").trim() || !!(f.hook || "").trim();
    if (kind === "copyDraft") return !!(f.body || "").trim();
    if (kind === "application" || kind === "account") return !!(f.company || "").trim();
    return true;
  };
  const dismiss = () => {
    if (isDirty() && (entry || hasSubstance())) {
      save();
      return;
    }
    onClose();
  };

  const save = () => {
    /* copyDraft is a plain record — the generic tail below would work, but an
       explicit branch keeps it from silently inheriting future changes meant
       for other kinds */
    if (kind === "copyDraft") return onSave({ ...f });
    if (kind === "application") {
      onSave({
        ...f,
        followUps: (f.followUps || []).map((x) => ({ days: Math.max(0, +x.days || 0), done: !!x.done, doneAt: x.doneAt || "" })),
        custom: (f.custom || []).filter((c) => c.k || c.v),
      });
    } else if (kind === "account") {
      onSave({
        ...f,
        contacts: (f.contacts || []).filter((c) => c.name || c.position || c.email || c.phone || c.notes || c.status || c.outreachKind || c.contacted),
      });
    } else {
      onSave(f);
    }
  };

  return (
    <div
      onClick={dismiss}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      {/* sits above the account modal it was opened from */}
      {historyContact && <ContactHistoryModal contact={historyContact.contact} company={historyContact.company} onClose={() => setHistoryContact(null)} />}
      {callContact && (
        <ColdCallModal
          contact={callContact.contact}
          company={f.company}
          onClose={() => setCallContact(null)}
          onSave={({ outcome, notes, tickFollowUp, followUpIndex }) => {
            const o = callOutcome(outcome);
            const i = callContact.index;
            const note = `${o?.label || "Call"}${notes.trim() ? ` — ${notes.trim()}` : ""}`;
            setF((p) => ({
              ...p,
              contacts: p.contacts.map((c, j) => {
                if (j !== i) return c;
                const next = {
                  ...c,
                  /* a call is a touch point like any other, so it feeds the
                     activity date, the nurture clock and the timeline */
                  touchpoints: [...(c.touchpoints || []), { id: uid(), date: today(), channel: "Phone call", note }],
                  history: withLog(c, [logEntry("touch", `☎ ${note}`)]).history,
                  /* a call IS contact, so an untouched record starts here */
                  contacted: c.contacted || today(),
                  status: c.status || "outreach",
                };
                if (tickFollowUp && followUpIndex >= 0) {
                  next.followUps = (c.followUps || []).map((x, k) => (k === followUpIndex ? { ...x, done: true, doneAt: today(), channel: "Phone call" } : x));
                }
                if (CALL_CLOSES.includes(outcome)) next.status = "closed";
                if (CALL_IS_REPLY.includes(outcome)) next.gotReply = true;
                /* a wrong number shouldn't stay in the field inviting a redial */
                if (outcome === "wrongnumber") next.phone = "";
                return next;
              }),
            }));
            /* no toast here: `flash` lives in the parent, and the logged call
               is immediately visible in the contact's touch points and history */
            setCallContact(null);
          }}
        />
      )}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: ["application", "account"].includes(kind) ? 620 : kind === "content" ? 760 : 420, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
            <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink }}>{titles[kind]}</div>
            {/* makes the commit-on-dismiss behaviour legible rather than magic */}
            {isDirty() && (
              <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: 0.4, color: C.amber, flexShrink: 0, textAlign: "right", lineHeight: 1.4 }}>
                UNSAVED
                <div style={{ color: C.muted, letterSpacing: 0 }}>tap outside to save</div>
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 16px", minHeight: 0 }}>

        {kind === "application" && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Field label="Company name" value={f.company} onChange={set("company")} placeholder="e.g. Acme SaaS Inc." />
              </div>
              <button
                onClick={() => set("highConfidence")(!f.highConfidence)}
                title={f.highConfidence ? "High confidence — tap to unmark" : "Mark as high confidence"}
                style={{
                  flexShrink: 0,
                  marginBottom: 12,
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  border: `1px solid ${f.highConfidence ? C.amber : C.panelEdge}`,
                  background: f.highConfidence ? "rgba(245,185,66,0.14)" : "transparent",
                  color: f.highConfidence ? C.amber : C.muted,
                  fontSize: 18,
                  cursor: "pointer",
                }}
              >
                {f.highConfidence ? "⭐" : "☆"}
              </button>
            </div>
            <Field label="Role / position applied for" value={f.role} onChange={set("role")} placeholder="e.g. Senior Product Designer" />
            <Field label="Company website" value={f.website} onChange={set("website")} placeholder="https://acme.com" />
            <div style={{ marginBottom: 12 }}>
              <Label>Where did you find the job post?</Label>
              <select value={f.source} onChange={(e) => set("source")(e.target.value)} style={selectStyle}>
                <option value="">— select source —</option>
                {APP_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            {f.source === "Job board" && (
              <div style={{ marginBottom: 12 }}>
                <Label>Which job board?</Label>
                {!customBoard ? (
                  <select
                    value={JOB_BOARD_OPTIONS.includes(f.jobBoardName) ? f.jobBoardName : ""}
                    onChange={(e) => {
                      if (e.target.value === "__other__") setCustomBoard(true);
                      else set("jobBoardName")(e.target.value);
                    }}
                    style={selectStyle}
                  >
                    <option value="">— select board —</option>
                    {JOB_BOARD_OPTIONS.filter((b) => b !== "Other").map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                    <option value="__other__">Other (type name)…</option>
                  </select>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={f.jobBoardName}
                      placeholder="e.g. Kalibrr, Remote OK"
                      onChange={(e) => set("jobBoardName")(e.target.value)}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <Btn ghost onClick={() => setCustomBoard(false)} style={{ padding: "10px 12px" }}>
                      List
                    </Btn>
                  </div>
                )}
                {f.jobBoardName && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Shows as its own slice in the "Where found" donut.</div>}
              </div>
            )}
            <Field label="Link to the job post" value={f.postLink} onChange={set("postLink")} placeholder="https://linkedin.com/jobs/…" />
            {f.postLink ? (
              <div style={{ marginBottom: 12 }}>
                <Label>Posting last confirmed live</Label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="date"
                    value={f.postVerified || ""}
                    onChange={(e) => set("postVerified")(e.target.value)}
                    style={{ ...inputStyle, flex: 1, fontFamily: mono, padding: "8px 10px", colorScheme: "dark" }}
                  />
                  <button
                    onClick={() => set("postVerified")(today())}
                    style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.blue, borderRadius: 10, padding: "9px 12px", fontSize: 12, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}
                  >
                    ✓ Still live today
                  </button>
                </div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                  {postingNeedsCheck({ ...f, id: entry?.id })
                    ? `⚠ Not confirmed in ${daysSince(postingCheckedOn(f))} days — worth opening the link before you follow up again.`
                    : "Open the link and hit this whenever you re-check that the role is still posted."}
                </div>
              </div>
            ) : null}
            <div style={{ marginBottom: 12 }}>
              <Label>…or upload a screenshot of the post</Label>
              {f.postShot ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <a href={shotPublicUrl(f.postShot)} target="_blank" rel="noreferrer" style={{ flex: 1 }}>
                    <img src={shotPublicUrl(f.postShot)} alt="job post" style={{ width: "100%", maxHeight: 140, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.panelEdge}` }} />
                  </a>
                  <button
                    onClick={() => {
                      const oldPath = f.postShot;
                      set("postShot")("");
                      if (oldPath) edgeDelete("job-posts", oldPath).catch(() => {});
                    }}
                    style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 10, width: 40, height: 40, cursor: "pointer", flexShrink: 0 }}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="file"
                    accept="image/*"
                    disabled={shotBusy}
                    onChange={(e) => handleShotFile(e.target.files && e.target.files[0])}
                    style={{ ...inputStyle, padding: "8px 12px" }}
                  />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Or press Ctrl+V (⌘V on Mac) anywhere in this window to paste a copied screenshot.</div>
                  {shotBusy && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Uploading…</div>}
                  {shotErr && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{shotErr}</div>}
                </>
              )}
            </div>
            {!f.postShot && (
              <Field
                label="…or paste a link if you uploaded it elsewhere (Google Drive, Photos, etc.)"
                value={f.screenshotLink}
                onChange={set("screenshotLink")}
                placeholder="https://drive.google.com/…"
              />
            )}
            {f.screenshotLink && !f.postShot && (
              <div style={{ fontSize: 11, color: C.muted, margin: "-8px 0 12px" }}>
                Tip: in Google Drive/Photos, right-click the file → Share → "Anyone with the link" so it opens for you later.
              </div>
            )}
            <Field label="Salary / offer" value={f.salary} onChange={set("salary")} placeholder="e.g. ₱120K–150K/mo or $1,800/mo" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "flex-end" }}>
              <Field label="Contact person" value={f.contact} onChange={set("contact")} placeholder="e.g. Jane Cruz" />
              {/* their title, not the role you're applying for — the two were
                  being conflated, which put a wrong claim in draft openings */}
              <Field label="Their position" value={f.contactPosition} onChange={set("contactPosition")} placeholder="e.g. Head of Design" />
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label="Email" value={f.email} onChange={set("email")} placeholder="jane@acme.com" />
                </div>
                <div style={{ paddingBottom: 10 }}>
                  <CopyButton text={f.email} title="Copy email" />
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Phone number" value={f.contactPhone} onChange={set("contactPhone")} placeholder="e.g. +63 917 000 0000" />
              <Field label="LinkedIn profile" value={f.contactLinkedin} onChange={set("contactLinkedin")} placeholder="https://linkedin.com/in/…" />
            </div>

            {/* an application's contact is a single person, so the same
                connection pipeline applies — just at the application level
                rather than inside a contacts array */}
            {(f.contactLinkedin || "").trim() &&
              (() => {
                const asContact = { linkedin: f.contactLinkedin, liStatus: f.liStatus, liStatusAt: f.liStatusAt };
                const stale = liStaleDays(asContact);
                return (
                  <div style={{ marginBottom: 12 }}>
                    <Label>LinkedIn connection</Label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <select
                        value={f.liStatus || ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setF((p) => ({
                            ...p,
                            liStatus: v,
                            liStatusAt: v ? today() : "",
                            history: [logEntry("linkedin", `LinkedIn → ${LI_META(v).label}`), ...(p.history || [])].slice(0, 200),
                          }));
                        }}
                        style={{ ...selectStyle, flex: 1, color: LI_META(f.liStatus).color === "muted" ? C.muted : C[LI_META(f.liStatus).color] }}
                      >
                        {LI_STATUSES.map((x) => (
                          <option key={x.key || "none"} value={x.key}>
                            in · {x.label}
                          </option>
                        ))}
                      </select>
                      {f.liStatusAt && <span style={{ fontFamily: mono, fontSize: 11, color: stale ? C.red : C.muted, flexShrink: 0 }}>{daysSince(f.liStatusAt)}d</span>}
                    </div>
                    {stale > 0 && (
                      <div style={{ fontSize: 11, color: C.red, lineHeight: 1.5, marginTop: 4 }}>
                        ⚠ Request pending {stale} days. LinkedIn won&apos;t tell you it was ignored — reach them another way or mark it declined so it stops looking live.
                      </div>
                    )}
                  </div>
                );
              })()}

            <Field label="Date contacted / applied" type="date" value={f.contacted} onChange={set("contacted")} />

            {/* history is a property of the LEAD, not of a LinkedIn profile —
                status moves and touch points happen regardless */}
            {(() => {
              const stale = liStaleDays({ linkedin: f.contactLinkedin, liStatus: f.liStatus, liStatusAt: f.liStatusAt });
              const count = contactTimeline({ contacted: f.contacted, history: f.history, touchpoints: f.touchpoints }).length;
              return (
                <button
                  onClick={() =>
                    setHistoryContact({
                      contact: { name: f.contact || f.company, position: f.role, linkedin: f.contactLinkedin, liStatus: f.liStatus, liStatusAt: f.liStatusAt, contacted: f.contacted, history: f.history, touchpoints: f.touchpoints },
                      company: f.company,
                    })
                  }
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    textAlign: "left",
                    background: "transparent",
                    border: `1px solid ${stale ? C.red : C.panelEdge}`,
                    color: stale ? C.red : C.muted,
                    borderRadius: 10,
                    padding: "9px 12px",
                    fontSize: 13,
                    cursor: "pointer",
                    marginBottom: 12,
                  }}
                >
                  🕘 History{count ? ` · ${count} event${count === 1 ? "" : "s"}` : " · nothing logged yet"}
                  {stale > 0 ? ` · ⚠ LinkedIn request ${stale}d pending` : ""}
                </button>
              );
            })()}

            <div style={{ marginBottom: 4 }}>
              <Label>Touch points (every message sent — Facebook, cold email, etc.)</Label>
            </div>
            {(f.touchpoints || []).length === 0 && (
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>No touch points logged yet.</div>
            )}
            {(f.touchpoints || []).map((tp, i) => (
              <div key={tp.id || i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="date"
                  value={tp.date}
                  onChange={(e) =>
                    setF((p) => ({ ...p, touchpoints: p.touchpoints.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)) }))
                  }
                  style={{ ...inputStyle, width: "auto", maxWidth: 150, minWidth: 130, colorScheme: "dark", padding: "8px 8px", fontSize: 13, flexShrink: 0 }}
                />
                <select
                  value={tp.channel}
                  onChange={(e) =>
                    setF((p) => ({ ...p, touchpoints: p.touchpoints.map((x, j) => (j === i ? { ...x, channel: e.target.value } : x)) }))
                  }
                  style={{ ...selectStyle, flex: "1 1 120px", minWidth: 0, padding: "8px 10px", fontSize: 13 }}
                >
                  <option value="">Channel…</option>
                  {TOUCHPOINT_CHANNELS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <input
                  value={tp.note}
                  placeholder="note (optional)"
                  onChange={(e) =>
                    setF((p) => ({ ...p, touchpoints: p.touchpoints.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)) }))
                  }
                  style={{ ...inputStyle, flex: "1 1 140px", minWidth: 0, padding: "8px 10px", fontSize: 13 }}
                />
                <button
                  onClick={() => setF((p) => ({ ...p, touchpoints: p.touchpoints.filter((_, j) => j !== i) }))}
                  style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 8, width: 32, height: 36, cursor: "pointer", flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setF((p) => ({ ...p, touchpoints: [...(p.touchpoints || []), { id: uid(), date: today(), channel: "", note: "" }] }))
              }
              style={{ background: "transparent", border: `1px dashed ${C.panelEdge}`, color: C.muted, borderRadius: 10, padding: "8px 12px", fontSize: 12, cursor: "pointer", width: "100%", boxSizing: "border-box", marginBottom: 16 }}
            >
              + Add touch point
            </button>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Label>Follow-up schedule (days after contact)</Label>
              {(f.followUps || []).length > 0 && (
                <button
                  onClick={() => setF((p) => ({ ...p, followUps: [] }))}
                  style={{ background: "transparent", border: "none", color: C.muted, fontSize: 11, textDecoration: "underline", cursor: "pointer", padding: 0, marginBottom: 4 }}
                >
                  🚫 No follow-up needed
                </button>
              )}
            </div>
            {(f.followUps || []).length === 0 && (
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>No follow-ups scheduled for this one.</div>
            )}
            {(f.followUps || []).map((fu, i) => {
              const d = f.contacted ? followUpDueDate(f.contacted, f.followUps, i) : "";
              const due = d && !fu.done && d <= today();
              return (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  {/* the row order already says which follow-up this is, so the
                      full label is desktop-only — it was pushing the delete
                      button off the right edge on a phone */}
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, width: isDesktop ? 78 : 16, flexShrink: 0 }}>{isDesktop ? `Follow-up ${i + 1}` : i + 1}</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={fu.days}
                    onChange={(e) =>
                      setF((p) => ({ ...p, followUps: p.followUps.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)) }))
                    }
                    style={{ ...inputStyle, width: isDesktop ? 72 : 56, fontFamily: mono, flexShrink: 0, padding: isDesktop ? "8px 10px" : "8px 6px" }}
                  />
                  <div style={{ fontFamily: mono, fontSize: 11, color: fu.done ? C.green : due ? C.red : C.muted, flex: 1, overflow: "hidden", whiteSpace: "nowrap" }}>
                    {d || "—"}
                    {fu.done ? " ✓" : due ? " ⚑ DUE" : ""}
                  </div>
                  {/* pulls the best-graded copy for THIS follow-up number,
                      fills the placeholders from this lead, and puts it on the
                      clipboard — the library is only useful if reaching it
                      takes one tap from where you're actually working */}
                  <button
                    onClick={() => onCopyDraft && onCopyDraft(i, f)}
                    title={`Copy your best "${copyPurposeLabel(purposeForFollowUp(i))}" draft, filled in for this lead`}
                    style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.blue, borderRadius: 10, padding: isDesktop ? "0 9px" : "0", width: isDesktop ? "auto" : 34, height: 34, cursor: "pointer", flexShrink: 0, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}
                  >
                    {isDesktop ? "⧉ Copy" : "⧉"}
                  </button>
                  {/* which channel this follow-up goes out on — the touch point
                      it creates inherits it, so the log says how you reached them.

                      On mobile the full name ate the row, so the select is made
                      invisible and stretched over an icon instead. The native
                      element still handles the interaction, which means iOS
                      opens its usual picker showing the FULL channel names —
                      only the collapsed state is an icon, so nothing about
                      choosing gets harder. */}
                  {(() => {
                    const chVal = fu.channel || modal.defaultTouchChannel || DEFAULT_TOUCH_CHANNEL;
                    const onCh = (e) => setF((p) => ({ ...p, followUps: p.followUps.map((x, j) => (j === i ? { ...x, channel: e.target.value } : x)) }));
                    const opts = TOUCHPOINT_CHANNELS.map((ch) => (
                      <option key={ch} value={ch}>
                        {ch}
                      </option>
                    ));
                    if (isDesktop)
                      return (
                        <select value={chVal} onChange={onCh} style={{ ...selectStyle, width: 104, fontSize: 11, padding: "7px 6px", flexShrink: 0 }}>
                          {opts}
                        </select>
                      );
                    return (
                      <span style={{ position: "relative", width: 40, height: 34, flexShrink: 0 }} title={chVal}>
                        <span
                          aria-hidden
                          style={{
                            position: "absolute",
                            inset: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: `1px solid ${C.panelEdge}`,
                            borderRadius: 10,
                            background: C.bg,
                            color: C.muted,
                            fontFamily: mono,
                            fontSize: 12,
                            pointerEvents: "none",
                          }}
                        >
                          {channelIcon(chVal)}
                        </span>
                        <select value={chVal} onChange={onCh} aria-label="Follow-up channel" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, appearance: "none", border: "none", background: "transparent" }}>
                          {opts}
                        </select>
                      </span>
                    );
                  })()}
                  <button
                    onClick={() =>
                      setF((p) => {
                        const wasDone = !!p.followUps[i]?.done;
                        const ch = p.followUps[i]?.channel || modal.defaultTouchChannel || DEFAULT_TOUCH_CHANNEL;
                        return {
                          ...p,
                          followUps: p.followUps.map((x, j) => (j === i ? { ...x, done: !x.done, doneAt: !x.done ? today() : "" } : x)),
                          /* ticking it logs the send; un-ticking removes only the
                             auto-created entry, never one you wrote yourself */
                          touchpoints: wasDone
                            ? (p.touchpoints || []).filter((t) => !(t.fromFollowUp && t.note === `Follow-up #${i + 1}`))
                            : [...(p.touchpoints || []), followUpTouchpoint(ch, i)],
                        };
                      })
                    }
                    title={fu.done ? "Mark not done" : "Mark done"}
                    style={{ background: "transparent", border: `1px solid ${fu.done ? C.green : C.panelEdge}`, color: fu.done ? C.green : C.muted, borderRadius: 10, width: 34, height: 34, cursor: "pointer", flexShrink: 0 }}
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => setF((p) => ({ ...p, followUps: p.followUps.filter((_, j) => j !== i) }))}
                    style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 10, width: 34, height: 34, cursor: "pointer", flexShrink: 0 }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              onClick={() => setF((p) => ({ ...p, followUps: [...(p.followUps || []), { days: (+(p.followUps?.slice(-1)[0]?.days) || 7) + 7, done: false }] }))}
              style={{ background: "transparent", border: `1px dashed ${C.panelEdge}`, color: C.muted, borderRadius: 10, padding: "8px 12px", fontSize: 12, cursor: "pointer", width: "100%", boxSizing: "border-box", marginBottom: 12 }}
            >
              + Add follow-up
            </button>

            <div style={{ marginBottom: 12 }}>
              <Label>Status ("outreach" counts toward Outreach, not Apps)</Label>
              <select
                value={f.status}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((p) => ({ ...p, status: v, contacted: !p.status && v && !p.contacted ? today() : p.contacted }));
                }}
                style={selectStyle}
              >
                {APP_STATUSES.map((s) => (
                  <option key={s || "blank"} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
              {f.status === "" && (
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                  Saved for later — won't count in your funnel or need a contact date until you set a real status.
                </div>
              )}
            </div>

            {["rejected", "bad fit"].includes(f.status) && (
              <div style={{ marginBottom: 12 }}>
                <Label>How far did this get?</Label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[
                    ["", "No reply"],
                    ...MILESTONE_STAGES.filter((st) => st !== "offer").map((st) => [st, MILESTONE_LABEL[st]]),
                  ].map(([key, label]) => {
                    const cur = MILESTONE_STAGES.filter((st) => (f.milestonesLogged || []).includes(st)).pop() || "";
                    const on = cur === key;
                    return (
                      <button
                        key={key || "none"}
                        onClick={() =>
                          setF((p) => ({
                            ...p,
                            /* picking a stage implies every stage before it */
                            milestonesLogged: key ? MILESTONE_STAGES.filter((st) => STAGE_IDX[st] <= STAGE_IDX[key]) : [],
                          }))
                        }
                        style={{
                          fontFamily: sans,
                          fontSize: 12,
                          fontWeight: 700,
                          padding: "7px 11px",
                          borderRadius: 20,
                          border: `1px solid ${on ? C.blue : C.panelEdge}`,
                          background: on ? "rgba(96,165,250,0.12)" : "transparent",
                          color: on ? C.blue : C.muted,
                          cursor: "pointer",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                  Closing an entry hides how far it actually got, so this is what keeps it in your funnel. An interview that ended in a rejection is still an interview —
                  it counts, and it's the strongest evidence your applications are landing.
                </div>
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <Label>Did they ever reply?</Label>
              <button
                onClick={() => setF((p) => ({ ...p, gotReply: !p.gotReply }))}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  textAlign: "left",
                  background: f.gotReply ? "rgba(96,165,250,0.1)" : "transparent",
                  border: `1px solid ${f.gotReply ? C.blue : C.panelEdge}`,
                  color: f.gotReply ? C.blue : C.muted,
                  borderRadius: 10,
                  padding: "9px 12px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {f.gotReply ? "✉ Yes — a human replied" : "☐ No reply / silence"}
              </button>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                {["rejected", "bad fit"].includes(f.status)
                  ? f.gotReply
                    ? "Replied then rejected — your resume got through and a person engaged. The leak is later, in the conversation."
                    : "Rejected with no reply — nothing got through. That points at the resume/ATS/opening-message layer, not your interview skills."
                  : "Auto-set when a reply-or-later stage gets closed, so a rejection never erases the fact that someone answered."}
              </div>
            </div>

            {modal.goalMode === "pool" && (
              <div style={{ marginBottom: 12 }}>
                <Label>Pool membership</Label>
                <button
                  onClick={() => setF((p) => ({ ...p, fromPool: !p.fromPool, poolName: !p.fromPool ? p.poolName || modal.poolCycleName || "" : "" }))}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    textAlign: "left",
                    background: f.fromPool ? "rgba(74,222,128,0.09)" : "transparent",
                    border: `1px solid ${f.fromPool ? C.green : C.panelEdge}`,
                    color: f.fromPool ? C.green : C.muted,
                    borderRadius: 10,
                    padding: "9px 12px",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {f.fromPool ? `🎯 In the pool${f.poolName ? ` · ${f.poolName}` : ""}` : "☐ Not in the pool"}
                </button>
                {f.fromPool && (
                  <input
                    value={f.hook}
                    onChange={(e) => {
                      const v = e.target.value.slice(0, 120);
                      setF((p) => ({ ...p, hook: v, researchedAt: v.trim() ? p.researchedAt || today() : "" }));
                    }}
                    placeholder='Hook — one line, "generic", or "generic person"' 
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                )}
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                  {f.fromPool
                    ? "Writing the hook is the discovery event — it counts toward this cycle's discovery target."
                    : "Adds this company to the closed set you're working through. Removing it leaves the record untouched."}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <Label>Reapplication?</Label>
              <button
                onClick={() => setF((p) => ({ ...p, attempt: attemptOf(p) > 1 ? 1 : 2 }))}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  textAlign: "left",
                  background: attemptOf(f) > 1 ? "rgba(245,185,66,0.1)" : "transparent",
                  border: `1px solid ${attemptOf(f) > 1 ? C.amber : C.panelEdge}`,
                  color: attemptOf(f) > 1 ? C.amber : C.muted,
                  borderRadius: 10,
                  padding: "9px 12px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {attemptOf(f) > 1 ? `↻ Tagged as a reapplication (attempt #${attemptOf(f)})` : "☐ Not a reapplication"}
              </button>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                Tag this when you&apos;ve applied to the same role at the same company before. Keeps both attempts in your history and stops them being counted as one opportunity.
              </div>
            </div>

            {(f.status === "outreach" || f.outreachKind || f.outreachChannel) && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <Label>Warm or cold?</Label>
                    {(f.outreachKind || f.outreachChannel) && (
                      <button
                        onClick={() => {
                          set("outreachKind")("");
                          set("outreachChannel")("");
                        }}
                        title="Clear outreach tags"
                        style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 8, width: 22, height: 22, fontSize: 12, lineHeight: "20px", cursor: "pointer", padding: 0, marginBottom: 4 }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {f.status !== "outreach" && (f.outreachKind || f.outreachChannel) && (
                    <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 6 }}>
                      Kept from when this was tagged as outreach. Tap × above to clear if that was a mistake.
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    {OUTREACH_KINDS.map((k) => (
                      <button
                        key={k}
                        onClick={() => set("outreachKind")(f.outreachKind === k ? "" : k)}
                        style={{
                          flex: 1,
                          textTransform: "capitalize",
                          fontFamily: sans,
                          fontSize: 13,
                          fontWeight: 700,
                          padding: "10px 12px",
                          borderRadius: 10,
                          cursor: "pointer",
                          border: `1px solid ${f.outreachKind === k ? outreachKindColor(k) : C.panelEdge}`,
                          background: f.outreachKind === k ? `${outreachKindColor(k)}22` : "transparent",
                          color: f.outreachKind === k ? outreachKindColor(k) : C.muted,
                        }}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <Label>Outreached via</Label>
                  <select value={f.outreachChannel} onChange={(e) => set("outreachChannel")(e.target.value)} style={selectStyle}>
                    <option value="">— select channel —</option>
                    {OUTREACH_CHANNELS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {f.status === "bad fit" && (
              <div style={{ marginBottom: 12 }}>
                <Label>Why is this a bad fit? (select all that apply)</Label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  {BAD_FIT_REASONS.map((r) => {
                    const checked = f.badReasons.includes(r);
                    return (
                      <button
                        key={r}
                        onClick={() =>
                          setF((p) => ({
                            ...p,
                            badReasons: checked ? p.badReasons.filter((x) => x !== r) : [...p.badReasons, r],
                          }))
                        }
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          textAlign: "left",
                          fontFamily: sans,
                          fontSize: 13,
                          fontWeight: checked ? 700 : 500,
                          padding: "9px 12px",
                          borderRadius: 10,
                          cursor: "pointer",
                          border: `1px solid ${checked ? C.red : C.panelEdge}`,
                          background: checked ? "rgba(248,113,113,0.1)" : "transparent",
                          color: checked ? C.red : C.muted,
                        }}
                      >
                        <span style={{ fontSize: 14 }}>{checked ? "☑" : "☐"}</span>
                        {r}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <Field label="Notes" value={f.notes} onChange={set("notes")} placeholder="next step, thoughts…" />

            <Label>Custom fields</Label>
            {(f.custom || []).map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input
                  value={c.k}
                  placeholder="Label (e.g. Portfolio sent)"
                  onChange={(e) => setF((p) => ({ ...p, custom: p.custom.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) }))}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <input
                  value={c.v}
                  placeholder="Value"
                  onChange={(e) => setF((p) => ({ ...p, custom: p.custom.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) }))}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  onClick={() => setF((p) => ({ ...p, custom: p.custom.filter((_, j) => j !== i) }))}
                  style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 10, width: 40, cursor: "pointer", flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() => setF((p) => ({ ...p, custom: [...(p.custom || []), { k: "", v: "" }] }))}
              style={{ background: "transparent", border: `1px dashed ${C.panelEdge}`, color: C.muted, borderRadius: 10, padding: "8px 12px", fontSize: 12, cursor: "pointer", width: "100%", boxSizing: "border-box", marginBottom: 12 }}
            >
              + Add custom field
            </button>
          </>
        )}

        {kind === "decision" && (
          <Field label="Decision, with the numbers behind it" value={f.note} onChange={set("note")} placeholder="e.g. Runway 14.2 mo — floor holds at P95K" />
        )}

        {kind === "session" && entry && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 13, color: C.muted, fontStyle: "italic", lineHeight: 1.5 }}>"{entry.feeling || "Support session"}"</div>
              <div style={{ fontFamily: mono, fontSize: 12, color: (+entry.intensity || 0) >= 8 ? C.red : C.amber, flexShrink: 0 }}>
                {entry.intensity || "–"}/10 · {entry.date}
              </div>
            </div>
            {[
              ["deescalate", "1 · SETTLE THE FEELING", C.blue],
              ["reality", "2 · BACK TO REALITY — THE EVIDENCE", C.amber],
              ["reconnect", "2 · BACK TO THE GOAL", C.amber],
              ["achievements", "3 · YOUR TRACK RECORD", C.green],
              ["forward", "4 · YOUR WILL, AND THE BETTER FUTURE", C.blue],
            ].map(
              ([k, label, col]) =>
                entry[k] && (
                  <div key={k}>
                    <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: col, marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>{entry[k]}</div>
                  </div>
                )
            )}
            {entry.script && (
              <div>
                <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: C.blue, marginBottom: 4 }}>TRANSCRIPT</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{entry.script}</div>
                {entry.audioPath ? (
                  <div style={{ marginTop: 10 }}>
                    <audio controls src={audioPublicUrl(entry.audioPath)} style={{ width: "100%" }} />
                    <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 4 }}>
                      Original recording · archived {entry.audioCreated} · kept until {addDays(entry.audioCreated, AUDIO_TTL_DAYS)}
                    </div>
                  </div>
                ) : modal.localUrl ? (
                  <div style={{ marginTop: 10 }}>
                    <audio controls src={modal.localUrl} style={{ width: "100%" }} />
                    <div style={{ fontFamily: mono, fontSize: 10, color: C.amber, marginTop: 4 }}>
                      Original recording · on this device · uploads to cloud automatically when online
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
                    Audio wasn't archived for this session — the transcript above is the record. (New sessions save their audio automatically.)
                  </div>
                )}
              </div>
            )}
            {entry.one_action && (
              <div style={{ background: C.bg, border: `1px solid ${C.green}`, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: C.green, marginBottom: 4 }}>5 · THE ONE ACTION</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, fontWeight: 700 }}>{entry.one_action}</div>
              </div>
            )}
          </div>
        )}

        {kind === "accomplishment" && (
          <>
            <Field label="What you accomplished" value={f.text} onChange={set("text")} placeholder="e.g. Sent 3 warm outreaches to fintech design leads" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Date" type="date" value={f.date} onChange={set("date")} />
              <Field label="Category" value={f.category} onChange={set("category")} placeholder="e.g. Pipeline, Portfolio" />
            </div>
          </>
        )}

        {kind === "checkinDay" && (
          <>
            <Label>What determines your "day"?</Label>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
              This decides when today flips to tomorrow — for goal targets, due follow-ups, and everything else the app treats as "today." Defaults to the Philippines. Fixed offset only, no daylight saving adjustment.
            </div>
            <select
              value={f.timezoneOffset}
              onChange={(e) => set("timezoneOffset")(parseFloat(e.target.value))}
              style={{ ...selectStyle, marginBottom: 16 }}
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz.label} value={tz.offset}>{tz.label}</option>
              ))}
            </select>

            <Field label="Day of the month for the runway check-in (1–28)" type="number" value={f.day} onChange={set("day")} />
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 16 }}>
              On or after this day each month, the Dashboard will remind you to recalculate fund ÷ expenses. Saving new runway numbers marks the month as done.
            </div>

            <Label>Default follow-up schedule (days after contact)</Label>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
              New applications start with this schedule. Existing applications keep their own.
            </div>
            {(f.followUpDefaults || []).map((d, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, width: 78, flexShrink: 0 }}>Follow-up {i + 1}</div>
                <input
                  type="number"
                  inputMode="numeric"
                  value={d}
                  onChange={(e) =>
                    setF((p) => ({ ...p, followUpDefaults: p.followUpDefaults.map((x, j) => (j === i ? e.target.value : x)) }))
                  }
                  style={{ ...inputStyle, width: 90, fontFamily: mono, flexShrink: 0, padding: "8px 10px" }}
                />
                <div style={{ fontSize: 12, color: C.muted, flex: 1 }}>days</div>
                <button
                  onClick={() => setF((p) => ({ ...p, followUpDefaults: p.followUpDefaults.filter((_, j) => j !== i) }))}
                  style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 10, width: 34, height: 34, cursor: "pointer", flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setF((p) => ({ ...p, followUpDefaults: [...(p.followUpDefaults || []), (+(p.followUpDefaults?.slice(-1)[0]) || 7) + 7] }))
              }
              style={{ background: "transparent", border: `1px dashed ${C.panelEdge}`, color: C.muted, borderRadius: 10, padding: "8px 12px", fontSize: 12, cursor: "pointer", width: "100%", boxSizing: "border-box", marginBottom: 12 }}
            >
              + Add follow-up
            </button>

            <Label>Max follow-ups per day</Label>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
              Adding a batch of applications on one day would otherwise land every one of their follow-ups on the same later day. New entries get nudged forward (up to a
              week) onto a lighter day, and the Dashboard shows this many as today's batch with the rest queued behind. Set 0 to turn both off.
            </div>
            <input
              type="number"
              inputMode="numeric"
              value={f.followUpDailyCap}
              onChange={(e) => set("followUpDailyCap")(e.target.value)}
              style={{ ...inputStyle, width: 90, fontFamily: mono, padding: "8px 10px", marginBottom: 16 }}
            />

            <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.panelEdge}` }}>
              <Label>🤖 AI provider — outreach drafting</Label>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                Drafts a first email from a pool company&apos;s hook. Built-in needs no key. Choosing your own provider keeps the key in this browser only — it is never
                synced, so it won&apos;t follow you to another device, and anyone using this browser profile can read it.
              </div>
              {Object.entries(AI_PROVIDERS).map(([key, prov]) => (
                <button
                  key={key}
                  onClick={() => set("aiProvider")(key)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    textAlign: "left",
                    background: f.aiProvider === key ? "rgba(96,165,250,0.1)" : "transparent",
                    border: `1px solid ${f.aiProvider === key ? C.blue : C.panelEdge}`,
                    color: f.aiProvider === key ? C.blue : C.muted,
                    borderRadius: 10,
                    padding: "9px 12px",
                    fontSize: 13,
                    cursor: "pointer",
                    marginBottom: 6,
                  }}
                >
                  {f.aiProvider === key ? "◉" : "○"} {prov.label}
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{prov.sub}</div>
                </button>
              ))}

              {AI_PROVIDERS[f.aiProvider]?.needsKey && (
                <>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, marginTop: 6 }}>API key (stored in this browser only)</div>
                  <input
                    type="password"
                    value={f.aiKey}
                    onChange={(e) => set("aiKey")(e.target.value)}
                    placeholder={f.aiProvider === "anthropic" ? "sk-ant-…" : "sk-…"}
                    style={{ ...inputStyle, fontFamily: mono, fontSize: 12 }}
                    autoComplete="off"
                  />
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, marginTop: 8 }}>Model</div>
                  <input
                    value={f.aiModel}
                    onChange={(e) => set("aiModel")(e.target.value)}
                    placeholder={AI_PROVIDERS[f.aiProvider]?.defaultModel || "model name"}
                    style={{ ...inputStyle, fontFamily: mono, fontSize: 12 }}
                  />
                  {f.aiProvider === "custom" && (
                    <>
                      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, marginTop: 8 }}>Base URL (OpenAI-compatible, without /chat/completions)</div>
                      <input value={f.aiBaseUrl} onChange={(e) => set("aiBaseUrl")(e.target.value)} placeholder="https://openrouter.ai/api/v1" style={{ ...inputStyle, fontFamily: mono, fontSize: 12 }} />
                    </>
                  )}
                </>
              )}

              {f.aiProvider === "anthropic" && (
                <>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, marginTop: 10 }}>Let it research</div>
                  <button
                    onClick={() => set("aiWebSearch")(!f.aiWebSearch)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      textAlign: "left",
                      background: f.aiWebSearch ? "rgba(74,222,128,0.09)" : "transparent",
                      border: `1px solid ${f.aiWebSearch ? C.green : C.panelEdge}`,
                      color: f.aiWebSearch ? C.green : C.muted,
                      borderRadius: 10,
                      padding: "9px 12px",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {f.aiWebSearch ? "◉ Web search on" : "○ Web search off"}
                  </button>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                    When a hook is set to &ldquo;generic&rdquo;, the model searches for a real one and writes the email around it. Billed as extra usage on your key. Only
                    Anthropic supports this here — the other providers are told not to invent anything instead.
                  </div>
                </>
              )}

              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, marginTop: 10 }}>Token limit per draft</div>
              <input
                type="number"
                inputMode="numeric"
                value={f.aiMaxTokens}
                onChange={(e) => set("aiMaxTokens")(e.target.value)}
                style={{ ...inputStyle, width: 110, fontFamily: mono, padding: "8px 10px" }}
              />
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4, marginBottom: 10 }}>
                500–16000. An email needs perhaps 300, but reasoning models spend most of the budget thinking before they write a word — if drafts come back missing their
                subject and opening, this is usually why. Raising it costs more per draft.
              </div>

              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, marginTop: 10 }}>Your positioning — one paragraph</div>
              <textarea
                value={f.aiPitch}
                onChange={(e) => set("aiPitch")(e.target.value)}
                placeholder="e.g. Graphic designer, 6 years in SaaS and fintech brand + product design. Remote from the Philippines, working with AU/US teams. Strong on design systems and shipping fast with small teams."
                style={{ ...inputStyle, minHeight: 78, resize: "vertical", fontSize: 13, marginBottom: 16 }}
              />
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: -10, marginBottom: 16 }}>
                Without this the drafts are generic. It never leaves your device except in the drafting request itself.
              </div>

              <Label>✂️ What the AI writes</Label>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                Fixed sections are inserted word-for-word and never sent through the model to reproduce — asking it to &ldquo;include this ask&rdquo; gets you a helpful
                paraphrase every time. Leave a fixed section empty to drop it from the email entirely.
              </div>
              {DRAFT_SECTION_DEFS.map((d) => {
                const sec = f.draftSections[d.id];
                const setSec = (patch) => set("draftSections")({ ...f.draftSections, [d.id]: { ...sec, ...patch } });
                return (
                  <div key={d.id} style={{ border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "9px 11px", marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{d.label}</div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{d.hint}</div>
                      </div>
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        {[
                          ["ai", "AI"],
                          ["fixed", "Fixed"],
                        ].map(([mode, label]) => (
                          <button
                            key={mode}
                            onClick={() => setSec({ mode })}
                            style={{
                              fontFamily: sans,
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "5px 9px",
                              borderRadius: 14,
                              cursor: "pointer",
                              border: `1px solid ${sec.mode === mode ? (mode === "ai" ? C.blue : C.green) : C.panelEdge}`,
                              background: sec.mode === mode ? (mode === "ai" ? "rgba(96,165,250,0.12)" : "rgba(74,222,128,0.12)") : "transparent",
                              color: sec.mode === mode ? (mode === "ai" ? C.blue : C.green) : C.muted,
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {sec.mode === "fixed" && (
                      <textarea
                        value={sec.text}
                        onChange={(e) => setSec({ text: e.target.value })}
                        placeholder={
                          d.id === "ask"
                            ? "e.g. If it's useful, I'm happy to send over two or three ideas for your onboarding screens — no strings."
                            : d.id === "signoff"
                            ? "e.g. Justine\nPortfolio: …"
                            : d.id === "offer"
                            ? "e.g. I do brand and product design for small SaaS teams — design systems, marketing sites, and the bits in between."
                            : "Your exact wording"
                        }
                        style={{ ...inputStyle, minHeight: 62, resize: "vertical", fontSize: 12, marginTop: 8 }}
                      />
                    )}
                  </div>
                );
              })}
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 6 }}>
                The model still sees your fixed text as context, so its sections won&apos;t duplicate or argue with the ask.
              </div>
              <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", marginTop: 8, marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: C.ink, lineHeight: 1.5, marginBottom: 6 }}>
                  Fixed text can still vary — these are swapped in per company when the draft is built:
                </div>
                {DRAFT_TOKENS.map((t) => (
                  <div key={t.token} style={{ display: "flex", gap: 8, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
                    <span style={{ fontFamily: mono, color: C.blue, minWidth: 92 }}>{t.label}</span>
                    <span>{t.desc}</span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 6 }}>
                  e.g. &ldquo;I&apos;d love to help [Company] with…&rdquo;. A token with no value stays visible rather than leaving a gap, so you can spot it.
                </div>
              </div>

              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Your name (for [Me])</div>
              <input value={f.aiSenderName} onChange={(e) => set("aiSenderName")(e.target.value)} placeholder="Justine Javines" style={{ ...inputStyle, marginBottom: 16 }} />
            </div>

            <Label>Default follow-up channel</Label>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
              Ticking a follow-up logs a touch point automatically. This is the channel it assumes — changeable per follow-up.
            </div>
            <select value={f.defaultTouchChannel} onChange={(e) => set("defaultTouchChannel")(e.target.value)} style={{ ...selectStyle, width: 160, marginBottom: 16 }}>
              {TOUCHPOINT_CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>

            <Label>Default follow-up channel</Label>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
              Ticking a follow-up logs a touch point automatically, and this is the channel it assumes. Each contact and each individual follow-up can still override it.
            </div>
            <select value={f.defaultTouchChannel} onChange={(e) => set("defaultTouchChannel")(e.target.value)} style={{ ...selectStyle, width: 160, marginBottom: 16 }}>
              {TOUCHPOINT_CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>

            {/* ---- daily snapshots ----
                Deliberately above the destructive settings: if something has
                gone wrong, this is what you want to find first. */}
            <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.panelEdge}` }}>
              <Label>↺ Daily backups</Label>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                One copy per day, kept on this device for {SNAP_KEEP} days. Separate from sync on purpose — if a bad edit or a broken write reached the server, restoring from
                the server would just restore the damage. Restoring takes a copy of today first, so it&apos;s reversible.
              </div>
              {/* Available with zero snapshots, which is exactly when you need
                  it: a fresh install has no daily copies until tomorrow. */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <Btn onClick={onExportCurrent} style={{ flex: 1, padding: "8px 10px", fontSize: 12 }}>
                  ⬇ Export now
                </Btn>
                <label
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: `1px solid ${C.panelEdge}`,
                    color: C.muted,
                    borderRadius: 10,
                    padding: "8px 10px",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: sans,
                  }}
                >
                  ⬆ Import file
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = ""; /* so re-picking the same file fires again */
                      if (file) onImportBackup(file);
                    }}
                    style={{ display: "none" }}
                  />
                </label>
              </div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
                Export saves a JSON file of everything as it stands now. Import replaces your data with a file — it takes a copy of your current state first, so it&apos;s
                reversible. This is the recovery path that still works on a new device.
              </div>

              {snapshots.length === 0 ? (
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 16 }}>
                  No daily snapshots yet — the first is taken the next time you open the app on a new day. Use Export now for an immediate copy.
                </div>
              ) : (
                <div style={{ marginBottom: 16 }}>
                  {snapshots.map((snap) => (
                    <div key={snap.date + (snap.preRestore ? "-pre" : "")} style={{ background: C.bg, border: `1px solid ${snap.preRestore ? C.amber : C.panelEdge}`, borderRadius: 10, padding: "9px 11px", marginBottom: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontFamily: mono, fontSize: 12, color: C.ink }}>
                          {snap.date}
                          {snap.preRestore && <span style={{ color: C.amber, fontSize: 10 }}> · before restore</span>}
                        </span>
                        <span style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>{daysSince(snap.date) === 0 ? "today" : `${daysSince(snap.date)}d ago`}</span>
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                        {snap.summary.applications} applications · {snap.summary.accounts} accounts · {snap.summary.contacts} contacts · {snap.summary.content} content
                        {snap.summary.copy ? ` · ${snap.summary.copy} copy` : ""}
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <Btn
                          color={confirmRestore === snap.date ? C.red : undefined}
                          ghost={confirmRestore !== snap.date}
                          onClick={() => {
                            if (confirmRestore === snap.date) {
                              onRestoreSnapshot(snap);
                              setConfirmRestore("");
                              return;
                            }
                            setConfirmRestore(snap.date);
                            setTimeout(() => setConfirmRestore(""), 5000);
                          }}
                          style={{ padding: "5px 10px", fontSize: 11 }}
                        >
                          {confirmRestore === snap.date ? "Replace everything?" : "↺ Restore"}
                        </Btn>
                        <Btn ghost onClick={() => onExportSnapshot(snap)} style={{ padding: "5px 10px", fontSize: 11 }}>
                          ⬇ File
                        </Btn>
                        <Btn ghost onClick={() => onDeleteSnapshot(snap.date)} style={{ padding: "5px 10px", fontSize: 11 }}>
                          ×
                        </Btn>
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                    Restoring overwrites everything on every device once it syncs. <strong style={{ color: C.ink }}>⬇ File</strong> saves a copy off-device — the only thing that
                    survives losing this browser.
                  </div>
                </div>
              )}
            </div>

            <Label>🗄 File applications that never got an answer</Label>
            <button
              onClick={() => set("autoArchiveStale")(!f.autoArchiveStale)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                textAlign: "left",
                background: f.autoArchiveStale ? "rgba(74,222,128,0.09)" : "transparent",
                border: `1px solid ${f.autoArchiveStale ? C.green : C.panelEdge}`,
                color: f.autoArchiveStale ? C.green : C.muted,
                borderRadius: 10,
                padding: "9px 12px",
                fontSize: 13,
                cursor: "pointer",
                marginBottom: 8,
              }}
            >
              {f.autoArchiveStale ? "◉ Auto-file them" : "○ Leave them in the pipeline"}
            </button>
            {f.autoArchiveStale && (
              <>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Days of silence before filing</div>
                <input
                  type="number"
                  inputMode="numeric"
                  value={f.autoArchiveDays}
                  onChange={(e) => set("autoArchiveDays")(e.target.value)}
                  style={{ ...inputStyle, width: 90, fontFamily: mono, padding: "8px 10px" }}
                />
              </>
            )}
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginTop: 8, marginBottom: 16 }}>
              Applications still at outreach, applied or followed up with no reply get archived and written to the CSV backup, exactly like a closed one. Anything that got a
              reply is never auto-filed — that goes to the housekeeping tray for you to decide. Restore any of them from the Archived filter.
            </div>

            <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.panelEdge}` }}>
              <Label>🎯 Goal model</Label>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                Standard is the original target-over-days quota — unbounded, so you can only ever be behind. Pool pacing replaces it with coverage of the closed company set
                pushed over from Pool Mode: finite, and something you can actually finish.
              </div>
              {[
                { key: "standard", label: "Standard — N over N days", sub: "Daily quota with pace ramps and weekly rollover" },
                { key: "pool", label: "Pool pacing — cover the pool", sub: "Coverage headline, weekly write budget, no cross-week debt" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => set("goalMode")(opt.key)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    textAlign: "left",
                    background: f.goalMode === opt.key ? "rgba(74,222,128,0.09)" : "transparent",
                    border: `1px solid ${f.goalMode === opt.key ? C.green : C.panelEdge}`,
                    color: f.goalMode === opt.key ? C.green : C.muted,
                    borderRadius: 10,
                    padding: "9px 12px",
                    fontSize: 13,
                    cursor: "pointer",
                    marginBottom: 6,
                  }}
                >
                  {f.goalMode === opt.key ? "◉" : "○"} {opt.label}
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{opt.sub}</div>
                </button>
              ))}
              {f.goalMode === "pool" && (
                <>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, marginTop: 6 }}>Companies to write per week</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={f.poolWeeklyWrite}
                    onChange={(e) => set("poolWeeklyWrite")(e.target.value)}
                    style={{ ...inputStyle, width: 90, fontFamily: mono, padding: "8px 10px" }}
                  />
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 6 }}>
                    Spread across Mon–Sat. A 45-company pool at 8/week covers in about six weeks, matching Pool Mode's closure window. Your playbook targets 20–25/week, so
                    this is a deliberate trade of volume for repeatability — worth watching your reply rate to see if it pays.
                  </div>
                </>
              )}
              {f.goalMode === "pool" && (
                <div style={{ fontSize: 11, color: C.amber, lineHeight: 1.5, marginTop: 8 }}>
                  Pool pacing needs companies tagged 🎯 POOL. If none have been pushed over from Pool Mode yet, the standard goal card keeps showing.
                </div>
              )}

              <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.panelEdge}` }}>
                <Label>Discovery + reachout timelines</Label>
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                  Each cycle opens with discovery weeks — research companies, find contacts, write one hook each — then spends the rest on reachout. Kept here even when pool
                  pacing is off, where they show as context rather than binding the quota.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Cycle length (weeks)</div>
                    <input type="number" inputMode="numeric" value={f.cycleWeeks} onChange={(e) => set("cycleWeeks")(e.target.value)} style={{ ...inputStyle, width: "100%", fontFamily: mono, padding: "8px 10px", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Discovery weeks</div>
                    <input type="number" inputMode="numeric" value={f.discoveryWeeks} onChange={(e) => set("discoveryWeeks")(e.target.value)} style={{ ...inputStyle, width: "100%", fontFamily: mono, padding: "8px 10px", boxSizing: "border-box" }} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Cycle start (aligns to that week's Monday)</div>
                <input type="date" value={f.cycleStart} onChange={(e) => set("cycleStart")(e.target.value)} style={{ ...inputStyle, fontFamily: mono, padding: "8px 10px", colorScheme: "dark", marginBottom: 8 }} />
                {(() => {
                  /* show the derived arithmetic live — this is the whole point:
                     the discovery number isn't chosen, it's a consequence */
                  const cw = Math.max(2, Math.min(26, +f.cycleWeeks || DEFAULT_CYCLE_WEEKS));
                  const dw = Math.max(1, Math.min(cw - 1, +f.discoveryWeeks || DEFAULT_DISCOVERY_WEEKS));
                  const ww = Math.max(0, +f.poolWeeklyWrite || 0);
                  const target = ww * (cw - dw);
                  const perWeek = Math.ceil(target / dw);
                  const hrs = +((target * 5) / 60).toFixed(1);
                  const hrsPerWeek = +(hrs / dw).toFixed(1);
                  return (
                    <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "9px 11px", fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
                      <span style={{ color: C.ink }}>
                        {ww}/wk × {cw - dw} reachout weeks = {target} companies to research
                      </span>
                      <br />
                      {perWeek}/week across {dw} discovery week{dw === 1 ? "" : "s"} · ~{hrsPerWeek}h/week at 5 min each
                      {hrsPerWeek > 3 && <span style={{ color: C.amber }}> — that&apos;s most of a 3–5h week. Lower the weekly write or add a discovery week.</span>}
                    </div>
                  );
                })()}
              </div>
            </div>

            <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.panelEdge}` }}>
              <Label>📦 Content commitment targets</Label>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                The weekly count only tells you you've missed after the week is gone. These two tell you beforehand: how many finished pieces to keep banked, and the minimum
                raw ideas to hold so a design day never starts from a blank page.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 4 }}>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Ready-to-publish buffer</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={f.contentBufferTarget}
                    onChange={(e) => set("contentBufferTarget")(e.target.value)}
                    style={{ ...inputStyle, width: "100%", fontFamily: mono, padding: "8px 10px", boxSizing: "border-box" }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Idea bank floor</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={f.contentIdeaFloor}
                    onChange={(e) => set("contentIdeaFloor")(e.target.value)}
                    style={{ ...inputStyle, width: "100%", fontFamily: mono, padding: "8px 10px", boxSizing: "border-box" }}
                  />
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 4 }}>
                You also get one streak freeze per calendar month, offered in Content mode when a missed week would otherwise break the chain.
              </div>
            </div>

            <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.panelEdge}` }}>
              <Label>📝 Content schedule — which day for which stage?</Label>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                Pick the days you want to ideate, draft, design, and schedule content. Content mode will show today's task based on this.
              </div>
              {CONTENT_SCHEDULE_STAGES.map((stage) => (
                <div key={stage} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{CONTENT_STAGE_LABEL[stage]}</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {WEEKDAY_ABBR.map((abbr, dow) => {
                      const active = (f.contentSchedule?.[stage] || []).includes(dow);
                      return (
                        <button
                          key={dow}
                          onClick={() =>
                            setF((p) => {
                              const cur = p.contentSchedule?.[stage] || [];
                              const next = cur.includes(dow) ? cur.filter((d) => d !== dow) : [...cur, dow];
                              return { ...p, contentSchedule: { ...p.contentSchedule, [stage]: next } };
                            })
                          }
                          style={{
                            flex: 1,
                            padding: "6px 0",
                            borderRadius: 8,
                            border: `1px solid ${active ? C.amber : C.panelEdge}`,
                            background: active ? "rgba(245,185,66,0.15)" : "transparent",
                            color: active ? C.amber : C.muted,
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                          {abbr}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.panelEdge}` }}>
              <Label>🧹 Housekeeping archive backup</Label>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                Every entry the Housekeeping agent archives is captured here first, in full, before it's ever stripped down. Nothing here affects your goal or funnel numbers either way.
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
                <span style={{ fontSize: 13, color: C.ink }}>{modal.archivedCsvCount || 0} archived {modal.archivedCsvCount === 1 ? "entry" : "entries"} backed up</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn ghost onClick={onDownloadCsv} disabled={!modal.archivedCsvCount} style={{ flex: 1 }}>
                  ⬇ Download CSV
                </Btn>
                {confirmClearCsv ? (
                  <Btn
                    color={C.red}
                    onClick={() => {
                      onDeleteCsvRows();
                      setConfirmClearCsv(false);
                    }}
                    style={{ flex: 1 }}
                  >
                    Confirm delete?
                  </Btn>
                ) : (
                  <Btn ghost onClick={() => setConfirmClearCsv(true)} disabled={!modal.archivedCsvCount} style={{ flex: 1 }}>
                    Delete backup
                  </Btn>
                )}
              </div>
            </div>
          </>
        )}

        {kind === "goal" && (
          <>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
              Applications and outreach count equally toward this target — each is worth 1, combined into one number. No need to split them out.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Target number (apps + outreach combined)" type="number" value={f.target} onChange={set("target")} />
              <Field label="Over how many days" type="number" value={f.days} onChange={set("days")} />
            </div>
            <Field label="Start date" type="date" value={f.startDate} onChange={set("startDate")} />

            <div style={{ marginBottom: 12 }}>
              <Label>Aggressiveness</Label>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.entries(AGGRESSIVENESS).map(([key, p]) => (
                  <button
                    key={key}
                    onClick={() => set("aggressiveness")(key)}
                    style={{
                      flex: 1,
                      fontFamily: sans,
                      fontSize: 13,
                      fontWeight: 700,
                      padding: "10px 8px",
                      borderRadius: 10,
                      cursor: "pointer",
                      border: `1px solid ${f.aggressiveness === key ? C.amber : C.panelEdge}`,
                      background: f.aggressiveness === key ? "rgba(245,185,66,0.12)" : "transparent",
                      color: f.aggressiveness === key ? C.amber : C.muted,
                    }}
                  >
                    {p.emoji} {p.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
                {f.aggressiveness === "chill" && "Lighter daily target (80% of the strict math) — sustainable pace, easier to keep up for the long haul."}
                {f.aggressiveness === "steady" && "Exactly the strict math (target ÷ days) — the baseline pace."}
                {f.aggressiveness === "aggressive" && "Pushes past the strict math (125%) — finishes with margin, or gets there faster."}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Label>Ramp-up</Label>
                <button
                  onClick={() => set("rampEnabled")(!f.rampEnabled)}
                  style={{
                    fontFamily: sans,
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "6px 14px",
                    borderRadius: 20,
                    cursor: "pointer",
                    border: `1px solid ${f.rampEnabled ? C.green : C.panelEdge}`,
                    background: f.rampEnabled ? "rgba(74,222,128,0.12)" : "transparent",
                    color: f.rampEnabled ? C.green : C.muted,
                  }}
                >
                  {f.rampEnabled ? "● On" : "○ Off"}
                </button>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
                Start below full pace and build up gradually, instead of hitting the full daily number from day one. The warm-up length and starting point follow your aggressiveness choice above.
              </div>
            </div>

            {(() => {
              const target = Math.max(1, Math.round(+f.target || 0));
              const days = Math.max(1, Math.round(+f.days || 0));
              const previewGoal = { target, days, startDate: f.startDate || today(), aggressiveness: f.aggressiveness, rampEnabled: f.rampEnabled };
              const preset = aggressivenessOf(previewGoal);
              const fullQuota = Math.max(1, Math.ceil((target / days) * preset.quotaMultiplier));
              const deadline = addDays(f.startDate || today(), days - 1);
              const startVal = Math.max(1, Math.round(fullQuota * preset.rampStart));
              return (
                <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 4 }}>
                  {f.rampEnabled ? (
                    <>
                      → Starts around <span style={{ color: C.amber, fontWeight: 700 }}>{startVal}/day</span>, ramps up to{" "}
                      <span style={{ color: C.amber, fontWeight: 700 }}>{fullQuota}/day</span> over {preset.rampDays} days, then holds steady.
                    </>
                  ) : (
                    <>
                      → <span style={{ color: C.amber, fontWeight: 700 }}>{fullQuota} per day</span>, flat from day one
                      {preset.quotaMultiplier !== 1 ? ` (${target}÷${days} × ${preset.quotaMultiplier}, rounded up)` : ` (${target}÷${days}, rounded up)`}
                    </>
                  )}
                  <br />→ Deadline: <span style={{ color: C.ink, fontWeight: 700 }}>{deadline}</span>
                </div>
              );
            })()}
          </>
        )}

        {kind === "winSnapshot" && (
          <>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
              This saves your current pipeline totals permanently under Past Wins — a benchmark to reference if you ever search again.
            </div>
            <Field label="Company" value={f.company} onChange={set("company")} placeholder="e.g. Acme SaaS Inc." />
            <Field label="Role / title" value={f.role} onChange={set("role")} placeholder="e.g. Senior Product Designer" />
            <Field label="Date" type="date" value={f.date} onChange={set("date")} />
            <div style={{ background: C.bg, border: `1px solid ${C.green}`, borderRadius: 10, padding: "10px 12px", marginTop: 4 }}>
              <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.18em", color: C.green, marginBottom: 6 }}>SNAPSHOT PREVIEW</div>
              <div style={{ fontFamily: mono, fontSize: 12, color: C.ink, lineHeight: 1.7 }}>
                Apps {totals.apps} · Outreach {totals.outreach} · Replies {totals.replies}
                <br />
                Screens {totals.screens} · Interviews {totals.interviews} · Offers {totals.offers}
              </div>
            </div>
          </>
        )}

        {kind === "account" && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Field label="Company name" value={f.company} onChange={set("company")} placeholder="e.g. Acme SaaS Inc." />
              </div>
              <button
                onClick={() => set("highConfidence")(!f.highConfidence)}
                title={f.highConfidence ? "High confidence — tap to unmark" : "Mark as high confidence"}
                style={{
                  flexShrink: 0,
                  marginBottom: 12,
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  border: `1px solid ${f.highConfidence ? C.amber : C.panelEdge}`,
                  background: f.highConfidence ? "rgba(245,185,66,0.14)" : "transparent",
                  color: f.highConfidence ? C.amber : C.muted,
                  fontSize: 18,
                  cursor: "pointer",
                }}
              >
                {f.highConfidence ? "⭐" : "☆"}
              </button>
            </div>
            <Field label="Website" value={f.website} onChange={set("website")} placeholder="https://acme.com" />
            <Field label="Industry" value={f.industry} onChange={set("industry")} placeholder="e.g. Fintech, SaaS" />
            <Field label="Headcount" value={f.headcount} onChange={set("headcount")} placeholder="e.g. 50-200, 500+" />
            {modal.goalMode === "pool" && (
              <div style={{ marginBottom: 12 }}>
                <Label>Pool membership</Label>
                <button
                  onClick={() => setF((p) => ({ ...p, fromPool: !p.fromPool, poolName: !p.fromPool ? p.poolName || modal.poolCycleName || "" : "" }))}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    textAlign: "left",
                    background: f.fromPool ? "rgba(74,222,128,0.09)" : "transparent",
                    border: `1px solid ${f.fromPool ? C.green : C.panelEdge}`,
                    color: f.fromPool ? C.green : C.muted,
                    borderRadius: 10,
                    padding: "9px 12px",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {f.fromPool ? `🎯 In the pool${f.poolName ? ` · ${f.poolName}` : ""}` : "☐ Not in the pool"}
                </button>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                  Adds this company to the closed set you're working through, so it counts toward coverage. Removing it leaves the record untouched.
                </div>
              </div>
            )}
            {f.fromPool && (
              <div style={{ marginBottom: 12 }}>
                <Label>🎯 Pool hook — one line</Label>
                <input
                  value={f.hook}
                  onChange={(e) => {
                    const v = e.target.value.slice(0, 120);
                    setF((p) => ({ ...p, hook: v, researchedAt: v.trim() ? p.researchedAt || today() : "" }));
                  }}
                  placeholder="Rebrand shipped 3 wks ago"
                  style={inputStyle}
                />
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
                  Writing the hook is the discovery event — it stamps the research date and counts toward this cycle's discovery target.
                  {f.researchedAt ? ` Researched ${f.researchedAt}.` : ""}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <Label>Account status</Label>
              <select value={f.status} onChange={(e) => set("status")(e.target.value)} style={selectStyle}>
                <option value="">active — still nurturing</option>
                <option value="closed">closed — they rejected / dead end</option>
                <option value="bad fit">bad fit</option>
              </select>
            </div>
            {f.status === "bad fit" && (
              <div style={{ marginBottom: 12 }}>
                <Label>Why is this a bad fit? (select all that apply)</Label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  {BAD_FIT_REASONS.map((r) => {
                    const checked = f.badReasons.includes(r);
                    return (
                      <button
                        key={r}
                        onClick={() => setF((p) => ({ ...p, badReasons: checked ? p.badReasons.filter((x) => x !== r) : [...p.badReasons, r] }))}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          textAlign: "left",
                          fontFamily: sans,
                          fontSize: 13,
                          fontWeight: checked ? 700 : 500,
                          padding: "9px 12px",
                          borderRadius: 10,
                          cursor: "pointer",
                          border: `1px solid ${checked ? C.red : C.panelEdge}`,
                          background: checked ? "rgba(248,113,113,0.1)" : "transparent",
                          color: checked ? C.red : C.muted,
                        }}
                      >
                        <span style={{ fontSize: 14 }}>{checked ? "☑" : "☐"}</span>
                        {r}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <Label>Contacts</Label>
            {(f.contacts || []).map((c, i) => {
              if (c.archivedAt) return null; /* archived — hidden from view, still present in data until it fully ages out */
              const setContact = (patch) => setF((p) => ({ ...p, contacts: p.contacts.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
              const fus = c.followUps || [];
              /* Marking a contact as outreached (or any further stage) IS the
                 act of recording that contact happened — so it stamps today's
                 date and seeds the follow-up schedule automatically, the same
                 way typing a date manually already did. Only fills a BLANK
                 date: an existing one is real history and never overwritten,
                 so back-dating an old outreach then setting its status still
                 keeps the date you entered. */
              const setContactStamped = (patch) => {
                const willBeContacted = "status" in patch ? !!patch.status : !!c.status;
                const needsDate = willBeContacted && !c.contacted;
                /* keep "they answered" alive when the contact gets closed */
                const withReply = "status" in patch ? { ...patch, ...latchContactReply(c, patch.status) } : patch;
                /* record the change itself — touch points say what you did,
                   history says what moved, which was previously invisible */
                const logged =
                  "status" in patch && patch.status !== c.status
                    ? { ...withReply, history: withLog(c, [logEntry("status", `Status → ${contactStatusLabel(patch.status) || "not contacted yet"}`)]).history }
                    : withReply;
                if (!needsDate) return setContact(logged);
                setContact({
                  ...logged,
                  contacted: today(),
                  followUps: fus.length === 0 ? DEFAULT_FOLLOWUPS.map((d) => ({ days: d, done: false })) : fus,
                });
              };
              /* LinkedIn state changes are logged the same way, and re-stamp
                 the date so the 7-day staleness clock restarts on each move */
              const setLiStatus = (v) =>
                setContact({
                  liStatus: v,
                  liStatusAt: v ? today() : "",
                  history: withLog(c, [logEntry("linkedin", `LinkedIn → ${LI_META(v).label}`)]).history,
                });
              const stale = liStaleDays(c);
              return (
                <div key={c.id || i} style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                    <input
                      value={c.name}
                      placeholder="Contact name"
                      onChange={(e) => setContact({ name: e.target.value })}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <CopyButton text={c.email} title="Copy email" />
                    <button
                      onClick={() => setCallContact({ contact: c, index: i })}
                      title="Log a cold call"
                      style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 10, width: 40, cursor: "pointer", flexShrink: 0, fontSize: 14 }}
                    >
                      ☎
                    </button>
                    <button
                      onClick={() => setHistoryContact({ contact: c, company: f.company })}
                      title="History — status changes, LinkedIn moves and touch points"
                      style={{ position: "relative", background: "transparent", border: `1px solid ${stale ? C.red : C.panelEdge}`, color: stale ? C.red : C.muted, borderRadius: 10, width: 40, cursor: "pointer", flexShrink: 0, fontSize: 14 }}
                    >
                      🕘
                      {stale > 0 && <span style={{ position: "absolute", top: -4, right: -4, width: 8, height: 8, borderRadius: 4, background: C.red }} />}
                    </button>
                    <button
                      onClick={() => setContact({ archivedAt: today() })}
                      title="Archive — hides it from view, doesn't affect any counted numbers"
                      style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 10, width: 40, cursor: "pointer", flexShrink: 0, fontSize: 14 }}
                    >
                      🗄
                    </button>
                    <button
                      onClick={() => setF((p) => ({ ...p, contacts: p.contacts.filter((_, j) => j !== i) }))}
                      style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, color: C.muted, borderRadius: 10, width: 40, cursor: "pointer", flexShrink: 0 }}
                    >
                      ×
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
                    <input
                      value={c.position}
                      placeholder="Position / title"
                      onChange={(e) => setContact({ position: e.target.value })}
                      style={inputStyle}
                    />
                    <input
                      value={c.phone}
                      placeholder="Phone number"
                      onChange={(e) => setContact({ phone: e.target.value })}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <input
                      value={c.email}
                      placeholder="Email"
                      onChange={(e) => setContact({ email: e.target.value })}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <input
                      value={c.linkedin}
                      placeholder="LinkedIn profile URL"
                      onChange={(e) => setContact({ linkedin: e.target.value })}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    {c.linkedin && (
                      <a
                        href={c.linkedin.startsWith("http") ? c.linkedin : `https://${c.linkedin}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open LinkedIn profile"
                        style={{ color: C.blue, fontSize: 15, flexShrink: 0, textDecoration: "none" }}
                      >
                        🔗
                      </a>
                    )}
                  </div>

                  {/* the connection request is its own small pipeline, and only
                      worth showing once there's a profile to connect on */}
                  {(c.linkedin || "").trim() && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <select
                          value={c.liStatus || ""}
                          onChange={(e) => setLiStatus(e.target.value)}
                          style={{ ...selectStyle, fontSize: 12, padding: "7px 9px", flex: 1, color: LI_META(c.liStatus).color === "muted" ? C.muted : C[LI_META(c.liStatus).color] }}
                        >
                          {LI_STATUSES.map((x) => (
                            <option key={x.key || "none"} value={x.key}>
                              in · {x.label}
                            </option>
                          ))}
                        </select>
                        {c.liStatusAt && (
                          <span style={{ fontFamily: mono, fontSize: 10, color: stale ? C.red : C.muted, flexShrink: 0 }}>
                            {daysSince(c.liStatusAt)}d
                          </span>
                        )}
                      </div>
                      {stale > 0 && (
                        <div style={{ fontSize: 11, color: C.red, lineHeight: 1.5, marginTop: 4 }}>
                          ⚠ Request pending {stale} days. LinkedIn won't tell you it was ignored — either reach them another way or mark it declined so it stops looking live.
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
                    <select
                      value={c.status}
                      onChange={(e) => setContactStamped({ status: e.target.value })}
                      style={{ ...selectStyle, fontSize: 13, padding: "8px 10px", color: c.status ? contactStatusColor(c.status) : C.muted }}
                    >
                      {CONTACT_STATUSES.map((s) => (
                        <option key={s || "blank"} value={s}>{contactStatusLabel(s)}</option>
                      ))}
                    </select>
                    <div style={{ display: "flex", gap: 6 }}>
                      {OUTREACH_KINDS.map((k) => (
                        <button
                          key={k}
                          onClick={() => {
                            const turningOn = c.outreachKind !== k;
                            /* picking warm/cold is itself declaring the outreach
                               happened — so set the status too if it's still blank */
                            setContactStamped({
                              outreachKind: turningOn ? k : "",
                              ...(turningOn && !c.status ? { status: "outreach" } : {}),
                            });
                          }}
                          style={{
                            flex: 1,
                            fontFamily: sans,
                            fontSize: 12,
                            fontWeight: 700,
                            padding: "8px 6px",
                            borderRadius: 8,
                            cursor: "pointer",
                            border: `1px solid ${c.outreachKind === k ? outreachKindColor(k) : C.panelEdge}`,
                            background: c.outreachKind === k ? "rgba(245,185,66,0.1)" : "transparent",
                            color: c.outreachKind === k ? outreachKindColor(k) : C.muted,
                            textTransform: "capitalize",
                          }}
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={() => setContact({ gotReply: !c.gotReply })}
                    title="Records that a human answered, so closing this contact doesn't erase the fact"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      textAlign: "left",
                      background: c.gotReply ? "rgba(96,165,250,0.1)" : "transparent",
                      border: `1px solid ${c.gotReply ? C.blue : C.panelEdge}`,
                      color: c.gotReply ? C.blue : C.muted,
                      borderRadius: 8,
                      padding: "7px 10px",
                      fontSize: 12,
                      cursor: "pointer",
                      marginBottom: 6,
                    }}
                  >
                    {c.gotReply ? "✉ They replied" : "☐ No reply yet"}
                  </button>

                  {(() => {
                    const n = nurtureState(c);
                    if (!n) return null;
                    const col = NURTURE_META[n].color === "amber" ? C.amber : C.muted;
                    return (
                      <div style={{ background: n === "nurture" ? "rgba(245,185,66,0.08)" : "transparent", border: `1px solid ${col}`, borderRadius: 8, padding: "7px 10px", marginBottom: 6 }}>
                        <span style={{ fontFamily: mono, fontSize: 9, letterSpacing: 0.4, color: col }}>
                          🌱 {NURTURE_META[n].label} · {daysSince(lastActivityDate(c))}d quiet
                        </span>
                        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.45, marginTop: 3 }}>{NURTURE_META[n].hint}</div>
                      </div>
                    );
                  })()}

                  {/* the hook lives on the PERSON now, so it's editable here as
                      well as in the Pool tab — whichever screen you're on when
                      you find the angle */}
                  {f.fromPool && (
                    <div style={{ marginBottom: 6 }}>
                      <input
                        value={c.hook || ""}
                        onChange={(e) => {
                          const v = e.target.value.slice(0, 120);
                          setContact({ hook: v, researchedAt: v.trim() ? c.researchedAt || today() : "" });
                        }}
                        placeholder='🎯 Their hook — one line, "generic", or "generic person"'
                        style={{ ...inputStyle, fontSize: 12, padding: "7px 9px" }}
                      />
                      {c.hook && (c.hook || "").trim() && (
                        <div style={{ fontFamily: mono, fontSize: 9, color: C.green, marginTop: 3 }}>
                          ✓ ready to write{c.researchedAt ? ` · researched ${c.researchedAt}` : ""}
                        </div>
                      )}
                    </div>
                  )}

                  {/* engagement loop — a different rhythm from follow-ups,
                      set by how often THEY post rather than by your queue */}
                  <div style={{ border: `1px solid ${isEngagementDue(c) ? C.blue : C.panelEdge}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>
                    <button
                      onClick={() =>
                        setContact({
                          socialActive: !c.socialActive,
                          socialSince: !c.socialActive ? today() : "",
                          postFrequency: !c.socialActive ? c.postFrequency : "",
                          history: withLog(c, [logEntry("status", !c.socialActive ? "Marked active on social" : "Stopped tracking social")]).history,
                        })
                      }
                      style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", fontSize: 13, fontWeight: 700, color: c.socialActive ? C.blue : C.muted, textAlign: "left" }}
                    >
                      {c.socialActive ? "☑" : "☐"} Active on social
                    </button>
                    {c.socialActive && (
                      <>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 6, marginBottom: 4 }}>How often do they post?</div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {POST_FREQUENCIES.map((fq) => (
                            <button
                              key={fq.key}
                              onClick={() => setContact({ postFrequency: fq.key })}
                              title={`${fq.sub} → engage about every ${fq.everyDays} days`}
                              style={{
                                fontFamily: sans,
                                fontSize: 11,
                                fontWeight: 700,
                                padding: "5px 9px",
                                borderRadius: 14,
                                cursor: "pointer",
                                border: `1px solid ${c.postFrequency === fq.key ? C.blue : C.panelEdge}`,
                                background: c.postFrequency === fq.key ? "rgba(96,165,250,0.12)" : "transparent",
                                color: c.postFrequency === fq.key ? C.blue : C.muted,
                              }}
                            >
                              {fq.label}
                            </button>
                          ))}
                        </div>
                        {c.postFrequency && (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 8 }}>
                            <div style={{ fontSize: 11, color: isEngagementDue(c) ? C.blue : C.muted, lineHeight: 1.45 }}>
                              {isEngagementDue(c) ? `Due to engage${engagementOverdueDays(c) > 0 ? ` · ${engagementOverdueDays(c)}d over` : ""}` : `Next around ${engagementDueDate(c)}`}
                              <div style={{ color: C.muted }}>
                                every ~{postFreqOf(c.postFrequency).everyDays}d · {lastEngagedDate(c) ? `last ${lastEngagedDate(c)}` : "not engaged yet"}
                              </div>
                            </div>
                            <Btn
                              onClick={() =>
                                setContact({
                                  lastEngagedAt: today(),
                                  touchpoints: [...(c.touchpoints || []), { id: uid(), date: today(), channel: "LinkedIn", note: "Engaged with a post" }],
                                  history: withLog(c, [logEntry("touch", "Engaged with a post")]).history,
                                })
                              }
                              style={{ padding: "6px 10px", fontSize: 12, flexShrink: 0 }}
                            >
                              ✓ Engaged
                            </Btn>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>Contacted:</span>
                    <input
                      type="date"
                      value={c.contacted}
                      onChange={(e) => {
                        const newDate = e.target.value;
                        const needsDefaults = newDate && fus.length === 0;
                        setContact({
                          contacted: newDate,
                          followUps: needsDefaults ? DEFAULT_FOLLOWUPS.map((d) => ({ days: d, done: false })) : fus,
                        });
                      }}
                      style={{ ...inputStyle, width: "auto", maxWidth: 160, colorScheme: "dark", padding: "6px 8px", fontSize: 12 }}
                    />
                  </div>

                  {fus.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 10, color: C.muted }}>⚑</span>
                      {/* one channel for this contact's follow-ups — the touch
                          point each tick creates inherits it */}
                      {(() => {
                        /* same invisible-select-over-an-icon trick as the
                           application row; this one is tighter still */
                        const chVal = c.followUpChannel || modal.defaultTouchChannel || DEFAULT_TOUCH_CHANNEL;
                        const opts = TOUCHPOINT_CHANNELS.map((ch) => (
                          <option key={ch} value={ch}>
                            {ch}
                          </option>
                        ));
                        const onCh = (e) => setContact({ followUpChannel: e.target.value });
                        if (isDesktop)
                          return (
                            <select value={chVal} onChange={onCh} style={{ ...selectStyle, width: 78, fontSize: 10, padding: "3px 4px" }}>
                              {opts}
                            </select>
                          );
                        return (
                          <span style={{ position: "relative", width: 30, height: 24, flexShrink: 0 }} title={chVal}>
                            <span
                              aria-hidden
                              style={{
                                position: "absolute",
                                inset: 0,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                border: `1px solid ${C.panelEdge}`,
                                borderRadius: 8,
                                background: C.bg,
                                color: C.muted,
                                fontFamily: mono,
                                fontSize: 10,
                                pointerEvents: "none",
                              }}
                            >
                              {channelIcon(chVal)}
                            </span>
                            <select value={chVal} onChange={onCh} aria-label="Follow-up channel" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, appearance: "none", border: "none", background: "transparent" }}>
                              {opts}
                            </select>
                          </span>
                        );
                      })()}
                      {fus.map((fu, fi) => {
                        const due = c.contacted ? followUpDueDate(c.contacted, fus, fi) : "";
                        return (
                          /* the tick and its copy icon travel together — a
                             separate row of icons makes you count positions to
                             work out which follow-up each one belongs to */
                          <span key={fi} style={{ display: "inline-flex", alignItems: "center" }}>
                          <button
                            onClick={() => {
                              const wasDone = !!fu.done;
                              const ch = c.followUpChannel || modal.defaultTouchChannel || DEFAULT_TOUCH_CHANNEL;
                              setContact({
                                followUps: fus.map((x, xi) => (xi === fi ? { ...x, done: !x.done, doneAt: !x.done ? today() : "" } : x)),
                                touchpoints: wasDone
                                  ? (c.touchpoints || []).filter((t) => !(t.fromFollowUp && t.note === `Follow-up #${fi + 1}`))
                                  : [...(c.touchpoints || []), followUpTouchpoint(ch, fi)],
                                history: wasDone ? c.history || [] : withLog(c, [logEntry("followup", `Follow-up #${fi + 1} sent via ${ch}`)]).history,
                              });
                            }}
                            title={due ? `Due ${due}` : ""}
                            style={{
                              fontFamily: mono,
                              fontSize: 10,
                              padding: "3px 8px",
                              borderRadius: 10,
                              border: `1px solid ${fu.done ? C.green : C.panelEdge}`,
                              background: fu.done ? "rgba(74,222,128,0.1)" : "transparent",
                              color: fu.done ? C.green : C.muted,
                              cursor: "pointer",
                            }}
                          >
                            {fu.done ? "✓" : "○"} {fu.days}d
                          </button>
                          {onCopyDraft && (
                            <button
                              onClick={() => onCopyDraft(fi, { company: f.company, contact: c.name, contactPosition: c.position, industry: f.industry })}
                              title={`Copy your "${copyPurposeLabel(purposeForFollowUp(fi))}" draft for ${c.name || "this contact"}`}
                              style={{ background: "transparent", border: "none", color: C.blue, fontSize: 11, cursor: "pointer", padding: "0 3px", lineHeight: 1 }}
                            >
                              ⧉
                            </button>
                          )}
                          </span>
                        );
                      })}

                      <button
                        onClick={() => setContact({ followUps: [] })}
                        title="No follow-up needed — clear all"
                        style={{ background: "transparent", border: "none", color: C.muted, fontSize: 11, cursor: "pointer", padding: 0 }}
                      >
                        🚫
                      </button>
                    </div>
                  )}

                  <div style={{ marginTop: 6, marginBottom: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10, color: C.muted }}>Touch points:</span>
                      {(c.touchpoints || []).map((tp, ti) => {
                        const tps = c.touchpoints || [];
                        return (
                          <div key={tp.id || ti} style={{ display: "flex", alignItems: "center", gap: 3, background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "2px 4px 2px 6px" }}>
                            <select
                              value={tp.channel}
                              onChange={(e) => setContact({ touchpoints: tps.map((x, xi) => (xi === ti ? { ...x, channel: e.target.value } : x)) })}
                              style={{ fontSize: 10, background: "transparent", border: "none", color: C.ink, outline: "none", minWidth: 70, cursor: "pointer" }}
                            >
                              <option value="">Channel…</option>
                              {TOUCHPOINT_CHANNELS.map((ch) => (
                                <option key={ch} value={ch} style={{ background: C.panel }}>{ch}</option>
                              ))}
                            </select>
                            <span style={{ fontFamily: mono, fontSize: 9, color: C.muted }}>{tp.date}</span>
                            <button
                              onClick={() => setContact({ touchpoints: tps.filter((_, xi) => xi !== ti) })}
                              style={{ background: "transparent", border: "none", color: C.muted, fontSize: 11, cursor: "pointer", padding: 0, lineHeight: 1 }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                      <button
                        onClick={() => setContact({ touchpoints: [...(c.touchpoints || []), { id: uid(), date: today(), channel: "", note: "" }] })}
                        style={{ background: "transparent", border: `1px dashed ${C.panelEdge}`, color: C.muted, fontSize: 10, borderRadius: 10, padding: "3px 8px", cursor: "pointer" }}
                      >
                        + touch point
                      </button>
                    </div>
                  </div>

                  <input
                    value={c.notes}
                    placeholder="Notes (optional)"
                    onChange={(e) => setContact({ notes: e.target.value })}
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                </div>
              );
            })}
            <button
              onClick={() =>
                setF((p) => ({
                  ...p,
                  contacts: [...(p.contacts || []), { id: uid(), name: "", position: "", email: "", phone: "", linkedin: "", notes: "", status: "", outreachKind: "", contacted: "", followUps: [], touchpoints: [], linkedApplicationId: null }],
                }))
              }
              style={{ background: "transparent", border: `1px dashed ${C.panelEdge}`, color: C.muted, borderRadius: 10, padding: "8px 12px", fontSize: 12, cursor: "pointer", width: "100%", boxSizing: "border-box", marginBottom: 12 }}
            >
              + Add another contact
            </button>

            <Field label="Notes" value={f.notes} onChange={set("notes")} placeholder="relationship notes, how you connected…" />

            {entry &&
              (() => {
                const related = relatedApplications(f.company, apps || []);
                if (!related.length) return null;
                return (
                  <div style={{ marginTop: 4 }}>
                    <Label>Related applications ({related.length})</Label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {related.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => onOpenApplication && onOpenApplication(r)}
                          title="Open this entry in the Applications view"
                          style={{
                            background: C.bg,
                            border: `1px solid ${C.panelEdge}`,
                            borderRadius: 8,
                            padding: "8px 10px",
                            fontSize: 12,
                            textAlign: "left",
                            cursor: onOpenApplication ? "pointer" : "default",
                            color: C.ink,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                            boxSizing: "border-box",
                          }}
                        >
                          <span style={{ fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.role || "Role not set"}</span>
                          <span style={{ color: statusColor(r.status), fontFamily: mono, fontSize: 11, flexShrink: 0 }}>{statusLabel(r.status)}</span>
                          {r.contacted && <span style={{ color: C.muted, fontFamily: mono, fontSize: 10, flexShrink: 0 }}>{r.contacted}</span>}
                          <span style={{ marginLeft: "auto", color: C.blue, fontSize: 12, flexShrink: 0 }}>→</span>
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                      Linked automatically by matching company name. Click one to open it — unsaved changes here are discarded, so save first if you've edited anything.
                    </div>
                  </div>
                );
              })()}
          </>
        )}

        {kind === "content" && (
          <>
            <Field label="Title" value={f.title} onChange={set("title")} placeholder="e.g. 5 portfolio mistakes to avoid" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ marginBottom: 12 }}>
                <Label>Status</Label>
                <select value={f.status} onChange={(e) => set("status")(e.target.value)} style={selectStyle}>
                  {CONTENT_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: 12 }}>
                <Label>Type / format</Label>
                <select value={f.type} onChange={(e) => set("type")(e.target.value)} style={selectStyle}>
                  <option value="">— select —</option>
                  {CONTENT_TYPES.map((ty) => (
                    <option key={ty} value={ty}>{ty}</option>
                  ))}
                </select>
              </div>
            </div>
            <Field label="Link to the content (if published)" value={f.link} onChange={set("link")} placeholder="https://…" />
            <Field label="Link to assets (video / photo)" value={f.assetsLink} onChange={set("assetsLink")} placeholder="Google Drive, Dropbox, raw file link…" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Date" type="date" value={f.date} onChange={set("date")} />
              <Field label="Ship by (commitment)" type="date" value={f.shipBy} onChange={set("shipBy")} />
            </div>
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: -6, marginBottom: 12 }}>
              {contentOverdue({ ...f })
                ? `⚠ Past its ship-by date by ${daysSince(f.shipBy)} day${daysSince(f.shipBy) === 1 ? "" : "s"}. Either ship it or move the date deliberately — don't let it just sit.`
                : "Naming the day you'll publish is the commitment. Overdue pieces get flagged on the board."}
            </div>

            <div style={{ marginBottom: 12 }}>
              <Label>Platforms (select all that apply)</Label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {CONTENT_PLATFORMS.map((p) => {
                  const active = f.platforms.includes(p);
                  return (
                    <button
                      key={p}
                      onClick={() => set("platforms")(active ? f.platforms.filter((x) => x !== p) : [...f.platforms, p])}
                      style={{
                        fontFamily: sans,
                        fontSize: 12,
                        fontWeight: 700,
                        padding: "7px 12px",
                        borderRadius: 20,
                        border: `1px solid ${active ? C.blue : C.panelEdge}`,
                        background: active ? "rgba(125,176,247,0.14)" : "transparent",
                        color: active ? C.blue : C.muted,
                        cursor: "pointer",
                      }}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 16, marginBottom: 8, fontFamily: mono, fontSize: 10, letterSpacing: "0.18em", color: C.muted, textTransform: "uppercase" }}>
              Brain dump — as much room as you need
            </div>
            <TextAreaField
              label="💡 Hook / Idea"
              hint="the core concept"
              value={f.hook}
              onChange={set("hook")}
              placeholder="What's the one-line hook? Why would someone stop scrolling for this?"
              rows={4}
            />
            <TextAreaField
              label="📝 Outline / Key points"
              hint="the structure"
              value={f.outline}
              onChange={set("outline")}
              placeholder={"- point one\n- point two\n- point three"}
              rows={6}
            />
            <TextAreaField
              label="✍️ Draft / Script"
              hint="the actual write-up"
              value={f.draft}
              onChange={set("draft")}
              placeholder="Write the full draft here — as long as it needs to be."
              rows={16}
            />
            <TextAreaField
              label="🔗 Notes / references"
              hint="misc, links, next steps"
              value={f.notes}
              onChange={set("notes")}
              placeholder="Sources, references, follow-up ideas, anything else…"
              rows={4}
            />
          </>
        )}

        {kind === "copyDraft" && (
          <>
            <Field label="Name it" value={f.title} onChange={set("title")} placeholder="e.g. Short nudge — value-first" />
            <Label>Used for</Label>
            <select value={f.purpose} onChange={(e) => set("purpose")(e.target.value)} style={{ ...selectStyle, marginBottom: 12 }}>
              {COPY_PURPOSES.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <Label>The copy</Label>
            <textarea
              value={f.body}
              onChange={(e) => set("body")(e.target.value)}
              placeholder={"Subject: …\n\nHi [First name], …"}
              style={{ ...inputStyle, minHeight: 220, resize: "vertical", fontSize: 13, lineHeight: 1.6 }}
            />
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.55, marginTop: 6 }}>
              Write it as a template, not a one-off. These are swapped in when you use it:{" "}
              {DRAFT_TOKENS.map((t) => (
                <span key={t.token} style={{ fontFamily: mono, color: C.blue, marginRight: 6 }}>
                  {t.label}
                </span>
              ))}
            </div>
          </>
        )}

        {kind === "runway" && (
          <>
            <Field label="Emergency fund (₱)" type="number" value={f.fund} onChange={set("fund")} />
            <Field label="Monthly expenses (₱)" type="number" value={f.expenses} onChange={set("expenses")} />
          </>
        )}

        </div>

        <div style={{ display: "flex", gap: 10, padding: "14px 20px", borderTop: `1px solid ${C.panelEdge}`, flexShrink: 0, background: C.panel }}>
          {kind === "session" ? (
            <Btn ghost onClick={onClose} style={{ flex: 1 }}>Close</Btn>
          ) : (
            <>
              {/* Cancel still means cancel — but throwing away typed work on a
                  single tap is how notes disappear, so when the form is dirty
                  it asks once. */}
              <Btn
                ghost
                color={confirmDiscard ? C.red : undefined}
                onClick={() => {
                  if (!isDirty()) return onClose();
                  if (confirmDiscard) return onClose();
                  setConfirmDiscard(true);
                  setTimeout(() => setConfirmDiscard(false), 4000);
                }}
                style={{ flex: 1, ...(confirmDiscard ? { borderColor: C.red, color: C.red } : {}) }}
              >
                {confirmDiscard ? "Discard?" : "Cancel"}
              </Btn>
              <Btn onClick={save} style={{ flex: 2 }}>Save</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- sync modal (centered) ---------- */
/* ---------- delete confirmation (centered) ---------- */
function ConfirmDeleteModal({ label, note, onCancel, onConfirm }) {
  return (
    <div
      onClick={onCancel}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.82)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 55, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 360, background: C.panel, border: `1px solid ${C.red}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>Delete this entry?</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: note ? 8 : 16, wordBreak: "break-word" }}>
          You're about to delete <span style={{ color: C.ink, fontWeight: 700 }}>{label}</span>. You can undo this afterward with the ↩ Undo button if you change your mind.
        </div>
        {note && (
          <div style={{ fontSize: 12, color: C.amber, lineHeight: 1.5, marginBottom: 16, background: "rgba(245,185,66,0.08)", border: `1px solid ${C.amber}`, borderRadius: 10, padding: "8px 10px" }}>
            {note}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn ghost onClick={onCancel} style={{ flex: 1 }}>Cancel</Btn>
          <Btn onClick={onConfirm} color={C.red} style={{ flex: 1 }}>Delete</Btn>
        </div>
      </div>
    </div>
  );
}

function SyncModal({ currentKey, onClose, onSwitch, flash }) {
  const [input, setInput] = useState("");
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>Sync across devices</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 14 }}>
          Your data lives under this private sync code. <span style={{ color: C.amber }}>If two devices show different data or different daily advice, they're on different codes</span> — copy the code from one device and enter it on the other. Everything from both devices merges; nothing is lost. Treat the code like a password.
        </div>

        <Label>This device's sync code</Label>
        <div
          onClick={() => {
            try {
              navigator.clipboard.writeText(currentKey);
              flash("Sync code copied");
            } catch (e) {
              flash("Copy manually below");
            }
          }}
          style={{ fontFamily: mono, fontSize: 13, background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", wordBreak: "break-all", cursor: "pointer", marginBottom: 16 }}
          title="Click to copy"
        >
          {currentKey}
        </div>

        <div style={{ marginBottom: 12 }}>
          <Label>Use a code from another device</Label>
          <input value={input} placeholder="fd_…" onChange={(e) => setInput(e.target.value)} style={inputStyle} />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <Btn ghost onClick={onClose} style={{ flex: 1 }}>Close</Btn>
          <Btn onClick={() => onSwitch(input)} disabled={input.trim().length < 20} style={{ flex: 2 }}>
            Switch to this code
          </Btn>
        </div>
      </div>
    </div>
  );
}


/* ---------- emotional support modal (centered, on demand) ---------- */
const SUPPORT_BLOCKS = [
  ["deescalate", "1 · SETTLE THE FEELING", C.blue],
  ["reality", "2 · BACK TO REALITY — THE EVIDENCE", C.amber],
  ["reconnect", "2 · BACK TO THE GOAL", C.amber] /* legacy sessions */,
  ["achievements", "3 · YOUR TRACK RECORD", C.green],
  ["forward", "4 · YOUR WILL, AND THE BETTER FUTURE", C.blue],
];

/* ---------- today's focus popup ---------- */
function TodaysFocusModal({ onClose, coach, setCoach, coachLoading, runDaily, focusItems, nextImportantIdx, allFocusDone, canAutoGen }) {
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink }}>
              📋 Today's Focus — {new Date(today() + "T00:00:00").toDateString()}
              {coach.daily?.carried ? "  ·  CARRIED OVER" : ""}
            </div>
            {coach.daily && (
              <Btn ghost onClick={runDaily} disabled={coachLoading === "daily"} style={{ padding: "6px 10px", fontSize: 11, flexShrink: 0 }} title="Regenerate (replaces the current list)">
                {coachLoading === "daily" ? "…" : "↻"}
              </Btn>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 20px 16px", minHeight: 0 }}>
          {coach.daily?.carried && (
            <div style={{ fontSize: 12, color: C.amber, margin: "0 0 10px", lineHeight: 1.5 }}>
              Yesterday's unfinished items carried over. Finish these to unlock a fresh focus tomorrow — completed ones are already in your History.
            </div>
          )}

          {coachLoading === "daily" && (
            <div style={{ color: C.muted, fontFamily: mono, fontSize: 12, padding: "18px 0", letterSpacing: "0.15em" }}>READING YOUR INSTRUMENTS…</div>
          )}

          {!coachLoading && coach.daily && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {focusItems.map((f, i) => {
                  const done = (coach.dailyDone || []).includes(i);
                  const isNext = i === nextImportantIdx && !done;
                  return (
                    <div
                      key={i}
                      onClick={() => setCoach((p) => ({ ...p, dailyDone: done ? p.dailyDone.filter((d) => d !== i) : [...p.dailyDone, i] }))}
                      style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.bg, border: `1px solid ${done ? C.green : isNext ? C.amber : C.panelEdge}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer", transition: "border-color 0.25s ease" }}
                    >
                      <div style={{ fontFamily: mono, fontSize: 14, color: done ? C.green : isNext ? C.amber : C.muted, lineHeight: 1.4 }}>{done ? "◉" : "○"}</div>
                      <div style={{ minWidth: 0 }}>
                        {isNext && (
                          <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.18em", color: C.amber, marginBottom: 2 }}>★ DO THIS NEXT — HIGHEST IMPACT</div>
                        )}
                        <div style={{ fontSize: 14, lineHeight: 1.45, textDecoration: done ? "line-through" : "none", color: done ? C.muted : C.ink, wordBreak: "break-word" }}>{f.text}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {allFocusDone && (
                <div style={{ fontSize: 13, color: C.green, marginTop: 10, fontWeight: 700 }}>
                  ✓ All done — these archive to History tonight, and a fresh focus arrives tomorrow.
                </div>
              )}
              {coach.daily.why && <div style={{ fontSize: 12, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>{coach.daily.why}</div>}
              {coach.daily.watch && <div style={{ fontSize: 12, color: C.amber, marginTop: 8, lineHeight: 1.5 }}>⚠ {coach.daily.watch}</div>}
              {coach.daily.reminder && (
                <div style={{ marginTop: 12, borderLeft: `2px solid ${C.green}`, paddingLeft: 10, fontSize: 12, color: C.green, lineHeight: 1.5, fontStyle: "italic" }}>
                  {coach.daily.reminder}
                </div>
              )}
            </>
          )}

          {!coachLoading && !coach.daily && (
            <div style={{ padding: "10px 0" }}>
              <div style={{ color: C.muted, fontSize: 13, marginBottom: 10 }}>
                {canAutoGen ? "No focus set for today yet." : "Waiting for sync — generate manually if needed."}
              </div>
              <Btn onClick={runDaily} disabled={coachLoading === "daily"}>Generate today's focus</Btn>
            </div>
          )}
        </div>

        <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.panelEdge}`, flexShrink: 0 }}>
          <Btn ghost onClick={onClose} style={{ width: "100%" }}>Close</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------- weekly review popup ---------- */
function WeeklyReviewModal({ onClose, coach, coachLoading, runWeekly }) {
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink }}>
              📊 Weekly Review{coach.weeklyDate ? ` — last run ${coach.weeklyDate}` : ""}
            </div>
            <Btn onClick={runWeekly} disabled={coachLoading === "weekly"} style={{ padding: "6px 12px", fontSize: 11, flexShrink: 0 }}>
              {coachLoading === "weekly" ? "Reviewing…" : "Run review"}
            </Btn>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 20px 16px", minHeight: 0 }}>
          {!coach.weekly && coachLoading !== "weekly" && (
            <div style={{ color: C.muted, fontSize: 13, padding: "10px 0" }}>No review yet — run one every Friday to see your funnel, pipeline, and emotional patterns for the week.</div>
          )}
          {coach.weekly && coachLoading !== "weekly" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.amber, lineHeight: 1.45, wordBreak: "break-word" }}>{coach.weekly.verdict}</div>
              {[
                ["FUNNEL", coach.weekly.funnel],
                ["PIPELINE", coach.weekly.pipeline],
                ["EMOTIONS", coach.weekly.emotions],
                ["CONTENT", coach.weekly.content],
                ["FLOOR CHECK", coach.weekly.floor],
              ].map(
                ([k, v]) =>
                  v && (
                    <div key={k}>
                      <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: C.muted, marginBottom: 3 }}>{k}</div>
                      <div style={{ fontSize: 13, lineHeight: 1.55, wordBreak: "break-word" }}>{v}</div>
                    </div>
                  )
              )}
              {Array.isArray(coach.weekly.next_week) && coach.weekly.next_week.length > 0 && (
                <div>
                  <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: C.muted, marginBottom: 3 }}>NEXT WEEK</div>
                  {coach.weekly.next_week.map((n, i) => (
                    <div key={i} style={{ fontSize: 13, lineHeight: 1.6, wordBreak: "break-word" }}>
                      <span style={{ color: C.amber, fontFamily: mono }}>{i + 1}.</span> {n}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.panelEdge}`, flexShrink: 0 }}>
          <Btn ghost onClick={onClose} style={{ width: "100%" }}>Close</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------- patterns popup — pre-verified cross-domain observations ---------- */
function PatternsModal({ onClose, observations, narrative, narrativeLoading, onAskCoach }) {
  const kindColor = { watch: C.amber, positive: C.green, info: C.blue };
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 460, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 6 }}>🧭 Patterns</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
            Things worth noticing across your data — never verdicts, never a reason to lower your floor. Pure coincidence-spotting; you decide what it means.
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 20px 16px", minHeight: 0 }}>
          {observations.length === 0 && (
            <div style={{ color: C.muted, fontSize: 13, padding: "20px 0", textAlign: "center" }}>
              Nothing stands out right now — either everything's steady, or there isn't quite enough data yet to say anything meaningful.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {observations.map((o) => (
              <div key={o.id} style={{ background: C.bg, border: `1px solid ${kindColor[o.kind] || C.panelEdge}`, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ fontSize: 16, flexShrink: 0 }}>{o.icon}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: kindColor[o.kind] || C.ink }}>{o.title}</div>
                    <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginTop: 3, wordBreak: "break-word" }}>{o.detail}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {observations.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.panelEdge}` }}>
              {narrative ? (
                <div style={{ fontSize: 13, lineHeight: 1.6, color: C.ink, fontStyle: "italic" }}>{narrative}</div>
              ) : (
                <Btn ghost onClick={() => onAskCoach(observations)} disabled={narrativeLoading} style={{ width: "100%" }}>
                  {narrativeLoading ? "Thinking…" : "💬 Ask the coach to reflect on these"}
                </Btn>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.panelEdge}`, flexShrink: 0 }}>
          <Btn ghost onClick={onClose} style={{ width: "100%" }}>Close</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------- CRM housekeeping popup ---------- */
/* ---------- job post parser popup ---------- */
/* ---------- morning digest popup ---------- */
/* ---------- CSV backup reminder popup ---------- */
/* ---------- missed content-day prompt ---------- */
/* ---------- inline win outcome-update form ---------- */
/* ---------- Content Kanban board ---------- */
/* ---------- duplicate application -> merge into Account suggestion ---------- */
function DuplicateSuggestionModal({ pendingApp, duplicateApp, onMerge, onKeepSeparate, onClose }) {
  const sameContact = (pendingApp.contact || "").trim().toLowerCase() === (duplicateApp.contact || "").trim().toLowerCase() && !!pendingApp.contact;
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 8 }}>🏢 Same company, same role</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 16 }}>
          You already have an application for <strong style={{ color: C.ink }}>{duplicateApp.role || "this role"}</strong> at{" "}
          <strong style={{ color: C.ink }}>{duplicateApp.company}</strong> ({duplicateApp.contact || "no contact listed"}, status: {statusLabel(duplicateApp.status) || "blank"}).
          {sameContact ? (
            " This looks like the same person — merging will refresh that contact's info rather than track them twice."
          ) : (
            " This one has a different contact, though — merging will add them as a second contact on the same company's account, tracked as outreach rather than a separate application."
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Btn onClick={onMerge}>🏢 Merge into Account</Btn>
          <Btn ghost onClick={onKeepSeparate}>
            Keep as a separate application
          </Btn>
        </div>
      </div>
    </div>
  );
}

function ReapplySuggestionModal({ pendingApp, priorAttempts, onConfirm, onKeepNew, onClose }) {
  const latest = priorAttempts[0];
  const gapDays = latest?.contacted && pendingApp.contacted ? Math.round((new Date(pendingApp.contacted + "T00:00:00") - new Date(latest.contacted + "T00:00:00")) / 86400000) : null;
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 8 }}>↻ You&apos;ve applied here before</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 12 }}>
          <strong style={{ color: C.ink }}>{pendingApp.role || "This role"}</strong> at <strong style={{ color: C.ink }}>{pendingApp.company}</strong> already has{" "}
          {priorAttempts.length === 1 ? "an earlier attempt" : `${priorAttempts.length} earlier attempts`} on record
          {gapDays != null && gapDays > 0 ? ` — the last one ${gapDays} day${gapDays === 1 ? "" : "s"} ago` : ""}.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
          {priorAttempts.slice(0, 4).map((p) => (
            <div key={p.id} style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 8, padding: "7px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: C.muted, flexShrink: 0 }}>#{attemptOf(p)}</span>
              <span style={{ color: statusColor(p.status), fontFamily: mono, fontSize: 11 }}>{statusLabel(p.status) || "no status"}</span>
              {p.contacted && <span style={{ marginLeft: "auto", color: C.muted, fontFamily: mono, fontSize: 10 }}>{p.contacted}</span>}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 14 }}>
          Tagging it keeps both attempts in your history — useful when they ask &ldquo;have you applied before?&rdquo; — and stops the new attempt from being merged with the old
          one in your funnel counts.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Btn onClick={onConfirm}>↻ Tag as reapplication</Btn>
          <Btn ghost onClick={onKeepNew}>
            No — track as a new application
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* The pool's add form. Two deliberate design calls:

   1. TYPE CHOICE — a pool target is either an APPLICATION (going after a
      specific role) or an ACCOUNT (going after the company, working several
      contacts inside it). You pick; both count identically toward coverage.

   2. FAST PATH BY DEFAULT — building a 45-company pool in two sittings means
      the common case has to be company + hook + enter. So the inline form stays
      minimal, and "More fields" opens the full Application or Account modal
      prefilled when a target deserves the whole record up front.

   Closed weeks don't hide the form, they relabel it — parking a name should be
   one action, not a dead end you have to work around. */
/* The pool's add control.

   Tapping a type goes straight to that record's full modal, prefilled as a
   pool member — no second "more fields" step, and no half-populated record
   that behaves differently from one made through + Track application.
   Hooks aren't asked for here because every row below has an inline hook
   field: adding the name and researching it are separate acts, and the
   cycle already separates them.

   During reachout weeks the pool is closed, so the control becomes a bench
   parking slip instead of disappearing — capturing a name shouldn't require
   fighting the app. */
/* Per-contact timeline. Read-only by design: it's a record of what happened,
   and a record you can edit after the fact isn't much of a record. */
/* Logs a cold call. Everything it records feeds the systems that already
   exist rather than sitting in its own silo: a touch point (so the activity
   date, nurture clock and history timeline all move), optionally a ticked
   follow-up, and a status change when the outcome ends the pursuit. */
function ColdCallModal({ contact, company, onClose, onSave }) {
  const [outcome, setOutcome] = useState("");
  const [notes, setNotes] = useState("");
  const [tickFollowUp, setTickFollowUp] = useState(true);
  const picked = callOutcome(outcome);
  const fus = Array.isArray(contact.followUps) ? contact.followUps : [];
  const nextUnticked = fus.findIndex((x) => !x.done);
  const toneCol = (t) => (t === "green" ? C.green : t === "red" ? C.red : t === "blue" ? C.blue : t === "amber" ? C.amber : C.muted);
  const past = (contact.touchpoints || []).filter((t) => t.channel === "Phone call");
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 18, boxSizing: "border-box", maxHeight: "86vh", overflowY: "auto" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink }}>☎ Log a call</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
          {contact.name || "Unnamed contact"}
          {contact.position ? ` · ${contact.position}` : ""}
          {company ? ` · ${company}` : ""}
        </div>
        {contact.phone ? (
          <a href={`tel:${contact.phone}`} style={{ display: "inline-block", fontFamily: mono, fontSize: 13, color: C.blue, textDecoration: "none", marginBottom: 12 }}>
            {contact.phone} →
          </a>
        ) : (
          <div style={{ fontSize: 11, color: C.amber, marginBottom: 12 }}>No phone number saved for this contact.</div>
        )}

        {past.length > 0 && (
          <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "8px 10px", marginBottom: 12 }}>
            <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.12em", color: C.muted, marginBottom: 4 }}>
              {past.length} PREVIOUS CALL{past.length === 1 ? "" : "S"}
            </div>
            {past.slice(-3).reverse().map((t) => (
              <div key={t.id} style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                {t.date} — {t.note || "call"}
              </div>
            ))}
          </div>
        )}

        <Label>How did it go?</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
          {CALL_OUTCOMES.map((o) => {
            const col = toneCol(o.tone);
            const on = outcome === o.key;
            return (
              <button
                key={o.key}
                onClick={() => setOutcome(o.key)}
                style={{
                  textAlign: "left",
                  background: on ? `${col}1f` : "transparent",
                  border: `1px solid ${on ? col : C.panelEdge}`,
                  color: on ? col : C.muted,
                  borderRadius: 10,
                  padding: "8px 11px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {on ? "◉" : "○"} {o.label}
              </button>
            );
          })}
        </div>

        <Label>Notes</Label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was said, who to ask for, when to try again…"
          style={{ ...inputStyle, minHeight: 84, resize: "vertical", fontSize: 13, marginBottom: 10 }}
        />

        {/* Every logged call counts as follow-up work, not just the ones that
            landed — dialling IS the outreach, and the tick records that you did
            it. Still a toggle, because three no-answers in one afternoon would
            otherwise burn the whole sequence without reaching anyone. */}
        {picked && nextUnticked !== -1 && (
          <button
            onClick={() => setTickFollowUp((v) => !v)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              textAlign: "left",
              background: tickFollowUp ? "rgba(74,222,128,0.09)" : "transparent",
              border: `1px solid ${tickFollowUp ? C.green : C.panelEdge}`,
              color: tickFollowUp ? C.green : C.muted,
              borderRadius: 10,
              padding: "9px 12px",
              fontSize: 13,
              cursor: "pointer",
              marginBottom: 10,
            }}
          >
            {tickFollowUp ? "☑" : "☐"} Also tick follow-up {nextUnticked + 1}
          </button>
        )}
        {picked && !picked.landed && tickFollowUp && nextUnticked !== -1 && (
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
            You didn&apos;t reach them this time. The call still counts as follow-up {nextUnticked + 1} — untick above if you&apos;d rather keep that slot for an attempt that
            actually connects.
          </div>
        )}
        {picked && nextUnticked === -1 && (
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
            Every scheduled follow-up is already done, so this logs as a touch point only.
          </div>
        )}
        {picked && CALL_CLOSES.includes(picked.key) && (
          <div style={{ fontSize: 11, color: C.amber, lineHeight: 1.5, marginBottom: 10 }}>
            This closes the contact, so it stops appearing in due lists and the nurture clock.
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Btn ghost onClick={onClose} style={{ flex: 1 }}>
            Cancel
          </Btn>
          <Btn
            disabled={!outcome}
            onClick={() => onSave({ outcome, notes, tickFollowUp, followUpIndex: nextUnticked })}
            style={{ flex: 2 }}
          >
            Log call
          </Btn>
        </div>
      </div>
    </div>
  );
}

function ContactHistoryModal({ contact, company, onClose }) {
  const events = contactTimeline(contact);
  const ICON = { status: "◑", linkedin: "in", touch: "✉", first: "●", followup: "⚑" };
  const COLOR = { status: C.amber, linkedin: C.blue, touch: C.ink, first: C.green, followup: C.red };
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 18, boxSizing: "border-box", maxHeight: "82vh", overflowY: "auto" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink }}>🕘 {contact.name || "Unnamed contact"}</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
          {[contact.position, company].filter(Boolean).join(" · ") || "History"}
        </div>

        {(contact.linkedin || "").trim() && (
          <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "9px 11px", marginBottom: 12 }}>
            <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.12em", color: C.muted, marginBottom: 3 }}>LINKEDIN</div>
            <div style={{ fontSize: 13, color: LI_META(contact.liStatus).color === "muted" ? C.muted : C[LI_META(contact.liStatus).color] }}>
              {LI_META(contact.liStatus).label}
              {contact.liStatusAt ? ` · ${daysSince(contact.liStatusAt)}d ago` : ""}
            </div>
            {liStaleDays(contact) > 0 && <div style={{ fontSize: 11, color: C.red, marginTop: 4, lineHeight: 1.45 }}>Pending {liStaleDays(contact)} days — treat it as ignored unless you hear otherwise.</div>}
          </div>
        )}

        {events.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 13, padding: "14px 2px", textAlign: "center", lineHeight: 1.6 }}>
            Nothing logged yet. Status changes, LinkedIn moves and touch points all land here automatically.
          </div>
        ) : (
          events.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", paddingBottom: 10, marginBottom: 10, borderBottom: `1px solid ${C.panelEdge}` }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: COLOR[e.kind] || C.muted, flexShrink: 0, width: 18, textAlign: "center", paddingTop: 2 }}>{ICON[e.kind] || "·"}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.45 }}>{e.text}</div>
                <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 2 }}>
                  {e.at} · {daysSince(e.at)}d ago
                </div>
              </div>
            </div>
          ))
        )}

        <Btn ghost onClick={onClose} style={{ width: "100%", marginTop: 4 }}>
          Close
        </Btn>
      </div>
    </div>
  );
}

/* One saved piece of copy. Grading is the point of the whole section, so the
   stars sit in the header rather than behind an edit screen — a grade you have
   to open a modal to set is a grade that never gets set. */
/* Shown when more than one draft fits the slot. Deliberately shows a preview
   of each — a title alone doesn't tell you which variant you're sending, and
   picking blind is how the wrong tone reaches the wrong lead. */
function CopyPickerModal({ purpose, options, label, onPick, onClose }) {
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 18, boxSizing: "border-box", maxHeight: "84vh", overflowY: "auto" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink }}>⧉ Which draft?</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
          {copyPurposeLabel(purpose)}
          {label ? ` · ${label}` : ""}
        </div>

        {options.map((d, i) => (
          <button
            key={d.id}
            onClick={() => onPick(d)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              textAlign: "left",
              background: "transparent",
              border: `1px solid ${i === 0 ? C.amber : C.panelEdge}`,
              borderRadius: 10,
              padding: "10px 12px",
              marginBottom: 8,
              cursor: "pointer",
              color: C.ink,
              fontFamily: sans,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.title || "Untitled"}
                {d.source === "ai" && <span style={{ fontFamily: mono, fontSize: 9, color: C.blue, marginLeft: 6 }}>AI</span>}
              </span>
              <span style={{ fontSize: 11, color: C.amber, flexShrink: 0, letterSpacing: 1 }}>{d.grade ? "★".repeat(d.grade) : ""}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {d.body}
            </div>
            <div style={{ fontFamily: mono, fontSize: 9, color: C.muted, marginTop: 4 }}>
              {i === 0 ? "best rated · " : ""}
              {d.timesUsed ? `used ${d.timesUsed}×` : "unused"}
            </div>
          </button>
        ))}

        <Btn ghost onClick={onClose} style={{ width: "100%", marginTop: 4 }}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

function CopyDraftCard({ draft, onGrade, onEdit, onDelete, onUsed }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const copy = () => {
    (navigator.clipboard?.writeText(draft.body) || Promise.reject()).then(
      () => {
        setCopied(true);
        onUsed();
        setTimeout(() => setCopied(false), 1600);
      },
      () => {}
    );
  };
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {draft.title || "Untitled"}
            {draft.source === "ai" && <span style={{ fontFamily: mono, fontSize: 9, color: C.blue, marginLeft: 6 }}>AI</span>}
          </div>
          <div style={{ display: "flex", gap: 2, marginTop: 3 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => onGrade(draft.id, n)}
                title={`Grade ${n}/5`}
                style={{ background: "transparent", border: "none", padding: "0 1px", cursor: "pointer", fontSize: 13, lineHeight: 1, color: n <= draft.grade ? C.amber : C.panelEdge }}
              >
                ★
              </button>
            ))}
            <span style={{ fontFamily: mono, fontSize: 9, color: C.muted, marginLeft: 6, alignSelf: "center" }}>
              {draft.timesUsed ? `used ${draft.timesUsed}×` : "unused"}
            </span>
          </div>
        </div>
        <button
          onClick={copy}
          title="Copy to clipboard"
          style={{ background: "transparent", border: `1px solid ${copied ? C.green : C.panelEdge}`, color: copied ? C.green : C.muted, borderRadius: 8, width: 34, height: 34, cursor: "pointer", fontSize: 13, flexShrink: 0 }}
        >
          {copied ? "✓" : "⧉"}
        </button>
      </div>

      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          fontSize: 12,
          color: C.muted,
          lineHeight: 1.55,
          marginTop: 6,
          cursor: "pointer",
          whiteSpace: "pre-wrap",
          ...(open ? {} : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }),
        }}
      >
        {draft.body || "Empty"}
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <Btn ghost onClick={onEdit} style={{ padding: "5px 10px", fontSize: 11 }}>
          Edit
        </Btn>
        <Btn ghost onClick={onDelete} style={{ padding: "5px 10px", fontSize: 11 }}>
          Delete
        </Btn>
      </div>
    </div>
  );
}

function DraftModal({ member, text, loading, error, onClose, onRegenerate, foundHook, searched, generic, onSaveHook, missing, echoWarnings, pickContacts, onPickContact, personMode, target }) {
  const [copied, setCopied] = useState(false);
  const [edited, setEdited] = useState(text || "");
  useEffect(() => setEdited(text || ""), [text]);
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 55, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 18, boxSizing: "border-box", maxHeight: "88vh", overflowY: "auto" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 4 }}>✍ Draft — {member.company}</div>
        <div style={{ fontSize: 12, color: C.amber, lineHeight: 1.45, marginBottom: 12 }}>
          {personMode
            ? `To ${target?.name || "a contact"}${target?.position ? ` · ${target.position}` : ""}`
            : generic
            ? searched
              ? "Generic — AI searched for a hook"
              : "Generic — no hook, no web access"
            : member.hook}
        </div>

        {/* asked before any request goes out, so a wrong pick costs nothing */}
        {pickContacts && (
          <>
            <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.55, marginBottom: 10 }}>Who is this going to?</div>
            {pickContacts.map((c) => (
              <button
                key={c.id}
                onClick={() => onPickContact(c)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  textAlign: "left",
                  background: "transparent",
                  border: `1px solid ${C.panelEdge}`,
                  borderRadius: 10,
                  padding: "10px 12px",
                  marginBottom: 6,
                  cursor: "pointer",
                  color: C.ink,
                  fontFamily: sans,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {c.name}
                <div style={{ fontSize: 11, fontWeight: 400, color: c.position ? C.muted : C.amber, marginTop: 2 }}>{c.position || "no position set — the role line will be dropped"}</div>
              </button>
            ))}
            <Btn ghost onClick={onClose} style={{ width: "100%", marginTop: 4 }}>
              Cancel
            </Btn>
          </>
        )}

        {/* the model went looking and found something real — worth keeping */}
        {foundHook && (
          <div style={{ background: "rgba(74,222,128,0.08)", border: `1px solid ${C.green}`, borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
            <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.12em", color: C.muted, marginBottom: 4 }}>HOOK FOUND</div>
            <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.45 }}>{foundHook}</div>
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, margin: "6px 0 8px" }}>Verify it before sending — search results can be stale or about a different company with a similar name.</div>
            <Btn color={C.green} onClick={() => onSaveHook(foundHook)} style={{ padding: "6px 11px", fontSize: 12 }}>
              Save as this company&apos;s hook
            </Btn>
          </div>
        )}

        {generic && !personMode && !searched && !loading && !pickContacts && (
          <div style={{ background: "rgba(245,185,66,0.08)", border: `1px solid ${C.amber}`, borderRadius: 10, padding: "10px 12px", marginBottom: 12, fontSize: 11, color: C.muted, lineHeight: 1.55 }}>
            Written without research — this provider can&apos;t browse, so the model was told not to invent anything about {member.company}. That makes it honest but plain.
            A real hook converts far better; five minutes on their site usually finds one. Anthropic + web search is the only setup here that can look things up for you.
          </div>
        )}

        {loading && <div style={{ color: C.muted, fontSize: 13, padding: "18px 0", textAlign: "center" }}>Drafting…</div>}
        {error && (
          <div style={{ background: "rgba(248,113,113,0.08)", border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 12px", fontSize: 12, color: C.red, lineHeight: 1.5, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {!pickContacts && !loading && !error && echoWarnings && echoWarnings.length > 0 && (
          <div style={{ background: "rgba(245,185,66,0.08)", border: `1px solid ${C.amber}`, borderRadius: 10, padding: "10px 12px", marginBottom: 12, fontSize: 12, color: C.amber, lineHeight: 1.55 }}>
            ⚠ <strong>{echoWarnings.join(", ")}</strong> may say the same thing as your fixed offer or ask. Near-identical sentences were removed automatically; these are close
            enough to check but not to cut. Read the draft as a whole before sending.
          </div>
        )}
        {!pickContacts && !loading && !error && missing && missing.length > 0 && (
          <div style={{ background: "rgba(248,113,113,0.08)", border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 12px", marginBottom: 12, fontSize: 12, color: C.red, lineHeight: 1.55 }}>
            ⚠ The model didn&apos;t return: <strong>{missing.join(", ")}</strong>. What&apos;s below is only your fixed sections. Hit Redraft — if it keeps happening, raise the
            token limit in Settings or switch to a non-reasoning model.
          </div>
        )}
        {!pickContacts && !loading && !error && (
          <>
            <textarea
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              style={{ ...inputStyle, minHeight: 260, resize: "vertical", fontSize: 13, lineHeight: 1.6, fontFamily: sans }}
            />
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, margin: "6px 0 12px" }}>
              A draft, not a send. Check every factual claim about the company before it goes out — a wrong detail in the first line is worse than no first line.
            </div>
          </>
        )}

        {!pickContacts && (
        <div style={{ display: "flex", gap: 8 }}>
          <Btn ghost onClick={onClose} style={{ flex: 1 }}>
            Close
          </Btn>
          {!loading && (
            <Btn ghost onClick={onRegenerate} style={{ flex: 1 }}>
              ↻ Redraft
            </Btn>
          )}
          {!loading && !error && (
            <Btn
              onClick={() => {
                (navigator.clipboard?.writeText(edited) || Promise.reject()).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  },
                  () => {}
                );
              }}
              style={{ flex: 1 }}
            >
              {copied ? "✓ Copied" : "Copy"}
            </Btn>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function PoolAdd({ open, onAddApplication, onAddAccount, onPark }) {
  const [name, setName] = useState("");
  const park = () => {
    if (!name.trim()) return;
    onPark(name.trim());
    setName("");
  };
  if (!open)
    return (
      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
        <Label>Park on the bench</Label>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name" style={inputStyle} onKeyDown={(e) => e.key === "Enter" && park()} />
          <Btn color={C.amber} onClick={park} disabled={!name.trim()} style={{ flexShrink: 0 }}>
            Park
          </Btn>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
          Pool is closed this week, so this waits on the bench until discovery reopens — that's intended, not a rejection.
        </div>
      </div>
    );
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
      <Label>Add to pool</Label>
      <div style={{ display: "flex", gap: 8 }}>
        {[
          ["📋", "Application", "chasing one role", onAddApplication],
          ["🏢", "Account", "several contacts", onAddAccount],
        ].map(([icon, label, sub, fn]) => (
          <button
            key={label}
            onClick={fn}
            style={{
              flex: 1,
              textAlign: "left",
              fontFamily: sans,
              fontSize: 13,
              fontWeight: 700,
              padding: "11px 12px",
              borderRadius: 10,
              cursor: "pointer",
              border: `1px solid ${C.panelEdge}`,
              background: "transparent",
              color: C.ink,
            }}
          >
            {icon} {label}
            <div style={{ fontSize: 11, fontWeight: 400, color: C.muted, marginTop: 2 }}>{sub}</div>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>Opens the full form. Add the hook afterwards on the row — five minutes, not a dossier.</div>
    </div>
  );
}

/* one pool member. The hook is editable inline because writing it IS the
   discovery event — making that a modal trip would be friction on the exact
   action the whole cycle is built around. */
/* Renders one WORK ITEM — a person, not a company. An account with three
   contacts produces three of these rows, each with its own hook, so a hook
   written for Ana can't end up addressed to Ben. */
function PoolRow({ item, badge, onHook, onOpen, onRemove, onDraft, onCopy, polishing, onRepolish }) {
  const [draft, setDraft] = useState(item.hook || "");
  const dirty = draft !== (item.hook || "");
  const ref = item.ref;
  const save = () => ref && onHook(ref, draft);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span onClick={() => onOpen(item)} style={{ fontSize: 14, fontWeight: 700, cursor: "pointer", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ marginRight: 5, fontSize: 12 }} title={item.kind === "contact" ? "A contact inside an account" : item.kind === "account" ? "Account with no contacts yet" : "Tracked as an application"}>
            {item.kind === "application" ? "📋" : "🏢"}
          </span>
          {/* the PERSON leads, because the hook is about them — the company is
              context. On a company with no contacts yet it's the other way. */}
          {item.contactName ? (
            <>
              {item.contactName}
              <span style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>
                {item.contactPosition ? ` · ${item.contactPosition}` : ""} · {item.company}
              </span>
            </>
          ) : (
            <>
              {item.company || "Unnamed"}
              <span style={{ fontSize: 11, color: C.amber, fontWeight: 400 }}> · no contact yet</span>
            </>
          )}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {badge}
          {onRemove && (
            <button
              onClick={() => onRemove(item)}
              title="Remove from the pool"
              aria-label="Remove from the pool"
              style={{ background: "transparent", border: "none", color: C.muted, fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "0 2px" }}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 120))}
          placeholder='Hook — one line, "generic", or "generic person"' 
          style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
          onKeyDown={(e) => e.key === "Enter" && dirty && save()}
        />
        {dirty && (
          <Btn onClick={save} style={{ padding: "7px 11px", fontSize: 12, flexShrink: 0 }}>
            Save
          </Btn>
        )}
        {/* pull a saved first-contact template rather than generating one —
            cheaper, instant, and uses copy you've already graded */}
        {!dirty && onCopy && (
          <Btn
            ghost
            onClick={() => onCopy(item)}
            title="Copy your saved First contact template, filled in for this company"
            style={{ padding: "7px 10px", fontSize: 12, flexShrink: 0 }}
          >
            ⧉
          </Btn>
        )}
        {/* drafting only makes sense once there's a hook to open with */}
        {!dirty && onDraft && (item.hook || "").trim() && (
          <Btn
            ghost
            onClick={() => onDraft(item)}
            title={item.entry?.outreachDraft ? "View the saved draft" : "Draft an email from this hook"}
            style={{ padding: "7px 10px", fontSize: 12, flexShrink: 0, color: item.entry?.outreachDraft ? C.blue : C.muted, borderColor: item.entry?.outreachDraft ? C.blue : C.panelEdge }}
          >
            {item.entry?.outreachDraft ? "✍ Draft ✓" : "✍ Draft"}
          </Btn>
        )}
      </div>
      {/* the polished opening, shown so it can be checked and corrected — an
          AI sentence that goes straight to the clipboard unseen is exactly how
          a wrong claim reaches a stranger */}
      {item.hookPolished && item.hookPolishedFrom === (item.hook || "").trim() && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 6, background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 8, padding: "7px 9px" }}>
          <span style={{ fontFamily: mono, fontSize: 9, color: C.blue, flexShrink: 0, paddingTop: 2 }}>AI</span>
          <span style={{ fontSize: 12, color: C.ink, lineHeight: 1.45, flex: 1, minWidth: 0 }}>{item.hookPolished}</span>
          {onRepolish && (
            <button onClick={() => onRepolish(item)} title="Rewrite this opening line" style={{ background: "transparent", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: 0, flexShrink: 0 }}>
              ↻
            </button>
          )}
        </div>
      )}
      {polishing === item.key && <div style={{ fontSize: 11, color: C.blue, marginTop: 6 }}>Polishing the opening line…</div>}
      {item.researchedAt && <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 4 }}>researched {item.researchedAt}</div>}
    </div>
  );
}

function ContentBoard({ items, onOpen, onMove, onDropStage, isDesktop, openLink, onAddToStage }) {
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);

  return (
    <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8, justifyContent: isDesktop ? "center" : "flex-start" }}>
      {CONTENT_STATUSES.map((stage, colIdx) => {
        const colItems = items.filter((c) => (c.status || "idea") === stage);
        const isDragOver = isDesktop && dragOverStage === stage;
        return (
          <div
            key={stage}
            onDragOver={
              isDesktop
                ? (e) => {
                    e.preventDefault();
                    if (dragOverStage !== stage) setDragOverStage(stage);
                  }
                : undefined
            }
            onDragLeave={isDesktop ? () => setDragOverStage((s) => (s === stage ? null : s)) : undefined}
            onDrop={
              isDesktop
                ? (e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/plain");
                    if (id) onDropStage(id, stage);
                    setDragOverStage(null);
                    setDraggingId(null);
                  }
                : undefined
            }
            style={{
              flex: "0 0 240px",
              width: 240,
              background: C.panel,
              border: `1px solid ${isDragOver ? C.amber : C.panelEdge}`,
              borderRadius: 12,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              maxHeight: "70vh",
              transition: "border-color 0.1s",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexShrink: 0 }}>
              <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: contentStatusColor(stage), textTransform: "uppercase" }}>
                {contentStatusLabel(stage)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontFamily: mono, fontSize: 11, color: C.muted }}>{colItems.length}</div>
                <button
                  onClick={() => onAddToStage(stage)}
                  title={`Add content directly to ${contentStatusLabel(stage)}`}
                  style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, borderRadius: 6, color: C.muted, fontSize: 13, width: 22, height: 22, lineHeight: "20px", padding: 0, cursor: "pointer" }}
                >
                  +
                </button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
              {colItems.length === 0 && (
                <div style={{ fontSize: 11, color: isDragOver ? C.amber : C.muted, textAlign: "center", padding: "12px 0" }}>
                  {isDragOver ? "Drop here" : "Nothing here"}
                </div>
              )}
              {colItems.map((c) => (
                <div
                  key={c.id}
                  draggable={isDesktop}
                  onDragStart={
                    isDesktop
                      ? (e) => {
                          e.dataTransfer.setData("text/plain", c.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDraggingId(c.id);
                        }
                      : undefined
                  }
                  onDragEnd={isDesktop ? () => { setDraggingId(null); setDragOverStage(null); } : undefined}
                  style={{
                    background: C.bg,
                    /* overdue commitments read red — a ship-by date you set and
                       blew past is the strongest signal on this board */
                    border: `1px solid ${contentOverdue(c) ? C.red : C.panelEdge}`,
                    borderRadius: 10,
                    padding: 10,
                    cursor: isDesktop ? "grab" : "pointer",
                    opacity: draggingId === c.id ? 0.4 : 1,
                  }}
                  onClick={() => onOpen(c)}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1.4 }}>{c.title || "Untitled"}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{[c.type, (c.platforms || []).join(", ")].filter(Boolean).join(" · ") || "—"}</div>
                  {c.date && <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 4 }}>{c.date}</div>}
                  {c.shipBy && c.status !== "published" && (
                    <div style={{ fontFamily: mono, fontSize: 10, color: contentOverdue(c) ? C.red : C.muted, marginTop: 2 }}>
                      {contentOverdue(c) ? `⚠ ship-by ${c.shipBy} · ${daysSince(c.shipBy)}d late` : `ship by ${c.shipBy}`}
                    </div>
                  )}
                  {(c.link || c.assetsLink) && (
                    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 10, marginTop: 4 }}>
                      {c.link && openLink(c.link, { title: "Open published content" })}
                      {c.assetsLink && openLink(c.assetsLink, { title: "Open video/photo assets", icon: "📁" })}
                    </div>
                  )}
                  <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                    <button
                      onClick={() => onMove(c.id, -1)}
                      disabled={colIdx === 0}
                      title={colIdx === 0 ? "" : `Move back to ${contentStatusLabel(CONTENT_STATUSES[colIdx - 1])}`}
                      style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, borderRadius: 6, color: colIdx === 0 ? C.panelEdge : C.muted, fontSize: 11, padding: "3px 8px", cursor: colIdx === 0 ? "default" : "pointer" }}
                    >
                      ‹
                    </button>
                    <button
                      onClick={() => onMove(c.id, 1)}
                      disabled={colIdx === CONTENT_STATUSES.length - 1}
                      title={colIdx === CONTENT_STATUSES.length - 1 ? "" : `Move forward to ${contentStatusLabel(CONTENT_STATUSES[colIdx + 1])}`}
                      style={{ background: "transparent", border: `1px solid ${C.panelEdge}`, borderRadius: 6, color: colIdx === CONTENT_STATUSES.length - 1 ? C.panelEdge : C.muted, fontSize: 11, padding: "3px 8px", cursor: colIdx === CONTENT_STATUSES.length - 1 ? "default" : "pointer" }}
                    >
                      ›
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WinUpdateForm({ onCancel, onSave }) {
  const [sentiment, setSentiment] = useState(null);
  const [note, setNote] = useState("");
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: 10 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => setSentiment("negative")}
          style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: `1px solid ${sentiment === "negative" ? C.red : C.panelEdge}`, background: sentiment === "negative" ? "rgba(248,113,113,0.15)" : "transparent", color: sentiment === "negative" ? C.red : C.muted, fontSize: 11, cursor: "pointer" }}
        >
          😕 Went negative
        </button>
        <button
          onClick={() => setSentiment("positive")}
          style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: `1px solid ${sentiment === "positive" ? C.green : C.panelEdge}`, background: sentiment === "positive" ? "rgba(74,222,128,0.15)" : "transparent", color: sentiment === "positive" ? C.green : C.muted, fontSize: 11, cursor: "pointer" }}
        >
          🙂 Still positive
        </button>
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={sentiment === "negative" ? "e.g. rejected, or turned out to be a bad fit (optional)" : "add context (optional)"}
        style={{ ...inputStyle, fontSize: 12, marginBottom: 8 }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn ghost onClick={onCancel} style={{ flex: 1, padding: "6px 10px", fontSize: 11 }}>
          Cancel
        </Btn>
        <Btn onClick={() => sentiment && onSave(sentiment, note.trim())} disabled={!sentiment} style={{ flex: 1, padding: "6px 10px", fontSize: 11 }}>
          Save
        </Btn>
      </div>
    </div>
  );
}

function MissedContentModal({ onClose, stage, onContinue, onSkip }) {
  const [reason, setReason] = useState("");
  const picked = CONTENT_SKIP_REASONS.find((r) => r.key === reason);
  return (
    <div
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 400, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box", maxHeight: "85vh", overflowY: "auto" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 8 }}>📝 Missed yesterday's content task</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 14 }}>
          Yesterday's plan was to <strong style={{ color: C.ink }}>{CONTENT_STAGE_LABEL[stage]?.toLowerCase()}</strong> something. What got in the way? No wrong answers — this is
          how the app learns whether your schedule needs changing.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {CONTENT_SKIP_REASONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              style={{
                textAlign: "left",
                background: reason === r.key ? "rgba(245,185,66,0.1)" : "transparent",
                border: `1px solid ${reason === r.key ? C.amber : C.panelEdge}`,
                color: reason === r.key ? C.amber : C.muted,
                borderRadius: 10,
                padding: "9px 12px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {reason === r.key ? "◉" : "○"} {r.label}
            </button>
          ))}
        </div>
        {picked && <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, marginBottom: 14, fontStyle: "italic" }}>{picked.fix}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn ghost disabled={!reason} onClick={() => onSkip(reason)} style={{ flex: 1 }}>
            Let it go
          </Btn>
          <Btn disabled={!reason} onClick={() => onContinue(reason)} style={{ flex: 1 }}>
            Do it today
          </Btn>
        </div>
        {!reason && <div style={{ fontSize: 11, color: C.muted, marginTop: 8, textAlign: "center" }}>Pick a reason to continue</div>}
      </div>
    </div>
  );
}

function CsvBackupPromptModal({ onClose, count, onDownload }) {
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 380, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 8 }}>🧹 Archive backup ready</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 16 }}>
          {count} archived {count === 1 ? "entry" : "entries"} {count === 1 ? "is" : "are"} backed up in full. Worth downloading a copy for your own records — you can always do this later from Settings too.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn ghost onClick={onClose} style={{ flex: 1 }}>Not now</Btn>
          <Btn
            onClick={() => {
              onDownload();
              onClose();
            }}
            style={{ flex: 1 }}
          >
            ⬇ Download
          </Btn>
        </div>
      </div>
    </div>
  );
}

function MorningDigestModal({ onClose, dueCount, goalInfo, topPattern }) {
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 4 }}>☀️ Here's where things stand</div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 16 }}>Today, at a glance.</div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {dueCount > 0 && (
            <div style={{ background: C.bg, border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: C.ink }}>⚑ Follow-ups due</span>
              <span style={{ fontFamily: mono, fontSize: 16, fontWeight: 800, color: C.red }}>{dueCount}</span>
            </div>
          )}
          {goalInfo && (
            <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: C.ink }}>🎯 Today's target</span>
              <span style={{ fontFamily: mono, fontSize: 16, fontWeight: 800, color: goalInfo.actualToday >= goalInfo.todaysTarget ? C.green : C.amber }}>
                {goalInfo.actualToday}/{goalInfo.todaysTarget}
              </span>
            </div>
          )}
          {topPattern && (
            <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{topPattern.icon} {topPattern.title}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>{topPattern.detail}</div>
            </div>
          )}
          {dueCount === 0 && !goalInfo && !topPattern && (
            <div style={{ fontSize: 13, color: C.muted, textAlign: "center", padding: "10px 0" }}>Nothing urgent — a clean slate today.</div>
          )}
        </div>

        <Btn onClick={onClose} style={{ width: "100%", marginTop: 16 }}>Got it</Btn>
      </div>
    </div>
  );
}

function ParseJobPostModal({ onClose, onParsed, onParse }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const canParse = url.trim() || text.trim();

  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 6 }}>📋 Paste a job post</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
            Drop the job post link and it'll fetch and extract company, role, salary, and source into a draft you still review and save yourself. Nothing is created automatically.
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 16px", minHeight: 0 }}>
          <Label>Job post link</Label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            autoFocus
            style={{ ...inputStyle, marginBottom: 14 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 12px" }}>
            <div style={{ flex: 1, height: 1, background: C.panelEdge }} />
            <span style={{ fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>OR PASTE TEXT INSTEAD</span>
            <div style={{ flex: 1, height: 1, background: C.panelEdge }} />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="If the link can't be fetched (paywalled, login-gated, etc.), paste the raw text here"
            rows={8}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: sans, minHeight: 150 }}
          />
          {error && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{error}</div>}
        </div>
        <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.panelEdge}`, flexShrink: 0, display: "flex", gap: 10 }}>
          <Btn ghost onClick={onClose} style={{ flex: 1 }}>Cancel</Btn>
          <Btn
            onClick={async () => {
              if (!canParse || loading) return;
              setLoading(true);
              setError("");
              try {
                const parsed = await onParse({ url: url.trim(), text: text.trim() });
                onParsed(parsed);
              } catch (e) {
                setError(url.trim() ? "Couldn't fetch that link — try pasting the post's text instead." : "Couldn't parse that — check connection and retry, or open a blank draft and fill it in yourself.");
              }
              setLoading(false);
            }}
            disabled={loading || !canParse}
            style={{ flex: 1 }}
          >
            {loading ? "Parsing…" : "Parse & continue"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function HousekeepingModal({ onClose, proposals, onArchive, onArchiveAll, onSnooze }) {
  /* local set is only for hiding a row instantly after acting on it — the
     durable record is onSnooze, which persists and syncs */
  const [skipped, setSkipped] = useState(() => new Set());
  const visible = proposals.filter((p) => !skipped.has(p.type + (p.id || p.contactId)));
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 460, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 6 }}>🧹 CRM Housekeeping</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
            Nothing here changes your goal progress, funnel totals, or conversion % — archiving just tucks a stale entry out of your active view. It stays fully counted, and only
            gets stripped down to a bare record after another 30 untouched days. <strong style={{ color: C.ink }}>Keep</strong> hides an entry from this sweep for 30 days rather
            than only until you close this box.
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 20px 16px", minHeight: 0 }}>
          {visible.length === 0 && (
            <div style={{ color: C.muted, fontSize: 13, padding: "20px 0", textAlign: "center" }}>
              Nothing stale right now — everything's either recent or already archived.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visible.map((p) => {
              const key = p.type + (p.id || p.contactId);
              return (
                <div key={key} style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>{p.detail}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Btn
                      onClick={() => {
                        onArchive(p);
                        setSkipped((s) => new Set(s).add(key));
                      }}
                      style={{ padding: "6px 12px", fontSize: 11 }}
                    >
                      🗄 Archive
                    </Btn>
                    <Btn
                      ghost
                      onClick={() => {
                        onSnooze([key]);
                        setSkipped((s) => new Set(s).add(key));
                      }}
                      style={{ padding: "6px 12px", fontSize: 11 }}
                    >
                      Keep · 30d
                    </Btn>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.panelEdge}`, flexShrink: 0, display: "flex", gap: 10 }}>
          {visible.length > 0 && (
            <Btn
              ghost
              onClick={() => {
                /* no snooze needed — archiving removes them from the sweep
                   on its own, and a snooze would linger pointlessly */
                onArchiveAll(visible);
                setSkipped((s) => {
                  const next = new Set(s);
                  visible.forEach((p) => next.add(p.type + (p.id || p.contactId)));
                  return next;
                });
              }}
              style={{ flex: 1 }}
            >
              Archive all ({visible.length})
            </Btn>
          )}
          <Btn ghost onClick={onClose} style={{ flex: 1 }}>Close</Btn>
        </div>
      </div>
    </div>
  );
}

function SupportModal({ onClose, runSupport, onSaveSession }) {
  const [feeling, setFeeling] = useState("");
  const [intensity, setIntensity] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const savedRef = useRef(false);

  const FALLBACK = {
    deescalate:
      "Pause. Breathe in for 4, out for 6 — five times. The long exhale is what tells your nervous system the threat is not physical. This wave crests and passes within minutes if you don't re-feed it with new anxious thoughts. Let it crest.",
    reality:
      "Nothing about the numbers changed in the last hour. The runway is what it was this morning. The pipeline is what the tracker says — not what the fear says. Rejection at ~95% of cold applications is the statistical default for everyone, including excellent candidates. The feeling is real; its claim is testable — and the tracker is the test.",
    achievements:
      "Open your History tab right now and read three items out loud. Those are documented facts you produced — not opinions, not luck. A person with that list is demonstrably capable of executing this search.",
    forward:
      "The way out of this situation is the process you already built: every application, follow-up, and finished focus item compounds. You are not waiting for a better future — you are constructing it in trackable increments, on a runway measured in months, not days.",
    one_action:
      "Write down the feeling and the one claim it's making — one sentence each. That's the whole task for the next 10 minutes.",
  };

  const go = async () => {
    setBusy(true);
    setErr("");
    let r;
    try {
      const got = await runSupport(feeling, intensity);
      r = got && got.deescalate ? got : FALLBACK;
    } catch (e) {
      r = FALLBACK;
      setErr("Coach unreachable — showing the built-in protocol instead.");
    }
    setResult(r);
    /* the diary: every session is saved automatically */
    if (!savedRef.current) {
      savedRef.current = true;
      onSaveSession({ feeling, intensity, ...r });
    }
    setBusy(false);
  };

  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.82)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 460, maxHeight: "84vh", overflowY: "auto", background: C.panel, border: `1px solid ${C.blue}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>🛟 Emotional support</div>

        {!result && (
          <>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 14 }}>
              First we settle the feeling, then reality with evidence, your track record, the path forward — then one small step. Every session is saved to your diary in the Mind tab.
            </div>
            <Field label="What's happening / what are you feeling?" value={feeling} onChange={setFeeling} placeholder="e.g. Got a rejection and the old belief is back" />
            <Field label="Intensity 1–10" type="number" value={intensity} onChange={setIntensity} />
            {+intensity >= 8 && (
              <div style={{ fontSize: 12, color: C.amber, lineHeight: 1.5, marginBottom: 12 }}>
                Intensity 8+: before anything else — stand up, walk for a few minutes, long exhales. Come back when it's under 7. This window will wait.
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <Btn ghost onClick={onClose} style={{ flex: 1 }}>Close</Btn>
              <Btn onClick={go} disabled={busy || !feeling.trim()} color={C.blue} style={{ flex: 2 }}>
                {busy ? "…" : "Get support"}
              </Btn>
            </div>
          </>
        )}

        {result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
            {err && <div style={{ fontSize: 11, color: C.muted }}>{err}</div>}
            {SUPPORT_BLOCKS.map(
              ([k, label, col]) =>
                result[k] && (
                  <div key={k}>
                    <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: col, marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>{result[k]}</div>
                  </div>
                )
            )}
            <div style={{ background: C.bg, border: `1px solid ${C.green}`, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: C.green, marginBottom: 4 }}>5 · ONE THING TO REGULATE — NEXT 10 MINUTES</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, fontWeight: 700 }}>{result.one_action}</div>
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>✓ Saved to your support diary (Mind tab)</div>
            <Btn onClick={onClose} style={{ width: "100%" }}>Close</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- audio retention modal (centered) ---------- */
function AudioExpiryModal({ sessions, onDownload, onDelete, onClose }) {
  const [busyId, setBusyId] = useState(null);
  if (!sessions.length) {
    onClose();
    return null;
  }
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.82)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 55, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, maxHeight: "80vh", overflowY: "auto", background: C.panel, border: `1px solid ${C.amber}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>🎙 Audio retention — 12 months reached</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 14 }}>
          These voice recordings have reached their 12-month retention date. Choose for each: download a copy (then it's removed from the cloud) or delete it. Transcripts are always kept in your diary either way.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sessions.map((s) => (
            <div key={s.id} style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{s.feeling || "Voice session"}</div>
                <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, flexShrink: 0 }}>created {s.audioCreated}</div>
              </div>
              <audio controls src={audioPublicUrl(s.audioPath)} style={{ width: "100%", marginTop: 8 }} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Btn
                  onClick={async () => {
                    setBusyId(s.id);
                    await onDownload(s);
                    setBusyId(null);
                  }}
                  disabled={busyId === s.id}
                  color={C.green}
                  style={{ flex: 2, padding: "8px 10px", fontSize: 12 }}
                >
                  {busyId === s.id ? "…" : "⬇ Download & remove"}
                </Btn>
                <Btn
                  onClick={async () => {
                    setBusyId(s.id);
                    await onDelete(s);
                    setBusyId(null);
                  }}
                  disabled={busyId === s.id}
                  color={C.red}
                  style={{ flex: 1, padding: "8px 10px", fontSize: 12 }}
                >
                  Delete
                </Btn>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <Btn ghost onClick={onClose} style={{ width: "100%" }}>
            Decide later (will ask again next time)
          </Btn>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<FlightDeck />);
