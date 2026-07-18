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

const MODES = ["DASHBOARD", "GOAL", "PIPELINE", "CONTENT", "EMOTIONS", "RUNWAY", "HISTORY"];
const TITLES = {
  DASHBOARD: "Dashboard",
  GOAL: "Goal Planner",
  PIPELINE: "Pipeline (CRM)",
  CONTENT: "Content",
  EMOTIONS: "Mind",
  RUNWAY: "Runway Gauge",
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
  return d.toISOString().slice(0, 10);
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
const OUTREACH_CHANNELS = ["Email", "Call", "Text", "Other"];
/* "bad fit" reasons — multi-select, for companies that don't align on comp/values/etc */
const BAD_FIT_REASONS = ["Salary too low", "Values mismatch", "Culture concerns", "Red flags in process", "Scope creep", "Other"];

/* ---- account / contact relationship model ---- */
const CONTACT_STATUSES = ["", "outreach", "replied", "discovery call", "ongoing", "closed"];
const contactStatusLabel = (s) => (s ? s : "Not contacted yet");
const contactStatusColor = (s) =>
  s === "closed" ? C.muted : s === "ongoing" ? C.green : s === "discovery call" ? C.amber : s === "replied" || s === "outreach" ? C.blue : C.muted;
const isContactBlankStatus = (c) => !c.status;
const isContactOpen = (c) => c.status !== "closed";
const isContactOutreached = (c) => !!c.status; /* any status set means real contact has happened */
const isContactDue = (c) => {
  if (isContactBlankStatus(c)) return false;
  const n = nextFollowUp(c);
  return !!(n && isContactOpen(c) && n.date <= today());
};

const ACCOUNT_STATUSES = ["", "closed", "bad fit"];
const accountStatusLabel = (s) => (s === "closed" ? "closed" : s === "bad fit" ? "bad fit" : "active");
const accountStatusColor = (s) => (s === "closed" ? C.muted : s === "bad fit" ? C.red : C.green);
const isAccountOpen = (acc) => !acc.status;

/* ---- syncing account-contact outreach into the real pipeline ----
   Outreaching a contact is real outreach — it should count everywhere an
   application does (funnel, goals, conversion, donuts) without every one of
   those systems needing special-cased contact-awareness. So instead of
   merging counts in parallel, each outreached contact gets a real, linked
   entry in state.applications (source "Accounts", fromAccountContact: true),
   kept in sync as the contact's own status/tags/follow-ups change. */
const CONTACT_TO_APP_STATUS = { "": "", outreach: "outreach", replied: "replied", "discovery call": "screening", ongoing: "interview", closed: "rejected" };
const mapContactStatusToAppStatus = (contactStatus) => CONTACT_TO_APP_STATUS[contactStatus] ?? "";
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

    const payload = {
      company: accountCompany,
      website: accountWebsite,
      contact: c.name,
      email: c.email,
      contactPhone: c.phone,
      contactLinkedin: c.linkedin,
      source: "Accounts",
      status: mapContactStatusToAppStatus(c.status),
      contacted: c.contacted,
      outreachKind: c.outreachKind,
      followUps: c.followUps || [],
      touchpoints: c.touchpoints || [],
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

  return { contacts: updatedContacts, applications: apps };
}

/* ---- content management model ---- */
const CONTENT_STATUSES = ["idea", "draft", "design", "scheduled", "published"];
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
const reached = (a, stage) => {
  if ((a.milestonesLogged || []).includes(stage)) return true;
  return a.status !== "rejected" && a.status !== "bad fit" && (STAGE_IDX[a.status] ?? 0) >= STAGE_IDX[stage];
};
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
const relatedApplications = (accountCompany, apps) => {
  const key = normCompanyName(accountCompany);
  if (!key) return [];
  return apps.filter((a) => normCompanyName(a.company) === key);
};

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

/* Rollover: walks day 1 -> uptoDayIndex, carrying yesterday's shortfall/surplus
   into today. Overachieving reduces tomorrow's target (never below 0);
   falling short adds the remainder on top of tomorrow's base target. Only
   TODAY's number is exposed — future days aren't speculatively adjusted,
   since their actuals aren't known yet. */
function computeDailyRollout(goal, apps, fullQuota, uptoDayIndex) {
  const countsByDate = new Map();
  apps.forEach((a) => {
    if (a.contacted && isGoalActivity(a)) countsByDate.set(a.contacted, (countsByDate.get(a.contacted) || 0) + 1);
  });
  let carry = 0;
  let carryIntoToday = 0;
  let todaysEffective = fullQuota;
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
    carry = effective - actual; /* positive = shortfall carries forward; negative = surplus banked */
  }
  return { todaysTarget: todaysEffective, carryIntoToday };
}

/* pure: derive everything about a goal from the goal record + the pipeline */
function computeGoal(goal, apps) {
  if (!goal || !goal.target || !goal.days) return null;
  const preset = aggressivenessOf(goal);
  const fullQuota = Math.max(1, Math.ceil((goal.target / goal.days) * preset.quotaMultiplier));
  const deadline = addDays(goal.startDate, goal.days - 1);
  const t = today();
  const elapsedCalendarDays = Math.min(goal.days, Math.max(0, Math.floor((new Date(t) - new Date(goal.startDate)) / 86400000) + 1));

  /* expected-by-now = sum of each day's scheduled target so far (ramp-aware), skipping Sundays */
  let expectedByNow = 0;
  for (let i = 1; i <= elapsedCalendarDays; i++) {
    const d = new Date(goal.startDate + "T00:00:00");
    d.setDate(d.getDate() + (i - 1));
    if (d.getDay() === 0) continue;
    expectedByNow += dailyTargetForDay(goal, i, fullQuota);
  }

  const actualTotal = apps.filter((a) => a.contacted && a.contacted >= goal.startDate && isGoalActivity(a)).length;
  const actualByNow = apps.filter((a) => a.contacted && a.contacted >= goal.startDate && a.contacted <= t && isGoalActivity(a)).length;
  const actualToday = apps.filter((a) => a.contacted === t && isGoalActivity(a)).length;
  const daysRemaining = Math.max(0, goal.days - elapsedCalendarDays); /* calendar days, same unit as "over N days" */
  const pastDeadline = t > deadline;
  const rollout = computeDailyRollout(goal, apps, fullQuota, Math.max(1, elapsedCalendarDays));
  const rawTodaysTarget = rollout.todaysTarget;
  const carryIntoToday = rollout.carryIntoToday; /* >0 = shortfall carried in from yesterday, <0 = surplus banked, 0 = none */
  const stillRamping = goal.rampEnabled && elapsedCalendarDays < preset.rampDays;

  /* weekly breakdown, Mon-Sat buckets across the whole campaign span, ramp-aware.
     Same rollover principle as the daily target: a week that beats its target
     reduces the next week's number; a week that falls short adds the
     remainder on top of the next week's base target. Carry flows forward
     week-to-week in one pass, independent of (and in addition to) the daily
     carry above — they're complementary views of the same underlying data. */
  const weeksMap = new Map();
  let dayCounter = 0;
  for (let d = new Date(goal.startDate + "T00:00:00"); d <= new Date(deadline + "T00:00:00"); d.setDate(d.getDate() + 1)) {
    dayCounter++;
    if (d.getDay() === 0) continue;
    const wStart = iso(mondayOf(d));
    const label = weekLabel(mondayOf(d));
    if (!weeksMap.has(label)) weeksMap.set(label, { label, weekStart: wStart, workingDays: 0, baseTarget: 0 });
    const wk = weeksMap.get(label);
    wk.workingDays += 1;
    wk.baseTarget += dailyTargetForDay(goal, dayCounter, fullQuota);
  }
  let weekCarry = 0;
  const weeks = Array.from(weeksMap.values())
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((w) => {
      const actual = apps.filter((a) => a.contacted && a.contacted >= goal.startDate && weekStartOfDate(a.contacted) === w.weekStart && isGoalActivity(a)).length;
      const carryIn = weekCarry;
      const target = Math.max(0, w.baseTarget + carryIn);
      const weekEnd = addDays(w.weekStart, 5); /* Saturday — the week isn't "over" until this has passed */
      weekCarry = weekEnd < t ? target - actual : 0; /* only carry from weeks that have FULLY CONCLUDED; the current week is still changing, so it must not push a premature shortfall onto next week */
      return { ...w, target, actual, carryIn };
    });
  const thisWeekStart = iso(mondayOf(new Date(t + "T00:00:00")));
  const thisWeek = weeks.find((w) => w.weekStart === thisWeekStart) || null;

  /* reconcile daily with weekly: today's target should never ask for more
     than what's actually left to finish THIS week's own number — otherwise,
     on (or near) the last day of a week, the daily view can demand more than
     the weekly view says is even needed. Only kicks in when it would matter
     (daily target exceeds what's left this week); a normal mid-week target
     is untouched.
     Crucially, this must be based on the week's progress as of the START of
     today (excluding whatever's already been logged today) — otherwise the
     target would keep shrinking in real time as today's own applications get
     logged, chasing itself downward instead of staying fixed for the day. */
  const thisWeekActualBeforeToday = Math.max(0, (thisWeek?.actual ?? 0) - actualToday);
  const weeklyRemaining = thisWeek ? Math.max(0, thisWeek.target - thisWeekActualBeforeToday) : null;
  const todaysTarget = weeklyRemaining !== null ? Math.min(rawTodaysTarget, weeklyRemaining) : rawTodaysTarget;
  const todayMet = actualToday >= todaysTarget;

  return {
    fullQuota,
    todaysTarget,
    carryIntoToday,
    actualToday,
    todayMet,
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
  const totalApps = apps.filter((a) => !isBlankStatus(a) && !isOutreach(a)).length;
  const totalOutreach = apps.filter((a) => isOutreach(a)).length;
  const replies = apps.filter((a) => reached(a, "replied")).length;
  const screens = apps.filter((a) => reached(a, "screening")).length;
  const interviews = apps.filter((a) => reached(a, "interview")).length;
  const offers = apps.filter((a) => a.status === "offer" || (a.milestonesLogged || []).includes("offer")).length;
  const badFits = apps.filter((a) => isBadFit(a)).length;
  const highConfidence = apps.filter((a) => a.highConfidence).length;
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
      funnel: { applications: totalApps, outreach: totalOutreach, replies, screens, interviews, offers, conversionRatePct, badFitCount: badFits, highConfidenceCount: highConfidence },
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
const HOUSEKEEPING_STALE_DAYS = 30;
const HOUSEKEEPING_TOMBSTONE_DAYS = 30;
function computeHousekeepingProposals(state, apps) {
  const cutoff = addDays(today(), -HOUSEKEEPING_STALE_DAYS);
  const proposals = [];

  apps.forEach((a) => {
    if (a.archivedAt || a.tombstoned || a.fromAccountContact) return; /* synced entries are managed via their contact, not directly */
    if (!isOpenApp(a)) return; /* closed already — nothing to clean up */
    if (!a.contacted || a.contacted > cutoff) return;
    const days = Math.floor((new Date(today()) - new Date(a.contacted)) / 86400000);
    proposals.push({ type: "application", id: a.id, label: a.company || "Unnamed application", detail: `No activity in ${days} days (last: ${a.contacted}).` });
  });

  (state.accounts || []).forEach((acc) => {
    (acc.contacts || []).forEach((c) => {
      if (c.archivedAt || c.tombstoned) return;
      if (!isContactOpen(c) || !isContactOutreached(c)) return;
      if (!c.contacted || c.contacted > cutoff) return;
      const days = Math.floor((new Date(today()) - new Date(c.contacted)) / 86400000);
      proposals.push({ type: "contact", accountId: acc.id, contactId: c.id, label: `${c.name || "Unnamed"} @ ${acc.company || "Unnamed account"}`, detail: `No activity in ${days} days (last: ${c.contacted}).` });
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
const DEFAULT_FOLLOWUPS = [3, 7, 14]; /* days after the application date: day 3, day 7, day 14 */
const normFollowUps = (a) => {
  if (Array.isArray(a.followUps)) return a.followUps; /* respects both a populated AND a deliberately-cleared [] array */
  if (a.followUpDays != null) return [{ days: +a.followUpDays || 7, done: false }];
  return DEFAULT_FOLLOWUPS.map((d) => ({ days: d, done: false }));
};
/* next pending follow-up → {date, index, total} or null when all done / no contact date */
const nextFollowUp = (a) => {
  if (!a.contacted) return null;
  const fus = normFollowUps(a);
  const i = fus.findIndex((f) => !f.done);
  if (i === -1) return null;
  return { date: addDays(a.contacted, +fus[i].days || 0), index: i, total: fus.length };
};
const followUpOf = (a) => nextFollowUp(a)?.date || "";
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
  contentGoal: { perWeek: 3 },
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
  settings: { checkinDay: 1, timezoneOffset: 8 },
  lastCheckinMonth: null,
  lastDigestShownDate: null,
  archivedCsvRows: [],
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
  if (!s.contentGoal || typeof s.contentGoal !== "object") s.contentGoal = { perWeek: 3 };
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
  return {
    ...remoteS,
    applications: unionById(localS.applications, remoteS.applications),
    accounts: unionById(localS.accounts, remoteS.accounts),
    content: unionById(localS.content, remoteS.content),
    contentGoal: remoteS.contentGoal || localS.contentGoal || { perWeek: 3 },
    funnel: unionById(localS.funnel, remoteS.funnel),
    emotions: unionById(localS.emotions, remoteS.emotions),
    decisions: unionById(localS.decisions, remoteS.decisions),
    accomplishments: unionById(localS.accomplishments, remoteS.accomplishments),
    supportSessions: unionById(localS.supportSessions, remoteS.supportSessions),
    goal: remoteS.goal || localS.goal || null,
    cycleCount: Math.max(localS.cycleCount || 0, remoteS.cycleCount || 0),
    runway: remoteS.runway || localS.runway,
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
function Label({ children }) {
  return (
    <div style={{ fontFamily: sans, fontSize: 10, letterSpacing: "0.18em", color: C.muted, textTransform: "uppercase", marginBottom: 4 }}>
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
  const [weeklyModalOpen, setWeeklyModalOpen] = useState(false);
  const [patternsModalOpen, setPatternsModalOpen] = useState(false);
  const [housekeepingOpen, setHousekeepingOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [patternsNarrative, setPatternsNarrative] = useState("");
  const [patternsNarrativeLoading, setPatternsNarrativeLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState("local");
  const [crmView, setCrmView] = useState("applications"); /* toggle inside the CRM tab: applications <-> accounts */
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
  useEffect(() => setPipePage(0), [pipeFilter, pipeSearch, pipeSourceFilter, pipeStatusFilter]);
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
  const dueList = useMemo(() => apps.filter((a) => isDue(a) && !a.archivedAt), [apps]);
  const dueContactsCount = useMemo(
    () => (state.accounts || []).reduce((s, a) => s + (a.contacts || []).filter((c) => isContactDue(c) && !c.archivedAt).length, 0),
    [state.accounts]
  );
  const totalDueCount = dueList.length + dueContactsCount;
  const housekeepingProposals = useMemo(() => computeHousekeepingProposals(state, apps), [state.applications, state.accounts]);

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
    apps.forEach((a) => {
      if (isBlankStatus(a)) return; /* saved-for-later leads aren't funnel activity yet */
      const ws = weekStartOfDate(a.contacted);
      const label = ws ? weekLabel(new Date(ws + "T00:00:00")) : "No date set";
      const row = ensure(label, ws);
      /* an "outreach" status is a warm outreach, not yet an application */
      if (isOutreach(a)) row.d.outreach += 1;
      else row.d.apps += 1;
      if (reached(a, "replied")) row.d.replies += 1;
      if (reached(a, "screening")) row.d.screens += 1;
      if (reached(a, "interview")) row.d.interviews += 1;
      if (a.status === "offer" || (a.milestonesLogged || []).includes("offer")) row.d.offers += 1;
      if (isDue(a)) row.due += 1;
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
    const g = computeGoal(state.goal, apps);
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
          const gFinal = computeGoal(s.goal, s.applications);
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
      const g = computeGoal(state.goal, apps);
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
      return `Content: ${doneThisWeek}/${perWeek} this week, ${published} published total. Recent: ${recent}. Content is nurturing/staying visible to your network — NOT a job-search conversion tactic. Never frame it as "this will get you interviews"; the goal is consistency and genuine presence, full stop.`;
    })();
    const now = new Date(today() + "T00:00:00");
    return [
      `Today: ${now.toDateString()}.`,
      `Runway: ${months.toFixed(1)} months (zone: ${zone.name}). Fund P${state.runway.fund}, expenses P${state.runway.expenses}/mo.`,
      `Funnel totals (derived live from pipeline): apps ${totals.apps}, outreach ${totals.outreach}, replies ${totals.replies}, screens ${totals.screens}, interviews ${totals.interviews}, offers ${totals.offers}.`,
      `Outreach split (tags kept even after status advances): warm ${apps.filter((a) => a.outreachKind === "warm").length}, cold ${apps.filter((a) => a.outreachKind === "cold").length}, still-untagged-in-outreach ${apps.filter((a) => isOutreach(a) && !a.outreachKind).length}. Warm converts 4-10x better than cold.`,
      `Pipeline by status: ${byStatus}.`,
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
    const g = state.goal ? computeGoal(state.goal, apps) : null;
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
  const resolveMissedContent = (choice) => {
    if (!missedContentPrompt) return;
    const { date, stage } = missedContentPrompt;
    mutate((s) => {
      const log = { ...s.contentScheduleLog, [date]: { ...s.contentScheduleLog[date], resolved: true } };
      if (choice === "continue") {
        const t = today();
        log[t] = { stage, done: false, missed: false };
      }
      return { ...s, contentScheduleLog: log };
    });
    setMissedContentPrompt(null);
  };

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
    mutate(
      (s) => {
        let addWins = [];
        const applications = s.applications.map((a) => {
          if (a.id !== id) return a;
          const wasBlank = !a.status;
          const m = computeMilestoneWins(a, status);
          if (m) addWins = m.wins;
          return {
            ...a,
            status,
            contacted: wasBlank && status && !a.contacted ? today() : a.contacted,
            milestonesLogged: m ? m.milestonesLogged : a.milestonesLogged,
          };
        });
        if (addWins.length) winMsg = addWins.map((w) => w.text).join(" · ");
        return { ...s, applications, accomplishments: addWins.length ? [...addWins, ...s.accomplishments] : s.accomplishments };
      },
      "Status updated — funnel recalculated"
    );
    if (winMsg) setTimeout(() => flash(winMsg), 400); /* surface the win after the status toast */
  };

  /* excel-style inline cell commit */
  const updateAppField = (id, field, value) =>
    mutate((s) => ({ ...s, applications: s.applications.map((a) => (a.id === id ? { ...a, [field]: value } : a)) }));
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
  const openLinkedAccount = (app) => {
    const acc = state.accounts.find((a) => normCompanyName(a.company) === normCompanyName(app.company));
    if (!acc) return;
    setMode(2);
    setCrmView("accounts");
    setModal({ kind: "account", entry: acc });
  };

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
        return { ...s, applications: s.applications.filter((x) => x.id !== id), accounts };
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
        };
      }, `Deleted ${label}`);
    }
    setConfirmDelete(null);
  };

  const saveModal = (data) => {
    const { kind, entry } = modal;
    if (kind === "application") {
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
              return { ...a, ...data, milestonesLogged: m ? m.milestonesLogged : a.milestonesLogged };
            });
          } else {
            /* brand-new entry created directly at an advanced status (rare, but possible) */
            const m = computeMilestoneWins({ status: "", milestonesLogged: [] }, data.status);
            if (m) addWins = m.wins;
            applications = [{ id: uid(), ...data, milestonesLogged: m ? m.milestonesLogged : undefined }, ...s.applications];
          }
          if (addWins.length) winMsg = addWins.map((w) => w.text).join(" · ");
          return { ...s, applications, accomplishments: addWins.length ? [...addWins, ...s.accomplishments] : s.accomplishments };
        },
        entry ? "Application updated" : "Application added — funnel updated"
      );
      if (winMsg) setTimeout(() => flash(winMsg), 400);
    } else if (kind === "account") {
      let winMsg = "";
      mutate((s) => {
        const oldContacts = entry?.contacts || [];
        const oldAppsById = new Map(s.applications.map((a) => [a.id, a]));
        const { contacts: newContacts, applications: syncedApps } = syncContactsToApplications(data.company, data.website, oldContacts, data.contacts || [], s.applications);

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

        const accounts = entry
          ? s.accounts.map((acc) => (acc.id === entry.id ? { ...acc, ...data, contacts: newContacts } : acc))
          : [{ id: uid(), ...data, contacts: newContacts }, ...s.accounts];

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
          applications: finalApps,
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

  const renderDashboard = () => {
    const g = computeGoal(state.goal, apps);
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
      ) : state.goal && g ? (
        <div
          onClick={() => setMode(1)}
          style={{ background: C.panel, border: `1px solid ${g.todayMet ? C.green : C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14, cursor: "pointer" }}
        >
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
          <div key={k} style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, letterSpacing: "0.16em", color: C.muted }}>{k}</div>
            <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: col }}>{v}</div>
          </div>
        ))}
      </div>

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
              ? APP_STATUSES.map((s) => ({ label: statusLabel(s), value: apps.filter((a) => (a.status ?? "") === s).length, color: statusDonutColor(s) }))
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
      {dueList.length > 0 && (
        <div style={{ background: "rgba(248,113,113,0.07)", border: `1px solid ${C.red}`, borderRadius: 14, padding: "12px 16px", marginBottom: 14 }}>
          <Label>⚑ Follow-ups due — clear these first</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {dueList.slice(0, 6).map((a) => (
              <div key={a.id} onClick={() => setModal({ kind: "application", entry: a })} style={{ display: "flex", justifyContent: "space-between", gap: 8, cursor: "pointer", fontSize: 13 }}>
                <span style={{ fontWeight: 700 }}>{a.company || "Unnamed"}</span>
                <span style={{ fontFamily: mono, fontSize: 11, color: C.red, flexShrink: 0 }}>due {followUpOf(a)}</span>
              </div>
            ))}
            {dueList.length > 6 && <div style={{ fontSize: 11, color: C.muted }}>+ {dueList.length - 6} more in the Pipeline</div>}
          </div>
        </div>
      )}

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
      { key: "due", label: `⚑ Due (${dueList.length})` },
      { key: "badFit", label: `🚫 Bad fit (${apps.filter((a) => isBadFit(a) && !a.archivedAt).length})` },
      { key: "closed", label: `Closed (${apps.filter((a) => !isOpenApp(a) && !a.archivedAt).length})` },
      { key: "all", label: `All (${apps.filter((a) => !a.archivedAt).length})` },
      { key: "archived", label: `🗄 Archived (${apps.filter((a) => !!a.archivedAt).length})` },
    ];
    const shown = apps
      .filter((a) => (pipeFilter === "archived" ? !!a.archivedAt : !a.archivedAt))
      .filter((a) =>
        pipeFilter === "due"
          ? isDue(a)
          : pipeFilter === "blank"
          ? isBlankStatus(a)
          : pipeFilter === "active"
          ? isOpenApp(a)
          : pipeFilter === "closed"
          ? !isOpenApp(a)
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
      .sort((a, b) => (b.contacted || "").localeCompare(a.contacted || ""));
    const shownPage = shown.slice(pipePage * PAGE_SIZE, (pipePage + 1) * PAGE_SIZE);

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

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              ["applications", `📋 Applications (${realApplicationsCount})`],
              ["accounts", `🏢 Accounts (${(state.accounts || []).length})`],
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => setModal({ kind: "application", entry: null })}>+ Track application</Btn>
            <Btn ghost onClick={() => setModal({ kind: "parseJobPost", entry: null })}>🔗 Add from job post link</Btn>
            <Btn
              ghost
              onClick={() => {
                setModal({ kind: "account", entry: null });
              }}
            >
              + Track account
            </Btn>
            <button
              onClick={() => setHousekeepingOpen(true)}
              title="CRM Housekeeping"
              style={{
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
          </div>
        </div>

        {crmView === "accounts" ? (
          renderAccounts()
        ) : (
          <>
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

        {isDesktop ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {filters.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setPipeFilter(f.key)}
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
              🔍 {filters.find((f) => f.key === pipeFilter)?.label || "Filter"}
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
                  return (
                    <tr key={a.id} style={{ background: due ? "rgba(248,113,113,0.06)" : a.highConfidence ? "rgba(245,185,66,0.05)" : "transparent" }}>
                      <td style={{ ...td, textAlign: "center", position: "sticky", left: 0, zIndex: 2, background: C.panel }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => updateAppField(a.id, "highConfidence", !a.highConfidence)}
                          title={a.highConfidence ? "High confidence — click to unmark" : "Mark as high confidence"}
                          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 16, color: a.highConfidence ? C.amber : C.panelEdge, padding: 0 }}
                        >
                          {a.highConfidence ? "⭐" : "☆"}
                        </button>
                      </td>
                      <td style={{ ...td, borderLeft: due ? `3px solid ${C.red}` : "3px solid transparent", minWidth: 170, position: "sticky", left: 34, zIndex: 2, background: C.panel, boxShadow: `2px 0 0 ${C.panelEdge}` }}>
                        {cellInput(a, "company", { ph: "Company" })}
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(a, "website", { ph: "website.com" })}
                          {a.website && openLink(a.website, { title: "Open website" })}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 130 }}>{cellInput(a, "role", { ph: "Role applied for" })}</td>
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
        {shown.length > 0 && isDesktop && <Pagination page={pipePage} setPage={setPipePage} total={shown.length} />}

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
                  return (
                    <tr key={a.id} onClick={() => setModal({ kind: "application", entry: a })} style={{ cursor: "pointer", background: due ? "rgba(248,113,113,0.06)" : "transparent" }}>
                      <td style={{ ...td, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => updateAppField(a.id, "highConfidence", !a.highConfidence)}
                          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 15, color: a.highConfidence ? C.amber : C.panelEdge, padding: 0 }}
                        >
                          {a.highConfidence ? "⭐" : "☆"}
                        </button>
                      </td>
                      <td style={{ ...td, fontWeight: 700, borderLeft: due ? `3px solid ${C.red}` : "3px solid transparent", minWidth: 150 }}>
                        {a.company || "Unnamed"}
                        {a.role && <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{a.role}</div>}
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
        {shown.length > 0 && !isDesktop && <Pagination page={pipePage} setPage={setPipePage} total={shown.length} />}
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
      .sort((a, b) => (a.company || "").localeCompare(b.company || ""));
    const shownAccountsPage = shownAccounts.slice(accPage * PAGE_SIZE, (accPage + 1) * PAGE_SIZE);

    const rowsDesktop = shownAccounts.length > 0 && isDesktop;
    const rowsMobile = shownAccounts.length > 0 && !isDesktop;
    const isContactFilterView = accFilter === "outreachedContacts" || accFilter === "dueContacts";

    /* flat contact list for the Outreached/Due filters — shows people, not company rows */
    const flatContacts = isContactFilterView
      ? accounts
          .flatMap((acc) => (acc.contacts || []).filter((c) => !c.archivedAt).map((c) => ({ ...c, _company: acc.company || "Unnamed", _accountId: acc.id })))
          .filter((c) => (accFilter === "outreachedContacts" ? isContactOutreached(c) : isContactDue(c)))
          .filter((c) => {
            if (!accSearch.trim()) return true;
            const q = accSearch.trim().toLowerCase();
            return [c.name, c.email, c.position, c._company, c.linkedin].filter(Boolean).some((f) => f.toLowerCase().includes(q));
          })
          .sort((a, b) => a._company.localeCompare(b._company))
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
                {accFilter === "outreachedContacts" ? "No contacts outreached yet." : "No contacts due for follow-up."}
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
              ? "No accounts tracked yet. Use + Track account to build a company-level relationship record — multiple contacts, one place."
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
                          {contacts.length} contact{contacts.length === 1 ? "" : "s"}
                          {anyDue && <span style={{ color: C.red, marginLeft: 6 }}>⚑ due</span>}
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
                      <td style={{ ...td, minWidth: 150 }}>
                        {related.length === 0 ? (
                          <span style={{ color: C.muted, fontSize: 12 }}>—</span>
                        ) : (
                          <div style={{ fontSize: 12 }}>
                            <span style={{ color: C.blue, fontWeight: 700 }}>{related.length} linked</span>
                            <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                              {related
                                .slice(0, 3)
                                .map((r) => statusLabel(r.status))
                                .join(", ")}
                              {related.length > 3 ? "…" : ""}
                            </div>
                          </div>
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
                      {contacts.length} contact{contacts.length === 1 ? "" : "s"}{anyDue ? " ⚑" : ""}
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
                    {related.length > 0 && <span style={{ fontSize: 11, color: C.blue }}>{related.length} related app{related.length === 1 ? "" : "s"}</span>}
                  </div>
                </SwipeRow>
              );
            })}
          </div>
        )}
        {rowsMobile && <Pagination page={accPage} setPage={setAccPage} total={shownAccounts.length} />}

        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          {isDesktop ? "Click any cell to edit · click Contacts to manage the full contact list." : "Tap a row to manage contacts and details."} Related applications link automatically by company name.
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
      <div style={{ fontSize: 11, color: C.muted, margin: "-6px 0 12px" }}>
        Fully automatic from the Pipeline — set an entry's status to "outreach" to count it there instead of Apps.
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
    const g = computeGoal(state.goal, apps);
    return (
      <>
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
                  <div key={w.label} style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{w.label}</div>
                      <div style={{ fontFamily: mono, fontSize: 11, color: wOnPace ? C.green : C.amber }}>
                        {w.actual} / {w.target}
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

  const renderRunway = () => (
    <>
      <div
        onClick={() => setModal({ kind: "runway", entry: { fund: state.runway.fund, expenses: state.runway.expenses } })}
        style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14, cursor: "pointer" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Label>Runway remaining ({isDesktop ? "click" : "tap"} to update numbers)</Label>
          <div style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>
            ₱{Number(state.runway.fund).toLocaleString()} ÷ ₱{Number(state.runway.expenses).toLocaleString()}
          </div>
        </div>
        <div style={{ fontFamily: mono, fontSize: 44, fontWeight: 800, color: zone.color, lineHeight: 1.1 }}>
          {months.toFixed(1)}
          <span style={{ fontSize: 16, color: C.muted, marginLeft: 8 }}>months</span>
        </div>
        <div style={{ height: 10, background: C.bg, borderRadius: 5, marginTop: 12, overflow: "hidden", border: `1px solid ${C.panelEdge}` }}>
          <div style={{ height: "100%", width: `${Math.min((months / 24) * 100, 100)}%`, background: zone.color, borderRadius: 5, transition: "width 0.4s ease" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          {["0", "3", "6", "12", "24 mo"].map((t) => (
            <span key={t} style={{ fontFamily: mono, fontSize: 9, color: C.muted }}>{t}</span>
          ))}
        </div>
        <div style={{ marginTop: 12, fontFamily: mono, fontSize: 11, letterSpacing: "0.14em", color: zone.color }}>▮ {zone.name}</div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>{zone.note}</div>
      </div>

      <div
        onClick={() => setModal({ kind: "checkinDay", entry: { day: checkinDay, timezoneOffset: state.settings?.timezoneOffset, contentSchedule: state.contentSchedule } })}
        style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 14px", marginBottom: 14, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div style={{ fontSize: 13, color: C.muted }}>Settings: check-in day & follow-up defaults</div>
        <div style={{ fontFamily: mono, fontSize: 14, color: C.amber, fontWeight: 700 }}>
          Day {checkinDay}{state.lastCheckinMonth === thisMonth() ? " · ✓ done this month" : checkinDue ? " · ⚠ due" : ""}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <Label>{isDesktop ? "Written decisions — click to edit, × to delete" : "Written decisions — tap to edit, swipe left to delete"}</Label>
        <Btn onClick={() => setModal({ kind: "decision", entry: null })}>+ Log decision</Btn>
      </div>

      {state.decisions.length === 0 && (
        <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
          No decisions logged. The floor only moves on a written, dated decision — never on a mood.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {state.decisions.map((d) => (
          <SwipeRow
            key={d.id}
            showX={isDesktop}
            onTap={() => setModal({ kind: "decision", entry: d })}
            onDelete={() => mutate((s) => ({ ...s, decisions: s.decisions.filter((x) => x.id !== d.id) }), "Decision deleted")}
          >
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{d.note}</div>
            <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{d.date}</div>
          </SwipeRow>
        ))}
      </div>
    </>
  );

  const SECTIONS = { DASHBOARD: renderDashboard, GOAL: renderGoal, PIPELINE: renderPipeline, CONTENT: renderContent, EMOTIONS: renderEmotions, RUNWAY: renderRunway, HISTORY: renderHistory };

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
            {[
              ["⌂", "Home", 0],
              ["🎯", "Goal", 1],
              ["▦", "CRM", 2, totalDueCount],
              ["📝", "Content", 3],
              ["♡", "Mind", 4],
              ["⛽", "Fuel", 5],
              ["★", "Wins", 6],
            ].map(([icon, label, i, badge]) => (
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
                <span style={{ fontSize: 15 }}>{icon}</span>
                {label}
                {badge > 0 && (
                  <span style={{ minWidth: 16, height: 16, borderRadius: 8, background: C.red, color: "#2b0b0b", fontFamily: mono, fontSize: 9, fontWeight: 800, lineHeight: "16px", padding: "0 4px" }}>
                    {badge}
                  </span>
                )}
              </button>
            ))}
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
        <div style={{ display: "flex", justifyContent: "center", gap: 16, alignItems: "center", marginTop: 16, paddingBottom: isDesktop ? 0 : 74 }}>
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
          {[
            ["⌂", "Home", 0],
            ["🎯", "Goal", 1],
            ["▦", "CRM", 2, totalDueCount],
            ["📝", "Content", 3],
            ["♡", "Mind", 4],
            ["⛽", "Fuel", 5],
            ["★", "Wins", 6],
          ].map(([icon, label, i, badge]) => (
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
              <div style={{ fontSize: 17, lineHeight: 1 }}>{icon}</div>
              <div style={{ fontFamily: sans, fontSize: 9, letterSpacing: "0.06em", marginTop: 3, fontWeight: mode === i ? 800 : 600 }}>{label}</div>
              {badge > 0 && (
                <div style={{ position: "absolute", top: 4, left: "50%", marginLeft: 8, minWidth: 15, height: 15, borderRadius: 8, background: C.red, color: "#2b0b0b", fontFamily: mono, fontSize: 9, fontWeight: 800, lineHeight: "15px", padding: "0 3px" }}>
                  {badge}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: `calc(env(safe-area-inset-bottom, 0px) + ${isDesktop ? 24 : 84}px)`, left: "50%", transform: "translateX(-50%)", background: C.panelEdge, color: C.ink, fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 20, zIndex: 60 }}>
          {toast}
        </div>
      )}

      {modal && modal.kind !== "parseJobPost" && (
        <Modal
          key={modal.kind + "-" + (modal.entry?.id || "new")}
          modal={{ ...modal, followUpDefaults: state.settings?.followUpDefaults, syncKey: syncKeyRef.current, archivedCsvCount: state.archivedCsvRows.length }}
          onClose={() => setModal(null)}
          onSave={saveModal}
          totals={totals}
          apps={apps}
          onDownloadCsv={() => {
            triggerCsvDownload(state.archivedCsvRows, `flight-deck-archive-${today()}.csv`);
            mutate((s) => ({ ...s, lastCsvPromptDate: today() }));
          }}
          onDeleteCsvRows={() => mutate((s) => ({ ...s, archivedCsvRows: [] }), "Archive backup cleared")}
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
        />
      )}
      {digestOpen && (
        <MorningDigestModal
          onClose={dismissDigest}
          dueCount={totalDueCount}
          goalInfo={state.goal ? computeGoal(state.goal, apps) : null}
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
          onClose={() => resolveMissedContent("skip")}
          stage={missedContentPrompt.stage}
          onContinue={() => resolveMissedContent("continue")}
          onSkip={() => resolveMissedContent("skip")}
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
function Modal({ modal, onClose, onSave, totals, apps, onDownloadCsv, onDeleteCsvRows }) {
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
        postShot: entry?.postShot || "",
        screenshotLink: entry?.screenshotLink || "",
        salary: entry?.salary || pre.salary || "",
        contact: entry?.contact || "",
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
    if (kind === "account")
      return {
        company: entry?.company || "",
        website: entry?.website || "",
        industry: entry?.industry || "",
        headcount: entry?.headcount || "",
        status: entry?.status || "",
        highConfidence: entry?.highConfidence || false,
        badReasons: entry?.badReasons ? [...entry.badReasons] : [],
        notes: entry?.notes || "",
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
              linkedApplicationId: c.linkedApplicationId || null,
            }))
          : [{ id: uid(), name: "", position: "", email: "", phone: "", linkedin: "", notes: "", status: "", outreachKind: "", contacted: "", followUps: [], touchpoints: [], linkedApplicationId: null }],
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
        hook: entry?.hook || "",
        outline: entry?.outline || "",
        draft: entry?.draft || "",
        notes: entry?.notes || "",
      };
    return { fund: entry?.fund ?? "", expenses: entry?.expenses ?? "" };
  });
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const [shotBusy, setShotBusy] = useState(false);
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
  };

  const save = () => {
    if (kind === "application") {
      onSave({
        ...f,
        followUps: (f.followUps || []).map((x) => ({ days: Math.max(0, +x.days || 0), done: !!x.done })),
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
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: ["application", "account"].includes(kind) ? 620 : kind === "content" ? 760 : 420, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 14 }}>{titles[kind]}</div>
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
            <Field label="Date contacted / applied" type="date" value={f.contacted} onChange={set("contacted")} />

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
              const d = f.contacted ? addDays(f.contacted, +fu.days || 0) : "";
              const due = d && !fu.done && d <= today();
              return (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, width: 78, flexShrink: 0 }}>Follow-up {i + 1}</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={fu.days}
                    onChange={(e) =>
                      setF((p) => ({ ...p, followUps: p.followUps.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)) }))
                    }
                    style={{ ...inputStyle, width: 72, fontFamily: mono, flexShrink: 0, padding: "8px 10px" }}
                  />
                  <div style={{ fontFamily: mono, fontSize: 11, color: fu.done ? C.green : due ? C.red : C.muted, flex: 1, overflow: "hidden", whiteSpace: "nowrap" }}>
                    {d || "—"}
                    {fu.done ? " ✓" : due ? " ⚑ DUE" : ""}
                  </div>
                  <button
                    onClick={() =>
                      setF((p) => ({ ...p, followUps: p.followUps.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) }))
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

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
                    <select
                      value={c.status}
                      onChange={(e) => setContact({ status: e.target.value })}
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
                          onClick={() => setContact({ outreachKind: c.outreachKind === k ? "" : k })}
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
                      <span style={{ fontSize: 10, color: C.muted }}>Follow-ups:</span>
                      {fus.map((fu, fi) => {
                        const due = c.contacted ? addDays(c.contacted, fu.days) : "";
                        return (
                          <button
                            key={fi}
                            onClick={() => setContact({ followUps: fus.map((x, xi) => (xi === fi ? { ...x, done: !x.done } : x)) })}
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
                        <div key={r.id} style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
                          <span style={{ fontWeight: 700 }}>{r.role || "Role not set"}</span>
                          <span style={{ color: statusColor(r.status), marginLeft: 8, fontFamily: mono, fontSize: 11 }}>{statusLabel(r.status)}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Linked automatically by matching company name.</div>
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
            <Field label="Date" type="date" value={f.date} onChange={set("date")} />

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
              <Btn ghost onClick={onClose} style={{ flex: 1 }}>Cancel</Btn>
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
                    border: `1px solid ${C.panelEdge}`,
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
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 8 }}>📝 Missed yesterday's content task</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, marginBottom: 16 }}>
          Yesterday's plan was to <strong style={{ color: C.ink }}>{CONTENT_STAGE_LABEL[stage]?.toLowerCase()}</strong> something, but it wasn't checked off. Carry it into today, or let it go and stick with today's regular plan?
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn ghost onClick={onSkip} style={{ flex: 1 }}>Skip it</Btn>
          <Btn onClick={onContinue} style={{ flex: 1 }}>Continue today</Btn>
        </div>
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

function HousekeepingModal({ onClose, proposals, onArchive, onArchiveAll }) {
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
            Nothing here changes your goal progress, funnel totals, or conversion % — archiving just tucks a stale entry out of your active view. It stays fully counted, and only gets stripped down to a bare record after another 30 untouched days.
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
                    <Btn ghost onClick={() => setSkipped((s) => new Set(s).add(key))} style={{ padding: "6px 12px", fontSize: 11 }}>
                      Skip
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
