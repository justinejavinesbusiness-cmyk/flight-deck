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

const MODES = ["DASHBOARD", "PIPELINE", "FUNNEL", "EMOTIONS", "RUNWAY", "HISTORY"];
const TITLES = {
  DASHBOARD: "Dashboard",
  PIPELINE: "Pipeline (CRM)",
  FUNNEL: "Funnel Tracker",
  EMOTIONS: "Emotion Protocol",
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
const APP_STATUSES = ["applied", "followed up", "replied", "screening", "interview", "final round", "offer", "rejected"];
const STAGE_IDX = { applied: 0, "followed up": 1, replied: 2, screening: 3, interview: 4, "final round": 5, offer: 6 };
const isOpenApp = (a) => !["offer", "rejected"].includes(a.status);
const reached = (a, stage) => a.status !== "rejected" && (STAGE_IDX[a.status] ?? 0) >= STAGE_IDX[stage];
const statusColor = (s) =>
  s === "offer" ? C.green : s === "rejected" ? C.muted : ["interview", "final round"].includes(s) ? C.amber : ["replied", "screening"].includes(s) ? C.blue : C.ink;
const followUpOf = (a) => (a.contacted ? addDays(a.contacted, a.followUpDays ?? 7) : "");
const isDue = (a) => {
  const fu = followUpOf(a);
  return fu && isOpenApp(a) && fu <= today();
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
  funnel: [],
  emotions: [],
  decisions: [],
  accomplishments: [],
  supportSessions: [],
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
  if (!Array.isArray(s.accomplishments)) s.accomplishments = [];
  if (!Array.isArray(s.supportSessions)) s.supportSessions = [];
  if (!s.settings || typeof s.settings !== "object") s.settings = { checkinDay: 1 };
  if (!s.settings.checkinDay) s.settings.checkinDay = 1;
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
    funnel: unionById(localS.funnel, remoteS.funnel),
    emotions: unionById(localS.emotions, remoteS.emotions),
    decisions: unionById(localS.decisions, remoteS.decisions),
    accomplishments: unionById(localS.accomplishments, remoteS.accomplishments),
    supportSessions: unionById(localS.supportSessions, remoteS.supportSessions),
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

/* ---------- voice audio storage (Supabase Storage) ---------- */
const AUDIO_TTL_DAYS = 365; /* audio kept 12 months from creation, then user is asked */
const audioPublicUrl = (path) => `${SUPA_URL}/storage/v1/object/public/voice-sessions/${path}`;
async function uploadAudio(path, blob) {
  const r = await fetch(`${SUPA_URL}/storage/v1/object/voice-sessions/${path}`, {
    method: "POST",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "content-type": "audio/mpeg", "x-upsert": "true" },
    body: blob,
  });
  if (!r.ok) throw new Error(`storage upload ${r.status}`);
}
async function deleteAudio(path) {
  const r = await fetch(`${SUPA_URL}/storage/v1/object/voice-sessions/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!r.ok && r.status !== 404) throw new Error(`storage delete ${r.status}`);
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

/* ============================================================ */
export default function FlightDeck() {
  const [state, setState] = useState(DEFAULT_STATE);
  const [coach, setCoach] = useState(DEFAULT_COACH);
  const [mode, setMode] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState(null);
  const [syncModal, setSyncModal] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState("local");
  const [pipeFilter, setPipeFilter] = useState("active");
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
          outreach: 0,
          legacy: { apps: 0, replies: 0, screens: 0, interviews: 0, offers: 0 },
          d: { apps: 0, replies: 0, screens: 0, interviews: 0, offers: 0 },
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
      const ws = weekStartOfDate(a.contacted);
      const label = ws ? weekLabel(new Date(ws + "T00:00:00")) : "No date set";
      const row = ensure(label, ws);
      row.d.apps += 1;
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
      t.outreach += r.outreach;
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

  /* monthly runway check-in */
  const checkinDay = +state.settings?.checkinDay || 1;
  const checkinDue = new Date().getDate() >= checkinDay && state.lastCheckinMonth !== thisMonth();

  /* focus state */
  const focusItems = normFocus(coach.daily?.focus);
  const allFocusDone = focusItems.length > 0 && focusItems.every((_, i) => (coach.dailyDone || []).includes(i));

  /* ---------- coach ---------- */
  const buildContext = () => {
    const weekLines = weekRows
      .slice(0, 8)
      .map(
        (r) =>
          `${r.week}: apps ${r.d.apps + r.legacy.apps}, outreach ${r.outreach}, replies ${r.d.replies + r.legacy.replies}, screens ${r.d.screens + r.legacy.screens}, interviews ${r.d.interviews + r.legacy.interviews}, offers ${r.d.offers + r.legacy.offers}`
      );
    const byStatus = APP_STATUSES.map((s) => `${s}: ${apps.filter((a) => a.status === s).length}`).join(", ");
    const emos = state.emotions
      .slice(0, 6)
      .map((x) => `${x.date} ${x.name || "?"} (${x.intensity || "?"}/10) claim:"${x.claim || ""}" action:"${x.action || "none"}"`);
    const wins = (state.accomplishments || [])
      .slice(0, 10)
      .map((a) => `${a.date}: ${a.text}${a.category ? ` [${a.category}]` : ""}`);
    const sessions = (state.supportSessions || [])
      .slice(0, 6)
      .map((s) => `${s.date} "${s.feeling || "?"}" intensity ${s.intensity || "?"}/10`);
    const now = new Date();
    return [
      `Today: ${now.toDateString()}.`,
      `Runway: ${months.toFixed(1)} months (zone: ${zone.name}). Fund P${state.runway.fund}, expenses P${state.runway.expenses}/mo.`,
      `Funnel totals (derived live from pipeline): apps ${totals.apps}, outreach ${totals.outreach}, replies ${totals.replies}, screens ${totals.screens}, interviews ${totals.interviews}, offers ${totals.offers}.`,
      `Pipeline by status: ${byStatus}.`,
      `Follow-ups DUE today or overdue: ${dueList.length}${dueList.length ? " — " + dueList.slice(0, 6).map((a) => `${a.company || "unnamed"} (contacted ${a.contacted}, status ${a.status})`).join("; ") : ""}.`,
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

  const runDaily = async () => {
    setCoachLoading("daily");
    setCoachError("");
    try {
      const daily = await callClaude(
        "Give today's focus: a MAXIMUM of 3 things to do TODAY (specific and finishable today; due follow-ups by company name usually come first, then volume/quality work sized to where the funnel leaks, then any unfinished emotion-log action). EXACTLY ONE item must have key=true - the single highest-leverage action that most significantly boosts the chance of landing the job. Also give one sentence on why based on the numbers, one thing to watch (or empty string), and one grounding reminder in evidence-file style.",
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
            { id: sessionId, date: today(), feeling: "🎙 Weekly voice check-in", intensity: "", script, ...audioFields },
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
  const setAppStatus = (id, status) =>
    mutate(
      (s) => ({ ...s, applications: s.applications.map((a) => (a.id === id ? { ...a, status } : a)) }),
      "Status updated — funnel recalculated"
    );

  const saveModal = (data) => {
    const { kind, entry } = modal;
    if (kind === "week") {
      mutate(
        (s) => ({
          ...s,
          funnel: entry ? s.funnel.map((w) => (w.id === entry.id ? { ...w, ...data } : w)) : [{ id: uid(), ...data }, ...s.funnel],
        }),
        entry ? "Outreach updated" : "Outreach logged"
      );
    } else if (kind === "application") {
      mutate(
        (s) => ({
          ...s,
          applications: entry
            ? s.applications.map((a) => (a.id === entry.id ? { ...a, ...data } : a))
            : [{ id: uid(), ...data }, ...s.applications],
        }),
        entry ? "Application updated" : "Application added — funnel updated"
      );
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
        (s) => ({ ...s, settings: { ...s.settings, checkinDay: Math.min(28, Math.max(1, +data.day || 1)) } }),
        "Check-in day updated"
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

  const renderDashboard = () => (
    <>
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

      {/* monthly runway check-in banner */}
      {checkinDue && (
        <div style={{ background: "rgba(245,185,66,0.08)", border: `1px solid ${C.amber}`, borderRadius: 14, padding: "12px 16px", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14, color: C.amber }}>Monthly runway check-in</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                Recalculate fund ÷ expenses. The floor decision runs on this number — not on mood.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setModal({ kind: "runway", entry: { fund: state.runway.fund, expenses: state.runway.expenses } })} style={{ padding: "8px 12px", fontSize: 12 }}>
                Update numbers
              </Btn>
              <Btn ghost onClick={() => setModal({ kind: "checkinDay", entry: { day: checkinDay } })} style={{ padding: "8px 10px", fontSize: 12 }} title="Change check-in day">
                Day: {checkinDay}
              </Btn>
            </div>
          </div>
        </div>
      )}

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

      {/* today's focus */}
      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Label>
            Today's focus — {new Date().toDateString()}
            {coach.daily?.carried ? "  ·  CARRIED OVER" : ""}
          </Label>
          {coach.daily && (
            <Btn ghost onClick={runDaily} disabled={coachLoading === "daily"} style={{ padding: "6px 10px", fontSize: 11 }} title="Regenerate (replaces the current list)">
              {coachLoading === "daily" ? "…" : "↻"}
            </Btn>
          )}
        </div>

        {coach.daily?.carried && (
          <div style={{ fontSize: 12, color: C.amber, margin: "6px 0 2px", lineHeight: 1.5 }}>
            Yesterday's unfinished items carried over. Finish these to unlock a fresh focus tomorrow — completed ones are already in your History.
          </div>
        )}

        {coachLoading === "daily" && (
          <div style={{ color: C.muted, fontFamily: mono, fontSize: 12, padding: "18px 0", letterSpacing: "0.15em" }}>READING YOUR INSTRUMENTS…</div>
        )}

        {!coachLoading && coach.daily && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {focusItems.map((f, i) => {
                const done = (coach.dailyDone || []).includes(i);
                return (
                  <div
                    key={i}
                    onClick={() => setCoach((p) => ({ ...p, dailyDone: done ? p.dailyDone.filter((d) => d !== i) : [...p.dailyDone, i] }))}
                    style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.bg, border: `1px solid ${done ? C.green : f.key ? C.amber : C.panelEdge}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer" }}
                  >
                    <div style={{ fontFamily: mono, fontSize: 14, color: done ? C.green : C.amber, lineHeight: 1.4 }}>{done ? "◉" : "○"}</div>
                    <div style={{ minWidth: 0 }}>
                      {f.key && (
                        <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.18em", color: C.amber, marginBottom: 2 }}>★ HIGHEST LEVERAGE</div>
                      )}
                      <div style={{ fontSize: 14, lineHeight: 1.45, textDecoration: done ? "line-through" : "none", color: done ? C.muted : C.ink }}>{f.text}</div>
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
          A spoken session built from your actual week — numbers, wins, emotional patterns — settle, reality, track record, forward, one action. Transcript saves to your diary.
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

      {/* weekly review */}
      <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label>Weekly review{coach.weeklyDate ? ` — last run ${coach.weeklyDate}` : " — run every Friday"}</Label>
          <Btn onClick={runWeekly} disabled={coachLoading === "weekly"} style={{ padding: "6px 12px", fontSize: 11 }}>
            {coachLoading === "weekly" ? "Reviewing…" : "Run review"}
          </Btn>
        </div>

        {coach.weekly && coachLoading !== "weekly" && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.amber, lineHeight: 1.45 }}>{coach.weekly.verdict}</div>
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
                {list.map((a) => (
                  <SwipeRow
                    key={a.id}
                    showX={isDesktop}
                    onTap={() => setModal({ kind: "accomplishment", entry: a })}
                    onDelete={() => mutate((s) => ({ ...s, accomplishments: s.accomplishments.filter((x) => x.id !== a.id) }), "Accomplishment deleted")}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ fontSize: 13, lineHeight: 1.5 }}>✓ {a.text}</div>
                      <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, flexShrink: 0 }}>
                        {historyGroup === "category" ? a.date : a.category}
                      </div>
                    </div>
                  </SwipeRow>
                ))}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  };
  const renderPipeline = () => {
    const filters = [
      { key: "active", label: `Active (${apps.filter(isOpenApp).length})` },
      { key: "due", label: `⚑ Due (${dueList.length})` },
      { key: "closed", label: `Closed (${apps.filter((a) => !isOpenApp(a)).length})` },
      { key: "all", label: `All (${apps.length})` },
    ];
    const shown = apps
      .filter((a) => (pipeFilter === "due" ? isDue(a) : pipeFilter === "active" ? isOpenApp(a) : pipeFilter === "closed" ? !isOpenApp(a) : true))
      .slice()
      .sort((a, b) => (b.contacted || "").localeCompare(a.contacted || ""));

    const th = { textAlign: "left", fontFamily: sans, fontSize: 10, letterSpacing: "0.14em", color: C.muted, textTransform: "uppercase", padding: "8px 10px", borderBottom: `1px solid ${C.panelEdge}`, whiteSpace: "nowrap" };
    const td = { padding: "10px 10px", borderBottom: `1px solid ${C.panelEdge}`, fontSize: 13, verticalAlign: "middle" };

    return (
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
          <Btn onClick={() => setModal({ kind: "application", entry: null })}>+ Track application</Btn>
        </div>

        {shown.length === 0 && (
          <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
            {apps.length === 0
              ? "No applications tracked yet. Every company you add here updates the funnel numbers automatically."
              : "Nothing matches this filter."}
          </div>
        )}

        {shown.length > 0 && (
          <div
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12 }}
          >
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={th}>Company</th>
                  <th style={th}>Contact</th>
                  <th style={th}>Status</th>
                  <th style={th}>Contacted</th>
                  <th style={th}>Follow-up</th>
                  <th style={th}>Info</th>
                  <th style={{ ...th, width: 34 }}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const fu = followUpOf(a);
                  const due = isDue(a);
                  return (
                    <tr
                      key={a.id}
                      onClick={() => setModal({ kind: "application", entry: a })}
                      style={{ cursor: "pointer", background: due ? "rgba(248,113,113,0.06)" : "transparent" }}
                    >
                      <td style={{ ...td, fontWeight: 700, borderLeft: due ? `3px solid ${C.red}` : "3px solid transparent" }}>
                        {a.company || "Unnamed"}
                      </td>
                      <td style={{ ...td, color: C.muted }}>
                        {a.contact || "—"}
                        {a.email ? <div style={{ fontFamily: mono, fontSize: 11 }}>{a.email}</div> : null}
                      </td>
                      <td style={td} onClick={(e) => e.stopPropagation()}>
                        <select
                          value={a.status || "applied"}
                          onChange={(e) => setAppStatus(a.id, e.target.value)}
                          style={{ fontSize: 16, fontFamily: mono, background: C.bg, color: statusColor(a.status), border: `1px solid ${C.panelEdge}`, borderRadius: 8, padding: "4px 6px", outline: "none" }}
                        >
                          {APP_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ ...td, fontFamily: mono, fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{a.contacted || "—"}</td>
                      <td style={{ ...td, fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", color: due ? C.red : C.muted }}>
                        {fu || "—"}
                        {due ? " ⚑" : ""}
                      </td>
                      <td style={{ ...td, fontSize: 11, color: C.muted, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[a.notes, ...(a.custom || []).map((c) => `${c.k}: ${c.v}`)].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td style={td} onClick={(e) => e.stopPropagation()}>
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
          Changing a status here updates the Funnel numbers and weekly rows instantly.
        </div>
      </>
    );
  };

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
      <div style={{ fontSize: 11, color: C.muted, margin: "-6px 0 12px" }}>
        Auto-computed from the Pipeline. Only outreach is logged manually.
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <Label>Weeks (Mon–Sat)</Label>
        <Btn onClick={() => setModal({ kind: "week", entry: null })}>+ Log outreach</Btn>
      </div>

      {weekRows.length === 0 && (
        <div style={{ color: C.muted, fontSize: 14, padding: "24px 4px", textAlign: "center" }}>
          Track applications in the Pipeline and log weekly outreach — the funnel builds itself.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {weekRows.map((r) => {
          const a = r.d.apps + r.legacy.apps;
          const onPace = a >= 8 && r.outreach >= 20;
          const manualLog = r.id ? state.funnel.find((w) => w.id === r.id) : null;
          return (
            <SwipeRow
              key={r.week}
              showX={isDesktop && !!manualLog}
              onTap={() =>
                manualLog
                  ? setModal({ kind: "week", entry: manualLog })
                  : setModal({ kind: "week", entry: null, presetWeek: { week: r.week, weekStart: r.weekStart } })
              }
              onDelete={() =>
                manualLog
                  ? mutate((s) => ({ ...s, funnel: s.funnel.filter((x) => x.id !== manualLog.id) }), "Outreach log deleted")
                  : flash("This row is derived from the Pipeline")
              }
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{r.week}</div>
                <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", color: onPace ? C.green : C.amber }}>
                  {onPace ? "● ON PACE" : "○ BELOW PACE"}
                </div>
              </div>
              <div style={{ fontFamily: mono, fontSize: 12, color: C.muted, marginTop: 6 }}>
                A {a} · O {r.outreach} · R {r.d.replies + r.legacy.replies} · S {r.d.screens + r.legacy.screens} · I{" "}
                {r.d.interviews + r.legacy.interviews} · OF {r.d.offers + r.legacy.offers}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 6, alignItems: "center" }}>
                <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: C.blue }}>▸ AUTO FROM PIPELINE</div>
                {r.due > 0 && (
                  <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", color: C.red }}>
                    ⚑ {r.due} FOLLOW-UP{r.due === 1 ? "" : "S"} DUE
                  </div>
                )}
              </div>
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

      {/* support diary */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "18px 0 10px" }}>
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
          No sessions yet. Every 🛟 Emotional support session saves here automatically — a diary of advice you can reread anytime.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(state.supportSessions || []).map((s) => (
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
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                🛟 {s.feeling || "Support session"}
              </div>
              <div style={{ fontFamily: mono, fontSize: 12, color: (+s.intensity || 0) >= 8 ? C.red : C.amber, flexShrink: 0 }}>
                {s.intensity || "–"}/10
              </div>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.one_action || ""}
            </div>
            <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 6 }}>{s.date}</div>
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

      <div
        onClick={() => setModal({ kind: "checkinDay", entry: { day: checkinDay } })}
        style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: "10px 14px", marginBottom: 14, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div style={{ fontSize: 13, color: C.muted }}>Monthly check-in day ({isDesktop ? "click" : "tap"} to change)</div>
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

  const SECTIONS = { DASHBOARD: renderDashboard, PIPELINE: renderPipeline, FUNNEL: renderFunnel, EMOTIONS: renderEmotions, RUNWAY: renderRunway, HISTORY: renderHistory };

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
        input, textarea, select { font-size: 16px !important; }
        html, body { margin: 0; padding: 0; background: ${C.bg}; }
        button { -webkit-tap-highlight-color: transparent; }
        @media (hover: hover) {
          button:hover { filter: brightness(1.12); }
          tbody tr:hover { background: rgba(125,176,247,0.05) !important; }
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
            <Panel title="◈ DASHBOARD">{renderDashboard()}</Panel>
            <Panel title="◈ FUNNEL TRACKER">{renderFunnel()}</Panel>
            <Panel title="◈ PIPELINE — ALL APPLICATIONS" style={{ gridColumn: "1 / -1" }}>
              {renderPipeline()}
            </Panel>
            <Panel title="◈ EMOTION PROTOCOL">{renderEmotions()}</Panel>
            <Panel title="◈ RUNWAY GAUGE">{renderRunway()}</Panel>
            <Panel title="◈ HISTORY — ACCOMPLISHMENTS" style={{ gridColumn: "1 / -1" }}>
              {renderHistory()}
            </Panel>
          </div>
        ) : (
          <div style={{ flex: 1 }}>{SECTIONS[MODES[mode]]()}</div>
        )}

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "center", gap: 16, alignItems: "center", marginTop: 16 }}>
          {!isDesktop && <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.2em", color: C.muted }}>← SWIPE TO SWITCH MODE →</div>}
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

      {modal && (
        <Modal
          key={modal.kind + "-" + (modal.entry?.id || "new")}
          modal={modal}
          onClose={() => setModal(null)}
          onSave={saveModal}
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
          onLog={(entry) => {
            mutate((s) => ({ ...s, emotions: [{ id: uid(), date: today(), ...entry }, ...s.emotions] }), "Logged to Emotion Protocol");
            setSupportOpen(false);
          }}
        />
      )}
    </div>
  );
}
/* ---------- edit modal (centered) ---------- */
function Modal({ modal, onClose, onSave }) {
  const { kind, entry, presetWeek } = modal;
  const opts = weekOptions();
  const initialWeek = entry?.week || presetWeek?.week || opts[1]?.label || opts[0].label;
  const [customWeek, setCustomWeek] = useState(() => kind === "week" && initialWeek && !opts.some((o) => o.label === initialWeek));
  const [f, setF] = useState(() => {
    if (kind === "week")
      return {
        week: initialWeek,
        weekStart: entry?.weekStart || presetWeek?.weekStart || opts.find((o) => o.label === initialWeek)?.start || null,
        outreach: entry?.outreach ?? "",
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
    if (kind === "session") return {};
    if (kind === "accomplishment")
      return { text: entry?.text || "", date: entry?.date || today(), category: entry?.category || "Daily focus" };
    if (kind === "checkinDay") return { day: entry?.day ?? 1 };
    return { fund: entry?.fund ?? "", expenses: entry?.expenses ?? "" };
  });
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  const selectStyle = { ...inputStyle, appearance: "none" };

  const titles = {
    week: entry ? "Edit weekly outreach" : "Log weekly outreach",
    application: entry ? "Edit application" : "Track an application",
    emotion: entry ? "Edit protocol entry" : "Run the protocol",
    decision: entry ? "Edit decision" : "Written decision",
    session: "Support session — reread",
    accomplishment: entry ? "Edit accomplishment" : "Log a win",
    checkinDay: "Monthly check-in day",
    runway: "Update runway numbers",
  };

  const followUpDate = kind === "application" ? addDays(f.contacted, f.followUpDays) : "";

  const save = () => {
    if (kind === "application") {
      onSave({ ...f, custom: (f.custom || []).filter((c) => c.k || c.v) });
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
        style={{ width: "100%", maxWidth: 420, maxHeight: "80vh", overflowY: "auto", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 16, padding: 20, boxSizing: "border-box" }}
      >
        <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 14 }}>{titles[kind]}</div>

        {kind === "week" && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Label>Week (Monday – Saturday)</Label>
              {!customWeek ? (
                <select
                  value={opts.some((o) => o.label === f.week) ? f.week : "__custom__"}
                  onChange={(e) => {
                    if (e.target.value === "__custom__") setCustomWeek(true);
                    else {
                      const o = opts.find((x) => x.label === e.target.value);
                      setF((p) => ({ ...p, week: o.label, weekStart: o.start }));
                    }
                  }}
                  style={selectStyle}
                >
                  {opts.map((o) => (
                    <option key={o.label} value={o.label}>
                      {o.label}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={f.week}
                    placeholder="e.g. Jul 6 – Jul 11"
                    onChange={(e) => setF((p) => ({ ...p, week: e.target.value, weekStart: null }))}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <Btn ghost onClick={() => setCustomWeek(false)} style={{ padding: "10px 12px" }}>
                    List
                  </Btn>
                </div>
              )}
            </div>
            <Field label="Warm outreaches this week (target 20–25)" type="number" value={f.outreach} onChange={set("outreach")} />
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
              Applications, replies, screens, interviews, and offers are counted automatically from the Pipeline — track each company there.
            </div>
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
              <div style={{ fontFamily: mono, fontSize: 12, color: followUpDate <= today() ? C.red : C.green, margin: "-4px 0 12px" }}>
                ⚑ Follow-up date: {followUpDate}
                {followUpDate <= today() ? " — DUE" : ""}
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <Label>Status (drives the funnel numbers)</Label>
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
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
              On or after this day each month, the Dashboard will remind you to recalculate fund ÷ expenses. Saving new runway numbers marks the month as done.
            </div>
          </>
        )}

        {kind === "runway" && (
          <>
            <Field label="Emergency fund (₱)" type="number" value={f.fund} onChange={set("fund")} />
            <Field label="Monthly expenses (₱)" type="number" value={f.expenses} onChange={set("expenses")} />
          </>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
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

function SupportModal({ onClose, runSupport, onLog, onSaveSession }) {
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
      "Write the feeling and the claim it's making in your Emotion Protocol — one sentence each. That's the whole task for the next 10 minutes.",
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
              First we settle the feeling, then reality with evidence, your track record, the path forward — then one small step. Every session is saved to your diary in the Emotions tab.
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
            <div style={{ fontSize: 11, color: C.muted }}>✓ Saved to your support diary (Emotions tab)</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn ghost onClick={onClose} style={{ flex: 1 }}>Close</Btn>
              <Btn
                onClick={() => onLog({ name: feeling.slice(0, 60) || "Support session", intensity: intensity || "", claim: feeling, action: result.one_action })}
                color={C.green}
                style={{ flex: 2 }}
              >
                Log to Emotion Protocol
              </Btn>
            </div>
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
