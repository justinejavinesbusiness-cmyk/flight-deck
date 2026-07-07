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

const MODES = ["DASHBOARD", "GOAL", "PIPELINE", "EMOTIONS", "RUNWAY", "HISTORY"];
const TITLES = {
  DASHBOARD: "Dashboard",
  GOAL: "Goal Planner",
  PIPELINE: "Pipeline (CRM)",
  EMOTIONS: "Mind",
  RUNWAY: "Runway Gauge",
  HISTORY: "Accomplishments",
};
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

/* ---- week + follow-up helpers ---- */
const mondayOf = (d) => {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};
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
const OUTREACH_CHANNELS = ["Email", "Call", "Text", "Other"];
/* "bad fit" reasons — multi-select, for companies that don't align on comp/values/etc */
const BAD_FIT_REASONS = ["Salary too low", "Values mismatch", "Culture concerns", "Red flags in process", "Scope creep", "Other"];
const STAGE_IDX = { "": -2, outreach: -1, applied: 0, "followed up": 1, replied: 2, screening: 3, interview: 4, "final round": 5, offer: 6, "bad fit": -3, rejected: -3 };
const statusLabel = (s) => (s ? s : "Not applied yet");
const isOutreach = (a) => a.status === "outreach";
const isBlankStatus = (a) => !a.status;
const isBadFit = (a) => a.status === "bad fit";
const isOpenApp = (a) => !["offer", "rejected", "bad fit"].includes(a.status);
const reached = (a, stage) => a.status !== "rejected" && a.status !== "bad fit" && (STAGE_IDX[a.status] ?? 0) >= STAGE_IDX[stage];
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
  }));
  return { milestonesLogged: [...already, ...newlyReached], wins };
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
  const todaysTarget = rollout.todaysTarget;
  const carryIntoToday = rollout.carryIntoToday; /* >0 = shortfall carried in from yesterday, <0 = surplus banked, 0 = none */
  const todayMet = actualToday >= todaysTarget;
  const stillRamping = goal.rampEnabled && elapsedCalendarDays < preset.rampDays;

  /* weekly breakdown, Mon-Sat buckets across the whole campaign span, ramp-aware */
  const weeksMap = new Map();
  let dayCounter = 0;
  for (let d = new Date(goal.startDate + "T00:00:00"); d <= new Date(deadline + "T00:00:00"); d.setDate(d.getDate() + 1)) {
    dayCounter++;
    if (d.getDay() === 0) continue;
    const wStart = iso(mondayOf(d));
    const label = weekLabel(mondayOf(d));
    if (!weeksMap.has(label)) weeksMap.set(label, { label, weekStart: wStart, workingDays: 0, target: 0 });
    const wk = weeksMap.get(label);
    wk.workingDays += 1;
    wk.target += dailyTargetForDay(goal, dayCounter, fullQuota);
  }
  const weeks = Array.from(weeksMap.values())
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((w) => ({
      ...w,
      actual: apps.filter((a) => a.contacted && a.contacted >= goal.startDate && weekStartOfDate(a.contacted) === w.weekStart && isGoalActivity(a)).length,
    }));

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
    onPace: actualByNow >= expectedByNow,
    pctComplete: Math.min(100, Math.round((actualTotal / goal.target) * 100)),
    weeks,
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
  const offers = apps.filter((a) => a.status === "offer").length;
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


/* multi-step follow-ups: a.followUps = [{days, done}] counted from `contacted` */
const DEFAULT_FOLLOWUPS = [3, 7, 14];
const normFollowUps = (a) => {
  if (Array.isArray(a.followUps) && a.followUps.length) return a.followUps;
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
  (arr || []).map((f) => (typeof f === "string" ? { text: f, key: false } : { text: f?.text || "", key: !!f?.key }));

/* Day rollover: archive done items, carry over unfinished ones.
   Returns { coach, archived, shouldGenerate }. Pure function. */
function rolloverCoach(c, todayStr) {
  const t = todayStr || today();
  if (!c || !c.daily || !c.dailyDate) return { coach: { ...(c || {}), daily: null, dailyDate: null, dailyDone: [] }, archived: [], shouldGenerate: true };
  if (c.dailyDate === t) return { coach: c, archived: [], shouldGenerate: false };
  const items = normFocus(c.daily.focus);
  const doneIdx = new Set(c.dailyDone || []);
  const archived = items
    .filter((_, i) => doneIdx.has(i))
    .map((it) => ({ id: uid(), date: c.dailyDate, text: it.text, category: it.key ? "Key focus" : "Daily focus" }));
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

const DEFAULT_STATE = {
  applications: [],
  accounts: [],
  funnel: [],
  emotions: [],
  decisions: [],
  accomplishments: [],
  supportSessions: [],
  goal: null,
  cycleCount: 0,
  runway: { fund: 1200000, expenses: 50000 },
  settings: { checkinDay: 1 },
  lastCheckinMonth: null,
};
const DEFAULT_COACH = { dailyDate: null, daily: null, dailyDone: [], weeklyDate: null, weekly: null };

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/* migrate older saved shapes into v3 */
function migrate(saved) {
  const s = { ...DEFAULT_STATE, ...saved };
  if (!Array.isArray(s.applications)) s.applications = [];
  if (!Array.isArray(s.accounts)) s.accounts = [];
  if (!Array.isArray(s.accomplishments)) s.accomplishments = [];
  if (!Array.isArray(s.supportSessions)) s.supportSessions = [];
  if (!s.settings || typeof s.settings !== "object") s.settings = { checkinDay: 1 };
  if (!s.settings.checkinDay) s.settings.checkinDay = 1;
  if (!Array.isArray(s.settings.followUpDefaults) || !s.settings.followUpDefaults.length)
    s.settings.followUpDefaults = [...DEFAULT_FOLLOWUPS];
  s.accounts = s.accounts.map((a) => ({ ...a, contacts: Array.isArray(a.contacts) ? a.contacts : [] }));
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
  return s;
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
      setDx(-400);
      setTimeout(onDelete, 160);
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
        style={{ ...inputStyle, fontFamily: type === "number" ? mono : sans }}
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
const DONUT_COLORS = ["#F5B942", "#7DB0F7", "#4ADE80", "#F87171", "#C084FC", "#34D399", "#FB923C", "#7A8699"];
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
                stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
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
                <span style={{ width: 10, height: 10, borderRadius: 5, background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }} />
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
  const [weeklyModalOpen, setWeeklyModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState("local");
  const [crmView, setCrmView] = useState("applications"); /* toggle inside the CRM tab: applications <-> accounts */
  const [pipeFilter, setPipeFilter] = useState("active");
  const [pipeSearch, setPipeSearch] = useState("");
  const [accSearch, setAccSearch] = useState("");
  const [pipeSourceFilter, setPipeSourceFilter] = useState("");
  const [pipeStatusFilter, setPipeStatusFilter] = useState("");
  const [donutMode, setDonutMode] = useState("status");
  const [historyGroup, setHistoryGroup] = useState("date");
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

      const { coach: rolled, archived, shouldGenerate } = rolloverCoach(mergedCoach);
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
  const dueList = useMemo(() => apps.filter(isDue), [apps]);

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
      if (a.status === "offer") row.d.offers += 1;
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

  /* watch goal progress: celebrate every 5% milestone (targets > 250), and
     snapshot the whole cycle once the goal is fully achieved — regardless of
     whether it ended in a job or not. Runs quietly in the background. */
  useEffect(() => {
    if (!state.goal) return;
    const g = computeGoal(state.goal, apps);
    if (!g) return;
    const already = state.goal.milestonesCelebrated || [];
    let newMilestones = already;
    const newWins = [];

    if (state.goal.target > 250) {
      const currentPct = Math.min(100, Math.floor(g.pctComplete / 5) * 5);
      const toAward = [];
      for (let m = 5; m <= currentPct; m += 5) {
        if (!already.includes(m)) toAward.push(m);
      }
      if (toAward.length) {
        newMilestones = [...already, ...toAward];
        toAward.forEach((m) => {
          const msg = MILESTONE_MESSAGES[Math.floor(Math.random() * MILESTONE_MESSAGES.length)];
          newWins.push({
            id: uid(),
            date: today(),
            category: "Milestone",
            text: `🎉 ${m}% of your goal complete (${Math.round((state.goal.target * m) / 100)}/${state.goal.target})! ${msg}`,
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
      if (shouldSnapshotCycle) flash("🏁 Goal complete — Cycle snapshot saved to Wins");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.applications, state.goal]);

  /* monthly runway check-in */
  const checkinDay = +state.settings?.checkinDay || 1;
  const checkinDue = new Date().getDate() >= checkinDay && state.lastCheckinMonth !== thisMonth();

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
      .slice(0, 10)
      .map((a) => `${a.date}: ${a.text}${a.category ? ` [${a.category}]` : ""}`);
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
      return `Active goal: ${state.goal.target} applications+outreach combined (each counts as 1) over ${state.goal.days} days, deadline ${g.deadline}, aggressiveness ${g.aggressiveness.label}, full daily quota ${g.fullQuota}.${rampNote}${carryNote} Today's actual target (after rollover): ${g.todaysTarget}, done so far today: ${g.actualToday}. Progress: ${g.actualTotal}/${state.goal.target} (${g.pctComplete}%) — ${g.pastDeadline ? "deadline passed" : g.onPace ? "on pace" : `behind, expected ${g.expectedByNow} by now`}.`;
    })();
    const sessions = (state.supportSessions || [])
      .slice(0, 6)
      .map((s) => `${s.date} "${s.feeling || "?"}" intensity ${s.intensity || "?"}/10`);
    const now = new Date();
    return [
      `Today: ${now.toDateString()}.`,
      `Runway: ${months.toFixed(1)} months (zone: ${zone.name}). Fund P${state.runway.fund}, expenses P${state.runway.expenses}/mo.`,
      `Funnel totals (derived live from pipeline): apps ${totals.apps}, outreach ${totals.outreach}, replies ${totals.replies}, screens ${totals.screens}, interviews ${totals.interviews}, offers ${totals.offers}.`,
      `Outreach split (tags kept even after status advances): warm ${apps.filter((a) => a.outreachKind === "warm").length}, cold ${apps.filter((a) => a.outreachKind === "cold").length}, still-untagged-in-outreach ${apps.filter((a) => isOutreach(a) && !a.outreachKind).length}. Warm converts 4-10x better than cold.`,
      `Pipeline by status: ${byStatus}.`,
      `Follow-ups DUE today or overdue: ${dueList.length}${dueList.length ? " — " + dueList.slice(0, 6).map((a) => `${a.company || "unnamed"} (contacted ${a.contacted}, status ${a.status})`).join("; ") : ""}.`,
      goalLine,
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

  const runDaily = async () => {
    setCoachLoading("daily");
    setCoachError("");
    try {
      const daily = await callClaude(
        "Give today's focus: a MAXIMUM of 3 things to do TODAY (specific and finishable today; due follow-ups by company name usually come first, then volume/quality work sized to where the funnel leaks, then any unfinished emotion-log action). ORDER the items from HIGHEST to LOWEST impact on landing the job — item 1 must be the single highest-leverage action right now. Set key=true on item 1 only. This order matters: as items get completed, the app will highlight whichever remaining item is next in this priority order, so order them exactly by true impact, not by convenience or sequence. Also give one sentence on why based on the numbers, one thing to watch (or empty string), and one grounding reminder in evidence-file style.",
        `{"focus": [{"text": "...", "key": false}, {"text": "...", "key": true}], "why": "...", "watch": "...", "reminder": "..."}`
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
        "Run the Friday weekly review: a one-line verdict (on-track / off-track and why), funnel diagnosis (which stage leaks most vs benchmarks and the fix), pipeline hygiene (stale applications, follow-up discipline, status mix), emotional pattern analysis from the protocol log, acknowledgment of accomplishments, 2-4 priorities for next week, and a floor check (does P95K hold given runway - it should unless runway is critically low).",
        `{"verdict": "...", "funnel": "...", "pipeline": "...", "emotions": "...", "next_week": ["..."], "floor": "..."}`
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
      mutate(
        (s) => ({
          ...s,
          accounts: entry
            ? s.accounts.map((a) => (a.id === entry.id ? { ...a, ...data } : a))
            : [{ id: uid(), ...data }, ...s.accounts],
        }),
        entry ? "Account updated" : "Account tracked"
      );
      if (!entry) setCrmView("accounts"); /* land on the Accounts table after creating one */
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
          const { coach: rolled, archived } = rolloverCoach(mergeCoach(coach, { ...DEFAULT_COACH, ...remote.coach }));
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
    return (
    <>
      {/* today's goal — featured front and center, not buried in the Goal tab */}
      {state.goal && g ? (
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

      {/* today's focus & weekly review — popup modules, right below Today's Goal */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <button
          onClick={() => setFocusModalOpen(true)}
          style={{ flex: 1, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "14px 12px", cursor: "pointer", textAlign: "left" }}
        >
          <div style={{ fontSize: 20, marginBottom: 4 }}>📋</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Today's Focus</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {coach.daily ? `${focusItems.filter((_, i) => (coach.dailyDone || []).includes(i)).length}/${focusItems.length} done` : "Tap to generate"}
          </div>
        </button>
        <button
          onClick={() => setWeeklyModalOpen(true)}
          style={{ flex: 1, background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "14px 12px", cursor: "pointer", textAlign: "left" }}
        >
          <div style={{ fontSize: 20, marginBottom: 4 }}>📊</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Weekly Review</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {coach.weeklyDate ? `Last run ${coach.weeklyDate}` : "Run every Friday"}
          </div>
        </button>
      </div>

      {/* instrument strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        {[
          ["ACTIVE", apps.filter(isOpenApp).length, C.ink],
          ["DUE ⚑", dueList.length, dueList.length ? C.red : C.ink],
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
              ? APP_STATUSES.map((s) => ({ label: statusLabel(s), value: apps.filter((a) => (a.status ?? "") === s).length }))
              : donutMode === "source"
              ? (() => {
                  const buckets = new Map();
                  const bump = (label) => buckets.set(label, (buckets.get(label) || 0) + 1);
                  apps.forEach((a) => {
                    if (a.source === "Job board") {
                      bump(a.jobBoardName ? a.jobBoardName : "Job board (unspecified)");
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
            Warm/cold tags are kept even after status moves on (e.g. to applied). "Untagged" is only entries still sitting in outreach status. Warm converts 4–10x better than cold.
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
                  const isMilestone = Object.values(MILESTONE_LABEL).includes(a.category);
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
                          <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{a.date} · auto-detected forward progress</div>
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
      { key: "active", label: `Active (${apps.filter(isOpenApp).length})` },
      { key: "highConfidence", label: `⭐ High confidence (${apps.filter((a) => a.highConfidence).length})` },
      { key: "blank", label: `◻ Saved for later (${apps.filter(isBlankStatus).length})` },
      { key: "due", label: `⚑ Due (${dueList.length})` },
      { key: "badFit", label: `🚫 Bad fit (${apps.filter(isBadFit).length})` },
      { key: "closed", label: `Closed (${apps.filter((a) => !isOpenApp(a)).length})` },
      { key: "all", label: `All (${apps.length})` },
    ];
    const shown = apps
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
        return [a.company, a.contact, a.email, a.notes, a.jobBoardName, a.website, a.role]
          .filter(Boolean)
          .some((f) => f.toLowerCase().includes(q));
      })
      .slice()
      .sort((a, b) => (b.contacted || "").localeCompare(a.contacted || ""));

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              ["applications", "📋 Applications"],
              ["accounts", "🏢 Accounts"],
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
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={() => setModal({ kind: "application", entry: null })}>+ Track application</Btn>
            <Btn
              ghost
              onClick={() => {
                setModal({ kind: "account", entry: null });
              }}
            >
              + Track account
            </Btn>
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

        {shown.length === 0 && (
          <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
            {apps.length === 0
              ? "No applications tracked yet. Every company you add here updates the funnel numbers automatically."
              : "Nothing matches this search/filter."}
          </div>
        )}

        {shown.length > 0 && isDesktop && (
          <div
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
                  <th style={{ ...th, width: 34 }}>⭐</th>
                  <th style={th}>Company / Website</th>
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
                {shown.map((a) => {
                  const nf = nextFollowUp(a);
                  const due = isDue(a);
                  const fus = normFollowUps(a);
                  const doneCount = fus.filter((x) => x.done).length;
                  return (
                    <tr key={a.id} style={{ background: due ? "rgba(248,113,113,0.06)" : a.highConfidence ? "rgba(245,185,66,0.05)" : "transparent" }}>
                      <td style={{ ...td, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => updateAppField(a.id, "highConfidence", !a.highConfidence)}
                          title={a.highConfidence ? "High confidence — click to unmark" : "Mark as high confidence"}
                          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 16, color: a.highConfidence ? C.amber : C.panelEdge, padding: 0 }}
                        >
                          {a.highConfidence ? "⭐" : "☆"}
                        </button>
                      </td>
                      <td style={{ ...td, borderLeft: due ? `3px solid ${C.red}` : "3px solid transparent", minWidth: 170 }}>
                        {cellInput(a, "company", { ph: "Company" })}
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(a, "website", { ph: "website.com" })}
                          {a.website && openLink(a.website, { title: "Open website" })}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 130 }}>{cellInput(a, "role", { ph: "Role applied for" })}</td>
                      <td style={{ ...td, minWidth: 130 }} onClick={(e) => e.stopPropagation()}>
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
                              if (e.target.value !== (a.jobBoardName || "")) updateAppField(a.id, "jobBoardName", e.target.value);
                            }}
                            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            style={{ width: "100%", boxSizing: "border-box", fontSize: 12, fontFamily: mono, color: C.blue, background: "transparent", border: "1px solid transparent", borderRadius: 6, padding: "3px 4px", outline: "none", marginTop: 2 }}
                            onFocus={(e) => (e.target.style.border = `1px solid ${C.blue}`)}
                          />
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 110 }}>{cellInput(a, "contact", { ph: "Name" })}</td>
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
                        style={{ ...td, fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", color: due ? C.red : nf ? C.muted : C.green, cursor: "pointer" }}
                        onClick={() => setModal({ kind: "application", entry: a })}
                        title="Click to edit the follow-up schedule"
                      >
                        {nf ? `${nf.date} (${doneCount}/${fus.length})${due ? " ⚑" : ""}` : fus.length ? `all done (${fus.length})` : "—"}
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>{cellInput(a, "notes", { ph: "notes…" })}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => mutate((s) => ({ ...s, applications: s.applications.filter((x) => x.id !== a.id) }), "Application deleted")}
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
                {shown.map((a) => {
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
                      <td style={td}>
                        <span style={{ fontSize: 12, color: a.source ? C.ink : C.muted }}>{a.source || "—"}</span>
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
                        {nf ? `${nf.date} (${doneCount}/${fus.length})${due ? " ⚑" : ""}` : fus.length ? `all done (${fus.length})` : "—"}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => mutate((s) => ({ ...s, applications: s.applications.filter((x) => x.id !== a.id) }), "Application deleted")}
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
    const shownAccounts = accounts
      .filter((acc) => {
        if (!accSearch.trim()) return true;
        const q = accSearch.trim().toLowerCase();
        const contactMatch = (acc.contacts || []).some((c) => [c.name, c.email, c.position].filter(Boolean).some((f) => f.toLowerCase().includes(q)));
        return [acc.company, acc.website, acc.industry, acc.notes].filter(Boolean).some((f) => f.toLowerCase().includes(q)) || contactMatch;
      })
      .slice()
      .sort((a, b) => (a.company || "").localeCompare(b.company || ""));

    const rowsDesktop = shownAccounts.length > 0 && isDesktop;
    const rowsMobile = shownAccounts.length > 0 && !isDesktop;

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

        {shownAccounts.length === 0 && (
          <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
            {accounts.length === 0
              ? "No accounts tracked yet. Use + Track account to build a company-level relationship record — multiple contacts, one place."
              : "Nothing matches this search."}
          </div>
        )}

        {rowsDesktop && (
          <div style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1000 }}>
              <thead>
                <tr>
                  <th style={th}>Company / Website</th>
                  <th style={th}>Industry</th>
                  <th style={th}>Contacts</th>
                  <th style={th}>Related applications</th>
                  <th style={th}>Notes</th>
                  <th style={{ ...th, width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {shownAccounts.map((acc) => {
                  const contacts = acc.contacts || [];
                  const primary = contacts[0];
                  const related = relatedApplications(acc.company, apps);
                  return (
                    <tr key={acc.id}>
                      <td style={{ ...td, minWidth: 180 }}>
                        {cellInput(acc, "company", { ph: "Company", onCommit: updateAccountField })}
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cellInput(acc, "website", { ph: "website.com", onCommit: updateAccountField })}
                          {acc.website && openLink(acc.website, { title: "Open website" })}
                        </div>
                      </td>
                      <td style={{ ...td, minWidth: 120 }}>{cellInput(acc, "industry", { ph: "Industry", onCommit: updateAccountField })}</td>
                      <td style={{ ...td, minWidth: 160, cursor: "pointer" }} onClick={() => setModal({ kind: "account", entry: acc })}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: contacts.length ? C.ink : C.muted }}>
                          {contacts.length} contact{contacts.length === 1 ? "" : "s"}
                        </div>
                        {primary && (
                          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                            {primary.name || "Unnamed"}{primary.position ? ` · ${primary.position}` : ""}
                          </div>
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
                          onClick={() => mutate((s) => ({ ...s, accounts: s.accounts.filter((x) => x.id !== acc.id) }), "Account deleted")}
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

        {rowsMobile && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {shownAccounts.map((acc) => {
              const contacts = acc.contacts || [];
              const primary = contacts[0];
              const related = relatedApplications(acc.company, apps);
              return (
                <SwipeRow
                  key={acc.id}
                  showX={false}
                  onTap={() => setModal({ kind: "account", entry: acc })}
                  onDelete={() => mutate((s) => ({ ...s, accounts: s.accounts.filter((x) => x.id !== acc.id) }), "Account deleted")}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{acc.company || "Unnamed"}</div>
                    <div style={{ fontFamily: mono, fontSize: 11, color: C.muted, flexShrink: 0 }}>
                      {contacts.length} contact{contacts.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  {acc.industry && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{acc.industry}</div>}
                  {primary && (
                    <div style={{ fontSize: 12, color: C.ink, marginTop: 4 }}>
                      {primary.name || "Unnamed"}{primary.position ? ` · ${primary.position}` : ""}
                    </div>
                  )}
                  {related.length > 0 && (
                    <div style={{ fontSize: 11, color: C.blue, marginTop: 4 }}>{related.length} related application{related.length === 1 ? "" : "s"}</div>
                  )}
                </SwipeRow>
              );
            })}
          </div>
        )}

        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          {isDesktop ? "Click any cell to edit · click Contacts to manage the full contact list." : "Tap a row to manage contacts and details."} Related applications link automatically by company name.
        </div>
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

      {/* conversion: application/outreach -> closed deal */}
      {(() => {
        const topOfFunnel = totals.apps + totals.outreach;
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
              {totals.offers} offer{totals.offers === 1 ? "" : "s"} from {topOfFunnel} total sent
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
                  {g.pastDeadline ? "DEADLINE PASSED" : g.onPace ? "● ON PACE" : `○ BEHIND (expected ${g.expectedByNow})`}
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
              onDelete={() => mutate((st) => ({ ...st, supportSessions: st.supportSessions.filter((y) => y.id !== s.id) }), "Session deleted")}
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
        onClick={() => setModal({ kind: "checkinDay", entry: { day: checkinDay } })}
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

  const SECTIONS = { DASHBOARD: renderDashboard, GOAL: renderGoal, PIPELINE: renderPipeline, EMOTIONS: renderEmotions, RUNWAY: renderRunway, HISTORY: renderHistory };

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
        html, body { margin: 0; padding: 0; background: ${C.bg}; overflow-x: hidden; }
        button { -webkit-tap-highlight-color: transparent; }
        @media (hover: hover) {
          button:hover { filter: brightness(1.12); }
          tbody tr:hover { background: rgba(125,176,247,0.05) !important; }
        }
      `}</style>

      <div style={{ width: "100%", maxWidth: isDesktop ? (MODES[mode] === "PIPELINE" ? 1800 : 900) : 560, margin: "0 auto", flex: 1, display: "flex", flexDirection: "column", transition: "max-width 0.2s ease" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.3em", color: C.amber }}>FLIGHT DECK</div>
            <div style={{ fontSize: isDesktop ? 24 : 20, fontWeight: 800, letterSpacing: "-0.01em", marginTop: 2 }}>
              {TITLES[MODES[mode]]}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn ghost onClick={() => setModal({ kind: "checkinDay", entry: { day: checkinDay } })} title="Settings" style={{ padding: "10px 12px" }}>
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
              ["▦", "CRM", 2, dueList.length],
              ["♡", "Mind", 3],
              ["⛽", "Fuel", 4],
              ["★", "Wins", 5],
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
            ["▦", "CRM", 2, dueList.length],
            ["♡", "Mind", 3],
            ["⛽", "Fuel", 4],
            ["★", "Wins", 5],
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

      {modal && (
        <Modal
          key={modal.kind + "-" + (modal.entry?.id || "new")}
          modal={{ ...modal, followUpDefaults: state.settings?.followUpDefaults, syncKey: syncKeyRef.current }}
          onClose={() => setModal(null)}
          onSave={saveModal}
          totals={totals}
          apps={apps}
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
    </div>
  );
}
/* ---------- edit modal (centered) ---------- */
function Modal({ modal, onClose, onSave, totals, apps }) {
  const { kind, entry } = modal;
  const [f, setF] = useState(() => {
    if (kind === "application")
      return {
        company: entry?.company || "",
        role: entry?.role || "",
        website: entry?.website || "",
        source: entry?.source || "",
        jobBoardName: entry?.jobBoardName || "",
        postLink: entry?.postLink || "",
        postShot: entry?.postShot || "",
        screenshotLink: entry?.screenshotLink || "",
        salary: entry?.salary || "",
        contact: entry?.contact || "",
        email: entry?.email || "",
        contacted: entry?.contacted || "",
        followUps: entry
          ? normFollowUps(entry).map((f) => ({ ...f }))
          : (modal.followUpDefaults || DEFAULT_FOLLOWUPS).map((d) => ({ days: d, done: false })),
        status: entry ? entry.status || "applied" : "",
        outreachKind: entry?.outreachKind || "",
        outreachChannel: entry?.outreachChannel || "",
        badReasons: entry?.badReasons ? [...entry.badReasons] : [],
        highConfidence: entry?.highConfidence || false,
        notes: entry?.notes || "",
        custom: entry?.custom ? entry.custom.map((c) => ({ ...c })) : [],
      };
    if (kind === "decision") return { note: entry?.note || "" };
    if (kind === "session") return {};
    if (kind === "accomplishment")
      return { text: entry?.text || "", date: entry?.date || today(), category: entry?.category || "Daily focus" };
    if (kind === "checkinDay")
      return { day: entry?.day ?? 1, followUpDefaults: (modal.followUpDefaults || DEFAULT_FOLLOWUPS).map(String) };
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
        notes: entry?.notes || "",
        contacts: entry?.contacts ? entry.contacts.map((c) => ({ ...c })) : [{ id: uid(), name: "", position: "", email: "", phone: "", notes: "" }],
      };
    return { fund: entry?.fund ?? "", expenses: entry?.expenses ?? "" };
  });
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const [shotBusy, setShotBusy] = useState(false);
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
        contacts: (f.contacts || []).filter((c) => c.name || c.position || c.email || c.phone || c.notes),
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
        style={{ width: "100%", maxWidth: 420, maxHeight: "80vh", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
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
                    onClick={() => set("postShot")("")}
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Contact person" value={f.contact} onChange={set("contact")} placeholder="e.g. Jane Cruz" />
              <Field label="Email" value={f.email} onChange={set("email")} placeholder="jane@acme.com" />
            </div>
            <Field label="Date contacted / applied" type="date" value={f.contacted} onChange={set("contacted")} />

            <Label>Follow-up schedule (days after contact)</Label>
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
            <Field label="Company name" value={f.company} onChange={set("company")} placeholder="e.g. Acme SaaS Inc." />
            <Field label="Website" value={f.website} onChange={set("website")} placeholder="https://acme.com" />
            <Field label="Industry" value={f.industry} onChange={set("industry")} placeholder="e.g. Fintech, SaaS" />

            <Label>Contacts</Label>
            {(f.contacts || []).map((c, i) => (
              <div key={c.id || i} style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <input
                    value={c.name}
                    placeholder="Contact name"
                    onChange={(e) => setF((p) => ({ ...p, contacts: p.contacts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))}
                    style={{ ...inputStyle, flex: 1 }}
                  />
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
                    onChange={(e) => setF((p) => ({ ...p, contacts: p.contacts.map((x, j) => (j === i ? { ...x, position: e.target.value } : x)) }))}
                    style={inputStyle}
                  />
                  <input
                    value={c.phone}
                    placeholder="Phone number"
                    onChange={(e) => setF((p) => ({ ...p, contacts: p.contacts.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)) }))}
                    style={inputStyle}
                  />
                </div>
                <input
                  value={c.email}
                  placeholder="Email"
                  onChange={(e) => setF((p) => ({ ...p, contacts: p.contacts.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) }))}
                  style={{ ...inputStyle, marginBottom: 6 }}
                />
                <input
                  value={c.notes}
                  placeholder="Notes (optional)"
                  onChange={(e) => setF((p) => ({ ...p, contacts: p.contacts.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)) }))}
                  style={inputStyle}
                />
              </div>
            ))}
            <button
              onClick={() => setF((p) => ({ ...p, contacts: [...(p.contacts || []), { id: uid(), name: "", position: "", email: "", phone: "", notes: "" }] }))}
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
              📋 Today's Focus — {new Date().toDateString()}
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
