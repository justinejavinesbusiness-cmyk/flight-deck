import { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";

/* ============================================================
   FLIGHT DECK — Job Search Operating System (deployed build)
   - Mobile: swipe left/right switches modes, swipe an entry LEFT deletes
   - Desktop (>=1024px): full dashboard grid, hover x deletes
   - Persistence: Supabase (keyed by a private sync code) + local cache
   - Coach: Claude Sonnet via /api/coach Netlify function
   ============================================================ */

const SUPA_URL = "https://ywzvhloswottkasvhzfv.supabase.co";
const SUPA_KEY = "sb_publishable_YyQQvJHwJh3B0c6ZJCcuhQ__gCrN_ld";

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

const MODES = ["BRIEFING", "FUNNEL", "EMOTIONS", "RUNWAY"];
const TITLES = {
  BRIEFING: "Daily Briefing",
  FUNNEL: "Funnel Tracker",
  EMOTIONS: "Emotion Protocol",
  RUNWAY: "Runway Gauge",
};
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);

/* ---- week + follow-up helpers ---- */
const mondayOf = (d) => {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; /* Mon=0 … Sun=6 */
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};
const fmtShort = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const weekLabel = (mon) => {
  const sat = new Date(mon);
  sat.setDate(sat.getDate() + 5); /* Monday → Saturday */
  return `${fmtShort(mon)} – ${fmtShort(sat)}`;
};
const weekOptions = () => {
  const cur = mondayOf(new Date());
  const out = [];
  for (let i = 1; i >= -11; i--) {
    const m = new Date(cur);
    m.setDate(m.getDate() + i * 7);
    out.push(weekLabel(m));
  }
  return out;
};
const addDays = (iso, n) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return "";
  d.setDate(d.getDate() + (+n || 0));
  return d.toISOString().slice(0, 10);
};
const APP_STATUSES = ["applied", "followed up", "replied", "screening", "interview", "final round", "offer", "rejected"];
const statusColor = (s) =>
  s === "offer" ? "#4ADE80" : s === "rejected" ? "#7A8699" : ["interview", "final round"].includes(s) ? "#F5B942" : ["replied", "screening"].includes(s) ? "#7DB0F7" : "#E8EDF5";
const isOpenApp = (a) => !["offer", "rejected"].includes(a.status);
const dueApps = (w) =>
  (w.applications || []).filter(
    (a) => a.contacted && isOpenApp(a) && addDays(a.contacted, a.followUpDays ?? 7) <= today()
  );
const newSyncKey = () =>
  "fd_" +
  (crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "")
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(""));

const DEFAULT_STATE = {
  funnel: [],
  emotions: [],
  decisions: [],
  runway: { fund: 1200000, expenses: 50000 },
};
const DEFAULT_COACH = {
  dailyDate: null,
  daily: null,
  dailyDone: [],
  weeklyDate: null,
  weekly: null,
};

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const sans =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/* ---------- supabase rpc ---------- */
async function rpc(fn, args) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
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
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: C.red,
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingRight: 18,
          color: "#2b0b0b",
          fontFamily: sans,
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: "0.08em",
        }}
      >
        DELETE
      </div>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={() => {
          if (!moved.current && onTap) onTap();
        }}
        style={{
          transform: `translateX(${dx}px)`,
          transition: start.current ? "none" : "transform 0.18s ease-out",
          background: C.panel,
          border: `1px solid ${C.panelEdge}`,
          borderRadius: 12,
          padding: "12px 14px",
          paddingRight: showX ? 38 : 14,
          position: "relative",
          touchAction: "pan-y",
          cursor: "pointer",
        }}
      >
        {showX && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete entry"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 24,
              height: 24,
              borderRadius: 12,
              border: `1px solid ${C.panelEdge}`,
              background: "transparent",
              color: C.muted,
              fontSize: 13,
              lineHeight: "22px",
              cursor: "pointer",
              padding: 0,
            }}
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
    <div
      style={{
        fontFamily: sans,
        fontSize: 10,
        letterSpacing: "0.18em",
        color: C.muted,
        textTransform: "uppercase",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

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
          width: "100%",
          boxSizing: "border-box",
          fontSize: 16,
          fontFamily: type === "number" ? mono : sans,
          color: C.ink,
          background: C.bg,
          border: `1px solid ${C.panelEdge}`,
          borderRadius: 10,
          padding: "10px 12px",
          outline: "none",
        }}
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
      style={{
        fontFamily: sans,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: "0.06em",
        padding: "10px 16px",
        borderRadius: 10,
        border: ghost ? `1px solid ${C.panelEdge}` : "none",
        background: ghost ? "transparent" : disabled ? C.panelEdge : color,
        color: ghost ? C.muted : "#141a12",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Panel({ title, children, style }) {
  return (
    <div style={{ minWidth: 0, ...style }}>
      {title && (
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.28em",
            color: C.amber,
            margin: "0 2px 10px",
          }}
        >
          {title}
        </div>
      )}
      {children}
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
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState("local");
  const [coachLoading, setCoachLoading] = useState(null);
  const [coachError, setCoachError] = useState("");
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches
  );
  const undoStack = useRef([]);
  const [undoCount, setUndoCount] = useState(0);
  const swipe = useRef(null);
  const syncKeyRef = useRef(null);
  const saveTimer = useRef(null);
  const autoRan = useRef(false);

  /* responsive listener */
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const fn = (e) => setIsDesktop(e.matches);
    mq.addEventListener ? mq.addEventListener("change", fn) : mq.addListener(fn);
    return () =>
      mq.removeEventListener ? mq.removeEventListener("change", fn) : mq.removeListener(fn);
  }, []);

  /* load: local cache first, then remote (remote wins on first load) */
  useEffect(() => {
    let key = null;
    try {
      key = localStorage.getItem("fd-sync-key");
      if (!key) {
        key = newSyncKey();
        localStorage.setItem("fd-sync-key", key);
      }
      const ls = localStorage.getItem("fd-state");
      if (ls) setState({ ...DEFAULT_STATE, ...JSON.parse(ls) });
      const lc = localStorage.getItem("fd-coach");
      if (lc) setCoach({ ...DEFAULT_COACH, ...JSON.parse(lc) });
    } catch (e) {
      key = key || newSyncKey();
    }
    syncKeyRef.current = key;
    setLoaded(true);
    (async () => {
      try {
        const remote = await rpc("fd_get", { k: key });
        if (remote) {
          if (remote.data) setState({ ...DEFAULT_STATE, ...remote.data });
          if (remote.coach) setCoach({ ...DEFAULT_COACH, ...remote.coach });
        }
        setSyncStatus("synced");
      } catch (e) {
        setSyncStatus("offline");
      }
    })();
  }, []);

  /* save: local immediately, remote debounced */
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem("fd-state", JSON.stringify(state));
      localStorage.setItem("fd-coach", JSON.stringify(coach));
    } catch (e) {}
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        setSyncStatus("saving");
        await rpc("fd_set", { k: syncKeyRef.current, d: state, c: coach });
        setSyncStatus("synced");
      } catch (e) {
        setSyncStatus("offline");
      }
    }, 1200);
    return () => saveTimer.current && clearTimeout(saveTimer.current);
  }, [state, coach, loaded]);

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

  /* derived */
  const totals = state.funnel.reduce(
    (a, w) => ({
      apps: a.apps + (+w.apps || 0),
      outreach: a.outreach + (+w.outreach || 0),
      replies: a.replies + (+w.replies || 0),
      screens: a.screens + (+w.screens || 0),
      interviews: a.interviews + (+w.interviews || 0),
      offers: a.offers + (+w.offers || 0),
    }),
    { apps: 0, outreach: 0, replies: 0, screens: 0, interviews: 0, offers: 0 }
  );
  const months = state.runway.expenses > 0 ? state.runway.fund / state.runway.expenses : 0;
  const zone =
    months >= 12
      ? { name: "FULL LEVERAGE", color: C.green, note: "Floor holds. Push well above it. Decline below-floor without hesitation." }
      : months >= 6
      ? { name: "FLOOR HOLDS — TIGHTEN", color: C.amber, note: "Hold P95K. Raise volume, go heavier on warm channels." }
      : months >= 3
      ? { name: "TIMELINE COMPRESSES", color: "#FB923C", note: "Floor holds. Accept strong at-floor offers faster. Add interim income." }
      : { name: "DELIBERATE DECISION ZONE", color: C.red, note: "Only zone where lowering the floor is legitimate — written, dated, numbers attached." };

  /* ---------- coach ---------- */
  const buildContext = () => {
    const weeks = state.funnel
      .slice(0, 8)
      .map(
        (w) =>
          `${w.week || "wk"}: apps ${w.apps || 0}, outreach ${w.outreach || 0}, replies ${w.replies || 0}, screens ${w.screens || 0}, interviews ${w.interviews || 0}, offers ${w.offers || 0}`
      );
    const emos = state.emotions
      .slice(0, 6)
      .map(
        (x) =>
          `${x.date} ${x.name || "?"} (${x.intensity || "?"}/10) claim:"${x.claim || ""}" action:"${x.action || "none"}"`
      );
    const allApps = state.funnel.flatMap((w) => w.applications || []);
    const due = state.funnel.flatMap((w) => dueApps(w));
    const now = new Date();
    return [
      `Today: ${now.toDateString()}.`,
      `Runway: ${months.toFixed(1)} months (zone: ${zone.name}). Fund P${state.runway.fund}, expenses P${state.runway.expenses}/mo.`,
      `Funnel totals: apps ${totals.apps}, outreach ${totals.outreach}, replies ${totals.replies}, screens ${totals.screens}, interviews ${totals.interviews}, offers ${totals.offers}.`,
      `Tracked applications: ${allApps.length} total. Follow-ups DUE today or overdue: ${due.length}${due.length ? " — " + due.slice(0, 5).map((a) => `${a.company || "unnamed"} (contacted ${a.contacted}, status ${a.status})`).join("; ") : ""}.`,
      `Recent weeks (newest first):\n${weeks.join("\n") || "none logged yet"}`,
      `Recent emotion-protocol entries (newest first):\n${emos.join("\n") || "none logged yet"}`,
    ].join("\n\n");
  };

  const RULES = `You are the coaching layer inside "Flight Deck", a personal job-search tracker for a graphic designer in the Philippines targeting remote roles at AU/CA/US/UK companies.
Non-negotiable playbook rules you must coach within:
- The P95,000/month salary floor holds. NEVER suggest lowering it unless runway is under 3 months, and even then only as a written deliberate decision.
- Weekly benchmarks: 8-10 tailored applications + 20-25 warm outreaches. Warm/referral channels convert 4-10x better than cold applications.
- Funnel diagnosis: no replies = fix resume/portfolio layer; screens but no interviews = fix screening-call prep; interviews but no offers = fix interview stage.
- Rejection at ~95% of cold applications is the statistical norm, not a verdict. Decisions come from tracker numbers, never from moods.
- Emotions: each logged emotion should convert to exactly ONE small action. High intensity (8+) = body regulation first.
Tone: direct, warm, concrete, zero fluff, zero generic motivation. Reference their actual numbers.`;

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

  const runDaily = async () => {
    setCoachLoading("daily");
    setCoachError("");
    try {
      const daily = await callClaude(
        "Give today's briefing: the 2-3 most leveraged things to do TODAY (specific and finishable today, sized to where the funnel actually leaks and any unfinished emotion-log actions), one sentence on why based on the numbers, one thing to watch (emotional or strategic risk visible in the data, or empty string), and one grounding reminder in evidence-file style.",
        `{"focus": ["item1", "item2"], "why": "...", "watch": "...", "reminder": "..."}`
      );
      setCoach((p) => ({ ...p, daily, dailyDate: today(), dailyDone: [] }));
    } catch (e) {
      setCoachError(e.message && e.message.includes("ANTHROPIC") ? e.message : "Couldn't reach the coach. Check connection (or the ANTHROPIC_API_KEY on Netlify) and retry.");
    }
    setCoachLoading(null);
  };

  const runWeekly = async () => {
    setCoachLoading("weekly");
    setCoachError("");
    try {
      const weekly = await callClaude(
        "Run the Friday weekly review: a one-line verdict (on-track / off-track and why), funnel diagnosis (which stage leaks most vs benchmarks and the fix), emotional pattern analysis from the protocol log (recurring feelings, whether actions are being completed), 2-4 priorities for next week, and a floor check (does P95K hold given runway - it should unless runway is critically low).",
        `{"verdict": "...", "funnel": "...", "emotions": "...", "next_week": ["..."], "floor": "..."}`
      );
      setCoach((p) => ({ ...p, weekly, weeklyDate: today() }));
    } catch (e) {
      setCoachError(e.message && e.message.includes("ANTHROPIC") ? e.message : "Couldn't reach the coach. Check connection (or the ANTHROPIC_API_KEY on Netlify) and retry.");
    }
    setCoachLoading(null);
  };

  useEffect(() => {
    if (!loaded || autoRan.current) return;
    autoRan.current = true;
    /* wait a beat so a remote coach cache can land first */
    setTimeout(() => {
      setCoach((p) => {
        if (p.dailyDate !== today()) runDaily();
        return p;
      });
    }, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /* ---------- modal save ---------- */
  const saveModal = (data) => {
    const { kind, entry } = modal;
    if (kind === "funnel") {
      const manage = data.__manageApps;
      delete data.__manageApps;
      const id = entry?.id || uid();
      mutate(
        (s) => ({
          ...s,
          funnel: entry
            ? s.funnel.map((w) => (w.id === entry.id ? { ...w, ...data } : w))
            : [{ id, applications: [], ...data }, ...s.funnel],
        }),
        entry ? "Week updated" : "Week logged"
      );
      setModal(manage ? { kind: "apps", weekId: id } : null);
      return;
    } else if (kind === "application") {
      mutate(
        (s) => ({
          ...s,
          funnel: s.funnel.map((w) =>
            w.id === modal.weekId
              ? {
                  ...w,
                  applications: entry
                    ? (w.applications || []).map((a) => (a.id === entry.id ? { ...a, ...data } : a))
                    : [{ id: uid(), ...data }, ...(w.applications || [])],
                }
              : w
          ),
        }),
        entry ? "Application updated" : "Application added"
      );
      setModal({ kind: "apps", weekId: modal.weekId });
      return;
    } else if (kind === "emotion") {
      mutate(
        (s) => ({
          ...s,
          emotions: entry
            ? s.emotions.map((x) => (x.id === entry.id ? { ...x, ...data } : x))
            : [{ id: uid(), date: today(), ...data }, ...s.emotions],
        }),
        entry ? "Entry updated" : "Protocol logged"
      );
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
    } else if (kind === "runway") {
      mutate(
        (s) => ({ ...s, runway: { fund: +data.fund || 0, expenses: +data.expenses || 0 } }),
        "Runway recalculated"
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
      if (remote) {
        if (remote.data) setState({ ...DEFAULT_STATE, ...remote.data });
        if (remote.coach) setCoach({ ...DEFAULT_COACH, ...remote.coach });
        flash("Synced from that code");
      } else {
        flash("New code — current data will save to it");
      }
      setSyncModal(false);
    } catch (e) {
      flash("Couldn't reach sync server");
    }
  };

  /* ============ SECTION RENDERERS (shared mobile/desktop) ============ */

  const renderBriefing = () => (
    <>
      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label>Today's focus — {new Date().toDateString()}</Label>
          <Btn ghost onClick={runDaily} disabled={coachLoading === "daily"} style={{ padding: "6px 10px", fontSize: 11 }}>
            {coachLoading === "daily" ? "…" : "↻ Refresh"}
          </Btn>
        </div>

        {coachLoading === "daily" && (
          <div style={{ color: C.muted, fontFamily: mono, fontSize: 12, padding: "18px 0", letterSpacing: "0.15em" }}>
            READING YOUR INSTRUMENTS…
          </div>
        )}

        {!coachLoading && coach.daily && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {(coach.daily.focus || []).map((f, i) => {
                const done = coach.dailyDone.includes(i);
                return (
                  <div
                    key={i}
                    onClick={() =>
                      setCoach((p) => ({
                        ...p,
                        dailyDone: done ? p.dailyDone.filter((d) => d !== i) : [...p.dailyDone, i],
                      }))
                    }
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      background: C.bg,
                      border: `1px solid ${done ? C.green : C.panelEdge}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontFamily: mono, fontSize: 14, color: done ? C.green : C.amber, lineHeight: 1.4 }}>
                      {done ? "◉" : "○"}
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.45, textDecoration: done ? "line-through" : "none", color: done ? C.muted : C.ink }}>
                      {f}
                    </div>
                  </div>
                );
              })}
            </div>
            {coach.daily.why && <div style={{ fontSize: 12, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>{coach.daily.why}</div>}
            {coach.daily.watch && <div style={{ fontSize: 12, color: C.amber, marginTop: 8, lineHeight: 1.5 }}>⚠ {coach.daily.watch}</div>}
            {coach.daily.reminder && (
              <div style={{ marginTop: 12, borderLeft: `2px solid ${C.green}`, paddingLeft: 10, fontSize: 12, color: C.green, lineHeight: 1.5, fontStyle: "italic" }}>
                {coach.daily.reminder}
              </div>
            )}
          </>
        )}

        {!coachLoading && !coach.daily && !coachError && (
          <div style={{ color: C.muted, fontSize: 13, padding: "14px 0" }}>
            Open the app each morning and today's focus appears here automatically.
          </div>
        )}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label>Weekly review{coach.weeklyDate ? ` — last run ${coach.weeklyDate}` : " — run every Friday"}</Label>
          <Btn onClick={runWeekly} disabled={coachLoading === "weekly"} style={{ padding: "6px 12px", fontSize: 11 }}>
            {coachLoading === "weekly" ? "Reviewing…" : "Run review"}
          </Btn>
        </div>

        {coach.weekly && !coachLoading && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.amber, lineHeight: 1.45 }}>{coach.weekly.verdict}</div>
            {[
              ["FUNNEL", coach.weekly.funnel],
              ["EMOTIONS", coach.weekly.emotions],
              ["FLOOR CHECK", coach.weekly.floor],
            ].map(
              ([k, v]) =>
                v && (
                  <div key={k}>
                    <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: C.muted, marginBottom: 3 }}>{k}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.55 }}>{v}</div>
                  </div>
                )
            )}
            {Array.isArray(coach.weekly.next_week) && coach.weekly.next_week.length > 0 && (
              <div>
                <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.2em", color: C.muted, marginBottom: 3 }}>NEXT WEEK</div>
                {coach.weekly.next_week.map((n, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.6 }}>
                    <span style={{ color: C.amber, fontFamily: mono }}>{i + 1}.</span> {n}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {coachError && (
        <div style={{ marginTop: 12, background: "rgba(248,113,113,0.08)", border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 12px", fontSize: 13, color: C.red }}>
          {coachError}
        </div>
      )}
    </>
  );

  const renderFunnel = () => (
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

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <Label>{isDesktop ? "Weekly logs — click to edit, × to delete" : "Weekly logs — tap to edit, swipe left to delete"}</Label>
        <Btn onClick={() => setModal({ kind: "funnel", entry: null })}>+ Log week</Btn>
      </div>

      {state.funnel.length === 0 && (
        <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
          No weeks logged yet. Log your first week — the benchmark is 8–10 apps and 20–25 outreaches.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {state.funnel.map((w) => {
          const onPace = (+w.apps || 0) >= 8 && (+w.outreach || 0) >= 20;
          const tracked = (w.applications || []).length;
          const due = dueApps(w).length;
          return (
            <SwipeRow
              key={w.id}
              showX={isDesktop}
              onTap={() => setModal({ kind: "funnel", entry: w })}
              onDelete={() => mutate((s) => ({ ...s, funnel: s.funnel.filter((x) => x.id !== w.id) }), "Week deleted")}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{w.week || "Week"}</div>
                <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", color: onPace ? C.green : C.amber }}>
                  {onPace ? "● ON PACE" : "○ BELOW PACE"}
                </div>
              </div>
              <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, marginTop: 6 }}>
                A {w.apps || 0} · O {w.outreach || 0} · R {w.replies || 0} · S {w.screens || 0} · I {w.interviews || 0} · OF {w.offers || 0}
              </div>
              {(tracked > 0 || due > 0) && (
                <div style={{ display: "flex", gap: 10, marginTop: 6, alignItems: "center" }}>
                  {tracked > 0 && (
                    <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: C.blue }}>
                      ▸ {tracked} APPLICATION{tracked === 1 ? "" : "S"} TRACKED
                    </div>
                  )}
                  {due > 0 && (
                    <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: C.red }}>
                      ⚑ {due} FOLLOW-UP{due === 1 ? "" : "S"} DUE
                    </div>
                  )}
                </div>
              )}
            </SwipeRow>
          );
        })}
      </div>
    </>
  );

  const renderEmotions = () => (
    <>
      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14, fontSize: 13, lineHeight: 1.5, color: C.muted }}>
        <span style={{ color: C.amber, fontWeight: 700 }}>Protocol: </span>
        Body first (breathe 4-in / 6-out). If intensity is 8+, walk before logging. Name it → write the claim in third person → test vs. evidence → one action within 10 minutes.
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <Label>{isDesktop ? "Log — click to edit, × to delete" : "Log — tap to edit, swipe left to delete"}</Label>
        <Btn onClick={() => setModal({ kind: "emotion", entry: null })}>+ Run protocol</Btn>
      </div>

      {state.emotions.length === 0 && (
        <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
          Nothing logged. When a feeling hits, run it through here instead of your head.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {state.emotions.map((x) => (
          <SwipeRow
            key={x.id}
            showX={isDesktop}
            onTap={() => setModal({ kind: "emotion", entry: x })}
            onDelete={() => mutate((s) => ({ ...s, emotions: s.emotions.filter((e) => e.id !== x.id) }), "Entry deleted")}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{x.name || "Unnamed feeling"}</div>
              <div style={{ fontFamily: mono, fontSize: 12, color: (+x.intensity || 0) >= 8 ? C.red : C.amber }}>{x.intensity || "–"}/10</div>
            </div>
            {x.claim && <div style={{ fontSize: 12, color: C.muted, marginTop: 4, fontStyle: "italic" }}>"The thought says: {x.claim}"</div>}
            <div style={{ fontSize: 12, marginTop: 6, color: x.action ? C.green : C.muted }}>{x.action ? `→ ${x.action}` : "→ no action set yet"}</div>
            <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{x.date}</div>
          </SwipeRow>
        ))}
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

  const SECTIONS = { BRIEFING: renderBriefing, FUNNEL: renderFunnel, EMOTIONS: renderEmotions, RUNWAY: renderRunway };

  if (!loaded)
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontFamily: mono, fontSize: 13, letterSpacing: "0.2em" }}>
        LOADING INSTRUMENTS…
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
        input, textarea, select { font-size: 16px !important; }
        html, body { margin: 0; padding: 0; background: ${C.bg}; }
        button { -webkit-tap-highlight-color: transparent; }
        @media (hover: hover) {
          button:hover { filter: brightness(1.12); }
        }
      `}</style>

      <div style={{ width: "100%", maxWidth: isDesktop ? 1240 : 560, margin: "0 auto", flex: 1, display: "flex", flexDirection: "column" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.3em", color: C.amber }}>FLIGHT DECK</div>
            <div style={{ fontSize: isDesktop ? 24 : 20, fontWeight: 800, letterSpacing: "-0.01em", marginTop: 2 }}>
              {isDesktop ? "Job Search Operating System" : TITLES[MODES[mode]]}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn ghost onClick={() => setSyncModal(true)} title="Sync across devices" style={{ padding: "10px 12px" }}>
              ⇅
            </Btn>
            <Btn ghost disabled={undoCount === 0} onClick={undo} style={{ color: undoCount ? C.blue : C.muted }}>
              ↩ Undo{undoCount ? ` (${undoCount})` : ""}
            </Btn>
          </div>
        </div>

        {/* mobile mode dots */}
        {!isDesktop && (
          <div style={{ display: "flex", gap: 6, margin: "10px 0 14px" }}>
            {MODES.map((m, i) => (
              <div
                key={m}
                onClick={() => setMode(i)}
                style={{ height: 4, flex: 1, borderRadius: 2, background: i === mode ? C.amber : C.panelEdge, transition: "background 0.2s", cursor: "pointer" }}
              />
            ))}
          </div>
        )}

        {/* content */}
        {isDesktop ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start", marginTop: 18, flex: 1 }}>
            <Panel title="◈ DAILY BRIEFING">{renderBriefing()}</Panel>
            <Panel title="◈ FUNNEL TRACKER">{renderFunnel()}</Panel>
            <Panel title="◈ EMOTION PROTOCOL">{renderEmotions()}</Panel>
            <Panel title="◈ RUNWAY GAUGE">{renderRunway()}</Panel>
          </div>
        ) : (
          <div style={{ flex: 1 }}>{SECTIONS[MODES[mode]]()}</div>
        )}

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "center", gap: 16, alignItems: "center", marginTop: 16 }}>
          {!isDesktop && (
            <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.2em", color: C.muted }}>← SWIPE TO SWITCH MODE →</div>
          )}
          <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.15em", color: syncStatus === "synced" ? C.green : syncStatus === "saving" ? C.amber : C.muted }}>
            {syncStatus === "synced" ? "● SYNCED" : syncStatus === "saving" ? "◌ SAVING" : "○ LOCAL ONLY"}
          </div>
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)", left: "50%", transform: "translateX(-50%)", background: C.panelEdge, color: C.ink, fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 20, zIndex: 60 }}>
          {toast}
        </div>
      )}

      {modal && modal.kind === "apps" && (
        <AppsModal
          week={state.funnel.find((w) => w.id === modal.weekId)}
          onClose={() => setModal(null)}
          onAdd={() => setModal({ kind: "application", weekId: modal.weekId, entry: null })}
          onEdit={(a) => setModal({ kind: "application", weekId: modal.weekId, entry: a })}
          onDelete={(appId) =>
            mutate(
              (s) => ({
                ...s,
                funnel: s.funnel.map((w) =>
                  w.id === modal.weekId
                    ? { ...w, applications: (w.applications || []).filter((a) => a.id !== appId) }
                    : w
                ),
              }),
              "Application deleted"
            )
          }
        />
      )}
      {modal && modal.kind !== "apps" && (
        <Modal
          key={modal.kind + "-" + (modal.entry?.id || "new") + "-" + (modal.weekId || "")}
          modal={modal}
          onClose={() => setModal(null)}
          onSave={saveModal}
        />
      )}
      {syncModal && (
        <SyncModal
          currentKey={syncKeyRef.current}
          onClose={() => setSyncModal(false)}
          onSwitch={switchSyncKey}
          flash={flash}
        />
      )}
    </div>
  );
}

/* ---------- edit modal (centered) ---------- */
function Modal({ modal, onClose, onSave }) {
  const { kind, entry } = modal;
  const opts = weekOptions();
  const [customWeek, setCustomWeek] = useState(
    () => kind === "funnel" && entry?.week && !opts.includes(entry.week)
  );
  const [f, setF] = useState(() => {
    if (kind === "funnel")
      return {
        week: entry?.week || weekLabel(mondayOf(new Date())),
        apps: entry?.apps ?? "",
        outreach: entry?.outreach ?? "",
        replies: entry?.replies ?? "",
        screens: entry?.screens ?? "",
        interviews: entry?.interviews ?? "",
        offers: entry?.offers ?? "",
      };
    if (kind === "application")
      return {
        company: entry?.company || "",
        contact: entry?.contact || "",
        email: entry?.email || "",
        contacted: entry?.contacted || today(),
        followUpDays: entry?.followUpDays ?? 7,
        status: entry?.status || "applied",
        notes: entry?.notes || "",
        custom: entry?.custom ? entry.custom.map((c) => ({ ...c })) : [],
      };
    if (kind === "emotion")
      return { name: entry?.name || "", intensity: entry?.intensity ?? "", claim: entry?.claim || "", action: entry?.action || "" };
    if (kind === "decision") return { note: entry?.note || "" };
    return { fund: entry?.fund ?? "", expenses: entry?.expenses ?? "" };
  });
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  const selectStyle = {
    width: "100%",
    boxSizing: "border-box",
    fontSize: 16,
    fontFamily: sans,
    color: C.ink,
    background: C.bg,
    border: `1px solid ${C.panelEdge}`,
    borderRadius: 10,
    padding: "10px 12px",
    outline: "none",
    appearance: "none",
  };

  const titles = {
    funnel: entry ? "Edit week" : "Log a week",
    application: entry ? "Edit application" : "Track an application",
    emotion: entry ? "Edit protocol entry" : "Run the protocol",
    decision: entry ? "Edit decision" : "Written decision",
    runway: "Update runway numbers",
  };

  const followUpDate = kind === "application" ? addDays(f.contacted, f.followUpDays) : "";

  const saveApplication = () => {
    const clean = { ...f, custom: (f.custom || []).filter((c) => c.k || c.v) };
    onSave(clean);
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
        style={{ width: "100%", maxWidth: 420, maxHeight: "80vh", overflowY: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 14 }}>{titles[kind]}</div>

        {kind === "funnel" && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Label>Week (Monday – Saturday)</Label>
              {!customWeek ? (
                <select
                  value={opts.includes(f.week) ? f.week : "__custom__"}
                  onChange={(e) => {
                    if (e.target.value === "__custom__") setCustomWeek(true);
                    else set("week")(e.target.value);
                  }}
                  style={selectStyle}
                >
                  {opts.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={f.week}
                    placeholder="e.g. Jul 6 – Jul 11"
                    onChange={(e) => set("week")(e.target.value)}
                    style={{ ...selectStyle, flex: 1 }}
                  />
                  <Btn ghost onClick={() => setCustomWeek(false)} style={{ padding: "10px 12px" }}>
                    List
                  </Btn>
                </div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Applications" type="number" value={f.apps} onChange={set("apps")} />
              <Field label="Outreaches" type="number" value={f.outreach} onChange={set("outreach")} />
              <Field label="Replies" type="number" value={f.replies} onChange={set("replies")} />
              <Field label="Screens" type="number" value={f.screens} onChange={set("screens")} />
              <Field label="Interviews" type="number" value={f.interviews} onChange={set("interviews")} />
              <Field label="Offers" type="number" value={f.offers} onChange={set("offers")} />
            </div>
            <button
              onClick={() => onSave({ ...f, __manageApps: true })}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: C.bg,
                border: `1px dashed ${C.blue}`,
                color: C.blue,
                borderRadius: 10,
                padding: "11px 12px",
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: "0.04em",
                cursor: "pointer",
                marginBottom: 12,
              }}
            >
              ▸ Applications ({(entry?.applications || []).length}) — track companies & follow-ups
            </button>
          </>
        )}

        {kind === "application" && (
          <>
            <Field label="Company name" value={f.company} onChange={set("company")} placeholder="e.g. Acme SaaS Inc." />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Contact person" value={f.contact} onChange={set("contact")} placeholder="e.g. Jane Cruz" />
              <Field label="Email" value={f.email} onChange={set("email")} placeholder="jane@acme.com" />
              <Field label="Date contacted" type="date" value={f.contacted} onChange={set("contacted")} />
              <Field label="Follow up in (days)" type="number" value={f.followUpDays} onChange={set("followUpDays")} />
            </div>
            {followUpDate && (
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 12,
                  color: followUpDate <= today() ? C.red : C.green,
                  margin: "-4px 0 12px",
                }}
              >
                ⚑ Follow-up date: {followUpDate}
                {followUpDate <= today() ? " — DUE" : ""}
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <Label>Status</Label>
              <select value={f.status} onChange={(e) => set("status")(e.target.value)} style={selectStyle}>
                {APP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <Field label="Notes" value={f.notes} onChange={set("notes")} placeholder="role, salary range, next step…" />

            <Label>Custom fields</Label>
            {(f.custom || []).map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input
                  value={c.k}
                  placeholder="Label (e.g. Portfolio sent)"
                  onChange={(e) =>
                    setF((p) => ({ ...p, custom: p.custom.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) }))
                  }
                  style={{ ...selectStyle, flex: 1, fontSize: 16 }}
                />
                <input
                  value={c.v}
                  placeholder="Value"
                  onChange={(e) =>
                    setF((p) => ({ ...p, custom: p.custom.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) }))
                  }
                  style={{ ...selectStyle, flex: 1, fontSize: 16 }}
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

        {kind === "emotion" && (
          <>
            <Field label="Name the feeling (be specific)" value={f.name} onChange={set("name")} placeholder="e.g. fear of rejection" />
            <Field label="Intensity 1–10 (if 8+, walk first)" type="number" value={f.intensity} onChange={set("intensity")} />
            <Field label='The claim — "The thought says…"' value={f.claim} onChange={set("claim")} placeholder="e.g. I won't get another high-paying job" />
            <Field label="One action (within 10 minutes)" value={f.action} onChange={set("action")} placeholder="e.g. send 1 outreach" />
          </>
        )}

        {kind === "decision" && (
          <Field label="Decision, with the numbers behind it" value={f.note} onChange={set("note")} placeholder="e.g. Runway 14.2 mo — floor holds at P95K" />
        )}

        {kind === "runway" && (
          <>
            <Field label="Emergency fund (₱)" type="number" value={f.fund} onChange={set("fund")} />
            <Field label="Monthly expenses (₱)" type="number" value={f.expenses} onChange={set("expenses")} />
          </>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <Btn ghost onClick={onClose} style={{ flex: 1 }}>Cancel</Btn>
          <Btn onClick={() => (kind === "application" ? saveApplication() : onSave(f))} style={{ flex: 2 }}>Save</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------- applications list modal (centered) ---------- */
function AppsModal({ week, onClose, onAdd, onEdit, onDelete }) {
  if (!week) return null;
  const apps = week.applications || [];
  return (
    <div
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(6,10,18,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 460, maxHeight: "80vh", overflowY: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Applications — {week.week || "Week"}</div>
          <Btn onClick={onAdd} style={{ padding: "8px 12px", fontSize: 12 }}>+ Add</Btn>
        </div>

        {apps.length === 0 && (
          <div style={{ color: C.muted, fontSize: 13, padding: "18px 0", textAlign: "center" }}>
            No applications tracked yet for this week. Add each company you applied to and Flight Deck will watch the follow-up dates.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {apps.map((a) => {
            const fu = a.contacted ? addDays(a.contacted, a.followUpDays ?? 7) : "";
            const due = fu && isOpenApp(a) && fu <= today();
            return (
              <div
                key={a.id}
                onClick={() => onEdit(a)}
                style={{ background: C.bg, border: `1px solid ${due ? C.red : C.panelEdge}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer", position: "relative", paddingRight: 38 }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(a.id);
                  }}
                  title="Delete application"
                  style={{ position: "absolute", top: 8, right: 8, width: 24, height: 24, borderRadius: 12, border: `1px solid ${C.panelEdge}`, background: "transparent", color: C.muted, fontSize: 13, lineHeight: "22px", cursor: "pointer", padding: 0 }}
                >
                  ×
                </button>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{a.company || "Unnamed company"}</div>
                  <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: statusColor(a.status), textTransform: "uppercase", flexShrink: 0 }}>
                    {a.status || "applied"}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                  {[a.contact, a.email].filter(Boolean).join(" · ") || "no contact yet"}
                </div>
                <div style={{ fontFamily: mono, fontSize: 11, marginTop: 6, color: due ? C.red : C.muted }}>
                  {a.contacted ? `contacted ${a.contacted}` : "no contact date"}
                  {fu ? ` → follow up ${fu}${due ? " ⚑ DUE" : ""}` : ""}
                </div>
                {(a.custom || []).length > 0 && (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                    {a.custom.map((c) => `${c.k}: ${c.v}`).join(" · ")}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 14 }}>
          <Btn ghost onClick={onClose} style={{ width: "100%" }}>Close</Btn>
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
          Your data is stored under this private sync code. Enter the same code on another device (phone ↔ desktop) to see the same data. Treat it like a password.
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

        <Field label="Use a code from another device" value={input} onChange={setInput} placeholder="fd_…" />

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

const root = createRoot(document.getElementById("root"));
root.render(<FlightDeck />);
