import { useState, useEffect, useRef, useMemo } from "react";
import { createRoot } from "react-dom/client";

/* ============================================================
   FLIGHT DECK · POOL MODE (v0.1) — a separate, parallel version

   PREMISE: list building isn't the bottleneck. Restarting discovery every
   week is. So the unit of work changes:

     · Build ONE pool of ~45 companies. Once. Two sittings.
     · The pool is then CLOSED for six weeks. Adding names is intercepted.
     · Weekly hours go to writing, not finding. There is always someone in
       the pool to write to, so a session never begins with "who?"
     · Research is capped at 5 minutes and yields ONE hook line — never a
       dossier.
     · Refresh by adding five names from the Bench, never by starting over.

   ------------------------------------------------------------
   DATA SAFETY — read this before changing anything

   This app shares your Flight Deck account but NEVER writes to it.

     · It reads the main record (applications, accounts, contacts, content)
       through fd_get with your existing sync key. READ ONLY. There is no
       fd_set call anywhere in this file that targets the main key.
     · It writes its own separate record under `<syncKey>_pool`. Pools,
       hooks, bench and sessions live there. A bug in this file cannot
       corrupt your real pipeline.

   That separation is also why marking a company "worked" here does not
   create an application in Flight Deck. It doesn't need to: coverage is
   derived from BOTH sources — your real Flight Deck history AND anything
   marked here. Log outreach in Flight Deck exactly as you always have and
   the coverage grid picks it up on next load. Nothing is entered twice.
   ============================================================ */

const SUPA_URL = "https://ywzvhloswottkasvhzfv.supabase.co";
const SUPA_KEY = "sb_publishable_YyQQvJHwJh3B0c6ZJCcuhQ__gCrN_ld";

const C = {
  bg: "#0E1420",
  panel: "#17202F",
  panelEdge: "#232F42",
  ink: "#E8EEF7",
  muted: "#8798B0",
  blue: "#60A5FA",
  green: "#4ADE80",
  amber: "#F5B942",
  red: "#F87171",
};
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/* ---------- dates (offset-aware, mirroring main.jsx's fixed helpers) ---------- */
let DAY_TZ_OFFSET_HOURS = 8;
const today = () => {
  const d = new Date(Date.now() + DAY_TZ_OFFSET_HOURS * 3600000);
  return d.toISOString().slice(0, 10);
};
const iso = (d) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
/* uses iso(), never toISOString() directly — the off-by-one that bit main.jsx */
const addDays = (isoDate, n) => {
  if (!isoDate) return "";
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d)) return "";
  d.setDate(d.getDate() + (+n || 0));
  return iso(d);
};
const daysBetween = (a, b) => (!a || !b ? null : Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000));
const mondayOf = (d) => {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};
const thisMonday = () => iso(mondayOf(new Date(today() + "T00:00:00")));
const uid = () => "p" + Math.random().toString(36).slice(2, 10);
const fmt = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

/* ---------- shared normalisation (must match main.jsx so companies line up) ---------- */
const normCompany = (s) => (s || "").trim().toLowerCase();

/* ---------- pool model ---------- */
const POOL_SIZE = 45;
const CLOSED_WEEKS = 6;
const REFRESH_ADD = 5;
const RESEARCH_SECONDS = 300; /* five minutes, then write with what you have */

const DEFAULT_POOL_STATE = {
  pools: [],
  bench: [],
  activePoolId: null,
  weeklyWriteTarget: 8,
  adopted: false,
};

function migratePool(raw) {
  const s = { ...DEFAULT_POOL_STATE, ...(raw || {}) };
  if (!Array.isArray(s.pools)) s.pools = [];
  if (!Array.isArray(s.bench)) s.bench = [];
  s.pools = s.pools.map((p) => ({
    id: p.id || uid(),
    name: p.name || "Pool",
    builtOn: p.builtOn || today(),
    closedUntil: p.closedUntil || addDays(p.builtOn || today(), CLOSED_WEEKS * 7),
    targetSize: +p.targetSize || POOL_SIZE,
    members: Array.isArray(p.members)
      ? p.members.map((m) => ({
          id: m.id || uid(),
          company: m.company || "",
          hook: m.hook || "",
          hookedAt: m.hookedAt || "",
          researchSecs: +m.researchSecs || 0,
          workedAt: m.workedAt || "",
          note: m.note || "",
          /* "existing" = adopted from Flight Deck data, already lives there.
             "new" = first appeared here, so Flight Deck has never seen it. */
          origin: m.origin === "new" ? "new" : "existing",
          pushedAt: m.pushedAt || "",
        }))
      : [],
  }));
  if (typeof s.weeklyWriteTarget !== "number") s.weeklyWriteTarget = 8;
  return s;
}

/* ---------- reading the EXISTING Flight Deck data (read-only) ---------- */
/* Builds a per-company digest of everything already tracked, so seeding a pool
   uses real history instead of a blank slate, and so coverage credits work you
   already did. A company counts as WORKED if any application or account contact
   for it has a real status and a contact date. */
function digestMainState(main) {
  const byCompany = new Map();
  const touch = (companyRaw) => {
    const key = normCompany(companyRaw);
    if (!key) return null;
    if (!byCompany.has(key)) byCompany.set(key, { key, company: (companyRaw || "").trim(), worked: false, lastContact: "", intel: [], roles: new Set(), sources: new Set(), contacts: [] });
    return byCompany.get(key);
  };
  (main?.applications || []).forEach((a) => {
    if (a.archivedAt || a.tombstoned) return;
    const e = touch(a.company);
    if (!e) return;
    const hasReal = !!(a.status && a.contacted);
    if (hasReal) e.worked = true;
    if (a.contacted && a.contacted > e.lastContact) e.lastContact = a.contacted;
    if (a.role) e.roles.add(a.role);
    if (a.source) e.sources.add(a.source);
    if (a.notes) e.intel.push(a.notes);
  });
  (main?.accounts || []).forEach((acc) => {
    const e = touch(acc.company);
    if (!e) return;
    if (acc.notes) e.intel.push(acc.notes);
    (acc.contacts || []).forEach((c) => {
      if (c.archivedAt || c.tombstoned) return;
      e.contacts.push({ name: c.name || "", position: c.position || "", status: c.status || "" });
      if (c.status && c.contacted) e.worked = true;
      if (c.contacted && c.contacted > e.lastContact) e.lastContact = c.contacted;
      if (c.notes) e.intel.push(c.notes);
    });
  });
  return byCompany;
}

/* a pool member is worked if this app marked it, OR real Flight Deck history
   already shows contact — so switching versions never resets your progress */
const memberWorked = (m, digest) => !!(m.workedAt || digest.get(normCompany(m.company))?.worked);
const memberHooked = (m) => !!(m.hook || "").trim();

function poolStats(pool, digest) {
  if (!pool) return { total: 0, worked: 0, hooked: 0, unhooked: 0, ready: 0, pct: 0, inFlightDeck: 0, newHere: 0, pending: 0 };
  const total = pool.members.length;
  let worked = 0,
    hooked = 0,
    ready = 0,
    inFlightDeck = 0,
    newHere = 0,
    pending = 0;
  pool.members.forEach((m) => {
    const w = memberWorked(m, digest);
    const h = memberHooked(m);
    if (w) worked++;
    if (h) hooked++;
    if (h && !w) ready++;
    /* "already in Flight Deck" means either adopted from it, already pushed,
       or independently present there now — all three mean no push needed */
    const known = m.origin === "existing" || !!m.pushedAt || digest.has(normCompany(m.company));
    if (known) inFlightDeck++;
    else {
      newHere++;
      pending++;
    }
  });
  return { total, worked, hooked, unhooked: total - hooked, ready, pct: total ? Math.round((worked / total) * 100) : 0, inFlightDeck, newHere, pending };
}
const poolIsClosed = (pool) => !!pool && pool.closedUntil > today();

/* ---------- supabase rpc (same functions main.jsx uses) ---------- */
async function rpc(fn, args, timeoutMs = 8000) {
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

/* ---------- small ui atoms ---------- */
const Btn = ({ children, onClick, ghost, disabled, color, style }) => (
  <button
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
    style={{
      fontFamily: sans,
      fontSize: 14,
      fontWeight: 700,
      padding: "10px 14px",
      borderRadius: 10,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.45 : 1,
      border: `1px solid ${ghost ? C.panelEdge : color || C.blue}`,
      background: ghost ? "transparent" : `${color || C.blue}1a`,
      color: ghost ? C.muted : color || C.blue,
      ...style,
    }}
  >
    {children}
  </button>
);
const Label = ({ children }) => <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.14em", color: C.muted, textTransform: "uppercase", marginBottom: 6 }}>{children}</div>;
const Card = ({ children, edge, style }) => (
  <div style={{ background: C.panel, border: `1px solid ${edge || C.panelEdge}`, borderRadius: 14, padding: "14px 16px", marginBottom: 12, ...style }}>{children}</div>
);
const input = { background: C.bg, border: `1px solid ${C.panelEdge}`, color: C.ink, borderRadius: 10, padding: "10px 12px", fontSize: 14, fontFamily: sans, width: "100%", boxSizing: "border-box", outline: "none" };

/* ============================================================
   COVERAGE GRID — the emotional centre of this version.
   The old daily quota is infinite by construction: you can only ever be
   behind. Coverage is bounded, so the pool is something you can FINISH.
   ============================================================ */
function CoverageGrid({ pool, digest }) {
  const cells = pool.members.map((m) => {
    const w = memberWorked(m, digest);
    const h = memberHooked(m);
    return { id: m.id, company: m.company, color: w ? C.green : h ? C.amber : C.panelEdge, title: `${m.company}${w ? " · worked" : h ? " · hooked, not written" : " · untouched"}` };
  });
  const blanks = Math.max(0, pool.targetSize - cells.length);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(15, 1fr)", gap: 3 }}>
      {cells.map((c) => (
        <div key={c.id} title={c.title} style={{ height: 16, borderRadius: 2, background: c.color }} />
      ))}
      {Array.from({ length: blanks }).map((_, i) => (
        <div key={"b" + i} title="empty slot — pool not full" style={{ height: 16, borderRadius: 2, background: "transparent", border: `1px dashed ${C.panelEdge}` }} />
      ))}
    </div>
  );
}

/* ============================================================
   RESEARCH TIMER — enforces the five-minute hook.
   The point isn't the countdown, it's that hitting zero says "write with
   what you have" rather than "keep digging".
   ============================================================ */
function HookTimer({ seconds, running, onToggle, onReset }) {
  const over = seconds <= 0;
  const m = Math.max(0, Math.floor(Math.abs(seconds) / 60));
  const s = Math.max(0, Math.abs(seconds) % 60);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: mono, fontSize: 20, fontWeight: 800, color: over ? C.red : running ? C.amber : C.muted }}>
        {over ? "-" : ""}
        {m}:{String(s).padStart(2, "0")}
      </span>
      <Btn ghost onClick={onToggle} style={{ padding: "6px 10px", fontSize: 12 }}>
        {running ? "Pause" : seconds === RESEARCH_SECONDS ? "Start 5:00" : "Resume"}
      </Btn>
      <Btn ghost onClick={onReset} style={{ padding: "6px 10px", fontSize: 12 }}>
        Reset
      </Btn>
    </div>
  );
}

function PoolMode() {
  const [mainState, setMainState] = useState(null); /* READ ONLY, never written */
  const [ps, setPs] = useState(DEFAULT_POOL_STATE);
  const [loaded, setLoaded] = useState(false);
  const [sync, setSync] = useState("…");
  const [mode, setMode] = useState("dash"); /* dash | build | hook | write | bench */
  const [toast, setToast] = useState("");
  const keyRef = useRef(null);
  const saveTimer = useRef(null);

  const flash = (m) => {
    setToast(m);
    setTimeout(() => setToast(""), 2200);
  };

  /* boot: main record read-only, pool record read/write */
  useEffect(() => {
    (async () => {
      let key = null;
      try {
        key = localStorage.getItem("fd-sync-key");
      } catch (e) {}
      if (!key) {
        setSync("no account");
        setLoaded(true);
        return;
      }
      keyRef.current = key;
      let local = DEFAULT_POOL_STATE;
      try {
        const ls = localStorage.getItem("fd-pool-state");
        if (ls) local = migratePool(JSON.parse(ls));
      } catch (e) {}
      try {
        const [main, pool] = await Promise.all([rpc("fd_get", { k: key }), rpc("fd_get", { k: key + "_pool" }).catch(() => null)]);
        if (main?.data) setMainState(main.data);
        setPs(pool?.data ? migratePool(pool.data) : local);
        setSync("synced");
      } catch (e) {
        setPs(local);
        setSync("offline");
      }
      setLoaded(true);
    })();
  }, []);

  /* save: pool record ONLY. The main key is never a write target. */
  useEffect(() => {
    if (!loaded || !keyRef.current) return;
    try {
      localStorage.setItem("fd-pool-state", JSON.stringify(ps));
    } catch (e) {}
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        setSync("saving");
        await rpc("fd_set", { k: keyRef.current + "_pool", d: ps, c: {} });
        setSync("synced");
      } catch (e) {
        setSync("offline");
      }
    }, 900);
  }, [ps, loaded]);

  const digest = useMemo(() => digestMainState(mainState), [mainState]);
  const pool = useMemo(() => ps.pools.find((p) => p.id === ps.activePoolId) || null, [ps]);
  const stats = useMemo(() => poolStats(pool, digest), [pool, digest]);
  const closed = poolIsClosed(pool);

  const mutatePool = (fn) =>
    setPs((s) => ({ ...s, pools: s.pools.map((p) => (p.id === s.activePoolId ? fn(p) : p)) }));

  /* ---------- build ---------- */
  const createPool = (companies) => {
    const id = uid();
    const built = today();
    const members = companies.map((c) => ({
      id: uid(),
      company: typeof c === "string" ? c : c.company,
      origin: typeof c === "string" ? "new" : c.origin || "new",
      hook: "",
      hookedAt: "",
      researchSecs: 0,
      workedAt: "",
      note: "",
      pushedAt: "",
    }));
    setPs((s) => ({
      ...s,
      adopted: true,
      activePoolId: id,
      pools: [...s.pools, { id, name: `Pool ${s.pools.length + 1}`, builtOn: built, closedUntil: addDays(built, CLOSED_WEEKS * 7), targetSize: POOL_SIZE, members }],
    }));
    setMode("dash");
    flash(`Pool built · ${members.length} companies · closed until ${fmt(addDays(built, CLOSED_WEEKS * 7))}`);
  };

  /* Adding while OPEN goes into the pool. Adding while CLOSED is intercepted
     into the Bench — this is the whole commitment device. A label you can
     ignore isn't a commitment. */
  const addCompany = (name) => {
    const n = (name || "").trim();
    if (!n) return;
    if (!pool) return;
    const exists = pool.members.some((m) => normCompany(m.company) === normCompany(n));
    if (exists) return flash("Already in the pool");
    if (ps.bench.some((b) => normCompany(b.company) === normCompany(n))) return flash("Already on the bench");
    if (closed) {
      setPs((s) => ({ ...s, bench: [{ id: uid(), company: n, addedAt: today() }, ...s.bench] }));
      return flash("Pool is closed — parked on the bench");
    }
    /* typed in here, so Flight Deck has never seen it — mark it for pushing */
    const origin = digest.has(normCompany(n)) ? "existing" : "new";
    mutatePool((p) => ({ ...p, members: [...p.members, { id: uid(), company: n, origin, hook: "", hookedAt: "", researchSecs: 0, workedAt: "", note: "", pushedAt: "" }] }));
    flash(origin === "new" ? "Added — new to Flight Deck" : "Added — already in Flight Deck");
  };

  const setHook = (memberId, hook, secs) =>
    mutatePool((p) => ({
      ...p,
      members: p.members.map((m) => (m.id === memberId ? { ...m, hook, hookedAt: hook.trim() ? today() : "", researchSecs: typeof secs === "number" ? secs : m.researchSecs } : m)),
    }));
  const markWorked = (memberId) =>
    mutatePool((p) => ({ ...p, members: p.members.map((m) => (m.id === memberId ? { ...m, workedAt: m.workedAt ? "" : today() } : m)) }));

  /* refresh: pull five from the bench, extend closure. Never a restart. */
  const refreshPool = () => {
    const take = ps.bench.slice(0, REFRESH_ADD);
    if (!take.length) return flash("Bench is empty — add names first");
    const built = today();
    setPs((s) => ({
      ...s,
      bench: s.bench.slice(take.length),
      pools: s.pools.map((p) =>
        p.id === s.activePoolId
          ? {
              ...p,
              closedUntil: addDays(built, CLOSED_WEEKS * 7),
              members: [
                ...p.members,
                ...take.map((b) => ({ id: uid(), company: b.company, origin: digest.has(normCompany(b.company)) ? "existing" : "new", hook: "", hookedAt: "", researchSecs: 0, workedAt: "", note: "", pushedAt: "" })),
              ],
            }
          : p
      ),
    }));
    flash(`Added ${take.length} from the bench · closed again until ${fmt(addDays(built, CLOSED_WEEKS * 7))}`);
  };

  /* ============================================================
     PUSH TO FLIGHT DECK — the ONLY write to the main record in this app.

     Deliberately append-only and user-triggered, never automatic:
       1. fetch the main record fresh, immediately before writing, so the
          read-modify-write window is as small as possible
       2. refuse outright if it doesn't look like a real Flight Deck record
          (no applications array) — better to do nothing than to clobber
       3. append new applications only. Existing entries are passed through
          byte-for-byte; nothing is edited, reordered or removed
       4. pass the coach object straight back unchanged
       5. mark members pushedAt so a second press can't duplicate them

     Pushed entries carry fromPool + poolName, which is what makes them
     badgeable in Flight Deck and countable by pool pacing. Status is left
     BLANK on purpose: pushing is not outreach. It lands as a tracked lead
     that won't inflate your funnel until you actually write to it.
     ============================================================ */
  const [pushing, setPushing] = useState(false);
  const pushToFlightDeck = async () => {
    if (!pool || pushing) return;
    const pending = pool.members.filter((m) => m.origin === "new" && !m.pushedAt && !digest.has(normCompany(m.company)));
    if (!pending.length) return flash("Nothing new to push");
    setPushing(true);
    try {
      const remote = await rpc("fd_get", { k: keyRef.current });
      const data = remote?.data;
      if (!data || !Array.isArray(data.applications)) {
        setPushing(false);
        return flash("Couldn't read Flight Deck safely — nothing was written");
      }
      const existing = new Set(data.applications.map((a) => normCompany(a.company)).filter(Boolean));
      const toAdd = pending.filter((m) => !existing.has(normCompany(m.company)));
      if (!toAdd.length) {
        mutatePool((p) => ({ ...p, members: p.members.map((m) => (pending.some((x) => x.id === m.id) ? { ...m, pushedAt: today() } : m)) }));
        setPushing(false);
        return flash("All already in Flight Deck — marked as pushed");
      }
      const newApps = toAdd.map((m) => ({
        id: "fd" + Math.random().toString(36).slice(2, 10),
        company: m.company,
        role: "",
        status: "", /* saved-for-later: counts nothing until you actually write */
        contacted: "",
        notes: m.hook ? `Pool hook: ${m.hook}` : "",
        fromPool: true,
        poolName: pool.name,
        followUps: [],
        milestonesLogged: [],
      }));
      await rpc("fd_set", { k: keyRef.current, d: { ...data, applications: [...newApps, ...data.applications] }, c: remote.coach || {} });
      mutatePool((p) => ({ ...p, members: p.members.map((m) => (pending.some((x) => x.id === m.id) ? { ...m, pushedAt: today() } : m)) }));
      flash(`Pushed ${newApps.length} to Flight Deck · tagged 🎯 POOL`);
    } catch (e) {
      flash("Push failed — nothing was written");
    }
    setPushing(false);
  };

  /* weekly write pace — the only recurring number in this version */
  const writtenThisWeek = useMemo(() => {
    if (!pool) return 0;
    const mon = thisMonday();
    return pool.members.filter((m) => m.workedAt && m.workedAt >= mon).length;
  }, [pool]);

  if (!loaded)
    return (
      <div style={{ background: C.bg, minHeight: "100vh", color: C.muted, fontFamily: sans, display: "flex", alignItems: "center", justifyContent: "center" }}>Loading…</div>
    );

  if (!keyRef.current)
    return (
      <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: sans, padding: 20 }}>
        <h2 style={{ fontSize: 18 }}>No Flight Deck account found</h2>
        <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.6 }}>
          Pool Mode reads your existing Flight Deck data from this browser's sync key. Open the main Flight Deck app once on this device, then come back — your companies,
          contacts and history will be here.
        </p>
      </div>
    );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: sans, padding: "16px 14px 60px", maxWidth: 520, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>Pool Mode</div>
          <div style={{ fontSize: 11, color: C.muted }}>Flight Deck · parallel version</div>
        </div>
        <div style={{ fontFamily: mono, fontSize: 10, color: sync === "synced" ? C.green : sync === "offline" ? C.red : C.muted }}>{sync}</div>
      </div>

      <div style={{ background: "rgba(96,165,250,0.07)", border: `1px solid ${C.panelEdge}`, borderRadius: 10, padding: "8px 11px", marginBottom: 14, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
        Reads your real Flight Deck data. Writes only to its own record — your pipeline can't be touched from here.
      </div>

      {!pool ? (
        <BuildScreen digest={digest} onCreate={createPool} />
      ) : mode === "hook" ? (
        <HookSession pool={pool} digest={digest} onSetHook={setHook} onDone={() => setMode("dash")} />
      ) : mode === "write" ? (
        <WriteSession pool={pool} digest={digest} onWorked={markWorked} onDone={() => setMode("dash")} target={ps.weeklyWriteTarget} written={writtenThisWeek} />
      ) : mode === "bench" ? (
        <BenchScreen ps={ps} setPs={setPs} closed={closed} onRefresh={refreshPool} onBack={() => setMode("dash")} onAdd={addCompany} />
      ) : (
        <>
          <Card edge={stats.pct === 100 ? C.green : C.panelEdge}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: C.muted }}>
                {pool.name} · {closed ? "closed" : "open"}
              </span>
              <span style={{ fontFamily: mono, fontSize: 11, color: closed ? C.muted : C.amber }}>{closed ? `reopens ${fmt(pool.closedUntil)}` : "refresh due"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <span style={{ fontFamily: mono, fontSize: 30, fontWeight: 800 }}>{stats.worked}</span>
              <span style={{ fontSize: 15, color: C.muted }}>of {stats.total} worked</span>
            </div>
            <CoverageGrid pool={pool} digest={digest} />
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
              {stats.total - stats.worked} left · {stats.ready} hooked and ready to write · {stats.unhooked} still need a hook
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 4, fontFamily: mono }}>
              <span style={{ color: C.green }}>■</span> worked <span style={{ color: C.amber }}>■</span> hooked <span style={{ color: C.panelEdge }}>■</span> untouched
            </div>
          </Card>

          {stats.ready > 0 ? (
            <Card edge={C.blue} style={{ background: "rgba(96,165,250,0.08)" }}>
              <Label>Today · write session</Label>
              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Write {Math.min(3, stats.ready)} message{Math.min(3, stats.ready) === 1 ? "" : "s"}</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>All have hooks already. No searching needed.</div>
              <Btn onClick={() => setMode("write")} style={{ width: "100%" }}>
                Start writing
              </Btn>
            </Card>
          ) : (
            <Card edge={C.amber} style={{ background: "rgba(245,185,66,0.07)" }}>
              <Label>Today · hook session</Label>
              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Nothing is ready to write</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                {stats.unhooked > 0 ? "Spend one session finding hooks — five minutes each, one line each." : "Every company is worked. Time to refresh the pool."}
              </div>
              <Btn color={C.amber} onClick={() => setMode(stats.unhooked > 0 ? "hook" : "bench")} style={{ width: "100%" }}>
                {stats.unhooked > 0 ? "Start hook session" : "Refresh the pool"}
              </Btn>
            </Card>
          )}

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div>
                <Label>This week</Label>
                <div style={{ fontSize: 15 }}>
                  <span style={{ fontFamily: mono, fontWeight: 800, color: writtenThisWeek >= ps.weeklyWriteTarget ? C.green : C.ink }}>{writtenThisWeek}</span>
                  <span style={{ color: C.muted }}> / {ps.weeklyWriteTarget} written</span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <Label>Pace</Label>
                <div style={{ fontFamily: mono, fontSize: 12, color: C.muted }}>
                  {stats.total - stats.worked > 0 && ps.weeklyWriteTarget > 0 ? `~${Math.ceil((stats.total - stats.worked) / ps.weeklyWriteTarget)} wks to cover` : "pool covered"}
                </div>
              </div>
            </div>
          </Card>

          <Card edge={stats.pending > 0 ? C.blue : C.panelEdge}>
            <Label>Flight Deck sync</Label>
            <div style={{ display: "flex", gap: 14, marginBottom: 10 }}>
              <div>
                <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 800, color: C.green }}>{stats.inFlightDeck}</div>
                <div style={{ fontSize: 11, color: C.muted }}>in Flight Deck</div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 800, color: stats.pending > 0 ? C.blue : C.muted }}>{stats.pending}</div>
                <div style={{ fontSize: 11, color: C.muted }}>new here only</div>
              </div>
            </div>
            {stats.pending > 0 ? (
              <>
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55, marginBottom: 10 }}>
                  Pushing adds them as tracked leads tagged 🎯 POOL — blank status, so nothing inflates your funnel until you actually write. Existing entries are never
                  touched.
                </div>
                <Btn onClick={pushToFlightDeck} disabled={pushing} style={{ width: "100%" }}>
                  {pushing ? "Pushing…" : `Push ${stats.pending} to Flight Deck`}
                </Btn>
              </>
            ) : (
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>Every company here is already tracked in Flight Deck. Nothing to push.</div>
            )}
          </Card>

          <Card edge={closed ? C.panelEdge : C.amber}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 15 }}>{closed ? "🔒" : "🔓"}</span>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{closed ? "Discovery is closed" : "Pool is open"}</span>
            </div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55, marginBottom: 10 }}>
              {closed
                ? "Finding companies isn't this week's job. New names go to the bench and get pulled in at the next refresh."
                : `Closure lapsed on ${fmt(pool.closedUntil)}. Add ${REFRESH_ADD} from the bench and close it again — don't start over.`}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Btn ghost onClick={() => setMode("bench")} style={{ padding: "7px 11px", fontSize: 12 }}>
                Bench · {ps.bench.length}
              </Btn>
              {!closed && (
                <Btn color={C.amber} onClick={refreshPool} style={{ padding: "7px 11px", fontSize: 12 }}>
                  Refresh +{Math.min(REFRESH_ADD, ps.bench.length)}
                </Btn>
              )}
            </div>
          </Card>
        </>
      )}

      {toast && (
        <div style={{ position: "fixed", bottom: 18, left: 14, right: 14, maxWidth: 492, margin: "0 auto", background: C.panel, border: `1px solid ${C.blue}`, borderRadius: 10, padding: "10px 14px", fontSize: 13, textAlign: "center" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   BUILD SCREEN — two sittings, once. Seeds from data you ALREADY have,
   so a 45-company pool is mostly assembled from your real pipeline rather
   than typed from scratch.
   ============================================================ */
function BuildScreen({ digest, onCreate }) {
  const candidates = useMemo(() => {
    const arr = Array.from(digest.values());
    /* unworked first — those are the ones with runway left — then by how much
       intel already exists, so the easiest hooks surface early */
    return arr.sort((a, b) => Number(a.worked) - Number(b.worked) || b.intel.length - a.intel.length || a.company.localeCompare(b.company));
  }, [digest]);
  const [picked, setPicked] = useState(() => new Set());
  const [manual, setManual] = useState("");

  useEffect(() => {
    /* preselect up to a full pool, so the default action is "accept" not "curate" */
    setPicked(new Set(candidates.slice(0, POOL_SIZE).map((c) => c.key)));
  }, [candidates]);

  const toggle = (k) => setPicked((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const manualNames = manual.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const total = picked.size + manualNames.length;

  return (
    <>
      <Card>
        <Label>Build sitting</Label>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
          {total} of {POOL_SIZE} companies
        </div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
          {candidates.length} companies already exist in your Flight Deck data — {candidates.filter((c) => !c.worked).length} of them never contacted. Take them as your starting
          pool, then top up. Once built, the pool closes for {CLOSED_WEEKS} weeks.
        </div>
        <Btn
          onClick={() =>
            onCreate([
              /* adopted from Flight Deck — already tracked there, never pushed */
              ...[...picked].map((k) => digest.get(k)?.company).filter(Boolean).map((c) => ({ company: c, origin: "existing" })),
              /* typed here — Flight Deck has never seen these, so they're pushable */
              ...manualNames.map((c) => ({ company: c, origin: "new" })),
            ])
          }
          disabled={total === 0}
          style={{ width: "100%", marginTop: 12 }}
        >
          Build pool and close it
        </Btn>
        {manualNames.length > 0 && (
          <div style={{ fontSize: 11, color: C.blue, marginTop: 8, lineHeight: 1.5 }}>
            {picked.size} already in Flight Deck · {manualNames.length} new, pushable to Flight Deck after building
          </div>
        )}
      </Card>

      <Card>
        <Label>Add names not yet tracked</Label>
        <textarea value={manual} onChange={(e) => setManual(e.target.value)} placeholder={"One per line, or comma separated"} style={{ ...input, minHeight: 70, resize: "vertical" }} />
      </Card>

      <Label>From your existing data</Label>
      {candidates.length === 0 && <div style={{ color: C.muted, fontSize: 13, padding: "12px 2px" }}>No companies found in your Flight Deck data yet — add names above instead.</div>}
      {candidates.map((c) => {
        const on = picked.has(c.key);
        return (
          <div
            key={c.key}
            onClick={() => toggle(c.key)}
            style={{ display: "flex", gap: 10, alignItems: "flex-start", background: on ? "rgba(96,165,250,0.07)" : "transparent", border: `1px solid ${on ? C.blue : C.panelEdge}`, borderRadius: 10, padding: "9px 11px", marginBottom: 6, cursor: "pointer" }}
          >
            <span style={{ color: on ? C.blue : C.muted, fontSize: 13, flexShrink: 0 }}>{on ? "◉" : "○"}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{c.company}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                {c.worked ? `already contacted${c.lastContact ? ` · ${c.lastContact}` : ""}` : "never contacted"}
                {c.contacts.length ? ` · ${c.contacts.length} contact${c.contacts.length === 1 ? "" : "s"}` : ""}
                {c.intel.length ? " · has notes" : ""}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ============================================================
   HOOK SESSION — five minutes, one line. The single-line field is what
   structurally prevents a dossier; the timer just makes the cap felt.
   Existing notes from Flight Deck are shown so the five minutes are spent
   finding something NEW rather than re-reading what you already wrote.
   ============================================================ */
function HookSession({ pool, digest, onSetHook, onDone }) {
  const queue = pool.members.filter((m) => !memberHooked(m) && !memberWorked(m, digest));
  const [i, setI] = useState(0);
  const m = queue[i] || null;
  const [draft, setDraft] = useState("");
  const [secs, setSecs] = useState(RESEARCH_SECONDS);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setDraft("");
    setSecs(RESEARCH_SECONDS);
    setRunning(false);
  }, [m?.id]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSecs((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (!m)
    return (
      <Card>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Nothing left to hook</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Every unworked company in the pool has a hook. That's a write session waiting for you.</div>
        <Btn onClick={onDone} style={{ width: "100%" }}>
          Back
        </Btn>
      </Card>
    );

  const intel = digest.get(normCompany(m.company));
  const save = () => {
    onSetHook(m.id, draft.trim(), RESEARCH_SECONDS - secs);
    setI((x) => x + 1);
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: C.muted }}>
          Hook session · {i + 1} of {queue.length}
        </span>
        <Btn ghost onClick={onDone} style={{ padding: "6px 10px", fontSize: 12 }}>
          Done
        </Btn>
      </div>

      <Card edge={secs <= 0 ? C.red : C.panelEdge}>
        <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>{m.company}</div>
        <HookTimer seconds={secs} running={running} onToggle={() => setRunning((r) => !r)} onReset={() => { setSecs(RESEARCH_SECONDS); setRunning(false); }} />
        {secs <= 0 && <div style={{ fontSize: 12, color: C.red, marginTop: 8, lineHeight: 1.5 }}>Time's up. Write the hook with what you have — a partial hook beats a perfect dossier you never send.</div>}
      </Card>

      {intel && (intel.intel.length > 0 || intel.contacts.length > 0) && (
        <Card>
          <Label>Already in your data</Label>
          {intel.contacts.slice(0, 3).map((c, k) => (
            <div key={k} style={{ fontSize: 12, color: C.muted, marginBottom: 3 }}>
              {c.name || "unnamed"}
              {c.position ? ` · ${c.position}` : ""}
              {c.status ? ` · ${c.status}` : ""}
            </div>
          ))}
          {intel.intel.slice(0, 2).map((n, k) => (
            <div key={"n" + k} style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.5, borderLeft: `2px solid ${C.panelEdge}`, paddingLeft: 8 }}>
              {n.length > 160 ? n.slice(0, 160) + "…" : n}
            </div>
          ))}
        </Card>
      )}

      <Card>
        <Label>The hook — one line</Label>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 120))}
          placeholder="Rebrand shipped 3 wks ago"
          style={input}
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && save()}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 5 }}>
          <span>One recent post, one launch, one hire. Not a summary.</span>
          <span style={{ fontFamily: mono }}>{draft.length}/120</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Btn ghost onClick={() => setI((x) => x + 1)} style={{ flex: 1 }}>
            Skip
          </Btn>
          <Btn onClick={save} disabled={!draft.trim()} style={{ flex: 2 }}>
            Save hook · next
          </Btn>
        </div>
      </Card>
    </>
  );
}

/* ============================================================
   WRITE SESSION — mode-locked. There is deliberately no way to add a
   company from this screen. That absence is the feature: it's what stops
   discovery bleeding into writing time.
   ============================================================ */
function WriteSession({ pool, digest, onWorked, onDone, target, written }) {
  const queue = pool.members.filter((m) => memberHooked(m) && !memberWorked(m, digest));
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: C.muted }}>
          Write session · {written}/{target} this week
        </span>
        <Btn ghost onClick={onDone} style={{ padding: "6px 10px", fontSize: 12 }}>
          Done
        </Btn>
      </div>

      {queue.length === 0 ? (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Nothing hooked and unwritten</div>
          <div style={{ fontSize: 13, color: C.muted }}>Run a hook session to load the queue back up.</div>
        </Card>
      ) : (
        queue.map((m) => (
          <Card key={m.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {m.company}
                  {m.origin === "new" && !m.pushedAt && !digest.has(normCompany(m.company)) && (
                    <span style={{ fontFamily: mono, fontSize: 9, color: C.blue, border: `1px solid ${C.blue}`, borderRadius: 4, padding: "1px 4px", marginLeft: 6, verticalAlign: "middle" }}>NOT IN FD</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: C.amber, marginTop: 3, lineHeight: 1.45 }}>{m.hook}</div>
                {m.researchSecs > 0 && (
                  <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, marginTop: 4 }}>
                    researched {Math.floor(m.researchSecs / 60)}m{m.researchSecs % 60}s
                  </div>
                )}
              </div>
              <Btn color={C.green} onClick={() => onWorked(m.id)} style={{ padding: "7px 11px", fontSize: 12, flexShrink: 0 }}>
                Sent
              </Btn>
            </div>
          </Card>
        ))
      )}

      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.55, padding: "0 2px" }}>
        Log the outreach in Flight Deck as you normally would — coverage reads your real history too, so marking it here is just for today's count. Nothing gets entered twice.
      </div>
    </>
  );
}

/* ============================================================
   BENCH — the pressure-release valve. Names keep arriving whether the pool
   is closed or not; blocking them outright just makes you fight the app.
   Capture without acting, drain five at a time on refresh.
   ============================================================ */
function BenchScreen({ ps, setPs, closed, onRefresh, onBack, onAdd }) {
  const [name, setName] = useState("");
  const remove = (id) => setPs((s) => ({ ...s, bench: s.bench.filter((b) => b.id !== id) }));
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: C.muted }}>Bench · {ps.bench.length} parked</span>
        <Btn ghost onClick={onBack} style={{ padding: "6px 10px", fontSize: 12 }}>
          Back
        </Btn>
      </div>

      <Card>
        <Label>Park a name</Label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Company name"
            style={input}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                onAdd(name.trim());
                setName("");
              }
            }}
          />
          <Btn
            onClick={() => {
              onAdd(name.trim());
              setName("");
            }}
            disabled={!name.trim()}
            style={{ flexShrink: 0 }}
          >
            Park
          </Btn>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
          {closed ? "Pool is closed, so this goes straight to the bench — that's intended, not a rejection." : "Pool is open, so this goes straight in."}
        </div>
      </Card>

      {ps.bench.length > 0 && (
        <Btn color={C.amber} onClick={onRefresh} style={{ width: "100%", marginBottom: 12 }}>
          Pull {Math.min(REFRESH_ADD, ps.bench.length)} into the pool · close for {CLOSED_WEEKS} more weeks
        </Btn>
      )}

      {ps.bench.map((b, i) => (
        <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.panel, border: `1px solid ${i < REFRESH_ADD ? C.amber : C.panelEdge}`, borderRadius: 10, padding: "9px 11px", marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 14 }}>{b.company}</div>
            <div style={{ fontFamily: mono, fontSize: 10, color: C.muted }}>
              parked {b.addedAt}
              {i < REFRESH_ADD ? " · next up" : ""}
            </div>
          </div>
          <Btn ghost onClick={() => remove(b.id)} style={{ padding: "5px 9px", fontSize: 12 }}>
            ×
          </Btn>
        </div>
      ))}
      {ps.bench.length === 0 && <div style={{ color: C.muted, fontSize: 13, padding: "10px 2px", lineHeight: 1.55 }}>Bench is empty. When a company catches your eye during a closed stretch, park it here instead of breaking the pool.</div>}
    </>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<PoolMode />);
