/* ═══════════════════════════════════════════════════════════════
   SYNCHRONSTUDIO — privates Online-Dubbing-Game
   Statisch (GitHub Pages) + PeerJS (P2P). Host = Autorität.
   Modus A: Line-Booth (Szenen mit "lines"-Timings, Choicer-Voicer-Style)
   Modus B: Realtime (eigene Videos ohne Timings)
   ═══════════════════════════════════════════════════════════════ */

const APP_VERSION = "9.10.31";
const PEER_PREFIX = "syncstudio-emvw-";
// Live: große MP4s liegen nicht auf Pages (Deploy-Limit), sondern kommen vom CDN.
// Lokal weiterhin relative Pfade (scenes/…). blob:/http(s): unverändert durchreichen.
// jsDelivr (GitHub) blockiert Dateien > ~20 MB mit 403 — deshalb MP4s von GitHub Raw.
// Raw liefert application/octet-stream + nosniff → <video src> kann scheitern;
// deshalb laden wir MP4s per fetch als Blob (video/mp4) und zeigen echten Fortschritt.
const CDN_BASE = "https://cdn.jsdelivr.net/gh/synchron-studio/synchronstudio@main/";
const GH_RAW_BASE = "https://raw.githubusercontent.com/synchron-studio/synchronstudio/main/";
function useCdnAssets() {
  try { return /\.github\.io$/i.test(location.hostname); } catch { return false; }
}
function assetUrl(path) {
  if (!path) return path;
  if (/^(https?:|blob:|data:)/i.test(path)) return path;
  if (!useCdnAssets()) return path;
  const p = String(path).replace(/^\.\//, "").replace(/^\//, "");
  if (/\.mp4$/i.test(p)) return GH_RAW_BASE + p;
  return CDN_BASE + p;
}
function sceneVideoSrc() {
  return videoBlobUrl || assetUrl(scene && scene.videoUrl);
}
// ╔══════════════════════════════════════════════════════════════════╗
// ║  TURN-RELAY — HIER DEINE EIGENEN ZUGANGSDATEN EINTRAGEN!          ║
// ║  Nötig, wenn "Raum gefunden, aber Verbindung kommt nicht durch"   ║
// ║  (typisch bei DS-Lite/CGNAT, z. B. Vodafone Kabel oder O2).       ║
// ║                                                                    ║
// ║  Anbieter: ExpressTurn — https://www.expressturn.com              ║
// ║  1 TB/Monat gratis, ohne Kreditkarte (Stand: Umstellung von uns).  ║
// ╚══════════════════════════════════════════════════════════════════╝
const MY_TURN = [
  // ExpressTurn-Account — Freikontingent 1 TB/Monat statt vorher 0,5 GB bei Metered
  { urls: "stun:stun.expressturn.com:3478" },
  { urls: "turn:free.expressturn.com:3478?transport=udp", username: "000000002101101430", credential: "/NtVFzNcrMKmrE1oqCWjY8Kd7RQ=" },
  { urls: "turn:free.expressturn.com:3478?transport=tcp", username: "000000002101101430", credential: "/NtVFzNcrMKmrE1oqCWjY8Kd7RQ=" },
  { urls: "turn:free.expressturn.com:443?transport=tcp",  username: "000000002101101430", credential: "/NtVFzNcrMKmrE1oqCWjY8Kd7RQ=" },
];
const PEER_CONFIG = { config: { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  ...MY_TURN
], iceCandidatePoolSize: 4 } };
const CHUNK_SIZE = 128 * 1024;

// ── State ────────────────────────────────────────────────────
let peer = null, isHost = false, myName = "", myId = "";
let hostConn = null;
const conns = new Map();
let players = [];                 // [{id,name,role,ready,done,total}]

// ── Wiedererkennung über Verbindungsabbrüche hinweg ──────────
// Die Peer-Adresse (myId) ist nach einem Abbruch eine andere. Damit der Host trotzdem
// weiß, WER da wieder anklopft, hat jeder Spieler einen eigenen Schlüssel, der im
// Browser gespeichert bleibt. Nur so kann jemand seine Rolle und seine schon
// aufgenommenen Lines behalten.
let myKey = null;
try { myKey = localStorage.getItem("ss_key"); } catch {}
if (!myKey) {
  myKey = Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  try { localStorage.setItem("ss_key", myKey); } catch {}
}
let raumCode = null;              // aktueller Raum, für den Wiederverbindungs-Versuch
let absichtlichWeg = false;       // per Knopf verlassen → nicht wieder reinversuchen
let wvVersuch = 0, wvTimer = null;
const GNADENFRIST_MS = 120000;    // Lobby: so lange hält der Host einen Platz frei
const GNADENFRIST_PLAY_MS = 300000; // Während Booth/Premiere länger — Verbindungen knacken dort öfter
const rueckkehrTimer = new Map(); // Host: Schlüssel → Timeout bis der Platz freigegeben wird
function gnadenfristMs() {
  const ph = typeof aktuellePhase === "function" ? aktuellePhase() : "";
  if (ph === "scr-booth" || ph === "scr-record" || ph === "scr-playback" || ph === "scr-wait" || ph === "scr-duel-vote" || ph === "scr-rate") {
    return GNADENFRIST_PLAY_MS;
  }
  return GNADENFRIST_MS;
}
let scene = null;
let localVideoBuf = null, videoBlobUrl = null;
let fetchedVideoBlobUrl = null;   // Blob-URL vom CDN-Download (nicht Host-Upload)
let sceneVideoLoadToken = 0;
let myLoadPct = 0;
let myVideoReady = false;
let pendingGoLines = false;
let pendingGoRealtime = false;
let micStream = null;
let audioCtx = null;
let mixItems = [];                // [{role, startAt, buffer}]
let playNodes = [];
let syncOffsetMs = 0;
// Premiere: Original-Stimmen unbesetzter Rollen (Host steuert)
let premOrigOn = true;
let premOrigUnfilled = [];        // [{id, name}]
let premOrigMuted = new Set();    // Rollen-IDs die stumm sind
let premPaused = false;

const $ = (id) => document.getElementById(id);
let show = (id) => {
  const el = $(id); if (!el) return;
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  el.classList.add("active");
};
const status = (id, msg, isErr) => {
  const el = $(id); if (!el) return;
  el.textContent = msg; el.style.color = isErr ? "var(--hot)" : "";
};
function onlinePlayers() { return players.filter(p => !p.offline); }
function sendHost(msg) {
  if (isHost || !hostConn || !hostConn.open) return false;
  try { hostConn.send(msg); return true; } catch (e) { console.warn("sendHost:", e); return false; }
}
function clearSceneCaches() {
  try { origCache.clear(); } catch {}
  try { voiceTrackCache.clear(); } catch {}
  try { voiceTrackLoading.clear(); } catch {}
  try { refPeaksCache.clear(); } catch {}
}
const randCode = () => String(Math.floor(1000 + Math.random() * 9000));
const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));



function watchVideoErrors(vid, statusId) {
  vid.addEventListener("error", () => {
    status(statusId, "❌ Video konnte nicht geladen werden! Wenn du gerade erst hochgeladen hast: GitHub Pages braucht 2–5 Min zum Deployen — kurz warten, dann Strg+Shift+R.", true);
    SFX.err();
  });
  // Schwarze erste Frames: Vorschaubild ein Stück ins Video setzen
  vid.addEventListener("loadedmetadata", () => { if (vid.currentTime === 0 && vid.paused) try { vid.currentTime = 0.4; } catch {} });
}

function setBar(id, pct) {
  const el = $(id);
  if (!el) return;
  el.style.display = pct >= 100 ? "none" : "";
  el.querySelector("i").style.width = Math.min(100, Math.max(0, pct)) + "%";
}
// Wartet, bis das Video wirklich abspielbereit ist (canplaythrough), mit Timeout-Fallback
function waitCanPlay(v, timeoutMs = 20000) {
  return new Promise(res => {
    if (v.readyState >= 3) return res();
    const done = () => { clearTimeout(to); v.removeEventListener("canplaythrough", done); v.removeEventListener("canplay", done); res(); };
    const to = setTimeout(done, timeoutMs);
    v.addEventListener("canplaythrough", done);
    v.addEventListener("canplay", done);
    v.load();
  });
}

function revokeFetchedVideo() {
  if (!fetchedVideoBlobUrl) return;
  try { URL.revokeObjectURL(fetchedVideoBlobUrl); } catch {}
  if (videoBlobUrl === fetchedVideoBlobUrl) videoBlobUrl = null;
  fetchedVideoBlobUrl = null;
}

/** Szene-Video-Zustand leeren (CDN-Blob + Host-Upload), Lade-Flags zurück. */
function clearSceneVideoState() {
  sceneVideoLoadToken++;   // laufende Downloads abbrechen
  revokeFetchedVideo();
  if (videoBlobUrl) {
    try { if (String(videoBlobUrl).startsWith("blob:")) URL.revokeObjectURL(videoBlobUrl); } catch {}
  }
  videoBlobUrl = null;
  localVideoBuf = null;
  myLoadPct = 0;
  myVideoReady = false;
  pendingGoLines = false;
  pendingGoRealtime = false;
  players.forEach(p => { p.loadPct = 0; p.videoReady = false; });
}

/** Lädt eine Video-URL als Blob (richtiger MIME-Typ) und meldet 0–100 % Fortschritt. */
async function fetchVideoAsBlob(url, onProgress) {
  const res = await fetch(url, { mode: "cors", cache: "force-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = await res.arrayBuffer();
    if (onProgress) onProgress(100);
    return URL.createObjectURL(new Blob([buf], { type: "video/mp4" }));
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) {
      if (total > 0) onProgress(Math.min(99, Math.round(received / total * 100)));
      else onProgress(Math.min(95, Math.round(received / (1024 * 1024) * 4)));
    }
  }
  if (onProgress) onProgress(100);
  return URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
}

function reportLoadProgress(pct, ready) {
  myLoadPct = Math.max(0, Math.min(100, pct | 0));
  myVideoReady = !!ready;
  const me = players.find(p => p.id === myId);
  if (me) { me.loadPct = myLoadPct; me.videoReady = myVideoReady; }
  renderPlayers();
  renderBoothPlayers();
  if (isHost) {
    broadcastState({ throttle: !ready });
    checkStartable();
  } else {
    sendHost({ t: "loadProg", pct: myLoadPct, ready: myVideoReady });
  }
}

function flushPendingStart() {
  if (pendingGoLines) { pendingGoLines = false; startBooth(); return; }
  if (pendingGoRealtime) { pendingGoRealtime = false; startRealtime(); }
}

function queueOrStartBooth() {
  if (myRole() == null || myVideoReady || !(scene && scene.videoUrl)) {
    startBooth();
    return;
  }
  pendingGoLines = true;
  status("lobby-status", "Host hat gestartet — dein Video lädt noch (" + myLoadPct + "%). Du springst automatisch rein, sobald es fertig ist.", true);
  try { showToast("⏳ Video lädt noch — du kommst automatisch dazu", "join"); } catch {}
}

function queueOrStartRealtime() {
  if (myRole() == null || myVideoReady || !(scene && scene.videoUrl)) {
    startRealtime();
    return;
  }
  pendingGoRealtime = true;
  status("lobby-status", "Host hat gestartet — dein Video lädt noch (" + myLoadPct + "%). Du springst automatisch rein …", true);
  try { showToast("⏳ Video lädt noch — du kommst automatisch dazu", "join"); } catch {}
}

/** Szene-Video laden: Remote per Blob-Download (Fortschritt + MIME-Fix), Blob-URLs direkt. */
function beginSceneVideoLoad(src) {
  const token = ++sceneVideoLoadToken;
  pendingGoLines = false;
  pendingGoRealtime = false;
  myLoadPct = 0;
  myVideoReady = false;
  revokeFetchedVideo();
  reportLoadProgress(0, false);

  const preview = $("preview");
  if (!src) {
    myVideoReady = true;
    reportLoadProgress(100, true);
    setBar("download-bar", 100);
    return;
  }
  if (/^blob:/i.test(src)) {
    if (preview) preview.src = src;
    myVideoReady = true;
    myLoadPct = 100;
    reportLoadProgress(100, true);
    setBar("download-bar", 100);
    return;
  }

  setBar("download-bar", 0);
  status("lobby-status", "📥 Szene-Video wird geladen … bei langen Szenen kann das etwas dauern.");

  (async () => {
    try {
      const blobUrl = await fetchVideoAsBlob(src, (pct) => {
        if (token !== sceneVideoLoadToken) return;
        myLoadPct = pct;
        setBar("download-bar", pct);
        reportLoadProgress(pct, false);
        status("lobby-status", "📥 Video lädt … " + pct + "%" + (pct < 100 ? " — bitte warten" : ""));
      });
      if (token !== sceneVideoLoadToken) {
        try { URL.revokeObjectURL(blobUrl); } catch {}
        return;
      }
      fetchedVideoBlobUrl = blobUrl;
      videoBlobUrl = blobUrl;
      if (preview) preview.src = blobUrl;
      myLoadPct = 100;
      myVideoReady = true;
      setBar("download-bar", 100);
      reportLoadProgress(100, true);
      status("lobby-status", "✅ Video geladen — Rolle wählen & „Bin bereit“.");
      SFX.ok();
      flushPendingStart();
    } catch (e) {
      if (token !== sceneVideoLoadToken) return;
      console.warn("Video-Blob-Load fehlgeschlagen, Fallback auf Direkt-URL:", e);
      try {
        if (preview) preview.src = src;
        await waitCanPlay(preview, 90000);
        if (token !== sceneVideoLoadToken) return;
        myLoadPct = 100;
        myVideoReady = true;
        setBar("download-bar", 100);
        reportLoadProgress(100, true);
        status("lobby-status", "✅ Video bereit — Rolle wählen & „Bin bereit“.");
        flushPendingStart();
      } catch (e2) {
        console.warn("Video-Fallback auch fehlgeschlagen:", e2);
        myVideoReady = false;
        reportLoadProgress(myLoadPct, false);
        status("lobby-status", "❌ Video konnte nicht geladen werden. Verbindung prüfen — große Szenen (~20 MB) brauchen etwas Geduld.", true);
        SFX.err();
      }
    }
  })();
}

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
// Handy (vor allem iOS) pausiert den Ton, sobald die App kurz im Hintergrund war.
// Beim Zurückkommen und bei der nächsten Berührung wieder anstoßen.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended") {
    try { audioCtx.resume(); } catch {}
  }
});
["pointerdown", "touchstart", "click"].forEach(ev => {
  document.addEventListener(ev, () => {
    if (audioCtx && audioCtx.state === "suspended") { try { audioCtx.resume(); } catch {} }
  }, { capture: true, passive: true });
});

// Datei speichern — am PC immer echter Download in den Downloads-Ordner.
// Teilen-Menü nur auf iPhone/iPad, weil dort der normale Download oft gar nicht geht.
async function saveBlob(blob, dateiname) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) {
    try {
      if (navigator.canShare) {
        const datei = new File([blob], dateiname, { type: blob.type || "application/octet-stream" });
        if (navigator.canShare({ files: [datei] })) {
          await navigator.share({ files: [datei], title: dateiname });
          return "share";
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") return "abort";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = dateiname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "download";
}

// ═════════════════════════════════════════════════════════════
// SFX — komplett synthetisch, keine Dateien
// ═════════════════════════════════════════════════════════════
const SFX = (() => {
  function tone(f, dur = 0.08, type = "square", vol = 0.1, when = 0, slide = 0) {
    try {
      const a = getCtx(), o = a.createOscillator(), g = a.createGain();
      const t = a.currentTime + when;
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(a.destination);
      o.start(t); o.stop(t + dur + 0.05);
    } catch {}
  }
  // Echte Samples aus /sfx — überlappen erlaubt (jedes Mal neues Audio)
  const active = new Set();
  function sample(file, vol = 0.55) {
    try {
      const a = new Audio("sfx/" + file);
      a.volume = Math.max(0, Math.min(1, vol));
      active.add(a);
      a.addEventListener("ended", () => active.delete(a), { once: true });
      const p = a.play();
      if (p && p.catch) p.catch(() => { active.delete(a); });
      return a;
    } catch { return null; }
  }
  function fadeStop(a, ms = 800) {
    if (!a) return;
    const steps = 8, step = ms / steps, start = a.volume;
    let i = 0;
    const iv = setInterval(() => {
      i++;
      try { a.volume = Math.max(0, start * (1 - i / steps)); } catch {}
      if (i >= steps) { clearInterval(iv); try { a.pause(); } catch {} active.delete(a); }
    }, step);
  }
  return {
    click: () => { if (!sample("click.mp3", 0.42)) tone(950, 0.045, "square", 0.05); },
    ok:    () => { tone(660, 0.09, "triangle", 0.11); tone(990, 0.13, "triangle", 0.11, 0.09); },
    beep:  () => tone(440, 0.12, "sine", 0.14),
    go:    () => tone(880, 0.3, "sine", 0.16),
    rec:   () => tone(340, 0.14, "sine", 0.16, 0, 170),
    stop:  () => tone(170, 0.14, "sine", 0.14, 0, 340),
    done:  () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.13, "triangle", 0.1, i * 0.09)),
    err:   () => tone(150, 0.22, "sawtooth", 0.09),
    leave: () => { if (!sample("leave.mp3", 0.6)) [392, 294, 196].forEach((f, i) => tone(f, 0.16, "sine", 0.075, i * 0.1)); },
    back:  () => { sample("back.mp3", 0.5); },
    riser: () => sample("riser.mp3", 0.72),
    winner: () => sample("winner.mp3", 0.78),
    applause: (vol = 0.5) => sample("applause.mp3", vol),
    fadeStop,
    // Trefferton fürs Rhythmus-Spiel: kurz, weich, tonhöhenabhängig von der Wertung
    beathit: (kind) => {
      const f = kind === "perfect" ? 1046 : kind === "good" ? 784 : 587;
      const v = kind === "perfect" ? 0.045 : 0.032;
      tone(f, 0.055, "sine", v);
      if (kind === "perfect") tone(f * 1.5, 0.045, "sine", 0.022, 0.012);
    },
    drumroll: (durationSec = 6) => {
      try {
        const a = getCtx();
        const t0 = a.currentTime + 0.05;
        const noiseBuf = a.createBuffer(1, Math.max(1, a.sampleRate * 0.04), a.sampleRate);
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        const hits = 40;
        for (let i = 0; i < hits; i++) {
          const p = i / hits;
          const t = t0 + durationSec * (1 - Math.pow(1 - p, 2.4));
          const src = a.createBufferSource(); src.buffer = noiseBuf;
          const filt = a.createBiquadFilter(); filt.type = "bandpass"; filt.frequency.value = 180 + p * 220; filt.Q.value = 1.1;
          const g = a.createGain();
          g.gain.setValueAtTime(0.035 + p * 0.09, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
          src.connect(filt); filt.connect(g); g.connect(a.destination);
          try { src.start(t); src.stop(t + 0.06); } catch {}
        }
        const crashLen = Math.max(1, a.sampleRate * 0.5);
        const crashBuf = a.createBuffer(1, crashLen, a.sampleRate);
        const cd = crashBuf.getChannelData(0);
        for (let i = 0; i < crashLen; i++) cd[i] = (Math.random() * 2 - 1) * (1 - i / crashLen);
        const crashSrc = a.createBufferSource(); crashSrc.buffer = crashBuf;
        const crashG = a.createGain();
        const tc = t0 + durationSec;
        crashG.gain.setValueAtTime(0.16, tc);
        crashG.gain.exponentialRampToValueAtTime(0.001, tc + 0.5);
        crashSrc.connect(crashG); crashG.connect(a.destination);
        try { crashSrc.start(tc); crashSrc.stop(tc + 0.55); } catch {}
      } catch {}
    },
  };
})();
document.addEventListener("click", e => { if (e.target.closest("button:not(:disabled)")) SFX.click(); });
window.addEventListener("DOMContentLoaded", () => {
  watchVideoErrors($("preview"), "lobby-status");
  watchVideoErrors($("booth-video"), "booth-status");
  watchVideoErrors($("play-video"), "play-status");
});
document.body.insertAdjacentHTML("beforeend",
  `<button id="patchnotes-btn" style="position:fixed;left:12px;bottom:10px;z-index:99;font-family:var(--font-mono);font-size:.62rem;color:#7a7a88;letter-spacing:.12em;background:linear-gradient(180deg,#1a1a20,#131318);border:1px solid var(--metal);border-radius:5px;padding:5px 11px;cursor:pointer">v${APP_VERSION} · 📋 Patch Notes</button>
   <div id="patchnotes-overlay" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.7);align-items:center;justify-content:center;padding:20px">
     <div style="max-width:520px;width:100%;max-height:80vh;overflow-y:auto;background:#14141b;border:1px solid var(--line);border-radius:16px;padding:22px">
       <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
         <h2 style="margin:0">📋 Patch Notes</h2>
         <button id="patchnotes-close" class="ghost" style="padding:4px 12px">✕</button>
       </div>
       <div id="patchnotes-body" style="display:flex;flex-direction:column;gap:16px;font-size:.9rem;line-height:1.5"></div>
     </div>
   </div>`);

const PATCH_NOTES = [
  { v: "9.10.31", items: [
    "🔊 Line-Lautstärke kommt jetzt auch bei allen anderen in Premiere & Speichern an (nicht nur bei dir selbst)"
  ]},
  { v: "9.10.30", items: [
    "📥 Lange Szenen (z. B. Zenitsu): echter Ladebalken pro Spieler — Host sieht wer noch lädt",
    "🔒 Session startet erst, wenn bei allen Sprechern das Video fertig ist (kein Host-only-Start mehr)",
    "🎬 Große Videos zuverlässiger (als Blob geladen — GitHub-Raw-MIME-Fix)"
  ]},
  { v: "9.10.29", items: [
    "🎧 Pro Line: Stimme links / Mitte / rechts legen (Stereo) — gilt für Premiere & Speichern"
  ]},
  { v: "9.10.28", items: [
    "⬇ Outtakes sofort speichern — Reel wird im Hintergrund fertiggeschnitten"
  ]},
  { v: "9.10.27", items: [
    "🎬 Outtakes: keine Doppel-/Dreifach-Clips mehr (pro Line nur der letzte Blooper)"
  ]},
  { v: "9.10.26", items: [
    "🎬 Outtakes-Speichern: Bildspur gefixt (war nur Ton / wie MP3)"
  ]},
  { v: "9.10.25", items: [
    "🗣 Beim Aufnehmen optional Original mithören (Lautstärke regelbar) — Take bleibt nur deine Stimme"
  ]},
  { v: "9.10.24", items: [
    "🎬 Outtakes-Knopf deutlicher + Outtakes-Reel speichern/herunterladen"
  ]},
  { v: "9.10.23", items: [
    "💾 Premiere schneidet schon beim ersten Anschauen mit — kein automatischer Zweitdurchlauf mehr zum Speichern"
  ]},
  { v: "9.10.22", items: [
    "🎬 Große Videos (über 20 MB) laden wieder — jsDelivr-Limit umgangen (Marin/Zenitsu etc.)"
  ]},
  { v: "9.10.21", items: [
    "🎀 Neue Szene: My Dress-Up Darling — Kawaii Kaiwai Outro (4× Marin)"
  ]},
  { v: "9.10.20", items: [
    "🎬 Neue Szenen: Ghost Stories (Rabbit), Spider-Man NWH Organic Web, SpongeBob Menacingly"
  ]},
  { v: "9.10.19", items: [
    "🎚 Noise Gate weicher + Nebengeräusche raus (Stimme bleibt), Original-Stimmen in Premiere wählbar, Pause für alle"
  ]},
  { v: "9.10.18", items: [
    "🎛 Aufnahme-Welle wie Choicer: Original füllt die Breite, Lautstärke normalisiert (nicht mehr winzig/zu lang)"
  ]},
  { v: "9.10.17", items: [
    "⚡ Leichtere Performance: Visualizer/Mikro-Loop nur wenn nötig, Fortschritt gedrosselt, Offline-Countdown ohne Full-Redraw"
  ]},
  { v: "9.10.16", items: [
    "🔇 Lobby-Vorschauvideo stoppt beim Rundenstart (kein Geister-Ton mehr im Hintergrund)"
  ]},
  { v: "9.10.15", items: [
    "🐛 Viele Sync-Fixes: Offline blockiert Premiere/Mix/Bewertung nicht mehr",
    "🔌 Reload behält Rolle; eigene Videos + Wiederkommen stabiler",
    "🛡 Host-/Gast-Nachrichten getrennt; Duell-Einreichung nicht mehr fälschbar",
    "🏠 Spät dazukommen springt in die laufende Phase; Speichern/Caches robuster"
  ]},
  { v: "9.10.14", items: [
    "⬇ „Video speichern“ zuverlässiger sofort: Mitschnitt robuster, nach Lautstärke-Änderung im Hintergrund neu schneiden"
  ]},
  { v: "9.10.13", items: [
    "🏠 Neue Szene lädt alle aus der Premiere zurück in die Lobby (niemand bleibt dort hängen)"
  ]},
  { v: "9.10.12", items: [
    "🔌 Reconnect-Fix: kein doppelter Spieler mehr nach Rausflug — Platz/Rolle bleiben erhalten",
    "⏳ Längere Wartezeit bei Abbruch während Aufnahme/Premiere (weniger „rausgeworfen“)"
  ]},
  { v: "9.10.11", items: [
    "🎬 Outtakes: Host startet für alle — Takes von allen Spielern gemischt",
    "🔊 „Deine Lautstärke“ greift in der Premiere jetzt zuverlässig (auch für Gäste)"
  ]},
  { v: "9.10.10", items: [
    "⚔️ Hashiras Meet Muzan: Shock-Zeile korrigiert (jetzt Shinobu)"
  ]},
  { v: "9.10.9", items: [
    "⚔️ Neue Szene: Demon Slayer — Hashiras Meet Muzan (9 Rollen)"
  ]},
  { v: "9.10.8", items: [
    "📦 Live-Deploy neu: Videos kommen vom CDN — Higuruma Retrial & alle neuen Szenen wieder online"
  ]},
  { v: "9.10.7", items: [
    "📦 Seite stark verkleinert damit GitHub-Deploy wieder klappt — Higuruma Retrial inkl."
  ]},
  { v: "9.10.6", items: [
    "📦 Live-Deploy gefixt (Higuruma Retrial jetzt online), große Videos etwas verkleinert"
  ]},
  { v: "9.10.5", items: [
    "⚖️ Neue Szene: Jujutsu Kaisen — Higuruma Retrial (3 Rollen)"
  ]},
  { v: "9.10.4", items: [
    "🦸 Neue Szene: SpongeBob — International Justice League (5 Rollen)",
    "⬜ Weiße Balken laufen jetzt richtig bis zur Mitte zusammen"
  ]},
  { v: "9.10.3", items: [
    "⬜ Weiße Balken nur noch in der Aufnahme-Booth — Premiere wieder mit Zahlen-Countdown",
    "🎬 Outtakes als eigener großer Knopf bei der Premiere (sichtbar sobald du Takes neu aufgenommen hast)"
  ]},
  { v: "9.10.2", items: [
    "🔧 Live-Seite wieder korrekt aktualisiert (Besucherzähler greift jetzt)"
  ]},
  { v: "9.10.1", items: [
    "📊 GoatCounter: anonyme Besucherzahlen (wer die Seite öffnet) — Stats unter synchronstudio.goatcounter.com"
  ]},
  { v: "9.10", items: [
    "⬜ Weiße Balken jetzt klein über dem Video (nicht Fullscreen), max. 60% Deckraft",
    "🎭 Kinosaal/Vorhang nur noch beim Podest-Finale — Premiere startet sofort ohne Verzögerung",
    "🤝 SynchroBuddy wirklich nur 1× pro ganzem Match (nicht jede Bewertungsrunde neu)",
    "🎬 Yo Satoru neu gebaut (Rework 1.0.1): jetzt 5 Rollen (Gojo, Kenjaku, Mahito, Jogo, Choso), ~70 Lines, Timing/Audio gefixt"
  ]},
  { v: "9.9", items: [
    "🤝 SynchroBuddy: bei der Bewertung kannst du EINEM Sprecher einen Sticker geben, wenn die Szene richtig gesessen hat — bringt Extra-Punkte",
    "🎭 Premiere mit richtigem Kinosaal: Vorhang auf/zu, dunkler Saal",
    "👏 Applaus auf dem Podium je nach Abstand Platz 1 ↔ 2 (knapper Sieg = anders als klare Dominanz)",
    "⬜ Weiße Balken-Countdown (wie bei Synchronstudios) — an/aus neben dem 3-Sek.-Timer",
    "🎬 Outtakes-Reel: verworfene Takes landen in einer kleinen Blooper-Show nach der Premiere"
  ]},
  { v: "9.8", items: [
    "🏆 Podium-Finale richtig aufgepeppt: dunkle Bühne, Riser-Spannung, Gold/Silber/Bronze-Säulen, Scheinwerfer, Champion-Banner, Mega-Konfetti",
    "🎤 Neue Sounds: Riser (Spannungsaufbau), Gewinner-Fanfare, Publikum-Applaus — plus Klick, Zurück und „jemand hat den Raum verlassen“",
    "4️⃣5️⃣ Platz 4 und 5 erscheinen nach dem Top-3-Reveal unter den Säulen (nicht mehr nur als graue Liste)"
  ]},
  { v: "9.7", items: [
    "✨ Mehr Accessoires: Hasenohren, Sonnenbrille, Brille, Monokel, Partyhut, Mütze, Zauberhut, Blume, Schleife, Schnurrbart, Stern, Bandana",
    "👁 Raumcode in der Lobby lässt sich mit dem Augen-Knopf verwischen (z. B. für Streams) — nochmal tippen zeigt ihn wieder",
    "⏹ Beat-Booth: klarer „Song aus“-Knopf, damit du jederzeit abbrechen kannst"
  ]},
  { v: "9.6", items: [
    "🎭 Szenen-Filter nach Rollenanzahl: unter der Suche z. B. „2 Rollen“, „3 Rollen“, „7+“ — die Kacheln bleiben wie bisher",
    "⚙ Spielmodus nicht mehr als kleines Dropdown: jetzt vier große, klare Taster (Freies Spiel / Match / Battle Royale / Duell), damit man sofort sieht, was aktiv ist"
  ]},
  { v: "9.5", items: [
    "🫧 Neue Szene: „SpongeBob — Blasen-Nachrichten“ (3 Rollen)",
    "🌸 Neue Szene: „Rascal Does Not Dream — Fukashigi no Carte“ (6 Rollen, Opening-Song)",
    "🚗 Neue Szene: „Cars — We got ourselves a Noder“ (5 Rollen)",
    "💬 Neue Szene: „Jujutsu Kaisen — Was ist dein Typ, Itadori?“ (3 Rollen)",
    "⚡ Neue Szene: „Demon Slayer — Zenitsu vs. Kaigaku“ (7 Rollen, kompletter Kampf ~19 Min — stark komprimiert, damit es online lädt)"
  ]},
  { v: "9.4", items: [
    "💥 Neue Szene: „My Hero Academia — All Might vs. Nomu“ (8 Rollen)",
    "🏰 Neue Szene: „Attack on Titan — Ihr Verräter“ (6 Rollen)",
    "🔇 Neue Szene: „A Silent Voice — Mutter und Shouya“ (2 Rollen)",
    "⚖ Neue Szene: „Jujutsu Kaisen — Higurumas erstes Urteil“ (4 Rollen, lange Gerichtsszene)",
    "🪄 Neue Szene: „Harry Potter — Mein Junge“ (5 Rollen)",
    "⚡ Neue Szene: „Jujutsu Kaisen — Todos Black Flash“ (3 Rollen)"
  ]},
  { v: "9.3", items: [
    "🎲 Fix Rollen-Roulette: Bei vielen Rollen und wenigen Spielern kamen immer nur die obersten Rollen dran. Jetzt werden die Rollen wirklich zufällig gemischt",
    "⌨️ Leertaste in der Booth = Aufnehmen / Stoppen — Maus muss nicht mehr ran"
  ]},
  { v: "9.2.1", items: [
    "⬇ Fix: „Video speichern“ öffnet am PC nicht mehr das Windows-Freigeben-Menü, sondern lädt die Datei ganz normal in den Downloads-Ordner"
  ]},
  { v: "9.2", items: [
    "🎬 Neue Szene: „The Incredibles — Wo ist mein Superanzug?“ (2 Rollen: Frozone, Honey)",
    "👁 Neue Szene: „Jujutsu Kaisen — Tojis Auftritt“ (4 Rollen: Nanami, Maki, Dagon, Erzähler)",
    "🚗 Neue Szene: „Cyberpunk Edgerunners — Autoklau“ (6 Rollen: Maine, Kiwi, Rebecca, David, Lucy, Wachmann)",
    "⚡ Video speichern ohne zweites Durchschauen: Beim ersten Anschauen der Premiere wird das fertige Video schon mitgeschnitten. Danach ist „Speichern“ sofort fertig. Falls du die Lautstärke noch änderst, wird einmal im Hintergrund neu geschnitten — zuschauen musst du trotzdem nicht"
  ]},
  { v: "9.1", items: [
    "📱 Handy tauglicher: größere Knöpfe, sichere Ränder (nicht unter der Home-Leiste), kein versehentliches Zoomen beim Tippen, Textfelder zoomen auf dem iPhone nicht mehr rein",
    "🎬 Speichern als MP4, wenn der Browser das kann — direkt für TikTok, Insta und WhatsApp, ohne CapCut. Sonst weiterhin WebM mit Hinweis",
    "🔌 Wieder rein kommen: fliegst du kurz raus (WLAN-Zucken, App-Wechsel), bleibt dein Platz 2 Minuten frei. Du kommst automatisch zurück — mit Rolle und allem, was du schon aufgenommen hast",
    "🔌 Wer bewusst auf „Raum verlassen“ drückt, räumt den Platz sofort. Alle anderen sehen währenddessen „Verbindung weg“ mit Restzeit",
    "🎞 „testplace“ steht in der Szenen-Auswahl immer ganz hinten — nie wieder dazwischen"
  ]},
  { v: "9.0", items: [
    "🎬 Neue Szene: „Dragon Ball Z — Gokus erste Super-Saiyajin-Verwandlung“ (3 Rollen: Son Goku, Freezer, Son Gohan)",
    "🍔 Neue Szene: „SpongeBob — Ist Mayonnaise ein Instrument?“ (7 Rollen: Thaddäus, Patrick, Sandy, SpongeBob, Mr. Krabs, Plankton, Larry der Hummer)",
    "🖤 Schwarzbild-Fehler beim Speichern behoben: Bei manchen Rechnern kam nur Ton und ein schwarzes Video heraus. Das Bild wurde direkt vom Videoplayer abgegriffen, und je nach Grafikkarte kommen da schwarze Bilder an. Jetzt wird jedes Bild einzeln auf eine Zeichenfläche gemalt und DIESE aufgenommen",
    "🖤 Dazu eine Warnung: Wenn das Fenster beim Speichern in den Hintergrund rutscht, bremst der Browser die Aufnahme aus. Das wird jetzt erkannt und gesagt, statt dass du ein kaputtes Video bekommst",
    "🎙 „Studio-Qualität“ klingt endlich gut. Vorher hob der Effekt die Höhen an — und damit genau das Rauschen und Zischeln, das billige Mikrofone zu viel haben. Danach kam noch 55 % Extra-Pegel ohne Bremse obendrauf, das hat schlicht übersteuert",
    "🎙 Neu in der Kette: Höhen werden zurückgenommen statt angehoben, es gibt einen echten Zischlaut-Dämpfer, der nur eingreift wenn es nötig ist, eine sanfte zweistufige Verdichtung mit Limiter als Deckel und einen Ausgleich auf gleiche Lautheit statt auf die lauteste Spitze",
    "🎙 Die Rauschunterdrückung rechnete das Störgeräusch dreifach überhöht heraus — davon kam der dumpfe, gluckernde Klang. Jetzt sanfter und ruhiger, dafür sauber. Nebenbei läuft sie deutlich schneller",
    "📊 Der Visualizer beim Aufnehmen einer Line ist neu: Das Original liegt jetzt OBEN, deine Stimme UNTEN, auf einer gemeinsamen Zeitachse mit Sekunden-Markierungen. So siehst du sofort, ob du zu früh oder zu spät dran bist, statt zwei Wellen übereinander zu entwirren",
    "📊 Dazu eine gestrichelte Linie, wo das Original fertig ist, plus Hinweise „zu leise“ und „zu laut“ direkt im Bild"
  ]},
  { v: "8.9", items: [
    "🔗 Einladungs-Link: In der Lobby gibt's einen Knopf, der einen Link kopiert. Wer draufklickt, hat den Raumcode schon eingetragen — kein Vorlesen und Vertippen mehr",
    "🎞 Szenen-Auswahl komplett neu: statt einer langen Klappliste jetzt ein Raster mit echtem Bild aus jeder Szene und dem Namen clean darunter. Dazu eine Suche über Titel UND Rollennamen",
    "🎚 Neuer Studio-Visualizer beim Sprechen: LED-Ketten wie am Rack-Analyzer, mit nachfallenden Peak-Marken und Übersteuerungs-Lampe. Eingemessen, damit normales Sprechen in der Mitte liegt",
    "🖼 Kaputte Profilbilder raus: „Peter“ und „Lois“ zeigten nur ein leeres Kästchen. Wer eines davon ausgewählt hatte, bekommt automatisch die Auswahl zurückgesetzt",
    "⏱ Timing-Fehler korrigiert: Bei „Sae Vs Rin“ spielte „Original anhören“ ganze 2 Minuten statt eines Rufs, bei „Entertainment District“ war es an zwei Stellen praktisch stumm. Bei „Broly“ hatten zwei Lines gar keine Länge, bei „A Haunted House“ war die Reihenfolge vertauscht",
    "⏱ Aufnahmezeit richtet sich jetzt nach der echten Länge des Originals statt nach der Angabe in den Szenen-Daten — falsche Zeiten bremsen dich damit nicht mehr aus, und die „~X Sek.“-Anzeige stimmt",
    "🩹 Absturz behoben: Zuschauer (ohne Rolle) flogen bei Szenen ohne Line-Timings aus dem Spiel",
    "🩹 Hänger behoben: Ein Duell mit genau 2 Spielern blieb für immer im Abstimm-Screen stehen — jetzt stimmen die beiden selbst ab",
    "🩹 Hänger behoben: Verlor jemand mitten in der Aufnahme die Verbindung, wartete die Runde endlos auf seine Spur. Jetzt startet die Premiere mit dem Rest — und der Host hat zusätzlich einen Notausgang-Knopf"
  ]},
  { v: "8.8", items: [
    "🐛 Fix: „Original anhören“ spielte manchmal die Stimmen einer VORHERIGEN Szene ab — im Match-Modus bei jeder neuen Runde und bei Szenen, die der Host als eigenes Video überträgt",
    "🔧 Ursache endgültig behoben: die Stimmen-Spur wird jetzt pro Datei gemerkt statt in einer gemeinsamen Variable, die man bei jedem Szenenwechsel von Hand leeren musste (genau das wurde 3× vergessen)",
    "⚡ Nebeneffekt: schon geladene Szenen laden beim Zurückwechseln nicht neu, doppelte Klicks lösen nur einen Download aus, und ein fehlgeschlagener Download blockiert den Knopf nicht mehr dauerhaft"
  ]},
  { v: "8.7", items: [
    "🔊 Lautstärke-Regler pro Line: zu leise aufgenommen? Einfach bis auf 400 % hochdrehen — wirkt beim Anhören, in der Premiere und im fertigen Video",
    "⚠ Warnt automatisch, sobald das Hochdrehen in die Übersteuerung läuft (rechnet den echten Spitzenpegel deiner Aufnahme mit)"
  ]},
  { v: "8.6", items: [
    "🎙 Studio-Qualität grundlegend überarbeitet: statt simplem Abziehen läuft jetzt ein Wiener-Filter, der die Dämpfung aus dem zeitlichen Verlauf ableitet und glättet — dadurch verschwindet das metallische Gluckern (Restpegel-Schwankung von 0,25 statt vorher unruhig)",
    "🖱 Mausklicks und Tastenanschläge werden jetzt erkannt und gedämpft (rund 10 dB leiser) — kurze breitbandige Knackser, die eine reine Rauschunterdrückung gar nicht erfassen kann",
    "📈 Stimme bleibt besser erhalten: 78 % statt vorher 62 %",
    "🔊 Fix: Vorhören-Knopf ging nicht (Audio-Kontext war pausiert) und der Stärke-Regler ließ sich danach nicht mehr bedienen — jetzt spielt die Vorschau bei Regler-Änderung direkt mit der neuen Stärke weiter"
  ]},
  { v: "8.5", items: [
    "🎙 Studio-Qualität komplett neu gebaut: statt nur EQ läuft jetzt eine echte Rauschunterdrückung im Frequenzbereich — Grundrauschen, Lüfter- und Netzbrummen werden analysiert und herausgerechnet, gemessen rund 23 dB weniger Störgeräusch bei erhaltener Stimme",
    "🎚 Die Stärke-Regelung steuert dabei mit, wie beherzt aufgeräumt wird"
  ]},
  { v: "8.4", items: [
    "🎙 Neuer Effekt „Studio-Qualität“ — komplette Sende-Kette (Rumpel-Filter, Entmulmung, Präsenz-Anhebung, Zisch-Zähmung, Luft, Kompressor) für alle mit günstigem Mikrofon",
    "🎚 Effekt-Stärke frei regelbar von 0–100 %, wirkt bei JEDEM Effekt — z. B. Hall nur ganz dezent statt voll",
    "🔊 Vorhören-Knopf in der Booth: hört sich deinen Take (oder das Original) durch den eingestellten Effekt an, bevor du dich festlegst",
    "🖼 Editor: Profilbilder pro Rolle direkt hochladen, benennen und mit Vorschau sehen — werden automatisch auf 160px gebracht",
    "🎬 Neue Szene: Demon Slayer — Entertainment District Finale (6 Rollen, 116 Zeilen, 8:38)"
  ]},
  { v: "8.3", items: [
    "🌐 TURN-Server-Anbieter gewechselt: Metered (0,5 GB/Monat frei) → ExpressTurn (1 TB/Monat frei) — betrifft nur Verbindungen über restriktive Netzwerke, ändert am Spiel selbst nichts"
  ]},
  { v: "8.2", items: [
    "🎬 Drei neue Szenen: Dragon Ball Super — Broly Power Up (5 Rollen), Chainsaw Man — Reze & Denji im Café (3 Rollen), Jujutsu Kaisen — You Crying? (5 Rollen)",
    "🎭 13 neue Profilbilder"
  ]},
  { v: "8.1", items: [
    "🔥 Szene „Set Your Heart Ablaze“ war zwar hochgeladen, fehlte aber in der scenes.json — jetzt drin (37 Szenen)"
  ]},
  { v: "8.0", items: [
    "🎤 Fix: Der Mikrofon-Setup startete an einem Klick-Listener, der sich beim ERSTEN Klick irgendwo verbraucht hat — auch wenn dabei gar nichts passiert ist. Danach fragte der Browser nie wieder.",
    "🩺 Klare Fehlermeldungen statt Einheitstext: blockiert, kein Gerät gefunden, oder von Discord/OBS belegt — jeweils mit passender Anleitung"
  ]},
  { v: "7.9", items: [
    "🔥 Neue Szene: Demon Slayer — Set Your Heart Ablaze (Rengoku vs Akaza, 3 Rollen, 36 Zeilen)",
    "🎭 Zwei neue Profilbilder: Rengoku und Tanjiro"
  ]},
  { v: "7.8", items: [
    "🎬 Drei neue Szenen: Demon Slayer — Akaza, Douma & Gyokko im Infinity Castle (von Elias selbst gebaut!), Megamind — Presentation!, und Jujutsu Kaisen — Yo Satoru",
    "🎭 Acht neue Profilbilder: Douma, Gyokko, Akaza, Megamind, Hal, Gojo und Kenjaku"
  ]},
  { v: "7.7", items: [
    "⚡ Noten fallen jetzt fast 3x schneller (0,62 statt 1,7 Sekunden von oben bis zur Linie)",
    "🎯 Dafür deutlich weniger davon: 639 statt 961 — sie kleben nicht mehr aneinander, im Schnitt sind rund 2 gleichzeitig zu sehen",
    "🔀 Längste Serie auf einer Seite von 5 auf 3 runter, mit harter Grenze gegen monotone Blöcke",
    "🐛 Halte-Noten-Bug gefunden: sie verschwanden nach fest eingestellten 0,45 Sekunden — bei 0,9s Haltedauer also exakt auf halbem Weg. Jetzt bleiben sie bis zum Ende sichtbar."
  ]},
  { v: "7.6", items: [
    "🎵 Beat-Booth nochmal deutlich schneller: 961 statt 646 Noten (4,8 statt 3,2 pro Sekunde)",
    "🔀 Abwechslungsreichere Muster — 8 verschiedene Rhythmus-Figuren, die alle paar Takte wechseln und gespiegelt werden; längste Serie auf einer Seite jetzt 4 statt 5+",
    "🟢 Halte-Noten repariert: die Kugel bleibt jetzt sichtbar auf der Trefferlinie stehen statt zu verschwinden, mit grün leuchtendem Rand, Fortschrittsbalken und laufendem Funkenflug",
    "🔊 Trefferton statt Klick: kurz und weich, Tonhöhe richtet sich nach der Wertung"
  ]},
  { v: "7.5", items: [
    "🎵 Beat-Booth deutlich schneller: die Beat-Erkennung hatte nur jeden zweiten Schlag erwischt — jetzt 646 statt 355 Noten (3,2 statt 1,8 pro Sekunde)",
    "💥 Treffer knallen jetzt: Funken fliegen, die Spur blitzt auf, das Bild ruckelt kurz, ein Ring ploppt aus der Taste",
    "🌌 Neue Optik: Noten mit Leuchtschweif und Glanzlicht, Spuren mit Fluchtpunkt-Sog, Hintergrund pulsiert im Takt",
    "🏷️ Trefferanzeige springt größer und wuchtiger ins Bild"
  ]},
  { v: "7.4", items: [
    "🎵 Neues Rhythmus-Spiel „Beat-Booth“ im linken Panel — F für links, J für rechts, im Takt treffen",
    "🎯 Bewertung pro Note: Perfect / Good / OK / Miss, mit Combo-Bonus und Genauigkeit am Ende",
    "🟣 Halte-Noten: manche Noten müssen gedrückt gehalten werden",
    "🔇 Die Musik hört nur, wer selbst spielt — Lobby-Musik pausiert solange automatisch",
    "⏹ Bricht von selbst ab, sobald der Host startet oder es sonst weitergeht"
  ]},
  { v: "7.3", items: [
    "🎥 Kinosaal-Modus: Bei der Premiere fährt der ganze Saal runter — nur die Leinwand bleibt hell und bekommt einen Projektor-Schein",
    "🏆 Podium sind jetzt echte Körper statt flacher Rechtecke: gekippte Deckfläche, Bodenschatten, beleuchteter Siegersockel",
    "👋 Wenn jemand den Raum verlässt, sieht und hört man es jetzt — Einblendung mit Namen plus abfallender Ton",
    "🐛 Fix: Kritzel-Board flackerte beim Malen, weil der eigene laufende Strich bei jedem Neuaufbau kurz verschwand"
  ]},
  { v: "7.2", items: [
    "📊 Lebendiges VU-Meter im Kopfbereich — die LED-Kette folgt deinem Mikro in Echtzeit, mit nachlaufender Spitzenanzeige wie am echten Pult",
    "🎞️ Filmkorn und Vignette über allem — nimmt dem Bild das Sterile, alles wirkt analog statt frisch gerendert",
    "🎛️ Knöpfe sind jetzt echte Geräte-Taster: leicht erhaben, rasten beim Drücken spürbar ein",
    "🔶 Hauptknöpfe in gebürstetem Bernstein statt Farbverlauf"
  ]},
  { v: "7.1", items: [
    "🎛️ Komplettes Redesign — das Spiel sieht jetzt aus wie echtes Studio-Equipment statt wie eine Webseite",
    "🏷️ Überschriften sitzen auf Gaffer-Tape, so wie in echten Studios auf jedes Gerät geklebt wird",
    "🔤 Neue Schriften: Anton für Schlagzeilen (Kinoplakat-Wucht), Barlow für Fließtext, Space Mono für Zahlen & Beschriftungen",
    "🎨 Neue Farbwelt aus echtem Studio-Material: Flightcase-Anthrazit, Röhren-Bernstein, ON-AIR-Rot",
    "📻 Raumcode & Line-Zähler leuchten jetzt wie Geräte-Displays, Kopfzeile ist eine Rack-Blende mit Rändelschrauben",
    "🧰 Karten sind echte Flightcase-Panels mit Nieten, Metallkante und Bürstung — auch im Editor"
  ]},
  { v: "7.0", items: [
    "🔍 Neuer Selbst-Check: Knopf in den Host-Einstellungen prüft alle Szenen-Dateien auf einmal und listet dir kaputte Verweise auf — kein Rätselraten mehr bei „Video lädt nicht“",
    "✨ UI-Politur: eigene Scrollbalken, weicherer Fokus-Glow statt hartem Rahmen, einheitliche Regler & Dropdown-Pfeile, sanfte Screen-Übergänge, Fortschrittsbalken mit Glow"
  ]},
  { v: "6.9", items: [
    "🐛 Fix: Original-Audio spielte manchmal die Stimme der VORHERIGEN Szene ab (Voice-Track-Cache wurde beim direkten Laden über den Host-Dropdown und beim Duell-Start nicht zurückgesetzt)",
    "🎨 Kritzel-Board: feste Pixel-Maße statt verschachteltem Flexbox+Scroll — sollte das Verzerren/Nicht-Sehen bei manchen Browsern (Opera, Avast) beheben",
    "🥊 Duell-Modus: Host muss jetzt aktiv „Beide Versionen abspielen” klicken, startet nicht mehr automatisch; veraltete „X/Y geladen”-Anzeige vom normalen Modus wird ausgeblendet",
    "⏳ Kurze 3-Sekunden-Pause mit Countdown zwischen Duell-Take 1→2 und zwischen Match-Runden, statt direktem Sprung",
    "🏷️ Moduswechsel-Anzeige im Warteraum wird jetzt bei jedem Betreten frisch neu berechnet (gegen veraltete Labels)",
    "🌑 Podium-Finale: Erst wird's dunkel mit aufbauendem Trommelwirbel, dann schwingt der Scheinwerfer episch zur Enthüllung"
  ]},
  { v: "6.8", items: [
    "🐛 Fix: Wer neu dem Raum beitrat, bekam den bisherigen Kritzel-Board-Stand nie mitgeschickt — Leinwand sah leer aus, bis man selbst malte und dadurch (unabsichtlich) alles Vorherige lokal überschrieb",
    "🐛 Fix: Verzerrte/kaputte Striche, falls die Leinwand beim allerersten Klick noch nicht fertig gelayoutet war"
  ]},
  { v: "6.7", items: [
    "🐛 Fix: Seitenpanels waren beim allerersten Laden (Mikro-Screen) noch sichtbar — der Screen ist per HTML von Anfang an aktiv, bevor meine Sichtbarkeits-Logik überhaupt einmal lief"
  ]},
  { v: "6.6", items: [
    "🖼️ Seitenpanels erscheinen jetzt nur noch in Lobby & Warteraum (vorher fälschlich auch bei Mikro-Setup & Co.)",
    "📏 Kritzel-Board & Fun-Fact-Panel deutlich größer, werden bei Bedarf scrollbar",
    "🎬 Neue Szene: Jujutsu Kaisen — Maki vs Naoya mit Mai-Flashback (von dir selbst gebaut!)"
  ]},
  { v: "6.5", items: [
    "🖼️ Kritzel-Board zieht auf breiten Bildschirmen als festes Panel an den rechten Rand um (statt in der Karten-Spalte)",
    "💡 Neues linkes Seitenpanel mit rotierendem Fun-Fact-Ticker zum Ausgleich",
    "🎨 Nur noch ein gemeinsames Board statt zwei getrennter Kopien (Lobby + Warte-Screen)"
  ]},
  { v: "6.4", items: [
    "🎨 Kritzel-Board neu aufgeteilt: Werkzeugleiste links, größere Leinwand rechts",
    "🧽 Radiergummi ergänzt",
    "🌈 Doppelt so viele Farben (7 → 14)"
  ]},
  { v: "6.3", items: [
    "🎨 Kritzel-Board jetzt auch in der Lobby (vorher nur beim Warten nach der Aufnahme)",
    "🎬 Neue Szene: Star Wars — You Turned Her Against Me (Anakin & Obi-Wan)"
  ]},
  { v: "6.2", items: [
    "🎨 Neues Kritzel-Board in der Warte-Arena — alle malen live zusammen auf derselben Leinwand",
    "🐛 Fix: „Original anhören“ konnte bei langsamem Netzwerk verspätet die Stimme der VORHERIGEN Line abspielen, wenn man währenddessen zur nächsten weitergeklickt hat"
  ]},
  { v: "6.1", items: [
    "📋 Raumcode-Kopieren-Button in der Lobby",
    "🚪 Verlassen-Bestätigung als richtiges Modal statt Browser-Popup",
    "🎙 Mikro-Live-Anzeige neben deinem Namen in der Lobby (leuchtet, wenn Ton ankommt)",
    "🔊 Mehrere Effekte kräftiger gemacht (Telefon, Unter Wasser, Monster, Roboter u.a. — die waren zu schwach)",
    "🎭 Drei neue Effekte: Doppelgänger (Chorus), Nachschlag-Echo, Titan (sehr tiefe Stimme)"
  ]},
  { v: "6.0", items: [
    "🖼️ Hintergrund aufgewertet: dezente, unscharfe Charakterbilder aus unseren Szenen schweben jetzt mit den Farbpunkten"
  ]},
  { v: "5.9", items: ["✨ Profil-Accessoires: Katzenohren, Bärenohren, Kopfhörer, Krone, Heiligenschein & Teufelshörner — überlagern jedes Profilbild"] },
  { v: "5.8", items: [
    "🔇 Fix: Minigame-Sounds aus der Warte-Arena waren auch während der Booth-Aufnahme hörbar",
    "🎮 Zwei neue Warte-Arena-Spiele: Schnick-Schnack-Schnuck & Würfel-Duell",
    "🔦 Podium-Finale mit schwingendem Scheinwerfer über ~7 Sekunden bis zur Sieger-Enthüllung"
  ]},
  { v: "5.6", items: [
    "🐛 Fix: Duell-Modus zeigte nur das Ergebnis von wer zuerst fertig war, statt auf beide zu warten (match.mode wurde bei Mitspielern nie richtig übernommen)",
    "🎬 Cross-Origin-Fix fürs Video-Speichern ergänzt"
  ]},
  { v: "5.5", items: ["🎚 Noise Gate live nachjustierbar direkt in der Booth, wirkt sofort auch während laufender Aufnahme"] },
  { v: "5.3–5.4", items: ["🎬 Mehrere neue Szenen (Toji vs Gojo, Who Decided That, Backrooms Research, Death Note Potato Chip u.a.)", "🐛 Fix: „X/Y geladen“-Anzeige blieb hängen, wenn wer während des Ladens die Verbindung trennte"] },
  { v: "5.0–5.2", items: ["🥊 Neuer Duell-Modus: zwei Spieler sprechen dieselbe Rolle unabhängig ein, danach stimmt die Gruppe ab", "🎚 Eigene Effekt-Wahl pro Line beim Aufnehmen (überschreibt Szenen-Standard)", "🌊 Wellenform detaillierter (mehr Auflösung, Verlauf, Peak-Hold)"] },
  { v: "4.8–4.9", items: ["🌊 Dual-Waveform in der Booth: Original (lila) + eigene Stimme (blau) live überlagert", "🏆 Finale als echtes Podium (1./2./3. Platz) statt einfacher Liste", "⭐ Bewertungs-Screen optisch aufgewertet"] },
  { v: "4.7", items: ["✂️ Frame-genaues Timing im Editor, Wellenform-Vorschau beim Line-Setzen", "🔁 Einzelne Lines nachträglich neu einsprechen (Redo), ohne die ganze Szene zu wiederholen"] }
];
$("patchnotes-btn").onclick = () => {
  $("patchnotes-body").innerHTML = PATCH_NOTES.map(g => `
    <div>
      <div style="font-family:var(--font-display);color:var(--amber);margin-bottom:6px">v${g.v}</div>
      <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">${g.items.map(i => `<li>${i}</li>`).join("")}</ul>
    </div>`).join("");
  $("patchnotes-overlay").style.display = "flex";
};
$("patchnotes-close").onclick = () => $("patchnotes-overlay").style.display = "none";
$("patchnotes-overlay").onclick = e => { if (e.target.id === "patchnotes-overlay") $("patchnotes-overlay").style.display = "none"; };

// ═════════════════════════════════════════════════════════════
// MIKROFON — Einstellungen + Processing-Graph
// Aufnahmen laufen durch: Quelle → Brumm-Filter → Gain → recDest
// ═════════════════════════════════════════════════════════════
const micSettings = { deviceId: null, ns: true, ec: true, agc: true, lowcut: true, gain: 1, gate: 0.5 };
let micSrcNode = null, micHP = null, micGain = null, recDest = null, micGateNode = null, gateAn = null;
let vizAn = null, vizRAF = null;
let micReturnScreen = "scr-start";


// Läuft sofort, wenn die Seite schon fertig geladen ist — sonst greift ein
// DOMContentLoaded-Listener zu spät und das Feld bleibt leer.
function whenReady(fn) {
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", fn);
  else fn();
}

// Name & Mikro-Einstellungen merken (bleibt im Browser gespeichert)
try {
  const savedName = localStorage.getItem("ss_name");
  if (savedName) whenReady(() => { $("in-name").value = savedName; });
  const savedMic = JSON.parse(localStorage.getItem("ss_mic") || "null");
  if (savedMic) Object.assign(micSettings, savedMic);
} catch {}
function saveName() { try { localStorage.setItem("ss_name", myName); } catch {} }
function saveMic() { try { localStorage.setItem("ss_mic", JSON.stringify(micSettings)); } catch {} }


// ═════════════════════════════════════════════════════════════
// PROFILBILD — Emoji oder Szenen-Charakter, frei wählbar, gespeichert
// ═════════════════════════════════════════════════════════════
const AVATAR_EMOJIS = ["😎","🔥","💀","🎭","🐻","🤖","👻","🦈","🐸","🎃","👑","🥷","🧛","🦊","🐵","⚡"];
const AVATAR_CHARS = [
  { img: "scenes/dexter/dexter.png", label: "Dexter" },
  { img: "scenes/dexter/doakes.png", label: "Doakes" },
  { img: "scenes/dexter/random_dude.png", label: "Random Dude" },
  { img: "scenes/spongebob/spongebob.png", label: "Spongebob" },
  { img: "scenes/spongebob/patrick.png", label: "Patrick" },
  { img: "scenes/bigsmoke/big_smoke.png", label: "Big Smoke" },
  { img: "scenes/bigsmoke/cj.png", label: "CJ" },
  { img: "scenes/bigsmoke/sweet.png", label: "Sweet" },
  { img: "scenes/invincible/debbie.png", label: "Debbie" },
  { img: "scenes/invincible/mark.png", label: "Mark" },
  { img: "scenes/invincible/nolan.png", label: "Nolan" },
  { img: "scenes/backroomsdinner/clark.png", label: "Clark" },
  { img: "scenes/backroomsdinner/mary.png", label: "Mary" },
  { img: "scenes/jjkdomain/ryo.png", label: "Ryo" },
  { img: "scenes/jjkdomain/narrator.png", label: "Narrator" },
  { img: "scenes/jjkdomain/uro.png", label: "Uro" },
  { img: "scenes/jjkdomain/yuta.png", label: "Yuta" },
  { img: "scenes/jjkdomain/rika.png", label: "Rika" },
  { img: "scenes/jjkdomain/kurourushi.png", label: "Kurourushi" },
  { img: "scenes/breakingbad/tuco.png", label: "Tuco" },
  { img: "scenes/breakingbad/heisenberg.png", label: "Heisenberg" },
  { img: "scenes/breakingbad/otherguy.png", label: "Anderer Typ" },
  { img: "scenes/strongest/geto.png", label: "Geto" },
  { img: "scenes/strongest/gojo.png", label: "Gojo" },
  { img: "scenes/aibubble/deku.png", label: "Deku" },
  { img: "scenes/aibubble/tungtung.png", label: "Tung Tung" },
  { img: "scenes/chickenjockey/steve.png", label: "Steve" },
  { img: "scenes/chickenjockey/garret.png", label: "Garret" },
  { img: "scenes/chickenjockey/jockey.png", label: "Chicken Jockey" },
  { img: "scenes/tojigojo/toji.png", label: "Toji" },
  { img: "scenes/gokussj/goku.png", label: "Son Goku" },
  { img: "scenes/gokussj/freezer.png", label: "Freezer" },
  { img: "scenes/gokussj/gohan.png", label: "Son Gohan" },
  { img: "scenes/mayonnaise/thaddaeus.png", label: "Thaddäus" },
  { img: "scenes/mayonnaise/sandy.png", label: "Sandy" },
  { img: "scenes/mayonnaise/krabs.png", label: "Mr. Krabs" },
  { img: "scenes/mayonnaise/plankton.png", label: "Plankton" },
  { img: "scenes/mayonnaise/larry.png", label: "Larry der Hummer" },
  { img: "scenes/supersuit/frozone.png", label: "Frozone" },
  { img: "scenes/supersuit/honey.png", label: "Honey" },
  { img: "scenes/tojidomain/nanami.png", label: "Nanami" },
  { img: "scenes/tojidomain/maki.png", label: "Maki" },
  { img: "scenes/tojidomain/dagon.png", label: "Dagon" },
  { img: "scenes/edgerunnerscar/maine.png", label: "Maine" },
  { img: "scenes/edgerunnerscar/kiwi.png", label: "Kiwi" },
  { img: "scenes/edgerunnerscar/rebecca.png", label: "Rebecca" },
  { img: "scenes/edgerunnerscar/david.png", label: "David" },
  { img: "scenes/edgerunnerscar/lucy.png", label: "Lucy" },
  { img: "scenes/edgerunnerscar/wachmann.png", label: "Wachmann" },
  { img: "scenes/allmightnomu/allmight.png", label: "All Might" },
  { img: "scenes/allmightnomu/shigaraki.png", label: "Shigaraki" },
  { img: "scenes/allmightnomu/kirishima.png", label: "Kirishima" },
  { img: "scenes/allmightnomu/nomu.png", label: "Nomu" },
  { img: "scenes/allmightnomu/kurogiri.png", label: "Kurogiri" },
  { img: "scenes/allmightnomu/tokoyami.png", label: "Tokoyami" },
  { img: "scenes/allmightnomu/ojiro.png", label: "Ojiro" },
  { img: "scenes/aottraitor/reiner.png", label: "Reiner" },
  { img: "scenes/aottraitor/eren.png", label: "Eren" },
  { img: "scenes/aottraitor/bertolt.png", label: "Bertolt" },
  { img: "scenes/aottraitor/mikasa.png", label: "Mikasa" },
  { img: "scenes/aottraitor/armin.png", label: "Armin" },
  { img: "scenes/aottraitor/historia.png", label: "Historia" },
  { img: "scenes/silentvoice/shouya.png", label: "Shouya" },
  { img: "scenes/silentvoice/mutter.png", label: "Mutter (Silent Voice)" },
  { img: "scenes/higurumatrial/higuruma.png", label: "Higuruma" },
  { img: "scenes/higurumatrial/yuji.png", label: "Yuji" },
  { img: "scenes/higurumatrial/judgeman.png", label: "Judgeman" },
  { img: "scenes/higurumatrial/tengen.png", label: "Tengen" },
  { img: "scenes/harrycedric/harry.png", label: "Harry" },
  { img: "scenes/harrycedric/dumbledore.png", label: "Dumbledore" },
  { img: "scenes/harrycedric/molly.png", label: "Molly" },
  { img: "scenes/harrycedric/amos.png", label: "Amos Diggory" },
  { img: "scenes/todoflash/todo.png", label: "Todo" },
  { img: "scenes/todoflash/takada.png", label: "Takada" },
  { img: "scenes/bubblemsg/spongebob.png", label: "SpongeBob (Blasen)" },
  { img: "scenes/bubblemsg/thaddaeus.png", label: "Thaddäus (Blasen)" },
  { img: "scenes/fukashigi/mai.png", label: "Mai" },
  { img: "scenes/fukashigi/koga.png", label: "Koga" },
  { img: "scenes/fukashigi/futaba.png", label: "Futaba" },
  { img: "scenes/fukashigi/kaede.png", label: "Kaede" },
  { img: "scenes/fukashigi/shoko.png", label: "Shoko" },
  { img: "scenes/fukashigi/nodoka.png", label: "Nodoka" },
  { img: "scenes/noderrr/wingo.png", label: "Wingo" },
  { img: "scenes/noderrr/boost.png", label: "Boost" },
  { img: "scenes/noderrr/dj.png", label: "DJ" },
  { img: "scenes/noderrr/mack.png", label: "Mack" },
  { img: "scenes/noderrr/snotrod.png", label: "Snot Rod" },
  { img: "scenes/zenitsukaigaku/zenitsu.png", label: "Zenitsu" },
  { img: "scenes/zenitsukaigaku/kaigaku.png", label: "Kaigaku" },
  { img: "scenes/zenitsukaigaku/kokushibo.png", label: "Kokushibo" },
  { img: "scenes/zenitsukaigaku/jigoro.png", label: "Jigoro" },
  { img: "scenes/zenitsukaigaku/yushiro.png", label: "Yushiro" },
  { img: "scenes/tojigojo/gojo.png", label: "Gojo (Toji-Kampf)" },
  { img: "scenes/whodecided/escanor.png", label: "Escanor" },
  { img: "scenes/whodecided/estarossa.png", label: "Estarossa" },
  { img: "scenes/whodecided/zeldris.png", label: "Zeldris" },
  { img: "scenes/marriedcouple/shiori.png", label: "Shiori" },
  { img: "scenes/marriedcouple/jiro.png", label: "Jiro" },
  { img: "scenes/potatochip/light.png", label: "Light" },
  { img: "scenes/potatochip/ryuk.png", label: "Ryuk" },
  { img: "scenes/brresearch/bobby.png", label: "Bobby" },
  { img: "scenes/brresearch/clark.png", label: "Clark (Research)" },
  { img: "scenes/brresearch/kat.png", label: "Kat" },
  { img: "scenes/notmywallet/manray.png", label: "Man Ray" },
  { img: "scenes/turnedagainstme/anakin.png", label: "Anakin" },
  { img: "scenes/turnedagainstme/obiwan.png", label: "Obi-Wan" },
  { img: "scenes/makinaoyamai/naoya.png", label: "Naoya" },
  { img: "scenes/makinaoyamai/maki.png", label: "Maki" },
  { img: "scenes/makinaoyamai/mai.png", label: "Mai" },
  { img: "scenes/akazagyokodoumaszenevideo/douma.png", label: "Douma" },
  { img: "scenes/akazagyokodoumaszenevideo/gyokko.png", label: "Gyokko" },
  { img: "scenes/akazagyokodoumaszenevideo/akaza.png", label: "Akaza" },
  { img: "scenes/megamind/megamind.png", label: "Megamind" },
  { img: "scenes/megamind/hal.png", label: "Hal" },
  { img: "scenes/yosatarou/gojo.png", label: "Gojo (Yo Satoru)" },
  { img: "scenes/yosatarou/kenjaku.png", label: "Kenjaku" },
  { img: "scenes/yosatarou/mahito.png", label: "Mahito" },
  { img: "scenes/yosatarou/jogo.png", label: "Jogo" },
  { img: "scenes/yosatarou/choso.png", label: "Choso" },
  { img: "scenes/ablaze/rengoku.png", label: "Rengoku" },
  { img: "scenes/ablaze/tanjiro.png", label: "Tanjiro" },
  { img: "scenes/broly/goku.png", label: "Goku" },
  { img: "scenes/broly/broly.png", label: "Broly" },
  { img: "scenes/broly/paragus.png", label: "Paragus" },
  { img: "scenes/broly/frieza.png", label: "Frieza" },
  { img: "scenes/broly/krillin.png", label: "Krillin" },
  { img: "scenes/reze/reze.png", label: "Reze" },
  { img: "scenes/reze/cafeowner.png", label: "Café-Chef" },
  { img: "scenes/reze/denji.png", label: "Denji" },
  { img: "scenes/crying/gojo.png", label: "Gojo (Crying)" },
  { img: "scenes/crying/utahime.png", label: "Utahime" },
  { img: "scenes/crying/meimei.png", label: "Mei Mei" },
  { img: "scenes/crying/geto.png", label: "Geto" },
  { img: "scenes/crying/shoko.png", label: "Shoko" },
  { img: "scenes/ijlsa/narrator.png", label: "Erzähler (IJL)" },
  { img: "scenes/ijlsa/quickster.png", label: "Quickster" },
  { img: "scenes/ijlsa/captain_magma.png", label: "Captain Magma" },
  { img: "scenes/ijlsa/elastic_waistband.png", label: "Elastic Waistband" },
  { img: "scenes/ijlsa/miss_appear.png", label: "Miss Appear" },
  { img: "scenes/bubblemsg/patrick.png", label: "Patrick (Blasen)" },
  { img: "scenes/higurumaretrial/judge.png", label: "Random Judge" },
  { img: "scenes/higurumaretrial/higuruma.png", label: "Higuruma (Retrial)" },
  { img: "scenes/higurumaretrial/shimizu.png", label: "Shimizu" },
  { img: "scenes/hashirasmeetmuzan/sanemi.png", label: "Sanemi" },
  { img: "scenes/hashirasmeetmuzan/shinobu.png", label: "Shinobu" },
  { img: "scenes/hashirasmeetmuzan/muichiro.png", label: "Muichiro" },
  { img: "scenes/hashirasmeetmuzan/mitsuri.png", label: "Mitsuri" },
  { img: "scenes/hashirasmeetmuzan/obanai.png", label: "Obanai" },
  { img: "scenes/hashirasmeetmuzan/giyu.png", label: "Giyu" },
  { img: "scenes/hashirasmeetmuzan/gyomei.png", label: "Gyomei" },
  { img: "scenes/hashirasmeetmuzan/tanjiro.png", label: "Tanjiro (Hashira)" },
  { img: "scenes/hashirasmeetmuzan/muzan.png", label: "Muzan" },
  { img: "scenes/ghostrabbit/satsuki.png", label: "Satsuki" },
  { img: "scenes/ghostrabbit/mio.png", label: "Mio" },
  { img: "scenes/ghostrabbit/rabbit.png", label: "Rabbit (Ghost Stories)" },
  { img: "scenes/nwhorganic/andrew.png", label: "Andrew Spidey" },
  { img: "scenes/nwhorganic/ned.png", label: "Ned (NWH)" },
  { img: "scenes/nwhorganic/tom.png", label: "Tom Spidey" },
  { img: "scenes/nwhorganic/tobey.png", label: "Tobey Spidey" },
  { img: "scenes/sbmenacing/patrick.png", label: "Patrick (Menacing)" },
  { img: "scenes/sbmenacing/spongebob.png", label: "SpongeBob (Menacing)" },
  { img: "scenes/kawaimarin/marin1.png", label: "Marin 1" },
  { img: "scenes/kawaimarin/marin2.png", label: "Marin 2" },
  { img: "scenes/kawaimarin/marin3.png", label: "Marin 3" },
  { img: "scenes/kawaimarin/marin4.png", label: "Marin 4" },
];
// ── Schwebende Hintergrund-Punkte: Mix aus Farbverlauf-Kreisen und ganz dezenten Charakterbildern aus unseren Szenen ──
(function buildFloaties() {
  const f = document.getElementById("floaties");
  if (!f) return;
  const pool = [...AVATAR_CHARS].sort(() => Math.random() - 0.5).slice(0, 8);
  const TOTAL = 15;
  for (let i = 0; i < TOTAL; i++) {
    const s = document.createElement("span");
    const useImg = i % 2 === 0 && pool.length;   // jede zweite ein Bild, Rest bleibt schlichter Farbpunkt
    if (useImg) {
      const c = pool[(i / 2) % pool.length | 0];
      s.className = "img-orb";
      s.style.backgroundImage = `url('${c.img}')`;
      const sz = 26 + Math.random() * 24;
      s.style.width = s.style.height = sz + "px";
    } else {
      const sz = 6 + Math.random() * 26;
      s.style.width = s.style.height = sz + "px";
    }
    s.style.left = Math.random() * 100 + "%";
    s.style.animationDuration = (14 + Math.random() * 18) + "s";
    s.style.animationDelay = (-Math.random() * 24) + "s";
    f.appendChild(s);
  }
})();
let myAvatar = null;
try { const a = localStorage.getItem("ss_avatar"); if (a) myAvatar = JSON.parse(a); } catch {}
// Ein gespeichertes Charakterbild kann auf eine Datei zeigen, die es nicht mehr gibt
// (Szene entfernt oder umbenannt) — sonst schleppt man ein kaputtes Bild dauerhaft mit.
if (myAvatar && myAvatar.img && !AVATAR_CHARS.some(c => c.img === myAvatar.img)) {
  myAvatar = null;
  try { localStorage.removeItem("ss_avatar"); } catch {}
}

// ── Profil-Accessoires: selbst gezeichnete SVGs, überlagern den Avatar (kein externes Bildmaterial nötig) ──
const ACCESSORIES = {
  catears: { label: "🐱 Katzenohren", svg: `<svg viewBox="0 0 100 60" style="position:absolute;top:-28%;left:0;width:100%;height:70%;overflow:visible">
    <path d="M8,42 L20,4 L34,34 Z" fill="#3a3a46" stroke="#1a1a22" stroke-width="2"/>
    <path d="M66,34 L80,4 L92,42 Z" fill="#3a3a46" stroke="#1a1a22" stroke-width="2"/>
    <path d="M13,36 L21,14 L29,30 Z" fill="#f691b3"/>
    <path d="M71,30 L79,14 L87,36 Z" fill="#f691b3"/>
  </svg>` },
  bearears: { label: "🐻 Bärenohren", svg: `<svg viewBox="0 0 100 60" style="position:absolute;top:-26%;left:0;width:100%;height:65%;overflow:visible">
    <circle cx="20" cy="20" r="16" fill="#8a5a3c" stroke="#5c3a24" stroke-width="2"/>
    <circle cx="80" cy="20" r="16" fill="#8a5a3c" stroke="#5c3a24" stroke-width="2"/>
    <circle cx="20" cy="20" r="8" fill="#e8c9a8"/>
    <circle cx="80" cy="20" r="8" fill="#e8c9a8"/>
  </svg>` },
  bunny: { label: "🐰 Hasenohren", svg: `<svg viewBox="0 0 100 70" style="position:absolute;top:-42%;left:0;width:100%;height:80%;overflow:visible">
    <ellipse cx="28" cy="28" rx="11" ry="28" fill="#f0e6da" stroke="#c4b5a4" stroke-width="2" transform="rotate(-18 28 28)"/>
    <ellipse cx="72" cy="28" rx="11" ry="28" fill="#f0e6da" stroke="#c4b5a4" stroke-width="2" transform="rotate(18 72 28)"/>
    <ellipse cx="28" cy="30" rx="5" ry="16" fill="#f691b3" transform="rotate(-18 28 30)"/>
    <ellipse cx="72" cy="30" rx="5" ry="16" fill="#f691b3" transform="rotate(18 72 30)"/>
  </svg>` },
  headphones: { label: "🎧 Kopfhörer", svg: `<svg viewBox="0 0 100 100" style="position:absolute;top:-14%;left:0;width:100%;height:100%;overflow:visible">
    <path d="M14,52 A36,36 0 0 1 86,52" fill="none" stroke="#e0e0e8" stroke-width="7" stroke-linecap="round"/>
    <rect x="6" y="46" width="16" height="26" rx="7" fill="#c9483a" stroke="#7a1f16" stroke-width="2"/>
    <rect x="78" y="46" width="16" height="26" rx="7" fill="#c9483a" stroke="#7a1f16" stroke-width="2"/>
  </svg>` },
  sunglasses: { label: "🕶 Sonnenbrille", svg: `<svg viewBox="0 0 100 40" style="position:absolute;top:28%;left:0;width:100%;height:40%;overflow:visible">
    <path d="M8,18 H92" stroke="#1a1a22" stroke-width="3"/>
    <rect x="12" y="8" width="30" height="22" rx="6" fill="#1a1a22" stroke="#f0a830" stroke-width="2"/>
    <rect x="58" y="8" width="30" height="22" rx="6" fill="#1a1a22" stroke="#f0a830" stroke-width="2"/>
    <path d="M42,18 H58" stroke="#1a1a22" stroke-width="3"/>
  </svg>` },
  glasses: { label: "🤓 Brille", svg: `<svg viewBox="0 0 100 40" style="position:absolute;top:28%;left:0;width:100%;height:40%;overflow:visible">
    <circle cx="28" cy="20" r="14" fill="none" stroke="#c8c8d0" stroke-width="3.5"/>
    <circle cx="72" cy="20" r="14" fill="none" stroke="#c8c8d0" stroke-width="3.5"/>
    <path d="M42,20 H58" stroke="#c8c8d0" stroke-width="3"/>
    <path d="M14,18 L4,12" stroke="#c8c8d0" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M86,18 L96,12" stroke="#c8c8d0" stroke-width="2.5" stroke-linecap="round"/>
  </svg>` },
  monocle: { label: "🧐 Monokel", svg: `<svg viewBox="0 0 100 50" style="position:absolute;top:22%;left:0;width:100%;height:50%;overflow:visible">
    <circle cx="68" cy="22" r="16" fill="none" stroke="#f0a830" stroke-width="3.5"/>
    <circle cx="68" cy="22" r="11" fill="rgba(200,220,255,.18)"/>
    <path d="M68,38 Q55,55 48,58" fill="none" stroke="#f0a830" stroke-width="2" stroke-dasharray="3 2"/>
  </svg>` },
  crown: { label: "👑 Krone", svg: `<svg viewBox="0 0 100 60" style="position:absolute;top:-34%;left:0;width:100%;height:55%;overflow:visible">
    <path d="M10,50 L10,26 L30,40 L50,14 L70,40 L90,26 L90,50 Z" fill="#ffc95c" stroke="#a87a1a" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="50" cy="12" r="5" fill="#ff6b6b"/>
  </svg>` },
  party: { label: "🎉 Partyhut", svg: `<svg viewBox="0 0 100 70" style="position:absolute;top:-40%;left:0;width:100%;height:70%;overflow:visible">
    <path d="M28,58 L50,6 L72,58 Z" fill="#e63946" stroke="#8a1a22" stroke-width="2"/>
    <path d="M34,58 L50,18 L66,58 Z" fill="#f0a830"/>
    <circle cx="50" cy="8" r="6" fill="#5fe3a1"/>
    <circle cx="38" cy="40" r="3" fill="#fff"/>
    <circle cx="58" cy="34" r="2.5" fill="#fff"/>
  </svg>` },
  beanie: { label: "🧢 Mütze", svg: `<svg viewBox="0 0 100 55" style="position:absolute;top:-30%;left:0;width:100%;height:60%;overflow:visible">
    <ellipse cx="50" cy="38" rx="38" ry="14" fill="#3d6ea8" stroke="#244a78" stroke-width="2"/>
    <path d="M14,38 Q20,8 50,6 Q80,8 86,38" fill="#4a82c4" stroke="#244a78" stroke-width="2"/>
    <circle cx="50" cy="8" r="5" fill="#e63946"/>
  </svg>` },
  wizard: { label: "🧙 Zauberhut", svg: `<svg viewBox="0 0 100 80" style="position:absolute;top:-48%;left:0;width:100%;height:80%;overflow:visible">
    <ellipse cx="50" cy="62" rx="36" ry="10" fill="#2a2a38" stroke="#15151e" stroke-width="2"/>
    <path d="M22,58 L50,4 L78,58 Z" fill="#3a3a4e" stroke="#15151e" stroke-width="2"/>
    <path d="M38,40 L62,40" stroke="#f0a830" stroke-width="3"/>
    <circle cx="52" cy="22" r="2.5" fill="#ffe38a"/>
    <circle cx="42" cy="30" r="1.8" fill="#ffe38a"/>
  </svg>` },
  halo: { label: "😇 Heiligenschein", svg: `<svg viewBox="0 0 100 40" style="position:absolute;top:-38%;left:0;width:100%;height:40%;overflow:visible">
    <ellipse cx="50" cy="20" rx="26" ry="9" fill="none" stroke="#ffe38a" stroke-width="6"/>
  </svg>` },
  horns: { label: "😈 Teufelshörner", svg: `<svg viewBox="0 0 100 60" style="position:absolute;top:-24%;left:0;width:100%;height:55%;overflow:visible">
    <path d="M22,44 Q10,20 26,6 Q22,26 34,38 Z" fill="#c9312b" stroke="#6e130f" stroke-width="2"/>
    <path d="M78,44 Q90,20 74,6 Q78,26 66,38 Z" fill="#c9312b" stroke="#6e130f" stroke-width="2"/>
  </svg>` },
  flower: { label: "🌸 Blume", svg: `<svg viewBox="0 0 100 50" style="position:absolute;top:-18%;left:0;width:100%;height:50%;overflow:visible">
    <g transform="translate(78,22)">
      <circle cx="0" cy="-10" r="7" fill="#f691b3"/>
      <circle cx="9" cy="-3" r="7" fill="#f691b3"/>
      <circle cx="6" cy="8" r="7" fill="#f691b3"/>
      <circle cx="-6" cy="8" r="7" fill="#f691b3"/>
      <circle cx="-9" cy="-3" r="7" fill="#f691b3"/>
      <circle cx="0" cy="0" r="5" fill="#ffe38a"/>
    </g>
  </svg>` },
  bow: { label: "🎀 Schleife", svg: `<svg viewBox="0 0 100 50" style="position:absolute;top:-16%;left:0;width:100%;height:50%;overflow:visible">
    <path d="M50,28 L22,10 Q18,28 28,36 Z" fill="#e63946" stroke="#8a1a22" stroke-width="1.5"/>
    <path d="M50,28 L78,10 Q82,28 72,36 Z" fill="#e63946" stroke="#8a1a22" stroke-width="1.5"/>
    <circle cx="50" cy="28" r="7" fill="#c9312b" stroke="#8a1a22" stroke-width="1.5"/>
  </svg>` },
  mustache: { label: "🥸 Schnurrbart", svg: `<svg viewBox="0 0 100 40" style="position:absolute;top:58%;left:0;width:100%;height:40%;overflow:visible">
    <path d="M18,22 Q32,6 50,20 Q68,6 82,22 Q68,34 50,24 Q32,34 18,22 Z" fill="#3a2a22" stroke="#1a1210" stroke-width="1.5"/>
  </svg>` },
  star: { label: "⭐ Stern", svg: `<svg viewBox="0 0 100 50" style="position:absolute;top:-22%;left:0;width:100%;height:50%;overflow:visible">
    <path d="M78,22 L82,10 L86,22 L98,24 L88,32 L92,44 L82,36 L72,44 L76,32 L66,24 Z" fill="#f0a830" stroke="#a87a1a" stroke-width="1.5"/>
  </svg>` },
  bandana: { label: "🔴 Bandana", svg: `<svg viewBox="0 0 100 50" style="position:absolute;top:-8%;left:0;width:100%;height:50%;overflow:visible">
    <path d="M6,28 Q50,6 94,28 L88,38 Q50,18 12,38 Z" fill="#e63946" stroke="#8a1a22" stroke-width="2"/>
    <path d="M50,14 L62,2 L58,16 Z" fill="#c9312b"/>
  </svg>` }
};
let myAccessory = null;
try { const a2 = localStorage.getItem("ss_accessory"); if (a2) myAccessory = JSON.parse(a2); } catch {}

function avatarHTML(p) {
  const av = p.avatar;
  const acc = p.accessory && ACCESSORIES[p.accessory] ? ACCESSORIES[p.accessory].svg : "";
  const wrap = (inner) => acc ? `<div style="position:relative;display:inline-block">${inner}${acc}</div>` : inner;
  if (av && av.type === "char") return wrap(`<div class="pavatar pavatar-img" style="background-image:url('${av.value}')"></div>`);
  if (av && av.type === "emoji") return wrap(`<div class="pavatar" style="background:${avatarColor(p.name)}">${av.value}</div>`);
  const initial = (p.name || "?").trim().charAt(0).toUpperCase() || "?";
  return wrap(`<div class="pavatar" style="background:${avatarColor(p.name)}">${esc(initial)}</div>`);
}

function renderAvatarPicker() {
  const grid = $("avatar-grid");
  if (!grid) return;
  const emojiHtml = AVATAR_EMOJIS.map(e => `<button class="avatarbtn" data-type="emoji" data-value="${e}">${e}</button>`).join("");
  const charHtml = AVATAR_CHARS.map(c => `<button class="avatarbtn avatarbtn-img" data-type="char" data-value="${c.img}" style="background-image:url(\'${c.img}\')" title="${esc(c.label)}"></button>`).join("");
  grid.innerHTML = `<div class="avatar-section-label">Emoji</div><div class="avatar-row">${emojiHtml}</div>
    <div class="avatar-section-label">Aus unseren Szenen</div><div class="avatar-row">${charHtml}</div>`;
  grid.querySelectorAll(".avatarbtn").forEach(b => b.onclick = () => {
    myAvatar = { type: b.dataset.type, value: b.dataset.value };
    try { localStorage.setItem("ss_avatar", JSON.stringify(myAvatar)); } catch {}
    grid.querySelectorAll(".avatarbtn").forEach(x => x.classList.remove("chosen"));
    b.classList.add("chosen");
    renderAccessoryPreview();
    SFX.click();
  });
  if (myAvatar) {
    const sel = grid.querySelector(`.avatarbtn[data-type="${myAvatar.type}"][data-value="${CSS.escape ? CSS.escape(myAvatar.value) : myAvatar.value}"]`);
    if (sel) sel.classList.add("chosen");
  }
  renderAccessoryPicker();
}

// ── Accessoire-Auswahl: Katzenohren, Kopfhörer & Co. — überlagern das gewählte Profilbild ──
function renderAccessoryPicker() {
  const wrap = $("accessory-grid");
  if (!wrap) return;
  wrap.innerHTML = `<button class="avatarbtn accbtn" data-acc="" title="Kein Accessoire">🚫</button>` +
    Object.entries(ACCESSORIES).map(([k, a]) => `<button class="avatarbtn accbtn" data-acc="${k}" title="${esc(a.label)}">${a.label.split(" ")[0]}</button>`).join("");
  wrap.querySelectorAll(".accbtn").forEach(b => b.onclick = () => {
    myAccessory = b.dataset.acc || null;
    try { localStorage.setItem("ss_accessory", JSON.stringify(myAccessory)); } catch {}
    wrap.querySelectorAll(".accbtn").forEach(x => x.classList.remove("chosen"));
    b.classList.add("chosen");
    renderAccessoryPreview();
    SFX.click();
  });
  const sel = wrap.querySelector(`.accbtn[data-acc="${myAccessory || ""}"]`);
  if (sel) sel.classList.add("chosen");
  renderAccessoryPreview();
}
function renderAccessoryPreview() {
  const el = $("accessory-preview");
  if (!el) return;
  el.innerHTML = avatarHTML({ name: myName || "Du", avatar: myAvatar, accessory: myAccessory });
}

async function buildMic() {
  try {
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: micSettings.deviceId ? { exact: micSettings.deviceId } : undefined,
      echoCancellation: micSettings.ec,
      noiseSuppression: micSettings.ns,
      autoGainControl: micSettings.agc
    }});
    const ctx = getCtx();
    if (!recDest) {
      recDest = ctx.createMediaStreamDestination();
      micHP = ctx.createBiquadFilter(); micHP.type = "highpass";
      micGateNode = ctx.createGain();   // wird NICHT mehr ins Signal eingebunden — nur noch Analyse-Wert fürs Lämpchen
      micGain = ctx.createGain();
      vizAn = ctx.createAnalyser(); vizAn.fftSize = 1024; vizAn.smoothingTimeConstant = 0.75;
      // Wie ein Pegelmesser im Rack einmessen: normales Sprechen soll in der Mitte
      // landen, damit oben noch Luft ist und Rot wirklich „zu laut“ bedeutet.
      vizAn.minDecibels = -85; vizAn.maxDecibels = -20;
      gateAn = ctx.createAnalyser(); gateAn.fftSize = 512;
      micHP.connect(gateAn);                       // Pegel-Analyse fürs Gate-Lämpchen (rein visuell)
      micHP.connect(micGain);                       // Aufgenommenes Signal bleibt roh/ungegatet!
      micGain.connect(recDest); micGain.connect(vizAn);
      startGateLoop();
    }
    if (micSrcNode) micSrcNode.disconnect();
    micSrcNode = ctx.createMediaStreamSource(micStream);
    micSrcNode.connect(micHP);
    applyMicTuning();
    return true;
  } catch (e) {
    const n = e && e.name;
    let msg;
    if (n === "NotAllowedError" || n === "SecurityError")
      msg = "🚫 Mikrofon ist blockiert. Klick links in der Adressleiste auf das Schloss- bzw. Kamera-Symbol, stell Mikrofon auf Zulassen und lade die Seite neu.";
    else if (n === "NotFoundError" || n === "OverconstrainedError")
      msg = "🎤 Kein Mikrofon gefunden. Ist eins angeschlossen? Sonst unten ein anderes Gerät auswählen.";
    else if (n === "NotReadableError")
      msg = "🎤 Mikrofon ist von einem anderen Programm belegt (Discord, OBS, Teams …). Dort schließen und nochmal versuchen.";
    else
      msg = "🎤 Mikro-Zugriff fehlgeschlagen" + (n ? " (" + n + ")" : "") + " — Seite neu laden und nochmal versuchen.";
    status("mic-status", msg, true);
      SFX.err();
    return false;
  }
}
function applyMicTuning() {
  saveMic();
  if (!micHP) return;
  micHP.frequency.value = micSettings.lowcut ? 90 : 5;
  micGain.gain.value = micSettings.gain;
}

// ── Noise Gate: Mikro ist stumm, solange du nicht sprichst ──
let gateOpen = true, lastLoudT = 0;
// ── VU-Meter im Kopfbereich: LED-Kette, die dem Mikro-Pegel folgt ──
const VU_SEGMENTS = 12;
let vuBuilt = false, vuPeak = 0, vuPeakT = 0;
function updateVuMeter(rms) {
  const wrap = $("vu-leds");
  if (!wrap) return;
  if (!vuBuilt) { wrap.innerHTML = "<i></i>".repeat(VU_SEGMENTS); vuBuilt = true; }
  // RMS ist typischerweise sehr klein — auf eine Skala ziehen, bei der normales Sprechen
  // im mittleren Bereich landet und nur echtes Anschreien ganz oben rot wird
  const level = Math.min(1, Math.pow(Math.max(0, rms) * 3.6, 0.72));
  const lit = Math.round(level * VU_SEGMENTS);
  const now = performance.now();
  if (lit >= vuPeak) { vuPeak = lit; vuPeakT = now; }
  else if (now - vuPeakT > 700) vuPeak = Math.max(lit, vuPeak - 1), vuPeakT = now - 640;   // Spitzenwert klingt langsam ab
  const kids = wrap.children;
  for (let i = 0; i < VU_SEGMENTS; i++) {
    const el = kids[i];
    if (!el) continue;
    const isLit = i < lit, isPeak = i === vuPeak - 1 && vuPeak > lit;
    el.className = (isLit || isPeak) ? (i >= VU_SEGMENTS - 2 ? "on-hi" : i >= VU_SEGMENTS - 5 ? "on-mid" : "on-lo") : "";
    el.style.opacity = isPeak && !isLit ? ".55" : "1";
    el.style.height = (42 + (i / VU_SEGMENTS) * 58) + "%";   // Treppe nach oben, wie am echten Gerät
  }
}

let gateRAF = null;
function stopGateLoop() {
  if (gateRAF) { cancelAnimationFrame(gateRAF); gateRAF = null; }
}
function startGateLoop() {
  stopGateLoop();
  if (!gateAn) return;
  const buf = new Float32Array(gateAn.fftSize);
  function loop() {
    gateRAF = null;
    // Kein Mikro oder Tab im Hintergrund → Loop pausieren (Visibility startet neu)
    if (!micStream || document.hidden) return;
    gateAn.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();

    // Lobby-Mikro-Live-Anzeige: unabhängig vom Gate, zeigt einfach "kommt gerade Ton an"
    const liveDot = $("mic-live-dot");
    if (liveDot) liveDot.style.background = rms > 0.02 ? "var(--ok)" : "#3a3a46";
    updateVuMeter(rms);

    const thr = micSettings.gate * 0.16;            // Slider 0..1 → Schwelle 0..0.16 RMS (deutlich stärker)
    if (thr <= 0) {
      if (!gateOpen) { micGateNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.01); gateOpen = true; }
      const lamp0 = $("gate-lamp"), lamp02 = $("booth-gate-lamp");
      if (lamp0) lamp0.style.background = "var(--ok)";
      if (lamp02) lamp02.style.background = "var(--ok)";
    } else {
      if (rms > thr) lastLoudT = now;
      if (rms > thr && !gateOpen) { micGateNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.004); gateOpen = true; }
      else if (gateOpen && now - lastLoudT > 200) { micGateNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05); gateOpen = false; }
      const lamp = $("gate-lamp"), lamp2 = $("booth-gate-lamp");
      if (lamp) lamp.style.background = gateOpen ? "var(--ok)" : "#3a3a46";
      if (lamp2) lamp2.style.background = gateOpen ? "var(--ok)" : "#3a3a46";
    }
    gateRAF = requestAnimationFrame(loop);
  }
  gateRAF = requestAnimationFrame(loop);
}

function recStream() { return recDest.stream; }
async function ensureMic() { return micStream ? true : buildMic(); }

async function populateDevices() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
    $("mic-device").innerHTML = devs.map(d => `<option value="${d.deviceId}">${esc(d.label || "Mikrofon")}</option>`).join("");
    if (micSettings.deviceId) $("mic-device").value = micSettings.deviceId;
  } catch {}
}


// ── Dual-Waveform: lila = Original-Referenz-Peaks (statisch), blau = eigene Stimme (live während Aufnahme) ──
const refPeaksCache = new Map();
async function getRefPeaks(l, cols) {
  const key = l.idx + "|v2|" + cols;
  if (refPeaksCache.has(key)) return refPeaksCache.get(key);
  try {
    const buffer = await getLineOrigBuffer(l);
    if (!buffer) return null;
    const raw = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(raw.length / cols));
    const peaks = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      let max = 0, sum = 0, n = 0;
      const a0 = i * step, a1 = Math.min((i + 1) * step, raw.length);
      for (let j = a0; j < a1; j++) {
        const a = Math.abs(raw[j]);
        if (a > max) max = a;
        sum += a; n++;
      }
      // Peak + etwas RMS → dickere, lesbarere Welle (näher an Choicer Voicer)
      peaks[i] = Math.max(max, n ? (sum / n) * 2.2 : 0);
    }
    // Lautstärke normalisieren: leiseste Originals füllen trotzdem die Höhe
    let loud = 0;
    for (let i = 0; i < cols; i++) if (peaks[i] > loud) loud = peaks[i];
    if (loud > 0.015) {
      const scale = 0.94 / loud;
      for (let i = 0; i < cols; i++) peaks[i] = Math.min(1, peaks[i] * scale);
    }
    const result = { peaks, duration: buffer.duration };
    refPeaksCache.set(key, result);
    return result;
  } catch { return null; }
}

// ═════════════════════════════════════════════════════════════
// TAKE-ANSICHT — Original oben, eigene Stimme unten, gemeinsame Zeitachse
// Getrennt statt übereinander: so sieht man mit einem Blick, ob man zu früh
// oder zu spät dran ist, statt zwei ineinanderliegende Wellen zu entwirren.
// Vorschau (nur Original): gespiegelt + volle Breite wie bei Choicer Voicer.
// ═════════════════════════════════════════════════════════════
const VIZ_COLS = 200;
let liveVoicePeaks = null, liveVoiceIdx = -1, currentRefPeaks = null, recording = false;
let vizWindowSec = 3, vizElapsed = 0, vizLoudest = 0, vizClip = 0;

// Aufnahme-Fenster: Original-Länge + etwas Luft — nicht künstlich auf 2,5s aufblasen
function recWindowFor(l) {
  const nextL = (scene && scene.lines) ? scene.lines[l.idx + 1] : null;
  const room = nextL ? Math.max(0.2, nextL.t - l.end) : 0.75;
  const speak = lineSpeakSeconds(l);
  const pad = Math.min(0.85, Math.max(0.3, room * 0.7));
  return Math.min(16, Math.max(0.7, speak + pad));
}

// Gefüllte Wellenform als Treppenzug — liest sich als zusammenhängende Welle
// statt als lose Striche.
function fillWave(g, farbe, mid, richtung, hoehe, W, spalten, bis, amp) {
  const colW = W / spalten;
  g.beginPath();
  g.moveTo(0, mid);
  for (let i = 0; i <= bis; i++) {
    const y = mid + richtung * Math.max(0.012, Math.min(1, amp(i))) * hoehe;
    g.lineTo(i * colW, y);
    g.lineTo((i + 1) * colW, y);
  }
  g.lineTo((bis + 1) * colW, mid);
  g.closePath();
  g.fillStyle = farbe;
  g.fill();
}

function refAmpAt(i, fenster, dur, peaks) {
  const t = (i / VIZ_COLS) * fenster;
  if (t > dur) return 0;
  return peaks[Math.min(peaks.length - 1, Math.floor((t / Math.max(0.001, dur)) * peaks.length))] || 0;
}

function drawTakeViz() {
  const canvas = $("viz");
  if (!canvas) return;
  const g = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  g.clearRect(0, 0, W, H);

  const fenster = Math.max(0.4, vizWindowSec);
  const padY = 6 * dpr;
  const previewOnly = !recording && !(liveVoicePeaks && liveVoiceIdx >= 0);
  const mid = Math.round(H * (previewOnly ? 0.5 : 0.48));
  const obenH = mid - padY, untenH = H - padY - mid;

  // ── Zeitraster mit Sekunden ──
  const schritt = fenster > 12 ? 5 : fenster > 6 ? 2 : fenster > 2.5 ? 1 : 0.5;
  g.font = "700 " + (9 * dpr) + "px ui-monospace, monospace";
  g.textBaseline = "top";
  for (let s = schritt; s < fenster - 0.05; s += schritt) {
    const x = (s / fenster) * W;
    g.fillStyle = "rgba(255,255,255,.08)";
    g.fillRect(x, padY, Math.max(1, dpr), H - padY * 2);
    g.fillStyle = "rgba(255,255,255,.4)";
    g.fillText((s % 1 ? s.toFixed(1) : s) + "s", x + 4 * dpr, mid + 3 * dpr);
  }

  // ── Wo das Original zu Ende ist (nur wenn Aufnahme-Fenster länger ist) ──
  if (!previewOnly && currentRefPeaks && currentRefPeaks.duration < fenster - 0.05) {
    const x = (currentRefPeaks.duration / fenster) * W;
    g.fillStyle = "rgba(226,150,255,.45)";
    for (let y = padY; y < H - padY; y += 6 * dpr) g.fillRect(x, y, Math.max(1, dpr), 3 * dpr);
  }

  if (currentRefPeaks && currentRefPeaks.peaks.length) {
    const p = currentRefPeaks.peaks, dur = currentRefPeaks.duration || fenster;
    // Vorschau: Welle füllt die ganze Breite (Fenster = Orig-Länge). Aufnahme: Orig links.
    const bis = previewOnly
      ? VIZ_COLS - 1
      : Math.max(0, Math.min(VIZ_COLS - 1, Math.round((Math.min(dur, fenster) / fenster) * VIZ_COLS) - 1));
    const amp = i => refAmpAt(i, fenster, dur, p);

    if (previewOnly) {
      // Choicer-Style: gespiegelte Magenta-Welle, füllt die Höhe
      const h = Math.min(obenH, untenH) * 0.92;
      const gradUp = g.createLinearGradient(0, mid, 0, mid - h);
      gradUp.addColorStop(0, "rgba(180,70,230,.55)"); gradUp.addColorStop(1, "rgba(255,140,255,.98)");
      const gradDn = g.createLinearGradient(0, mid, 0, mid + h);
      gradDn.addColorStop(0, "rgba(160,50,200,.5)"); gradDn.addColorStop(1, "rgba(120,40,160,.85)");
      fillWave(g, gradUp, mid, -1, h, W, VIZ_COLS, bis, amp);
      fillWave(g, gradDn, mid, 1, h, W, VIZ_COLS, bis, amp);
    } else {
      const grad = g.createLinearGradient(0, mid, 0, padY);
      grad.addColorStop(0, "rgba(150,60,220,.55)"); grad.addColorStop(1, "rgba(240,170,255,.98)");
      fillWave(g, grad, mid, -1, obenH * 0.95, W, VIZ_COLS, bis, amp);
    }
  }

  // ── Eigene Stimme nach unten (normalisiert auf bisher lauteste Stelle) ──
  if (liveVoicePeaks && liveVoiceIdx >= 0) {
    const liveScale = 1 / Math.max(0.16, vizLoudest);
    const grad = g.createLinearGradient(0, mid, 0, H - padY);
    grad.addColorStop(0, "rgba(60,130,240,.55)"); grad.addColorStop(1, "rgba(150,215,255,.98)");
    fillWave(g, grad, mid, 1, untenH * 0.95, W, VIZ_COLS, liveVoiceIdx, i => Math.min(1, (liveVoicePeaks[i] || 0) * liveScale));
  }

  // ── Mittellinie ──
  g.fillStyle = "rgba(255,255,255,.28)";
  g.fillRect(0, mid - dpr * 0.5, W, Math.max(1, dpr));

  g.font = "700 " + (9 * dpr) + "px ui-monospace, monospace";
  if (previewOnly) {
    g.fillStyle = "rgba(240,180,255,.95)";
    g.textBaseline = "top"; g.fillText("ORIGINAL", 6 * dpr, padY + dpr);
  } else {
    g.fillStyle = "rgba(240,180,255,.95)";
    g.textBaseline = "top"; g.fillText("ORIGINAL", 6 * dpr, padY + dpr);
    g.fillStyle = "rgba(170,225,255,.95)";
    g.textBaseline = "bottom"; g.fillText("DU", 6 * dpr, H - padY);
  }

  // ── Laufmarke + Hinweise während der Aufnahme ──
  if (recording) {
    const x = (Math.min(fenster, vizElapsed) / fenster) * W;
    g.fillStyle = "rgba(255,255,255,.25)";
    g.fillRect(x, padY, Math.max(1, 3 * dpr), H - padY * 2);
    g.fillStyle = "#fff";
    g.fillRect(x, padY, Math.max(1, 1.4 * dpr), H - padY * 2);

    let hinweis = null, farbe = null;
    if (vizClip > 0) { hinweis = "ZU LAUT"; farbe = "#e63946"; }
    else if (vizElapsed > 0.7 && vizLoudest < 0.1) { hinweis = "ZU LEISE — NÄHER RAN"; farbe = "#f0a830"; }
    if (hinweis) {
      g.font = "700 " + (8 * dpr) + "px ui-monospace, monospace";
      const b = g.measureText(hinweis).width + 10 * dpr;
      g.fillStyle = "rgba(8,8,12,.85)";
      g.fillRect(W - b - 5 * dpr, padY + dpr, b, 12 * dpr);
      g.fillStyle = farbe;
      g.textBaseline = "middle";
      g.fillText(hinweis, W - b, padY + 7 * dpr);
    }
  }
}

function startDualViz(canvasId, l, recMaxSec) {
  vizWindowSec = recMaxSec;
  vizElapsed = 0; vizLoudest = 0; vizClip = 0;
  liveVoicePeaks = new Float32Array(VIZ_COLS);
  liveVoiceIdx = -1;
  currentRefPeaks = null;
  getRefPeaks(l, VIZ_COLS).then(r => { currentRefPeaks = r; });
  const wave = new Float32Array(vizAn.fftSize);
  cancelAnimationFrame(vizRAF);
  const t0 = performance.now();
  (function draw() {
    vizRAF = requestAnimationFrame(draw);
    if (recording) {
      // Lautstärke aus dem Zeitsignal (RMS) statt aus einzelnen Frequenzbändern:
      // misst die tatsächlich gesprochene Lautheit und bleibt unabhängig von der FFT-Größe.
      vizAn.getFloatTimeDomainData(wave);
      let sq = 0, spitze = 0;
      for (let i = 0; i < wave.length; i++) { const a = wave[i]; sq += a * a; const b = Math.abs(a); if (b > spitze) spitze = b; }
      const level = Math.min(1, Math.sqrt(sq / wave.length) * 4.2);
      vizElapsed = (performance.now() - t0) / 1000;
      vizClip = spitze > 0.985 ? 1.2 : Math.max(0, vizClip - 0.016);
      if (level > vizLoudest) vizLoudest = level;
      const col = Math.min(VIZ_COLS - 1, Math.floor((vizElapsed / vizWindowSec) * VIZ_COLS));
      liveVoicePeaks[col] = Math.max(liveVoicePeaks[col], level);
      // Übersprungene Spalten auffüllen, damit keine Löcher entstehen, wenn ein Bild ausfällt
      for (let i = Math.max(0, liveVoiceIdx); i < col; i++) if (!liveVoicePeaks[i]) liveVoicePeaks[i] = level * 0.7;
      liveVoiceIdx = Math.max(liveVoiceIdx, col);
    }
    drawTakeViz();
  })();
}

// ── Vorschau, bevor man überhaupt aufnimmt: nur das Original, volle Breite ──
function drawStaticRefViz() { drawTakeViz(); }
function previewRefViz(l) {
  cancelAnimationFrame(vizRAF);
  currentRefPeaks = null; recording = false;
  liveVoicePeaks = null; liveVoiceIdx = -1;
  vizElapsed = 0; vizLoudest = 0; vizClip = 0;
  // Vorläufig Szenen-Fenster, nach Laden = echte Original-Länge (volle Breite)
  vizWindowSec = Math.max(0.7, l.end - l.t);
  drawTakeViz();
  getRefPeaks(l, VIZ_COLS).then(r => {
    currentRefPeaks = r;
    if (myLines[curLine] !== l) return;
    if (r && r.duration > 0.25) vizWindowSec = r.duration;
    else vizWindowSec = recWindowFor(l);
    showLineDuration(l);
    drawTakeViz();
  });
}

// Wie lange dauert diese Line wirklich? Bevorzugt Original-Audio, aber keine
// riesigen Ausreißer wenn die Datei/Timing falsch ist.
function lineSpeakSeconds(l) {
  const win = Math.max(0.3, (l.end || 0) - (l.t || 0));
  const ref = currentRefPeaks && currentRefPeaks.duration || 0;
  if (!ref) return win;
  if (ref > win * 2.8) return win;   // Orig verdächtig lang → Szenen-Fenster
  return Math.max(0.3, Math.min(Math.max(ref, win * 0.85), ref + 0.2));
}
function showLineDuration(l) {
  const el = $("line-dur");
  if (el) el.textContent = "~" + Math.max(1, Math.round(lineSpeakSeconds(l))) + " Sek.";
}

// ── Studio-Spektrum: logarithmisch verteilte Bänder als LED-Ketten ──
// Wie an einem echten Analyzer im Rack: unten grün, oben Bernstein/Rot, dazu
// Peak-Haltemarken, die langsam nachfallen, und eine Übersteuerungs-Lampe.
const VIZ_BANDS = 30;
const VIZ_SEGMENTS = 15;
function bandEdges(bands, sampleRate, fftSize) {
  const lo = 55, hi = Math.min(15000, sampleRate / 2);
  const binOf = f => Math.max(0, Math.min(fftSize / 2 - 1, Math.round(f / (sampleRate / fftSize))));
  const out = [];
  for (let i = 0; i < bands; i++) {
    const f0 = lo * Math.pow(hi / lo, i / bands);
    const f1 = lo * Math.pow(hi / lo, (i + 1) / bands);
    const b0 = binOf(f0);
    out.push([b0, Math.max(b0 + 1, binOf(f1))]);
  }
  return out;
}
function startVizOn(canvasId) {
  const canvas = $(canvasId);
  if (!canvas || !vizAn) return;
  const g = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const freq = new Uint8Array(vizAn.frequencyBinCount);
  const wave = new Float32Array(vizAn.fftSize);
  const edges = bandEdges(VIZ_BANDS, getCtx().sampleRate, vizAn.fftSize);
  const level = new Float32Array(VIZ_BANDS);      // geglätteter Pegel je Band
  const hold = new Float32Array(VIZ_BANDS);       // Peak-Haltemarke
  let clipFlash = 0, last = performance.now();
  cancelAnimationFrame(vizRAF);
  (function draw(now) {
    vizRAF = requestAnimationFrame(draw);
    const dt = Math.min(0.1, ((now || performance.now()) - last) / 1000);
    last = now || performance.now();
    const W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    g.clearRect(0, 0, W, H);

    vizAn.getByteFrequencyData(freq);
    vizAn.getFloatTimeDomainData(wave);

    // Übersteuerung erkennen (Zeitsignal, nicht Spektrum — nur so sieht man echtes Clipping)
    let peak = 0;
    for (let i = 0; i < wave.length; i++) { const a = Math.abs(wave[i]); if (a > peak) peak = a; }
    if (peak > 0.985) clipFlash = 1.4;
    else clipFlash = Math.max(0, clipFlash - dt);

    const pad = 6 * dpr;
    const gridTop = pad, gridH = H - pad * 2;
    const segGap = Math.max(1, 1.2 * dpr);
    const segH = (gridH - segGap * (VIZ_SEGMENTS - 1)) / VIZ_SEGMENTS;
    const colW = (W - pad * 2) / VIZ_BANDS;
    const barW = Math.max(2 * dpr, colW * 0.68);

    // Dezente Skalenlinien als Rack-Referenz
    g.fillStyle = "rgba(255,255,255,.045)";
    for (let s = 0; s <= 3; s++) g.fillRect(pad, gridTop + (gridH / 3) * s - dpr * 0.4, W - pad * 2, dpr * 0.8);

    for (let b = 0; b < VIZ_BANDS; b++) {
      const [b0, b1] = edges[b];
      let m = 0;
      for (let i = b0; i < b1; i++) if (freq[i] > m) m = freq[i];
      // Höhere Frequenzen sind von Natur aus schwächer — leicht anheben, damit die
      // Kette über die ganze Breite lebt und nicht nur links ausschlägt.
      const tilt = 1 + (b / VIZ_BANDS) * 0.6;
      const v = Math.min(1, (m / 255) * tilt);
      // Schneller Anstieg, träges Abfallen — so liest man Sprache angenehm mit
      level[b] = v > level[b] ? level[b] + (v - level[b]) * 0.55 : level[b] + (v - level[b]) * 0.14;
      hold[b] = Math.max(level[b], hold[b] - dt * 0.55);

      const x = pad + b * colW + (colW - barW) / 2;
      const lit = Math.round(level[b] * VIZ_SEGMENTS);
      for (let s = 0; s < VIZ_SEGMENTS; s++) {
        const y = gridTop + gridH - (s + 1) * segH - s * segGap;
        const frac = s / (VIZ_SEGMENTS - 1);
        const on = s < lit;
        if (on) g.fillStyle = frac > 0.86 ? "#e63946" : frac > 0.62 ? "#f0a830" : "#5fe3a1";
        else g.fillStyle = frac > 0.86 ? "rgba(230,57,70,.11)" : frac > 0.62 ? "rgba(240,168,48,.10)" : "rgba(95,227,161,.085)";
        g.fillRect(x, y, barW, segH);
      }
      // Peak-Haltemarke
      if (hold[b] > 0.03) {
        const hy = gridTop + gridH - Math.min(gridH - dpr, hold[b] * gridH);
        g.fillStyle = "rgba(255,255,255,.8)";
        g.fillRect(x, hy, barW, Math.max(1, 1.6 * dpr));
      }
    }

    // Übersteuerungs-Lampe oben rechts
    if (clipFlash > 0) {
      g.fillStyle = "rgba(230,57,70," + Math.min(0.9, clipFlash) + ")";
      g.fillRect(W - pad - 34 * dpr, pad, 34 * dpr, 11 * dpr);
      g.fillStyle = "#12070a";
      g.font = "700 " + (7.5 * dpr) + "px ui-monospace, monospace";
      g.textBaseline = "middle";
      g.fillText("PEAK", W - pad - 30 * dpr, pad + 6 * dpr);
    }
  })();
}

// Setup-Screen
async function initMicScreen() {
  const ok = await buildMic();
  if (!ok) return false;
  await populateDevices();
  // Gespeicherte Einstellungen in die UI übernehmen
  $("mic-ns").checked = micSettings.ns; $("mic-ec").checked = micSettings.ec;
  $("mic-agc").checked = micSettings.agc; $("mic-lowcut").checked = micSettings.lowcut;
  $("mic-gain").value = micSettings.gain; $("mic-gain-val").textContent = Math.round(micSettings.gain * 100) + "%";
  $("mic-gate").value = micSettings.gate; $("mic-gate-val").textContent = micSettings.gate <= 0 ? "Aus" : Math.round(micSettings.gate * 100) + "%";
  startVizOn("mic-viz");
  $("btn-mic-done").disabled = false;
  status("mic-status", "Sprich rein — die Bars sollen ausschlagen. Dann Test aufnehmen!");
}
$("btn-mic-record").onclick = async () => {
  if (!micStream) { await initMicScreen(); if (!micStream) return; }
  status("mic-status", "🎤 Sprich jetzt 3 Sekunden …");
  const rec = new MediaRecorder(recStream(), { mimeType: pickMime() });
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = async () => {
    status("mic-status", "So klingst du in der Aufnahme:");
    const ctx = getCtx();
    const buf = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    src.onended = () => { status("mic-status", "Passt? Dann weiter — sonst Regler anpassen und nochmal testen."); $("btn-mic-done").disabled = false; };
  };
  rec.start(); SFX.rec();
  setTimeout(() => { rec.stop(); SFX.stop(); }, 3000);
};
$("btn-mic-done").onclick = () => {
  cancelAnimationFrame(vizRAF);
  if (micReturnScreen === "scr-start") { renderAvatarPicker(); show("scr-avatar"); }
  else show(micReturnScreen);
  SFX.ok();
};
$("btn-avatar-done").onclick = () => { show("scr-start"); SFX.ok(); };
$("btn-mic-settings").onclick = () => {
  micReturnScreen = document.querySelector(".screen.active")?.id || "scr-start";
  if (micReturnScreen === "scr-mic") return;
  show("scr-mic");
  initMicScreen();
};
$("mic-device").onchange = e => { micSettings.deviceId = e.target.value; buildMic(); };
$("mic-ns").onchange = e => { micSettings.ns = e.target.checked; buildMic(); };
$("mic-ec").onchange = e => { micSettings.ec = e.target.checked; buildMic(); };
$("mic-agc").onchange = e => { micSettings.agc = e.target.checked; buildMic(); };
$("mic-lowcut").onchange = e => { micSettings.lowcut = e.target.checked; applyMicTuning(); };
$("btn-mic-raw").onclick = () => {
  Object.assign(micSettings, { ns: false, ec: false, agc: false, lowcut: false, gate: 0 });
  $("mic-ns").checked = $("mic-ec").checked = $("mic-agc").checked = $("mic-lowcut").checked = false;
  $("mic-gate").value = 0; $("mic-gate-val").textContent = "Aus";
  buildMic();
  status("mic-status", "🎙 Roh-Modus: Alle Filter aus — pur wie dein Mikro klingt. (Kopfhörer Pflicht, sonst Echo!)");
};
$("mic-gain").oninput = e => { micSettings.gain = parseFloat(e.target.value); $("mic-gain-val").textContent = Math.round(micSettings.gain * 100) + "%"; applyMicTuning(); };
$("mic-gate").oninput = e => {
  micSettings.gate = parseFloat(e.target.value);
  $("mic-gate-val").textContent = micSettings.gate <= 0 ? "Aus" : Math.round(micSettings.gate * 100) + "%";
  syncBoothGateUI();
};
function syncBoothGateUI() {
  const bg = $("booth-gate"), bv = $("booth-gate-val");
  if (!bg) return;
  bg.value = micSettings.gate;
  bv.textContent = micSettings.gate <= 0 ? "Aus" : Math.round(micSettings.gate * 100) + "%";
}
$("booth-gate").oninput = e => {
  micSettings.gate = parseFloat(e.target.value);
  saveMic();
  syncBoothGateUI();
  $("mic-gate").value = micSettings.gate;
  $("mic-gate-val").textContent = micSettings.gate <= 0 ? "Aus" : Math.round(micSettings.gate * 100) + "%";
};
// Beim ersten Klick den Setup starten (AudioContext braucht eine Nutzergeste).
// Kein { once: true } — sonst verbraucht sich der Listener am ersten Klick, auch wenn dabei nichts passiert ist.
function micKickstart() {
  if (micStream) { document.removeEventListener("click", micKickstart); return; }
  if (document.querySelector("#scr-mic.active")) initMicScreen();
}
document.addEventListener("click", micKickstart);



// ═════════════════════════════════════════════════════════════
// 1) RAUM ERSTELLEN / BEITRETEN
// ═════════════════════════════════════════════════════════════
$("btn-create").onclick = () => {
  myName = $("in-name").value.trim();
  if (!myName) return status("start-status", "Erst Namen eingeben, digga 😄", true), SFX.err();
  saveName();
  isHost = true;
  absichtlichWeg = false;
  const code = randCode();
  raumCode = code;
  status("start-status", "① Verbinde zum Vermittlungsserver …");
  let opened = false;
  setTimeout(() => {
    if (!opened) status("start-status", "❌ Kein Kontakt zum Vermittlungsserver. Fast immer: Brave-Shields / Adblocker — für diese Seite ausschalten und neu laden.", true);
  }, 10000);
  peer = new Peer(PEER_PREFIX + code, PEER_CONFIG);
  peer.on("open", () => {
    opened = true;
    myId = peer.id;
    players = [{ id: myId, key: myKey, name: myName + " (Host)", avatar: myAvatar, accessory: myAccessory, role: null, ready: false, done: 0, total: 0, loadPct: 0, videoReady: false }];
    enterLobby(code);
    loadSceneList();
  });
  peer.on("connection", (conn) => setupHostConn(conn));
  // Verliert der Host kurz die Leitung zum Vermittlungsserver, könnte danach niemand
  // mehr beitreten oder zurückkommen. Deshalb sofort wieder anmelden.
  peer.on("disconnected", () => {
    if (absichtlichWeg || !peer || peer.destroyed) return;
    wvBanner("📴 Leitung zum Vermittlungsserver weg — melde neu an …");
    try { peer.reconnect(); } catch {}
    setTimeout(() => { if (peer && !peer.disconnected) wvBannerAus(); }, 2500);
  });
  peer.on("error", (e) => {
    if (e.type === "unavailable-id") { peer.destroy(); $("btn-create").click(); }
    else status("start-status", "Verbindungsfehler: " + e.type, true);
  });
};

$("btn-join").onclick = () => {
  myName = $("in-name").value.trim();
  const code = $("in-code").value.trim();
  if (!myName) return status("start-status", "Erst Namen eingeben 🙂", true), SFX.err();
  if (!/^\d{4}$/.test(code)) return status("start-status", "Der Raumcode hat 4 Ziffern.", true), SFX.err();
  saveName();
  absichtlichWeg = false; wvVersuch = 0; warSchonDrin = false;
  gastBeitreten(code, false);
};
let warSchonDrin = false;   // erst nach einem geglückten Beitritt automatisch nachfassen

// Verbindet als Gast mit einem Raum. Wird auch für jeden Wiederverbindungs-Versuch
// benutzt — bei einer Wiederkehr bleibt der aktuelle Bildschirm dabei unangetastet,
// damit schon aufgenommene Lines und die Stelle in der Szene erhalten bleiben.
let iceWatchTimer = null;
function gastBeitreten(code, wiederkehr) {
  isHost = false;
  raumCode = code;
  if (iceWatchTimer) { clearInterval(iceWatchTimer); iceWatchTimer = null; }
  if (peer) { try { peer.destroy(); } catch {} }
  let opened = false, joined = false;
  const melde = (msg, err) => { if (!wiederkehr) status("start-status", msg, err); };
  melde("① Verbinde zum Vermittlungsserver …");
  peer = new Peer(PEER_CONFIG);

  // Schritt 1 hängt → Server nicht erreichbar (Brave-Shields, Adblocker, Firewall)
  setTimeout(() => {
    if (!opened) melde("❌ Kein Kontakt zum Vermittlungsserver. Fast immer: Brave-Shields / Adblocker blockt — Schild-Icon anklicken, für diese Seite ausschalten, neu laden. Oder kurz in Chrome/Firefox testen.", true);
  }, 10000);

  peer.on("open", () => {
    opened = true;
    myId = peer.id;
    melde("② Server OK — suche Raum " + code + " …");
    hostConn = peer.connect(PEER_PREFIX + code, { reliable: true });

    // Schritt 2 hängt → Raum existiert, aber Peer-Verbindung kommt nicht durch (NAT/Firewall)
    setTimeout(() => {
      if (!joined) {
        melde("❌ Raum gefunden, aber die Verbindung zum Host kommt nicht durch. Beide mal: anderes Netz testen (z. B. Handy-Hotspot), VPN aus, Brave-Shields aus.", true);
        if (wiederkehr) planeWiederverbindung();
      }
    }, 15000);

    hostConn.on("open", () => {
      joined = true;
      warSchonDrin = true;
      sendHost({ t: "hello", name: myName, avatar: myAvatar, accessory: myAccessory, key: myKey });
      if (wiederkehr) {
        // Der Host antwortet mit "rejoined" und sagt darin, wie es weitergeht.
        // Bis dahin nichts anfassen.
        wvBanner("🔌 Wieder verbunden — hole den Stand …");
      } else {
        wvVersuch = 0; wvBannerAus();
        enterLobby(code);
      }
    });
    // ICE-Status verfolgen — Timer immer aufräumen (sonst stapeln sich Reconnect-Versuche)
    let iceTicks = 0;
    iceWatchTimer = setInterval(() => {
      iceTicks++;
      const pc = hostConn && hostConn.peerConnection;
      if (!pc) {
        if (iceTicks > 15) { clearInterval(iceWatchTimer); iceWatchTimer = null; }
        return;
      }
      if (joined || pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed" || iceTicks > 20) {
        clearInterval(iceWatchTimer); iceWatchTimer = null;
      }
      if (pc.iceConnectionState === "failed") {
        melde("❌ ICE failed — Direktverbindung UND TURN-Relay fehlgeschlagen. Jetzt hilft: eigener TURN-Zugang (steht in client.js ganz oben, 5 Min, gratis).", true);
        if (wiederkehr) planeWiederverbindung();
      }
    }, 2000);
    hostConn.on("data", (msg) => handleMsg(msg, hostConn));
    hostConn.on("close", verbindungWeg);
    hostConn.on("error", (e) => { console.error("conn error", e); melde("Verbindungsfehler zum Host: " + (e.type || e), true); verbindungWeg(); });
  });
  peer.on("disconnected", () => {
    // Nur die Leitung zum Vermittlungsserver ist weg — die lässt sich direkt wiederholen
    if (!absichtlichWeg && peer && !peer.destroyed) { try { peer.reconnect(); } catch {} }
  });
  peer.on("error", (e) => {
    console.error("peer error", e);
    if (e.type === "peer-unavailable") melde("Raum " + code + " nicht gefunden. Läuft der Host noch? Code richtig?", true);
    else melde("Verbindungsfehler: " + e.type + " — F12 → Console für Details.", true);
    if (wiederkehr || raumCode) planeWiederverbindung();
  });
}

// ── Automatisch wieder reinkommen ────────────────────────────
function verbindungWeg() {
  if (isHost || absichtlichWeg || !raumCode) return;
  planeWiederverbindung();
}

function planeWiederverbindung() {
  if (isHost || absichtlichWeg || !raumCode || !warSchonDrin) return;
  // Während Aufnahme/Premiere knackt die Leitung öfter (große Audio-Pakete) —
  // deshalb mehr Versuche, bevor wir aufgeben.
  const maxVersuche = 25;
  if (wvVersuch >= maxVersuche) {
    wvBanner("❌ Komme nicht mehr rein. Läuft der Host noch?", true);
    return;
  }
  clearTimeout(wvTimer);
  wvVersuch++;
  // Erst schnell probieren, dann in immer größeren Abständen — so ist ein kurzes
  // WLAN-Zucken sofort überbrückt, ohne den Host mit Anfragen zu überschütten.
  const warten = Math.min(8000, Math.round(500 * Math.pow(1.45, wvVersuch - 1)));
  wvBanner("📴 Verbindung weg — versuche wieder reinzukommen … (" + wvVersuch + "/" + maxVersuche + ")");
  wvTimer = setTimeout(() => gastBeitreten(raumCode, true), warten);
}

function wvBanner(text, dauerhaft) {
  const el = $("wv-banner");
  if (!el) return;
  el.textContent = text;
  el.style.display = "";
  el.style.background = dauerhaft ? "var(--hot)" : "#c9821f";
}
function wvBannerAus() { const el = $("wv-banner"); if (el) el.style.display = "none"; }



// ═════════════════════════════════════════════════════════════
// LOBBY-MUSIK — spielt nur in Lobby & Warte-Screens, nie ingame
// ═════════════════════════════════════════════════════════════
const lobbyAudio = new Audio("scenes/lobby_music.mp3");
lobbyAudio.loop = true;
let musicVol = 0.35, musicOn = true;
try {
  const mv = localStorage.getItem("ss_musicvol"); if (mv !== null) musicVol = parseFloat(mv);
  const mo = localStorage.getItem("ss_musicon"); if (mo !== null) musicOn = mo === "1";
} catch {}
lobbyAudio.volume = musicVol;

const MUSIC_SCREENS = new Set(["scr-mic", "scr-avatar", "scr-start", "scr-lobby", "scr-wait", "scr-final"]);

// ── Lobby-Musik-Visualizer: kleine EQ-Bars, solange Musik läuft ──
let lobbyAn = null, lobbyVizRAF = null;
let lobbyVizData = null;
function ensureLobbyAnalyser() {
  if (lobbyAn) return lobbyAn;
  try {
    const ctx = getCtx();
    const src = ctx.createMediaElementSource(lobbyAudio);
    lobbyAn = ctx.createAnalyser(); lobbyAn.fftSize = 64;
    src.connect(lobbyAn); lobbyAn.connect(ctx.destination);
  } catch (e) { /* schon verbunden (z.B. via elementSource) oder AudioContext noch nicht bereit */ }
  return lobbyAn;
}
function lobbyVizWanted() {
  if (document.hidden || !musicOn || !lobbyAn) return false;
  const active = document.querySelector(".screen.active")?.id;
  return MUSIC_SCREENS.has(active);
}
function stopLobbyViz() {
  if (lobbyVizRAF) { cancelAnimationFrame(lobbyVizRAF); lobbyVizRAF = null; }
  const canvas = document.getElementById("music-viz");
  if (canvas) {
    const g = canvas.getContext("2d");
    if (g) g.clearRect(0, 0, canvas.width, canvas.height);
  }
}
function drawLobbyViz() {
  stopLobbyViz();
  const canvas = document.getElementById("music-viz");
  if (!canvas || !lobbyVizWanted()) return;
  const g = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  if (!lobbyVizData || lobbyVizData.length !== lobbyAn.frequencyBinCount) {
    lobbyVizData = new Uint8Array(lobbyAn.frequencyBinCount);
  }
  (function loop() {
    if (!lobbyVizWanted()) { stopLobbyViz(); return; }
    lobbyVizRAF = requestAnimationFrame(loop);
    const W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
    if (!W || !H) return;
    if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
    g.clearRect(0, 0, W, H);
    if (lobbyAudio.paused) return;
    lobbyAn.getByteFrequencyData(lobbyVizData);
    const bars = 16, bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const v = lobbyVizData[i * 2] / 255;
      const h = Math.max(2 * dpr, v * H);
      g.fillStyle = "rgba(255,201,92,.85)";
      g.fillRect(i * bw + bw * 0.2, H - h, bw * 0.6, h);
    }
  })();
}

function updateLobbyMusic() {
  const active = document.querySelector(".screen.active")?.id;
  const want = musicOn && MUSIC_SCREENS.has(active);
  if (want) {
    ensureLobbyAnalyser();
    lobbyAudio.play().catch(() => {});
    drawLobbyViz();
  } else {
    lobbyAudio.pause();
    stopLobbyViz();
  }
  const btn = $("music-toggle");
  if (btn) btn.textContent = musicOn ? "🎵" : "🔇";
  const sl = $("music-vol"); if (sl) sl.value = musicVol;
}
function stopLobbyPreview() {
  const v = $("preview");
  if (!v) return;
  try { v.pause(); } catch {}
  try { v.currentTime = 0; } catch {}
}
// show() um Musik-Update erweitern
const _origShow = show;
show = function(id) {
  _origShow(id);
  // Vorschau aus der Lobby weiterlaufen lassen = Geister-Ton in Booth/Premiere
  if (id !== "scr-lobby") stopLobbyPreview();
  updateLobbyMusic();
  if (id === "scr-lobby" || id === "scr-wait") { startTipRotation(); renderSettingsView(); } else clearInterval(tipTimer);
  // Ingame (Booth/Aufnahme) ruhig halten: keine Ablenkung
  const calm = id === "scr-booth" || id === "scr-record";
  const f = document.getElementById("floaties");
  if (f) f.style.display = calm ? "none" : "";
  // Seitenpanels NUR in Lobby & Warteraum zeigen — überall sonst (Mikro-Setup, Avatar-Wahl, Premiere, Bewertung …) aus
  const showPanels = id === "scr-lobby" || id === "scr-wait";
  if (!showPanels && BG.running) bgStop(false);   // Beat-Booth beenden, sobald es weitergeht
  const spL = document.getElementById("side-panel-left"), spR = document.getElementById("side-panel-right");
  [spL, spR].forEach(sp => { if (sp) sp.style.visibility = showPanels ? "visible" : "hidden"; });
  if (showPanels) setTimeout(renderDrawBoard, 30);   // Canvas war ggf. gerade erst sichtbar -> Größe neu berechnen & zeichnen
  document.body.classList.toggle("ingame", calm);
};

window.addEventListener("DOMContentLoaded", () => {
  $("music-toggle").onclick = () => {
    musicOn = !musicOn;
    try { localStorage.setItem("ss_musicon", musicOn ? "1" : "0"); } catch {}
    updateLobbyMusic();
    SFX.click();
  };
  $("music-vol").oninput = e => {
    musicVol = parseFloat(e.target.value);
    lobbyAudio.volume = musicVol;
    try { localStorage.setItem("ss_musicvol", musicVol); } catch {}
    if (musicVol > 0 && !musicOn) { musicOn = true; updateLobbyMusic(); }
  };
  updateLobbyMusic();
});
// Autoplay-Freischaltung beim ersten Klick
document.addEventListener("click", () => { if (musicOn) lobbyAudio.play().catch(() => {}); }, { once: true });
// Tab im Hintergrund: teure Loops pausieren
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopLobbyViz();
    stopGateLoop();
  } else {
    updateLobbyMusic();
    if (micStream && gateAn) startGateLoop();
  }
});


// ═════════════════════════════════════════════════════════════
// EMOJI-REAKTIONEN — synchron bei allen sichtbar, gegen Lobby-Langeweile
// ═════════════════════════════════════════════════════════════
function emojiAction(char) {
  if (isHost) emojiBroadcast(myId, char);
  else sendHost({ t: "emoji", char });
}
function emojiBroadcast(pid, char) {
  broadcast({ t: "emojiShow", pid, char });
  showEmoji(pid, char);
}
function showEmoji(pid, char) {
  const layer = document.getElementById("emoji-layer");
  if (!layer) return;
  const el = document.createElement("div");
  el.className = "flyemoji";
  el.style.left = (10 + Math.random() * 80) + "%";
  el.style.setProperty("--drift", (Math.random() * 60 - 30) + "px");
  el.textContent = char;
  const label = document.createElement("span");
  label.className = "flyemoji-name";
  label.textContent = nameOf(pid);
  el.appendChild(label);
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
window.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".emojibtn").forEach(b => b.addEventListener("click", () => { emojiAction(b.dataset.e); SFX.click(); }));
});


// ── Rotierende Tipps/Fun Facts, während man in der Lobby wartet ──
const LOBBY_TIPS = [
  "💡 Tipp: Kopfhörer aufsetzen — sonst hört dein Mikro den Video-Sound mit!",
  "🎲 Rollen-Roulette würfelt die Besetzung zufällig — gut gegen Diskussionen.",
  "🕶 Blind-Modus: keine Übersetzung, kein Original — reines Improvisieren.",
  "🐢 Im Editor kannst du Szenen in 0.5× ansehen, um Lippen besser zu timen.",
  "🎮 Während ihr wartet: TicTacToe, Klick-Battle, Reaktions-Duell und Tipp-Renner warten unten!",
  "🗣 „Original anhören” zeigt dir die echte Betonung, bevor du aufnimmst.",
  "⭐ Nach jeder Runde bewertet ihr euch gegenseitig — bester Sprecher kriegt die Krone 👑",
  "⬇ Das fertige Ergebnis lässt sich als Video speichern — perfekt für TikTok.",
  "🎨 Baut euch eigene Szenen im Szenen-Editor — kein Choicer-Voicer-Pack nötig.",
];
let tipIdx = 0, tipTimer = null;
function rotateTip() {
  const el = document.getElementById("lobby-tip");
  if (!el) return;
  el.style.opacity = "0";
  setTimeout(() => { el.textContent = LOBBY_TIPS[tipIdx % LOBBY_TIPS.length]; tipIdx++; el.style.opacity = "1"; }, 300);
}
function startTipRotation() {
  clearInterval(tipTimer);
  rotateTip();
  tipTimer = setInterval(rotateTip, 7000);
}

// 💡 Fun-Fact-Ticker fürs linke Seitenpanel — läuft unabhängig durchgehend, rein zur Unterhaltung
const FUN_FACTS = [
  "🐙 Oktopusse haben drei Herzen und blaues Blut.",
  "🍯 Honig verdirbt praktisch nie — man hat noch essbaren Honig in 3000 Jahre alten Gräbern gefunden.",
  "🌕 Der Mond entfernt sich jedes Jahr etwa 3,8 cm von der Erde.",
  "🦒 Giraffen und Menschen haben gleich viele Halswirbel: sieben.",
  "🍌 Bananen sind aus botanischer Sicht Beeren — Erdbeeren dagegen nicht.",
  "⚡ Ein Blitz ist etwa fünfmal heißer als die Sonnenoberfläche.",
  "🐌 Manche Schnecken können bis zu drei Jahre am Stück schlafen.",
  "🎮 Das erste Videospiel-Easter-Egg wurde 1979 in „Adventure” für die Atari 2600 versteckt.",
  "🧠 Dein Gehirn verbraucht etwa 20% deiner täglichen Energie — obwohl es nur ~2% deines Körpergewichts ausmacht.",
  "🦈 Haie gibt es schon länger als Bäume — seit etwa 400 Millionen Jahren.",
  "🥶 Wasser kann bei Zimmertemperatur sieden — wenn der Luftdruck niedrig genug ist.",
  "🐝 Bienen können einfache Mathe-Aufgaben lösen und Muster erkennen.",
];
let funFactIdx = 0, funFactTimer = null;
function rotateFunFact() {
  const el = document.getElementById("funfact-text");
  if (!el) return;
  el.style.transition = "opacity .3s";
  el.style.opacity = "0";
  setTimeout(() => { el.textContent = FUN_FACTS[funFactIdx % FUN_FACTS.length]; funFactIdx++; el.style.opacity = "1"; }, 300);
}
// ═════════════════════════════════════════════════════════════
// 🎵 BEAT-BOOTH — Rhythmus-Minispiel (F = links, J = rechts)
// Läuft rein lokal: die Musik hört nur, wer selbst spielt.
// ═════════════════════════════════════════════════════════════
const BG = {
  audio: null, chart: null, notes: [], running: false, raf: null,
  score: 0, combo: 0, maxCombo: 0, counts: { perfect: 0, good: 0, ok: 0, miss: 0 },
  held: [null, null],        // laufende Halte-Note je Spur
  keyDown: [false, false],
  startedAt: 0, countdownUntil: 0, vol: 0.5,
  parts: [], flash: [0, 0], shake: 0, ringPop: [0, 0], pulse: 0, lastBeat: -1,
};
const BG_APPROACH = 0.62;                      // Sekunden von oben bis zur Linie -- kurz = die Noten schießen runter
const BG_WINDOWS = [[0.075, "perfect", 300], [0.13, "good", 180], [0.2, "ok", 80]];
const BG_KEYS = { f: 0, j: 1 };

async function bgLoadChart() {
  if (BG.chart) return BG.chart;
  try {
    const res = await fetch("beatchart.json?t=" + Date.now(), { cache: "no-store" });
    BG.chart = await res.json();
    return BG.chart;
  } catch (e) { console.error("Beat-Chart nicht ladbar:", e); return null; }
}

function bgJudge(text, color) {
  const el = $("bg-judge");
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
}

// Treffer-Effekte: Funken, kurzer Blitz auf der Spur, leichtes Rütteln
function bgBurst(lane, kind) {
  const colors = { perfect: "#5fe3a1", good: "#f0a830", ok: "#8a8a99", miss: "#e63946" };
  const col = colors[kind] || "#f0a830";
  const n = kind === "perfect" ? 16 : kind === "good" ? 11 : kind === "miss" ? 5 : 8;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const sp = 1.7 + Math.random() * 3.4;
    BG.parts.push({ lane, x: (Math.random() - .5) * 14, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.3, life: 1, col, r: 1.6 + Math.random() * 2.4 });
  }
  BG.flash[lane] = kind === "miss" ? 0.5 : 1;
  BG.shake = kind === "perfect" ? 5.5 : kind === "miss" ? 3 : 3.5;
  if (kind !== "miss") BG.ringPop[lane] = 1;
}

function bgAddHit(kind, points) {
  BG.counts[kind]++;
  if (kind === "miss") { BG.combo = 0; }
  else {
    BG.combo++;
    BG.maxCombo = Math.max(BG.maxCombo, BG.combo);
    BG.score += points + Math.min(BG.combo, 50) * 2;   // Combo-Bonus, gedeckelt
  }
  const sc = $("bg-score"), cb = $("bg-combo");
  if (sc) sc.textContent = BG.score;
  if (cb) { cb.textContent = BG.combo; cb.classList.toggle("hot", BG.combo >= 10); }
  const colors = { perfect: "#5fe3a1", good: "#f0a830", ok: "#8a8a99", miss: "#e63946" };
  const labels = { perfect: "PERFECT", good: "GOOD", ok: "OK", miss: "MISS" };
  bgJudge(labels[kind], colors[kind]);
}

function bgNow() {
  if (!BG.audio) return 0;
  return BG.audio.currentTime;
}

function bgHitAttempt(lane) {
  if (!BG.running) return;
  const t = bgNow();
  let best = null, bestDiff = 9;
  for (const n of BG.notes) {
    if (n.done || n.lane !== lane) continue;
    const d = Math.abs(n.t - t);
    if (d < bestDiff) { bestDiff = d; best = n; }
  }
  if (!best || bestDiff > 0.2) return;      // nichts in Reichweite -> kein Fehlklick-Abzug, bleibt fair
  for (const [win, kind, pts] of BG_WINDOWS) {
    if (bestDiff <= win) {
      best.done = true; best.hit = kind;
      bgAddHit(kind, pts);
      bgBurst(lane, kind);
      if (best.hold > 0) BG.held[lane] = best;   // Halte-Note startet
      SFX.beathit(kind);
      return;
    }
  }
}

function bgRelease(lane) {
  const h = BG.held[lane];
  if (!h) return;
  BG.held[lane] = null;
  const t = bgNow();
  if (t < h.t + h.hold - 0.15) {              // zu früh losgelassen
    h.holdBroken = true;
    bgAddHit("miss", 0);
  } else {
    h.holdDone = true;
    BG.score += 120;
    const sc = $("bg-score"); if (sc) sc.textContent = BG.score;
    bgJudge("Hold!", "#5fe3a1");
  }
}

function bgDraw() {
  const c = $("bg-canvas");
  if (!c) return;
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  const hitY = H - 52;
  const laneW = W / 2;
  const t = bgNow();

  // Kamerawackler nach einem Treffer
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (BG.shake > 0.1) {
    g.translate((Math.random() - .5) * BG.shake, (Math.random() - .5) * BG.shake);
    BG.shake *= 0.82;
  }
  g.clearRect(-10, -10, W + 20, H + 20);

  // Hintergrund pulsiert im Takt
  BG.pulse *= 0.9;
  const bpmSec = 60 / ((BG.chart && BG.chart.bpm) || 235) * 2;
  const beatIdx = Math.floor(t / bpmSec);
  if (beatIdx !== BG.lastBeat) { BG.lastBeat = beatIdx; BG.pulse = 1; }
  const bgGrad = g.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, `rgba(168,85,247,${0.05 + BG.pulse * 0.05})`);
  bgGrad.addColorStop(0.55, "rgba(10,10,14,0)");
  g.fillStyle = bgGrad; g.fillRect(0, 0, W, H);

  // Spuren mit Fluchtpunkt-Wirkung
  for (let L = 0; L < 2; L++) {
    const x = L * laneW;
    const lg = g.createLinearGradient(0, 0, 0, hitY);
    const base = L === 0 ? "240,168,48" : "230,57,70";
    lg.addColorStop(0, `rgba(${base},0)`);
    lg.addColorStop(1, `rgba(${base},${BG.keyDown[L] ? .16 : .05})`);
    g.fillStyle = lg; g.fillRect(x + 5, 0, laneW - 10, hitY);
    g.strokeStyle = `rgba(${base},.18)`; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + 5.5, 0); g.lineTo(x + 5.5, hitY);
    g.moveTo(x + laneW - 5.5, 0); g.lineTo(x + laneW - 5.5, hitY); g.stroke();

    // Aufblitzen direkt nach dem Treffer
    if (BG.flash[L] > 0.02) {
      g.fillStyle = `rgba(255,255,255,${BG.flash[L] * 0.13})`;
      g.fillRect(x + 5, 0, laneW - 10, hitY);
      BG.flash[L] *= 0.84;
    }
  }

  // Trefferlinie: glüht im Takt
  const glowA = 0.35 + BG.pulse * 0.4;
  g.save();
  g.shadowColor = "rgba(240,168,48,.9)"; g.shadowBlur = 12 + BG.pulse * 14;
  g.fillStyle = `rgba(240,168,48,${glowA})`;
  g.fillRect(0, hitY - 1.5, W, 3);
  g.restore();

  // Noten
  for (const n of BG.notes) {
    const dt = n.t - t;
    // Halte-Noten muessen bis zum ENDE ihrer Haltedauer sichtbar bleiben, nicht nur 0.45s nach dem Anschlag
    if (dt > BG_APPROACH || (dt + (n.hold || 0)) < -0.45) continue;
    const cx = n.lane * laneW + laneW / 2;
    const y = hitY * (1 - dt / BG_APPROACH);
    const isHeld = BG.held[n.lane] === n;
    const col = n.hold > 0 ? "168,85,247" : n.lane === 0 ? "240,168,48" : "230,57,70";

    // Beim Halten bleibt die Kugel auf der Trefferlinie stehen, statt darunter zu verschwinden
    const drawY = isHeld ? hitY : y;

    if (n.hold > 0) {                       // Halte-Balken: schrumpft sichtbar von unten weg
      const yEnd = hitY * (1 - (n.t + n.hold - t) / BG_APPROACH);
      const top = Math.min(drawY, yEnd), bot = Math.max(drawY, yEnd);
      const hgt = Math.max(0, bot - top);
      if (hgt > 0.5) {
        g.fillStyle = n.holdBroken ? "rgba(230,57,70,.18)" : `rgba(${col},${isHeld ? .6 : .28})`;
        g.fillRect(cx - 10, top, 20, hgt);
        g.fillStyle = `rgba(255,255,255,${isHeld ? .55 : .15})`;
        g.fillRect(cx - 2.5, top, 5, hgt);
        if (isHeld) {                        // Rand leuchtet, solange gehalten wird
          g.strokeStyle = "rgba(95,227,161,.85)"; g.lineWidth = 2;
          g.strokeRect(cx - 10, top, 20, hgt);
        }
      }
      // Fortschritt: wie viel vom Halten ist geschafft
      if (isHeld) {
        const p = Math.max(0, Math.min(1, (t - n.t) / n.hold));
        g.fillStyle = "rgba(95,227,161,.9)";
        g.fillRect(cx - 14, hitY + 26, 28 * p, 3);
        g.fillStyle = "rgba(255,255,255,.14)";
        g.fillRect(cx - 14 + 28 * p, hitY + 26, 28 * (1 - p), 3);
        if (Math.random() < 0.5) BG.parts.push({ lane: n.lane, x: (Math.random()-.5)*18, y: 0,
          vx: (Math.random()-.5)*1.6, vy: -1.4 - Math.random()*1.6, life: .8, col: "#5fe3a1", r: 1.3 + Math.random()*1.5 });
      }
    }
    if (n.done && !n.hold) continue;
    if (n.done && n.hold && !isHeld) continue;   // fertige Halte-Note nicht weiter zeichnen

    // Schweif hinter der Note
    if (!n.done) {
      const tg = g.createLinearGradient(0, drawY - 26, 0, drawY);
      tg.addColorStop(0, `rgba(${col},0)`); tg.addColorStop(1, `rgba(${col},.35)`);
      g.fillStyle = tg; g.fillRect(cx - 7, drawY - 26, 14, 26);
    }

    const r = (n.hold > 0 ? 13 : 11.5) * (isHeld ? 1.15 : 1);
    g.save();
    g.shadowColor = isHeld ? "rgba(95,227,161,.95)" : `rgba(${col},.9)`;
    g.shadowBlur = isHeld ? 20 : (n.done ? 4 : 14);
    g.beginPath(); g.arc(cx, drawY, r, 0, Math.PI * 2);
    g.fillStyle = isHeld ? "#5fe3a1" : (n.done ? "rgba(120,120,135,.35)" : `rgb(${col})`);
    g.fill();
    g.restore();
    if (!n.done || isHeld) {                // Glanzlicht oben, macht die Note plastisch
      g.beginPath(); g.arc(cx - r * .3, drawY - r * .35, r * .34, 0, Math.PI * 2);
      g.fillStyle = "rgba(255,255,255,.55)"; g.fill();
    }
  }

  // Tastenkappen unten
  for (let L = 0; L < 2; L++) {
    const cx = L * laneW + laneW / 2;
    const base = L === 0 ? "240,168,48" : "230,57,70";
    if (BG.ringPop[L] > 0.02) {              // Ring, der beim Treffer aufploppt
      g.beginPath(); g.arc(cx, hitY, 19 + (1 - BG.ringPop[L]) * 20, 0, Math.PI * 2);
      g.strokeStyle = `rgba(${base},${BG.ringPop[L] * .7})`; g.lineWidth = 2.5; g.stroke();
      BG.ringPop[L] *= 0.88;
    }
    const pressed = BG.keyDown[L];
    g.save();
    g.shadowColor = `rgba(${base},${pressed ? .9 : .3})`; g.shadowBlur = pressed ? 18 : 6;
    g.beginPath(); g.arc(cx, hitY, 18, 0, Math.PI * 2);
    g.fillStyle = pressed ? `rgba(${base},.4)` : "rgba(18,18,24,.9)";
    g.fill();
    g.strokeStyle = pressed ? `rgb(${base})` : `rgba(${base},.55)`; g.lineWidth = 2.5; g.stroke();
    g.restore();
    g.fillStyle = pressed ? "#0b0b0e" : `rgba(${base},.9)`;
    g.font = "700 16px 'Space Mono',monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(L === 0 ? "F" : "J", cx, hitY + 1);
  }

  // Funken
  for (let i = BG.parts.length - 1; i >= 0; i--) {
    const p = BG.parts[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.16; p.life -= 0.035;
    if (p.life <= 0) { BG.parts.splice(i, 1); continue; }
    const px = p.lane * laneW + laneW / 2 + p.x;
    g.globalAlpha = Math.max(0, p.life);
    g.fillStyle = p.col;
    g.beginPath(); g.arc(px, hitY + p.y, p.r * p.life, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }
  if (BG.parts.length > 220) BG.parts.splice(0, BG.parts.length - 220);
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function bgTick() {
  if (!BG.running) return;
  BG.raf = requestAnimationFrame(bgTick);
  const t = bgNow();

  // Countdown vor dem Start
  const cd = $("bg-count");
  if (performance.now() < BG.countdownUntil) {
    const left = Math.ceil((BG.countdownUntil - performance.now()) / 1000);
    if (cd) { cd.classList.add("show"); cd.textContent = left; }
    bgDraw();
    return;
  } else if (cd && cd.classList.contains("show")) {
    cd.classList.remove("show");
    BG.audio.play().catch(() => {});
  }

  // Verpasste Noten einsammeln
  for (const n of BG.notes) {
    if (!n.done && !n.missed && n.t < t - 0.2) { n.missed = true; n.done = true; bgAddHit("miss", 0); bgBurst(n.lane, "miss"); }
    // Halte-Note bis zum Ende durchgehalten -> automatisch gutschreiben
    if (BG.held[n.lane] === n && t >= n.t + n.hold) bgRelease(n.lane);
  }

  bgDraw();
  if (BG.audio.ended || t >= BG.chart.duration - 0.1) bgStop(true);
}

async function bgStart() {
  const chart = await bgLoadChart();
  if (!chart) { status("bg-result", "Beat-Chart nicht gefunden.", true); return; }
  bgStop(false);

  BG.notes = chart.notes.map(n => ({ ...n, done: false, missed: false, hit: null, holdBroken: false, holdDone: false }));
  BG.score = 0; BG.combo = 0; BG.maxCombo = 0;
  BG.counts = { perfect: 0, good: 0, ok: 0, miss: 0 };
  BG.held = [null, null]; BG.keyDown = [false, false];
  BG.parts = []; BG.flash = [0, 0]; BG.shake = 0; BG.ringPop = [0, 0]; BG.pulse = 0; BG.lastBeat = -1;
  $("bg-score").textContent = "0"; $("bg-combo").textContent = "0";
  $("bg-result").textContent = "";
  $("bg-start").style.display = "none"; $("bg-stop").style.display = "";

  if (!BG.audio) { BG.audio = new Audio("beatgame.mp3"); BG.audio.preload = "auto"; }
  BG.audio.volume = BG.vol;
  BG.audio.currentTime = 0;

  lobbyAudio.pause();                       // Lobby-Musik aus, sonst hört man zwei Songs übereinander
  BG.running = true;
  BG.countdownUntil = performance.now() + 3000;
  bgTick();
}

function bgStop(showResult, aborted) {
  const wasRunning = BG.running;
  BG.running = false;
  cancelAnimationFrame(BG.raf);
  if (BG.audio) { BG.audio.pause(); BG.audio.currentTime = 0; }
  const cd = $("bg-count"); if (cd) cd.classList.remove("show");
  const sb = $("bg-start"), st = $("bg-stop");
  if (sb) sb.style.display = ""; if (st) st.style.display = "none";
  if (showResult && wasRunning) {
    const c = BG.counts, total = c.perfect + c.good + c.ok + c.miss;
    const acc = total ? Math.round((c.perfect + c.good * 0.7 + c.ok * 0.35) / total * 100) : 0;
    const res = $("bg-result");
    const head = aborted ? "⏹ Gestoppt" : "🏁 Fertig";
    if (res) res.innerHTML = `${head} · <b>${BG.score}</b> Punkte · ${acc}% Genauigkeit · längste Combo ${BG.maxCombo}<br>
      <span style="color:#5fe3a1">${c.perfect} Perfect</span> · <span style="color:#f0a830">${c.good} Good</span> · ${c.ok} OK · <span style="color:#e63946">${c.miss} Miss</span>`;
    if (aborted) SFX.click(); else SFX.done();
  } else if (!showResult) {
    const res = $("bg-result"); if (res) res.textContent = "";
  }
  updateLobbyMusic();                       // Lobby-Musik ggf. wieder an
}

document.addEventListener("keydown", e => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;

  // Leertaste in der Booth = Aufnehmen / Stoppen (wie der große Aufnahme-Knopf)
  if ((e.code === "Space" || e.key === " ") && document.querySelector("#scr-booth.active")) {
    const btn = $("btn-line-rec");
    if (btn && !btn.disabled) {
      e.preventDefault();
      if (e.repeat) return;   // gedrückt halten nicht als Dauerfeuer
      btn.click();
    }
    return;
  }

  if (!BG.running) return;
  const lane = BG_KEYS[e.key.toLowerCase()];
  if (lane === undefined || BG.keyDown[lane]) return;
  e.preventDefault();
  BG.keyDown[lane] = true;
  bgHitAttempt(lane);
});
document.addEventListener("keyup", e => {
  const lane = BG_KEYS[(e.key || "").toLowerCase()];
  if (lane === undefined) return;
  BG.keyDown[lane] = false;
  if (BG.running) bgRelease(lane);
});

function startFunFactRotation() {
  clearInterval(funFactTimer);
  rotateFunFact();
  funFactTimer = setInterval(rotateFunFact, 8000);
}


// ── Mini-Konfetti: kleiner Belohnungsmoment beim "Bin bereit" ──
// ── Kurze Einblendung oben, z.B. wenn jemand den Raum verlässt ──
function showToast(text, kind) {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:120;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none";
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  const accent = kind === "leave" ? "var(--hot)" : "var(--amber)";
  t.style.cssText = `font-family:var(--font-body);font-size:.92rem;font-weight:600;color:var(--text);
    background:linear-gradient(180deg,#22222a,#17171d);border:1px solid ${accent};border-left:4px solid ${accent};
    border-radius:8px;padding:11px 18px;box-shadow:0 10px 30px rgba(0,0,0,.6);
    opacity:0;transform:translateY(-10px);transition:opacity .25s, transform .25s`;
  t.textContent = text;
  host.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = "1"; t.style.transform = "translateY(0)"; });
  setTimeout(() => {
    t.style.opacity = "0"; t.style.transform = "translateY(-10px)";
    setTimeout(() => t.remove(), 300);
  }, 3600);
}

function burstConfetti(mega) {
  const layer = document.getElementById("emoji-layer");
  if (!layer) return;
  const colors = ["#ffc95c", "#ff4d55", "#c84bff", "#5fe3a1", "#ffffff", "#f0a830"];
  const n = mega ? 55 : 18;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    p.className = "confetti-bit";
    p.style.left = (mega ? Math.random() * 100 : (40 + Math.random() * 20)) + "%";
    p.style.bottom = mega ? (10 + Math.random() * 40) + "%" : "30%";
    p.style.background = colors[i % colors.length];
    p.style.width = (6 + Math.random() * 8) + "px";
    p.style.height = (6 + Math.random() * 8) + "px";
    p.style.setProperty("--dx", (Math.random() * 280 - 140) + "px");
    p.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
    p.style.animationDelay = (Math.random() * (mega ? 0.45 : 0.15)) + "s";
    p.style.animationDuration = (1.2 + Math.random() * 1.1) + "s";
    layer.appendChild(p);
    setTimeout(() => p.remove(), 2200);
  }
}


// ═════════════════════════════════════════════════════════════
// REDO-FEATURE: eigene Lines auch nach Fertigmelden noch korrigieren
// (A) jeder spricht nur seine eigenen Lines neu, (B) überschreibt den alten Take,
// (C) geht nur, solange die Premiere noch nicht offiziell gestartet ist.
// ═════════════════════════════════════════════════════════════
let redoMode = null, redoReturnScreen = null;
let finalTracksData = null;   // Host: letzter kompletter Mix-Datensatz, für Nach-Korrekturen
let premiereLocked = false;   // true sobald die Premiere offiziell abgespielt wurde


// ═════════════════════════════════════════════════════════════
// 🥊 DUELL-MODUS: 2 Spieler, 1 Rolle, unabhängige Aufnahmen, Kopf-an-Kopf-Abstimmung
// ═════════════════════════════════════════════════════════════
let duelInfo = null;          // { roleId, aId, bId }
let duelStagedScene = null;   // vom Host im Setup gewählte Szene, bevor das Duell startet
const duelSubs = {};          // Host: playerId -> items[]
const duelVotes = {};         // Host: voterId -> "a" | "b"

// ═════════════════════════════════════════════════════════════
// RAUM VERLASSEN — sauberer Reset ohne Seiten-Reload
// ═════════════════════════════════════════════════════════════
function leaveRoom() {
  // Bewusst gegangen: kein Wiederverbinden versuchen, und der Host soll den Platz
  // sofort räumen statt ihn zwei Minuten freizuhalten.
  absichtlichWeg = true;
  raumCode = null;
  clearTimeout(wvTimer); wvVersuch = 0; wvBannerAus();
  if (!isHost && hostConn && hostConn.open) { try { sendHost({ t: "bye" }); } catch {} }
  rueckkehrTimer.forEach(t => clearTimeout(t)); rueckkehrTimer.clear();
  try { if (lineRec && lineRec.state === "recording") lineRec.stop(); } catch {}
  clearInterval(recTimer); clearInterval(cbTimer);
  playNodes.forEach(n => { try { n.stop(); } catch {} }); playNodes = [];
  stopGateLoop();
  stopLobbyViz();
  clearTimeout(stateBroadcastTimer); stateBroadcastTimer = null;
  ["preview","booth-video","play-video","rec-video"].forEach(id => { const v = $(id); if (v) { v.pause(); v.removeAttribute("src"); v.load(); } });
  try { peer && peer.destroy(); } catch {}
  peer = null; hostConn = null; conns.clear();
  isHost = false; players = []; scene = null;
  if (micStream) { try { micStream.getTracks().forEach(t => t.stop()); } catch {} micStream = null; }
  localVideoBuf = null; clearSceneVideoState();
  takes = {}; myLines = []; curLine = 0; outtakes = []; mixItems = []; collected.clear(); collectedOuttakes.clear();
  ttt = { p: [], board: Array(9).fill(null), turn: 0, winner: null };
  match = { rounds: 1, round: 1, totals: {}, autoRoulette: false, buddyGivers: {} };
  myBuddyUsed = false;
  Object.keys(mgWins).forEach(k => delete mgWins[k]);
  $("host-settings").style.display = "none";
  match.mode = "free";
  $("onair").classList.remove("live");
  $("host-scene").style.display = "none";
  $("host-start").style.display = "none";
  $("scene-card").style.display = "none";
  $("leave-btn").style.display = "none";
  status("start-status", "Raum verlassen. Du kannst direkt einen neuen erstellen oder beitreten.");
  show("scr-start");
  SFX.stop();
}
document.body.insertAdjacentHTML("beforeend",
  `<div id="wv-banner" style="display:none;position:fixed;top:0;left:0;right:0;z-index:250;background:#c9821f;color:#12120f;font-family:var(--font-mono);font-size:.8rem;font-weight:700;text-align:center;padding:7px 12px;letter-spacing:.04em;box-shadow:0 2px 12px rgba(0,0,0,.5)"></div>
   <button id="leave-btn" style="position:fixed;right:12px;bottom:10px;z-index:98;display:none;padding:8px 14px;font-size:.82rem;background:#1f1f28;border:1px solid var(--line);border-radius:8px;color:var(--muted)">🚪 Raum verlassen</button>
   <div id="leave-confirm-overlay" style="display:none;position:fixed;inset:0;z-index:210;background:rgba(0,0,0,.7);align-items:center;justify-content:center;padding:20px">
     <div style="max-width:340px;width:100%;background:#14141b;border:1px solid var(--line);border-radius:16px;padding:22px;text-align:center">
       <p style="margin:0 0 18px;font-size:1rem" id="leave-confirm-text">Raum wirklich verlassen?</p>
       <div class="row" style="justify-content:center;gap:10px">
         <button class="ghost" id="btn-leave-cancel">Abbrechen</button>
         <button class="primary" id="btn-leave-confirm" style="background:var(--hot)">🚪 Ja, verlassen</button>
       </div>
     </div>
   </div>`);
$("leave-btn").onclick = () => {
  $("leave-confirm-text").textContent = "Raum wirklich verlassen?" + (isHost ? " Du bist Host — der Raum wird für alle geschlossen!" : "");
  $("leave-confirm-overlay").style.display = "flex";
};
$("btn-leave-cancel").onclick = () => $("leave-confirm-overlay").style.display = "none";
$("leave-confirm-overlay").onclick = e => { if (e.target.id === "leave-confirm-overlay") $("leave-confirm-overlay").style.display = "none"; };
$("btn-leave-confirm").onclick = () => { $("leave-confirm-overlay").style.display = "none"; leaveRoom(); };

// ── Raumcode verstecken (Blur): gut für Streams/Screenshots — Auge toggelt Sichtbarkeit ──
let codeHidden = false;
try { codeHidden = localStorage.getItem("ss_code_hidden") === "1"; } catch {}
function syncCodeVisibility() {
  const el = $("lobby-code");
  const btn = $("btn-toggle-code");
  if (!el) return;
  el.classList.toggle("is-blurred", !!codeHidden);
  if (btn) {
    btn.textContent = codeHidden ? "👁‍🗨" : "👁";
    btn.title = codeHidden ? "Raumcode anzeigen" : "Raumcode verstecken";
  }
}
$("btn-toggle-code") && ($("btn-toggle-code").onclick = () => {
  codeHidden = !codeHidden;
  try { localStorage.setItem("ss_code_hidden", codeHidden ? "1" : "0"); } catch {}
  syncCodeVisibility();
  SFX.click();
});
syncCodeVisibility();

$("btn-copy-code") && ($("btn-copy-code").onclick = async () => {
  const code = raumCode || $("lobby-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    $("btn-copy-code").textContent = "✅";
    setTimeout(() => { $("btn-copy-code").textContent = "📋"; }, 1500);
    SFX.click();
  } catch { status("lobby-status", "Kopieren nicht möglich — Code von Hand markieren: " + code, true); }
});

// ── Einladungs-Link: Raumcode steckt in der Adresse, ein Klick reicht zum Beitreten ──
function inviteLink(code) {
  const u = new URL(location.href);
  u.hash = "";
  u.search = "?raum=" + code;
  return u.toString();
}
$("btn-copy-link") && ($("btn-copy-link").onclick = async () => {
  const link = inviteLink(raumCode || $("lobby-code").textContent);
  const btn = $("btn-copy-link");
  try {
    await navigator.clipboard.writeText(link);
    btn.textContent = "✅ Link kopiert — jetzt einfügen!";
    setTimeout(() => { btn.textContent = "🔗 Einladungs-Link kopieren"; }, 2500);
    SFX.click();
  } catch { status("lobby-status", "Kopieren nicht möglich — Link von Hand kopieren: " + link, true); }
});
// Wer über einen Einladungs-Link kommt, findet den Code schon eingetragen vor.
// Kein Auto-Beitritt: das Mikro braucht erst eine Freigabe durch eine echte Nutzergeste.
const invitedCode = (() => {
  const m = /^\d{4}$/.exec(new URLSearchParams(location.search).get("raum") || "");
  return m ? m[0] : null;
})();
if (invitedCode) whenReady(() => {
  $("in-code").value = invitedCode;
  const note = $("invite-note");
  if (note) { note.textContent = "🎬 Du wurdest in Raum " + invitedCode + " eingeladen — Code steht schon drin, einfach auf „Beitreten“."; note.style.display = ""; }
  const btn = $("btn-join");
  if (btn) btn.classList.add("primary");
});

function enterLobby(code) {
  $("lobby-code").textContent = code;
  syncCodeVisibility();
  if (isHost) { $("host-scene").style.display = ""; $("host-start").style.display = ""; }
  show("scr-lobby");
  renderPlayers();
  $("leave-btn").style.display = "";
  if (isHost) {
    $("host-settings").style.display = "";
    $("set-mode").onchange = hostSettingsChanged;
    $("set-rounds").onchange = hostSettingsChanged;
    $("set-roulette").onchange = hostSettingsChanged;
    hostSettingsChanged();
  }
  renderSettingsView();
  SFX.ok();
}

// ═════════════════════════════════════════════════════════════
// 2) NACHRICHTEN
// ═════════════════════════════════════════════════════════════
function setupHostConn(conn) {
  conn.on("open", () => conns.set(conn.peer, conn));
  conn.on("data", (msg) => handleMsg(msg, conn));
  conn.on("close", () => {
    conns.delete(conn.peer);
    const gone = players.find(p => p.id === conn.peer);
    if (!gone) { broadcastState(); return; }
    if (gone.gehtFreiwillig || !gone.key) { endgueltigWeg(gone); return; }

    // Schon wieder unter neuer Peer-ID drin? Dann nur den alten Geister-Eintrag
    // wegräumen — Rolle/Fortschritt auf den Live-Platz legen, kein Offline-Toast.
    const twin = players.find(p => p !== gone && p.key === gone.key);
    if (twin) {
      if (twin.role == null && gone.role != null) twin.role = gone.role;
      if ((twin.done || 0) < (gone.done || 0)) { twin.done = gone.done; twin.total = gone.total; }
      if (!twin.ready && gone.ready) twin.ready = true;
      if (!twin.prem && gone.prem) twin.prem = true;
      players = players.filter(p => p !== gone);
      clearTimeout(rueckkehrTimer.get(gone.key));
      rueckkehrTimer.delete(gone.key);
      broadcastState();
      maybeFinishTracks();
      syncForceMixBtn();
      return;
    }

    // Platz NICHT sofort löschen. Bei einem kurzen WLAN-Zucken soll die Person mit ihrer
    // Rolle und den schon aufgenommenen Lines zurückkommen können, statt als neuer
    // Spieler von vorne anzufangen.
    const frist = gnadenfristMs();
    gone.offline = true;
    gone.offlineBis = Date.now() + frist;
    showToast("📴 " + gone.name + " ist rausgeflogen — Platz bleibt " + Math.round(frist / 60000) + " Min. frei", "leave");
    SFX.leave();
    broadcast({ t: "playerOffline", name: gone.name });
    clearTimeout(rueckkehrTimer.get(gone.key));
    rueckkehrTimer.set(gone.key, setTimeout(() => endgueltigWeg(gone), frist));
    broadcastState();
    // Notausgang-Knopf für den Host neu bewerten, falls gerade auf diese Spur gewartet wird
    maybeFinishTracks();
    syncForceMixBtn();
    maybeFinishRating();
  });
}

// Gnadenfrist abgelaufen oder freiwillig gegangen: Platz endgültig räumen. Erst ab hier
// darf die Runde ohne diese Person weiterlaufen.
function endgueltigWeg(p) {
  if (!p || !players.includes(p)) return;
  if (p.key) { clearTimeout(rueckkehrTimer.get(p.key)); rueckkehrTimer.delete(p.key); }
  players = players.filter(x => x !== p);
  conns.delete(p.id);
  broadcast({ t: "playerLeft", name: p.name });
  showToast("👋 " + p.name + " hat den Raum verlassen", "leave");
  SFX.leave();
  broadcastState();
  maybeFinishTracks();
  if (duelInfo && document.querySelector("#scr-duel-vote.active")) maybeFinishDuelVote();
  updateRateProgress();
  maybeFinishRating();
  syncForceMixBtn();
}

// Beim Wiederkommen hat die Person eine neue Peer-Adresse. Alles, was noch unter der
// alten Adresse abgelegt ist, muss mitwandern — sonst könnte sie z. B. zweimal abstimmen.
function idUmschreiben(alt, neu) {
  if (!alt || alt === neu) return;
  const ausMap = (m) => { if (m && m.has && m.has(alt)) { m.set(neu, m.get(alt)); m.delete(alt); } };
  const ausObj = (o) => { if (o && Object.prototype.hasOwnProperty.call(o, alt)) { o[neu] = o[alt]; delete o[alt]; } };
  const ausListe = (a) => Array.isArray(a) ? a.map(id => id === alt ? neu : id) : a;

  ausMap(allRatings); ausMap(cbScores);
  ausObj(duelVotes); ausObj(duelSubs); ausObj(mgWins);
  if (match && match.totals) ausObj(match.totals);
  if (duelInfo) { if (duelInfo.aId === alt) duelInfo.aId = neu; if (duelInfo.bId === alt) duelInfo.bId = neu; }
  if (ttt) ttt.p = ausListe(ttt.p);
  if (rps) { rps.p = ausListe(rps.p); ausObj(rps.picks); ausObj(rps.wins); }
  if (dice) { dice.p = ausListe(dice.p); ausObj(dice.rolls); }
}

// In welcher Phase steckt die Runde gerade? Braucht ein Wiederkehrer, der die Seite
// zwischendurch neu geladen hat und deshalb nichts mehr weiß.
function aktuellePhase() {
  const aktiv = document.querySelector(".screen.active");
  return aktiv ? aktiv.id : "scr-lobby";
}
function broadcast(msg) { conns.forEach(c => { if (c.open) c.send(msg); }); }
let stateBroadcastTimer = null;
function flushStateBroadcast() {
  clearTimeout(stateBroadcastTimer);
  stateBroadcastTimer = null;
  broadcast({ t: "state", players });
  checkStartable();
  checkAllDone();
  if (isHost) renderPremState();
}
// opts.throttle: Netzwerk kurz bündeln (z. B. Line-Fortschritt), UI trotzdem sofort
function broadcastState(opts) {
  renderPlayers();
  renderBoothPlayers();
  if (opts && opts.throttle) {
    clearTimeout(stateBroadcastTimer);
    stateBroadcastTimer = setTimeout(flushStateBroadcast, 300);
    checkStartable();
    if (isHost) renderPremState();
    return;
  }
  flushStateBroadcast();
}

// Nachrichten, die der Host von Gästen annehmen darf (alles andere ignorieren)
const HOST_IN = new Set([
  "hello", "bye", "pickRole", "ready", "progress", "loadProg", "tracks", "trackUpdate",
  "ttt", "rps", "dice", "draw", "rate", "mg", "emoji", "premReady", "cb",
  "duelSubmit", "duelVote"
]);
// Nachrichten, die Gäste vom Host annehmen dürfen
const GUEST_IN = new Set([
  "full", "state", "scene", "playerLeft", "playerOffline", "playerBack", "rejoined",
  "settings", "sceneReset", "duelSetupInfo", "duelReady", "duelPlayGo", "duelVoteBroadcast",
  "duelResult", "wins", "nextRound", "matchEnd", "matchLobby", "videoMeta", "videoChunk",
  "goLines", "go", "mix", "outtakesPool", "playOuttakes", "tttState", "rpsState", "diceState",
  "drawState", "premGo", "premOrig", "premPause", "premResume", "emojiShow", "rateResult",
  "rxGo", "tpGo", "mgResult", "cbGo", "cbResult", "again"
]);

let pendingPhaseRestore = null;

function seedLocalPlayer(role) {
  let me = players.find(p => p.id === myId);
  if (!me) {
    me = {
      id: myId, key: myKey, name: myName, avatar: myAvatar, accessory: myAccessory,
      role: role != null ? role : null, ready: false, done: 0, total: 0,
      loadPct: 0, videoReady: false
    };
    players.push(me);
  } else if (role !== undefined) {
    me.role = role;
  }
  return me;
}

function matchPayload() {
  return { mode: match.mode, rounds: match.rounds, round: match.round, autoRoulette: match.autoRoulette };
}

// Nach Reload / Rausflug / Spätbeitritt: auf Host-Phase springen
function applyPhaseRestore(msg) {
  if (msg.match) {
    match.mode = msg.match.mode; match.rounds = msg.match.rounds;
    match.round = msg.match.round; match.autoRoulette = msg.match.autoRoulette;
    renderSettingsView(msg.match);
  }
  if (msg.duelInfo) duelInfo = msg.duelInfo;
  if (msg.scene) {
    scene = msg.scene;
    if (!msg.hatVideoUebertragung) { revokeFetchedVideo(); videoBlobUrl = null; }
    showScene(sceneVideoSrc());
  }
  seedLocalPlayer(msg.role);

  const meine = aktuellePhase();
  const vorSpiel = ["scr-mic", "scr-avatar", "scr-start", "scr-lobby"].includes(meine);
  const habeStand = myLines.length > 0 || mixItems.length > 0;
  const hostSchonWeiter = ["scr-playback", "scr-final", "scr-duel-vote", "scr-rate"].includes(msg.phase) && meine !== msg.phase;

  if (!msg.forceRestore && habeStand && !vorSpiel && !hostSchonWeiter) {
    showToast("🔌 Wieder drin — mach einfach weiter!", "join");
    SFX.ok();
    return;
  }

  // Eigenes Video kommt noch per Chunks — danach hier weitermachen
  if (msg.hatVideoUebertragung && !videoBlobUrl) {
    pendingPhaseRestore = Object.assign({}, msg, { forceRestore: true });
    wvBanner("🔌 Hole Video vom Host …");
    return;
  }
  pendingPhaseRestore = null;
  wvBannerAus();

  const leaveBtn = $("leave-btn");
  if (leaveBtn) leaveBtn.style.display = "";

  if (msg.phase === "scr-playback" && msg.mix) {
    if (!scene) { enterLobby(raumCode); return; }
    loadMix(msg.mix, msg);
  } else if (msg.phase === "scr-booth") {
    if (msg.role != null && scene) {
      queueOrStartBooth();
      showToast("🔌 Wieder drin — deine Rolle hast du zurück", "join");
    } else {
      show("scr-wait");
      status("wait-status", "🔌 Wieder drin — du schaust zu / warte auf die Premiere …");
    }
  } else if (msg.phase === "scr-wait" || msg.phase === "scr-record") {
    show("scr-wait");
    status("wait-status", "🔌 Wieder drin — warte auf die anderen …");
  } else if (msg.phase === "scr-rate") {
    show("scr-playback");
    status("play-status", "🔌 Wieder drin — Bewertung läuft …");
    if (!rateSent) showRateCard();
  } else if (msg.phase === "scr-duel-vote") {
    show("scr-duel-vote");
    status("duel-vote-status", "🔌 Wieder drin — stimme jetzt ab!");
  } else if (msg.phase === "scr-final") {
    show("scr-final");
  } else {
    enterLobby(raumCode);
  }
  SFX.ok();
}

function handleMsg(msg, conn) {
  if (!msg || !msg.t) return;
  if (isHost && !HOST_IN.has(msg.t)) return;
  if (!isHost && !GUEST_IN.has(msg.t)) return;

  switch (msg.t) {
    // — Host ← Gast —
    case "hello": {
      const samePeer = players.find(p => p.id === conn.peer);
      if (samePeer) {
        if (msg.name) samePeer.name = msg.name;
        if (msg.avatar) samePeer.avatar = msg.avatar;
        if (msg.accessory) samePeer.accessory = msg.accessory;
        if (msg.key && !samePeer.key) samePeer.key = msg.key;
        broadcastState();
        break;
      }

      const rueck = msg.key ? players.find(p => p.key === msg.key) : null;
      if (rueck) {
        const alteId = rueck.id;
        clearTimeout(rueckkehrTimer.get(msg.key)); rueckkehrTimer.delete(msg.key);
        rueck.id = conn.peer;
        rueck.offline = false; delete rueck.offlineBis;
        if (msg.name) rueck.name = msg.name;
        if (msg.avatar) rueck.avatar = msg.avatar;
        if (msg.accessory) rueck.accessory = msg.accessory;
        idUmschreiben(alteId, conn.peer);
        players = players.filter(p => p === rueck || !p.key || p.key !== msg.key);
        const oldC = conns.get(alteId);
        if (oldC && oldC !== conn) {
          try { oldC.close(); } catch {}
          conns.delete(alteId);
        }
        // Szene-Metadaten IMMER mitschicken (auch bei eigenem Video) — sonst crasht loadMix
        conn.send({
          t: "rejoined", phase: aktuellePhase(), role: rueck.role,
          scene: scene || null,
          hatVideoUebertragung: !!(scene && localVideoBuf),
          match: matchPayload(),
          duelInfo, mix: finalTracksData,
          ...metaMapsFromTracks(finalTracksData),
        });
        if (scene && localVideoBuf) sendLocalVideo(conn);
        conn.send({ t: "drawState", drawBoard });
        showToast("🔌 " + rueck.name + " ist wieder da!", "join");
        SFX.ok();
        broadcast({ t: "playerBack", name: rueck.name });
        broadcastState();
        syncForceMixBtn();
        break;
      }
      if (players.length >= 8) { conn.send({ t: "full", cap: 8 }); setTimeout(() => conn.close(), 500); break; }
      players.push({ id: conn.peer, key: msg.key || null, name: msg.name, avatar: msg.avatar || null, accessory: msg.accessory || null, role: null, ready: false, done: 0, total: 0, loadPct: 0, videoReady: false });
      if (scene) { if (localVideoBuf) sendLocalVideo(conn); else conn.send({ t: "scene", scene }); }
      conn.send({ t: "drawState", drawBoard });
      // Spät dazukommen mitten in der Runde → in die laufende Phase holen
      const ph = aktuellePhase();
      if (ph && ph !== "scr-lobby" && ph !== "scr-start") {
        conn.send({
          t: "rejoined", phase: ph, role: null, forceRestore: true,
          scene: scene || null,
          hatVideoUebertragung: !!(scene && localVideoBuf),
          match: matchPayload(),
          duelInfo, mix: finalTracksData,
          ...metaMapsFromTracks(finalTracksData),
        });
      }
      broadcastState();
      break;
    }
    case "bye": {
      const p = players.find(p => p.id === conn.peer);
      if (p) { p.gehtFreiwillig = true; endgueltigWeg(p); }
      break;
    }
    case "pickRole": {
      const taken = players.some(p => p.role === msg.role && p.id !== conn.peer);
      if (!taken) { const p = players.find(p => p.id === conn.peer); if (p) { p.role = msg.role; p.ready = false; } }
      broadcastState(); break;
    }
    case "ready": { const p = players.find(p => p.id === conn.peer); if (p && p.role != null) p.ready = true; broadcastState(); break; }
    case "progress": { const p = players.find(p => p.id === conn.peer); if (p) { p.done = msg.done; p.total = msg.total; } broadcastState({ throttle: true }); break; }
    case "loadProg": {
      const p = players.find(p => p.id === conn.peer);
      if (p) { p.loadPct = msg.pct | 0; p.videoReady = !!msg.ready; }
      broadcastState({ throttle: !msg.ready });
      break;
    }
    case "tracks": collectTracks(msg.role, attachTrackMeta(msg.items, msg), msg.outtakes, conn.peer); break;
    case "trackUpdate": {
      const tm = msg.trackMeta || msg;
      applyTrackUpdate(msg.role, msg.lineIdx, msg.startAt, msg.buf, tm.effect, tm.gate, tm.boost, tm.fxAmount, tm.pan);
      break;
    }
    case "ttt": tttHandle(msg.a, conn.peer); break;
    case "rps": rpsHandle(msg.a, conn.peer); break;
    case "dice": diceHandle(msg.a, conn.peer); break;
    case "draw": drawHandle(msg.a, conn.peer); break;
    case "rate": collectRating(conn.peer, msg.scores, msg.buddy); break;
    case "mg":
      if (msg.k === "rxStart") { const d = 1500 + Math.random() * 3500; broadcast({ t: "rxGo", delay: d }); rxRun(d); }
      if (msg.k === "tpStart") { const ph = TP_PHRASES[Math.floor(Math.random() * TP_PHRASES.length)]; broadcast({ t: "tpGo", phrase: ph }); tpRun(ph); }
      if (msg.k === "rxScore") mgScore("rx", conn.peer, msg.ms);
      if (msg.k === "tpScore") mgScore("tp", conn.peer, msg.ms);
      break;
    case "emoji": emojiBroadcast(conn.peer, msg.char); break;
    case "premReady": {
      const p = players.find(p => p.id === conn.peer);
      if (p) p.prem = true;
      broadcastState();
      renderPremState();
      broadcastPremOrig();
      break;
    }
    case "cb":
      if (msg.a && msg.a.k === "start") { broadcast({ t: "cbGo" }); cbRun(); }
      if (msg.a && msg.a.k === "score") cbScore(conn.peer, msg.a.n);
      break;
    case "duelSubmit": collectDuelSubmit(conn.peer, attachTrackMeta(msg.items, msg)); break;
    case "duelVote": collectDuelVote(conn.peer, msg.choice); break;

    // — Gast ← Host —
    case "full":
      status("start-status", "Raum ist voll (max. " + (msg.cap || 8) + " Spieler). 😅", true);
      show("scr-start"); break;
    case "state": players = msg.players; renderPlayers(); renderRoles(); renderBoothPlayers(); if (document.querySelector("#scr-playback.active")) renderPremStateGuest(); break;
    case "scene": {
      scene = msg.scene; clearSceneVideoState(); clearSceneCaches();
      const phSc = aktuellePhase();
      if (phSc !== "scr-lobby" && phSc !== "scr-start" && phSc !== "scr-mic" && phSc !== "scr-avatar") {
        resetForNewRound();
      }
      showScene(sceneVideoSrc());
      break;
    }
    case "playerLeft": showToast("👋 " + msg.name + " hat den Raum verlassen", "leave"); SFX.leave(); break;
    case "playerOffline": showToast("📴 " + msg.name + " ist rausgeflogen — Platz bleibt frei", "leave"); break;
    case "playerBack": showToast("🔌 " + msg.name + " ist wieder da!", "join"); SFX.ok(); break;
    case "rejoined":
      wvVersuch = 0; clearTimeout(wvTimer); wvBannerAus();
      applyPhaseRestore(msg);
      break;
    case "settings": match.mode = msg.mode; match.rounds = msg.rounds; match.round = msg.round; match.autoRoulette = msg.autoRoulette; renderSettingsView(msg); break;
    case "sceneReset": {
      scene = null; clearSceneVideoState(); clearSceneCaches();
      const phRs = aktuellePhase();
      if (phRs !== "scr-lobby" && phRs !== "scr-start" && phRs !== "scr-mic" && phRs !== "scr-avatar") {
        resetForNewRound();
      }
      const card = $("scene-card"); if (card) card.style.display = "none";
      renderPlayers();
      break;
    }
    case "duelSetupInfo": duelInfo = msg.duelInfo; break;
    case "duelReady":
      attachMetaToTracks(msg.dataA, msg.metaA || msg);
      attachMetaToTracks(msg.dataB, msg.metaB || msg);
      loadDuelSequence(msg.dataA, msg.dataB, msg.duelInfo);
      break;
    case "duelPlayGo": if (window.__duelRunSequence) { window.__duelRunSequence(); window.__duelRunSequence = null; } break;
    case "duelVoteBroadcast": showDuelVoteLive(msg.tally); break;
    case "duelResult": showDuelResult(msg.result); break;
    case "wins": Object.assign(mgWins, msg.wins); renderWins(); break;
    case "nextRound":
      match.round = msg.round; players = msg.players;
      if (msg.scene) { scene = msg.scene; clearSceneVideoState(); clearSceneCaches(); backToLobby(true); showScene(sceneVideoSrc()); renderSettingsView(); status("lobby-status", "🎲 Runde " + match.round + ": neue Szene & Rollen! „Bin bereit“ drücken."); }
      else startNewRound();
      break;
    case "matchEnd": showFinal(msg.list, msg.rounds, msg.championName); break;
    case "matchLobby": backToLobby(); break;
    case "videoMeta": startVideoReceive(msg); break;
    case "videoChunk": receiveVideoChunk(msg.buf); break;
    case "goLines": queueOrStartBooth(); break;
    case "go": queueOrStartRealtime(); break;
    case "mix": loadMix(msg.data, msg); break;
    case "outtakesPool":
      outtakes = dedupeOuttakes(Array.isArray(msg.items) ? msg.items : []);
      outtakesCache = null;
      resolveOuttakesCachePending(null);
      updateOuttakesBtn();
      scheduleOuttakesPrecache();
      break;
    case "playOuttakes":
      // Host spielt lokal selbst — Echo/Doppelstart vermeiden
      if (!isHost) playOuttakesReel();
      break;
    case "tttState": ttt = msg.ttt; renderTTT(); break;
    case "rpsState": rps = msg.rps; renderRPS(); break;
    case "diceState": dice = msg.dice; renderDice(); break;
    case "drawState": drawBoard = msg.drawBoard; renderDrawBoard(); break;
    case "premGo": premStart(); break;
    case "premOrig": applyPremOrigMsg(msg); break;
    case "premPause": premPauseAll(false); break;
    case "premResume": premResumeAll(false); break;
    case "emojiShow": showEmoji(msg.pid, msg.char); break;
    case "rateResult": showRateResult(msg.results, msg.eliminatedName); break;
    case "rxGo": rxRun(msg.delay); break;
    case "tpGo": tpRun(msg.phrase); break;
    case "mgResult": mgShowResult(msg.game, msg.list); break;
    case "cbGo": cbRun(); break;
    case "cbResult": cbShowResult(msg.list); break;
    case "again": resetForNewRound(); break;
  }
}


// ═════════════════════════════════════════════════════════════
// 3) SZENEN
// ═════════════════════════════════════════════════════════════
let sceneList = [];

// ── Schwierigkeitsgrad einer Szene (automatisch berechnet aus Tempo & Zeitfenstern) ──
function sceneDifficulty(s) {
  if (s.difficultyOverride) {
    const map = { easy: { label: "Easy", emoji: "🟢" }, medium: { label: "Medium", emoji: "🟡" }, hard: { label: "Zungenbrecher", emoji: "🔴" } };
    if (map[s.difficultyOverride]) return map[s.difficultyOverride];
  }
  if (!s.lines || !s.lines.length) return null;
  const lines = s.lines;
  const dur = Math.max(...lines.map(l => l.end)) - Math.min(...lines.map(l => l.t));
  const words = lines.reduce((sum, l) => sum + (l.text || "").split(/\s+/).filter(Boolean).length, 0);
  const wps = words / Math.max(1, dur);
  const avgWin = lines.reduce((sum, l) => sum + (l.end - l.t), 0) / lines.length;
  const avgWords = words / lines.length;
  const score = wps * 1.4 - avgWin * 0.25 + avgWords * 0.05;
  if (score < 2.0) return { label: "Easy", emoji: "🟢" };
  if (score < 3.2) return { label: "Medium", emoji: "🟡" };
  return { label: "Zungenbrecher", emoji: "🔴" };
}

const HINTEN_ANSTELLEN = new Set(["testplace"]);

async function loadSceneList() {
  const sel = $("scene-select");
  if (!sel) return;
  try {
    const res = await fetch("scenes.json?t=" + Date.now(), { cache: "no-store" });
    sceneList = await res.json();
  } catch (e) {
    console.error("scenes.json laden fehlgeschlagen:", e);
    sceneList = [];
  }
  // Test-Szenen gehören ans Ende: sie sind nur zum Ausprobieren da und sollen beim
  // Durchschauen nicht im Weg stehen. Alles andere behält seine Reihenfolge.
  sceneList = [...sceneList.filter(s => !HINTEN_ANSTELLEN.has(s.id)), ...sceneList.filter(s => HINTEN_ANSTELLEN.has(s.id))];
  sel.innerHTML = sceneList.length
    ? sceneList.map((s, i) => {
        const d = sceneDifficulty(s);
        return `<option value="${i}">${d ? d.emoji + " " : ""}${esc(s.title)} (${s.roles.length} Rollen${s.lines ? ", " + s.lines.length + " Lines" : ""}${d ? " · " + d.label : ""})</option>`;
      }).join("")
    : "<option>— Szenen laden… kurz warten &amp; Seite neu laden —</option>";
  renderRoleFilter();
  renderSceneGrid();
}

// ── Szenen-Auswahl als Bild-Raster ──
// Das <select> bleibt als unsichtbare Quelle der Wahrheit erhalten, damit der restliche
// Code (Laden-Knopf, Duell, Roulette) unverändert damit weiterarbeiten kann.
let thumbObserver = null;
let sceneRoleFilter = "all";   // "all" | "2" | "3" | … | "7p" (≥7)

function renderRoleFilter() {
  const bar = $("role-filter");
  if (!bar) return;
  const counts = {};
  for (const s of sceneList) {
    const n = (s.roles || []).length;
    if (!n) continue;
    const key = n >= 7 ? "7p" : String(n);
    counts[key] = (counts[key] || 0) + 1;
  }
  const chips = [{ key: "all", label: "Alle" }];
  for (let n = 1; n <= 6; n++) if (counts[String(n)]) chips.push({ key: String(n), label: n + " Rolle" + (n === 1 ? "" : "n") });
  if (counts["7p"]) chips.push({ key: "7p", label: "7+" });
  if (!counts[sceneRoleFilter] && sceneRoleFilter !== "all") sceneRoleFilter = "all";
  bar.innerHTML = `<span class="rf-label">Rollen</span>` + chips.map(c =>
    `<button type="button" class="rf-chip${c.key === sceneRoleFilter ? " on" : ""}" data-rf="${c.key}">${c.label}</button>`
  ).join("");
  bar.querySelectorAll(".rf-chip").forEach(btn => {
    btn.onclick = () => {
      sceneRoleFilter = btn.dataset.rf;
      bar.querySelectorAll(".rf-chip").forEach(b => b.classList.toggle("on", b.dataset.rf === sceneRoleFilter));
      SFX.click();
      renderSceneGrid();
    };
  });
}

function renderSceneGrid(filter) {
  const grid = $("scene-grid");
  if (!grid) return;
  const q = (filter == null ? ($("scene-search") ? $("scene-search").value : "") : filter).trim().toLowerCase();
  const hits = sceneList
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => {
      const n = (s.roles || []).length;
      if (sceneRoleFilter === "7p") { if (n < 7) return false; }
      else if (sceneRoleFilter !== "all" && n !== parseInt(sceneRoleFilter, 10)) return false;
      if (!q) return true;
      return (s.title + " " + (s.roles || []).map(r => r.name).join(" ")).toLowerCase().includes(q);
    });

  if (!sceneList.length) { grid.innerHTML = `<p class="sub" style="grid-column:1/-1">Szenen laden … kurz warten und Seite neu laden.</p>`; return; }
  if (!hits.length) {
    const tip = sceneRoleFilter !== "all" ? " mit diesem Rollen-Filter" : "";
    grid.innerHTML = `<p class="sub" style="grid-column:1/-1">Keine Szene passt${q ? " zu „" + esc(q) + "“" : ""}${tip}.</p>`;
    return;
  }

  const sel = $("scene-select");
  // Steht die aktuell gewählte Szene nicht in den Suchtreffern, rutscht die Auswahl
  // auf den ersten Treffer — sonst würde „Laden“ eine Szene starten, die gar nicht zu sehen ist.
  if (sel && !hits.some(h => String(h.i) === String(sel.value))) sel.value = String(hits[0].i);
  const current = sel ? String(sel.value) : "0";
  grid.innerHTML = hits.map(({ s, i }) => {
    const d = sceneDifficulty(s);
    const at = (s.lines && s.lines.length ? s.lines[0].t : 1) + 0.35;   // erster gesprochener Moment zeigt am besten, was los ist
    const fb = Object.values(s.avatars || {})[0] || "";
    return `<button type="button" class="scene-tile${String(i) === current ? " sel" : ""}" data-i="${i}"
        data-src="${esc(assetUrl(s.videoUrl))}" data-at="${at.toFixed(2)}" data-fb="${esc(fb)}">
      <span class="st-thumb"><span class="st-ph">🎬</span><span class="st-badge">${s.roles.length}&nbsp;Rollen</span></span>
      <span class="st-title">${esc(s.title)}</span>
      <span class="st-meta">${d ? d.emoji + " " + esc(d.label) : "—"}${s.lines ? " · " + s.lines.length + " Lines" : ""}</span>
    </button>`;
  }).join("");

  grid.querySelectorAll(".scene-tile").forEach(tile => {
    tile.onclick = () => {
      const alreadyPicked = tile.classList.contains("sel");
      grid.querySelectorAll(".scene-tile.sel").forEach(t => t.classList.remove("sel"));
      tile.classList.add("sel");
      if (sel) sel.value = tile.dataset.i;
      SFX.click();
      if (alreadyPicked) $("btn-load-scene").click();   // zweiter Klick auf dieselbe Szene lädt sie direkt
    };
  });

  // Vorschaubilder erst laden, wenn die Kachel wirklich sichtbar ist
  if (thumbObserver) thumbObserver.disconnect();
  if (typeof IntersectionObserver === "function") {
    thumbObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach(e => { if (e.isIntersecting) { mountSceneThumb(e.target); obs.unobserve(e.target); } });
    }, { root: grid, rootMargin: "150px" });
    grid.querySelectorAll(".scene-tile").forEach(t => thumbObserver.observe(t));
  } else {
    grid.querySelectorAll(".scene-tile").forEach(mountSceneThumb);
  }
}
// Standbild aus dem Video holen — so bekommt jede Szene automatisch ein Bild,
// auch neu hinzugefügte, ohne dass extra Dateien gepflegt werden müssen.
// Sobald das Bild da ist, wird es auf eine kleine Leinwand gemalt und das Video
// wieder freigegeben: 43 offene Videos gleichzeitig würden sonst den Speicher fluten.
function mountSceneThumb(tile) {
  if (tile.dataset.thumb) return;
  tile.dataset.thumb = "1";
  const holder = tile.querySelector(".st-thumb");
  const ph = holder.querySelector(".st-ph");
  const at = parseFloat(tile.dataset.at) || 1;
  const v = document.createElement("video");
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = "metadata";
  v.setAttribute("muted", ""); v.setAttribute("playsinline", "");

  const zeigeErsatzbild = () => {
    const fb = tile.dataset.fb;
    if (fb) { const img = document.createElement("img"); img.src = fb; img.alt = ""; holder.insertBefore(img, holder.firstChild); if (ph) ph.remove(); }
    else if (ph) ph.textContent = "🚫";
  };
  const einfrieren = () => {
    if (tile.dataset.frozen) return;
    tile.dataset.frozen = "1";
    try {
      const breit = 320, verhaeltnis = v.videoWidth ? v.videoHeight / v.videoWidth : 0.5625;
      const c = document.createElement("canvas");
      c.width = breit; c.height = Math.max(1, Math.round(breit * verhaeltnis));
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      holder.insertBefore(c, holder.firstChild);
      if (ph) ph.remove();
    } catch { zeigeErsatzbild(); }
    v.removeAttribute("src");
    try { v.load(); } catch {}
    v.remove();
  };

  let sprungNoetig = false;
  v.addEventListener("loadedmetadata", () => {
    const ziel = Math.min(at, Math.max(0, (v.duration || at) - 0.1));
    if (Math.abs(v.currentTime - ziel) > 0.3) { sprungNoetig = true; try { v.currentTime = ziel; } catch { sprungNoetig = false; } }
  }, { once: true });
  v.addEventListener("seeked", einfrieren, { once: true });
  v.addEventListener("loadeddata", () => { if (!sprungNoetig) einfrieren(); }, { once: true });
  v.addEventListener("error", () => { v.remove(); zeigeErsatzbild(); }, { once: true });
  // Reißleine, falls der Sprung nie zurückmeldet (z. B. Server ohne Range-Unterstützung)
  setTimeout(() => { if (!tile.dataset.frozen && v.readyState >= 2) einfrieren(); }, 8000);

  v.src = tile.dataset.src + "#t=" + at.toFixed(2);
  holder.insertBefore(v, holder.firstChild);
}
$("scene-search") && ($("scene-search").oninput = () => renderSceneGrid());

// Spielmodus: große Taster statt kleinem Dropdown — wählt intern weiter das <select>
function syncModePicker(mode) {
  const m = mode || ($("set-mode") && $("set-mode").value) || "free";
  if ($("set-mode")) $("set-mode").value = m;
  document.querySelectorAll("#mode-picker .mode-btn").forEach(btn => {
    const on = btn.dataset.mode === m;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}
$("mode-picker") && $("mode-picker").querySelectorAll(".mode-btn").forEach(btn => {
  btn.onclick = () => {
    if (!isHost) return;
    syncModePicker(btn.dataset.mode);
    SFX.click();
    hostSettingsChanged();
  };
});
syncModePicker();

// ── 🔍 Selbst-Check: prüft, ob wirklich alle in scenes.json referenzierten Dateien existieren ──
function filesOfScene(s) {
  const out = [];
  if (s.videoUrl) out.push(assetUrl(s.videoUrl));
  if (s.voiceTrack) out.push(assetUrl(s.voiceTrack));
  for (const a of Object.values(s.avatars || {})) out.push(assetUrl(a));
  for (const l of (s.lines || [])) if (l.orig) out.push(assetUrl(l.orig));
  return [...new Set(out)];   // Duplikate raus, spart Anfragen
}
async function checkFileExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.ok;
  } catch { return false; }
}
async function runWithLimit(tasks, limit) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}
$("btn-check-scenes") && ($("btn-check-scenes").onclick = async () => {
  const btn = $("btn-check-scenes");
  btn.disabled = true;
  $("check-result").style.display = "none";
  $("check-bar").style.display = "";
  setBar("check-bar", 0);

  // Alle Datei-Referenzen aus allen Szenen einsammeln
  const jobs = [];
  for (const s of sceneList) for (const f of filesOfScene(s)) jobs.push({ sceneId: s.id, title: s.title, file: f });
  if (!jobs.length) { status("check-status", "Keine Szenen geladen.", true); btn.disabled = false; $("check-bar").style.display = "none"; return; }

  let done = 0;
  const tasks = jobs.map(j => async () => {
    const ok = await checkFileExists(j.file);
    done++;
    setBar("check-bar", Math.round(done / jobs.length * 100));
    status("check-status", "Prüfe … " + done + "/" + jobs.length);
    return { ...j, ok };
  });
  const results = await runWithLimit(tasks, 8);   // max. 8 gleichzeitig, sonst überlastet's den Browser

  // Fehlende Dateien nach Szene gruppieren
  const broken = results.filter(r => !r.ok);
  const bySc = {};
  for (const b of broken) (bySc[b.sceneId] = bySc[b.sceneId] || { title: b.title, files: [] }).files.push(b.file);

  $("check-bar").style.display = "none";
  const el = $("check-result");
  el.style.display = "";
  if (!broken.length) {
    status("check-status", "");
    el.innerHTML = `<div class="raterow" style="border-color:var(--ok)"><span>✅ Alles in Ordnung — alle ${jobs.length} Dateien aus ${sceneList.length} Szenen sind erreichbar.</span></div>`;
  } else {
    status("check-status", "");
    el.innerHTML = `<div class="raterow" style="border-color:var(--hot);margin-bottom:8px"><span>⚠️ ${broken.length} von ${jobs.length} Dateien fehlen (${Object.keys(bySc).length} Szenen betroffen)</span></div>` +
      Object.entries(bySc).map(([sid, info]) => `
        <div style="background:#14141b;border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:6px">
          <div style="font-weight:700;margin-bottom:4px">${esc(info.title)} <span class="tag">(${esc(sid)})</span></div>
          ${info.files.map(f => `<div class="tag" style="color:var(--hot);text-transform:none;letter-spacing:0">✕ ${esc(f)}</div>`).join("")}
        </div>`).join("");
  }
  btn.disabled = false;
});

$("btn-load-scene").onclick = () => {
  const s = sceneList[$("scene-select").value];
  if (!s) return;
  // Host lokal genauso zurücksetzen wie die Gäste (Premiere-Reste, Takes, …)
  resetForNewRound();
  clearSceneCaches();
  scene = JSON.parse(JSON.stringify(s));       // Kopie, damit Blind-Flag das Original nicht verändert
  scene.blind = $("blind-mode").checked;
  clearSceneVideoState();
  resetRoles();
  showScene(sceneVideoSrc());
  // Zuerst alle aus Premiere/Warte holen (falls „again“ vorher verpasst wurde), dann Szene.
  broadcast({ t: "again" });
  broadcast({ t: "scene", scene });
  broadcastSettings();
  broadcastState();
};

const EFFECTS = {
  none: "Normal", vintage_1990: "Vintage / 90er Tape", radio: "Funkgerät", telefon: "Telefon", hall: "Halliger Raum",
  megaphone: "Megafon", underwater: "Unter Wasser", helium: "Helium", monster: "Monster", robot: "Roboter",
  chorus: "Doppelgänger", echo: "Nachschlag-Echo", titan: "Titan (sehr tief)",
  studio: "🎙 Studio-Qualität (rettet schlechte Mikros)"
};

// ── Spieler kann pro Line seinen eigenen Effekt waehlen — ueberschreibt Rollen-/Szenen-Standard NUR fuer diese Line ──
let myEffectOverrides = {};   // lineIdx -> Effekt-Key (nur gesetzt, wenn vom Standard abweichend)
let myEffectAmounts = {};     // lineIdx -> Effekt-Staerke 0..1 (nur gesetzt, wenn abweichend von voll)
let myLineGains = {};        // lineIdx -> Lautstaerke-Faktor (1 = unveraendert)
let myLinePans = {};         // lineIdx -> Stereo-Pan -1..1 (nur gesetzt, wenn Spieler selbst wählt)
// Einfache Stereo-Presets (kein echtes Oben/Unten — Kopfhörer/Boxen können nur links↔rechts)
const LINE_PAN_PRESETS = [
  { id: "auto", label: "Auto", tip: "Wie die Rolle (Standard)", pan: undefined },
  { id: "L",    label: "Links", tip: "Ganzer linker Ohrhörer", pan: -1 },
  { id: "l",    label: "Etwas L", tip: "Leicht nach links", pan: -0.5 },
  { id: "C",    label: "Mitte", tip: "Genau in der Mitte", pan: 0 },
  { id: "r",    label: "Etwas R", tip: "Leicht nach rechts", pan: 0.5 },
  { id: "R",    label: "Rechts", tip: "Ganzer rechter Ohrhörer", pan: 1 },
];
function panPresetId(pan) {
  if (pan === undefined || pan === null) return "auto";
  const hit = LINE_PAN_PRESETS.find(p => p.id !== "auto" && p.pan === pan);
  return hit ? hit.id : "auto";
}
function panLabel(pan) {
  if (pan == null || pan === 0) return "Mitte";
  if (pan <= -0.85) return "Links";
  if (pan < 0) return "Etwas L";
  if (pan >= 0.85) return "Rechts";
  return "Etwas R";
}
// ── Noise Gate NACHTRÄGLICH auf eine fertige Aufnahme anwenden (wie ein Effekt, nicht live eingebrannt) ──
// ═════════════════════════════════════════════════════════════
// 🎙 STUDIO-AUFBEREITUNG — echte Rauschunterdrueckung im Frequenzbereich
// Reine EQ-Filter machen eine Aufnahme nur lauter/heller. Was wirklich "sauber" klingt,
// ist das Herausrechnen von Grundrauschen, Luefter-, Raum- und Elektronikgeraeuschen.
// Dafuer wird das Signal in ueberlappende Zeitfenster zerlegt, jedes in seine Frequenzen
// zerlegt (FFT), der Rauschteppich pro Frequenz geschaetzt und abgezogen -- dann zurueck.
// ═════════════════════════════════════════════════════════════
function fftRadix2(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {           // Bit-Umkehr-Sortierung
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function denoiseChannel(x, strength, sampleRate) {
  const N = 2048, HOP = 512, SR = sampleRate || 44100;
  if (x.length < N * 3) return x;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const frames = Math.floor((x.length - N) / HOP) + 1;
  const bins = N / 2 + 1;

  // ── 1) Zerlegen: Betrag + Phase je Zeitfenster ──
  const pow = [], phRe = [], phIm = [];
  for (let f = 0; f < frames; f++) {
    const re = new Float64Array(N), im = new Float64Array(N);
    const off = f * HOP;
    for (let i = 0; i < N; i++) re[i] = (x[off + i] || 0) * win[i];
    fftRadix2(re, im, false);
    const p = new Float32Array(bins);
    for (let b = 0; b < bins; b++) p[b] = re[b] * re[b] + im[b] * im[b];
    pow.push(p); phRe.push(re); phIm.push(im);
  }

  // ── 2) Stoerteppich mitlaufend schaetzen (Minimum-Statistik) ──
  // Pro Frequenz wird das Minimum in einem Zeitfenster verfolgt: waehrend einer Sprechpause
  // bleibt nur das Stoergeraeusch uebrig, und das ist die Schaetzung. Berechnet in Bloecken
  // und danach ueber die Nachbarbloecke -- gleiches Ergebnis wie ein gleitendes Fenster,
  // aber ein Vielfaches schneller (vorher lief das bei jeder Aufnahme spuerbar lange).
  const SMOOTH = 0.9;
  const smoothed = [];
  const cur = new Float32Array(bins);
  for (let b = 0; b < bins; b++) cur[b] = pow[0][b];
  for (let f = 0; f < frames; f++) {
    const sm = new Float32Array(bins);
    for (let b = 0; b < bins; b++) { cur[b] = SMOOTH * cur[b] + (1 - SMOOTH) * pow[f][b]; sm[b] = cur[b]; }
    smoothed.push(sm);
  }
  const BLK = Math.max(4, Math.round(0.7 * SR / HOP));
  const nblk = Math.max(1, Math.ceil(frames / BLK));
  const blkMin = [];
  for (let k = 0; k < nblk; k++) {
    const m = new Float32Array(bins).fill(Infinity);
    const hi = Math.min(frames, (k + 1) * BLK);
    for (let f = k * BLK; f < hi; f++) { const sm = smoothed[f]; for (let b = 0; b < bins; b++) if (sm[b] < m[b]) m[b] = sm[b]; }
    blkMin.push(m);
  }
  const noiseBlk = [];
  for (let k = 0; k < nblk; k++) {
    const nz = new Float32Array(bins);
    const a = blkMin[Math.max(0, k - 1)], c = blkMin[Math.min(nblk - 1, k + 1)], m = blkMin[k];
    // Faktor 1.5, weil ein Minimum den Stoerteppich systematisch etwas zu tief schaetzt.
    // Vorher stand hier 1.9 und spaeter noch ein zweiter Faktor -- zusammen wurde damit rund
    // das Dreifache abgezogen, und genau davon kam der dumpfe, gluckernde Klang.
    for (let b = 0; b < bins; b++) nz[b] = Math.min(a[b], Math.min(m[b], c[b])) * 1.5;
    noiseBlk.push(nz);
  }

  // ── 2b) Zwei Bremsen gegen "die ganze Aufnahme ist Rauschen" ──
  // Die Minimum-Statistik setzt voraus, dass es zwischendurch Sprechpausen gibt. Bei einem
  // lang gehaltenen Laut -- Schrei, gehaltener Vokal, in Anime-Szenen ständig -- gibt es die
  // nicht. Dann haelt sie den Laut selbst fuer Rauschen und saugt die Stimme weg.
  // Bremse 1: die Schaetzung darf nur einen kleinen Teil der Gesamtenergie erklaeren.
  let gesamtE = 0, geschaetztE = 0;
  for (let f = 0; f < frames; f++) { const p = pow[f]; for (let b = 0; b < bins; b++) gesamtE += p[b]; }
  for (let f = 0; f < frames; f++) { const nz = noiseBlk[Math.min(nblk - 1, Math.floor(f / BLK))]; for (let b = 0; b < bins; b++) geschaetztE += nz[b]; }
  const OBERGRENZE = 0.12;
  if (geschaetztE > gesamtE * OBERGRENZE && geschaetztE > 0) {
    const k = (gesamtE * OBERGRENZE) / geschaetztE;
    for (const nz of noiseBlk) for (let b = 0; b < bins; b++) nz[b] *= k;
  }
  // Bremse 2: je deutlicher ein Zeitfenster ueber der ruhigsten Stelle der Aufnahme liegt,
  // desto weniger wird darin eingegriffen -- laute Stellen sind mit Sicherheit Stimme.
  const rahmenE = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let s2 = 0; const p = pow[f]; for (let b = 0; b < bins; b++) s2 += p[b]; rahmenE[f] = s2; }
  const sortiert = Float32Array.from(rahmenE).sort();
  const ruheE = Math.max(sortiert[Math.floor(frames * 0.15)], 1e-12);
  const sicherStimme = new Float32Array(frames);
  for (let f = 0; f < frames; f++) sicherStimme[f] = Math.max(0, Math.min(1, (10 * Math.log10(rahmenE[f] / ruheE)) / 20));

  // ── 3) Klick-Erkennung ──
  // Mausklicks/Tastenanschlaege sind sehr kurz und ueber alle Frequenzen verteilt.
  // Ein Frame gilt als Klick, wenn die Energie in den Hoehen schlagartig hochschiesst
  // und direkt danach wieder faellt -- so etwas macht keine Stimme.
  const hfStart = Math.floor(bins * 0.45);
  const hf = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let s2 = 0; for (let b = hfStart; b < bins; b++) s2 += pow[f][b]; hf[f] = s2; }
  const isClick = new Uint8Array(frames);
  for (let f = 2; f < frames - 2; f++) {
    const around = (hf[f - 2] + hf[f - 1] + hf[f + 1] + hf[f + 2]) / 4 + 1e-12;
    if (hf[f] > around * 6) isClick[f] = 1;
  }

  // ── 4) Zischlaut-Daempfer (De-Esser) ──
  // Billige Mikrofone uebertreiben S-, Z- und T-Laute. Pro Zeitfenster wird verglichen,
  // wie viel Energie im Zischbereich sitzt im Verhaeltnis zum Stimmkoerper. Nur wenn das
  // Verhaeltnis aus dem Ruder laeuft, wird der Zischbereich fuer dieses Fenster leiser
  // gemacht -- ein fester Filter wuerde dagegen die ganze Aufnahme dumpf machen.
  const binHz = SR / N;
  const sbLo = Math.min(bins - 1, Math.round(4800 / binHz)), sbHi = Math.min(bins - 1, Math.round(9800 / binHz));
  const bdLo = Math.min(bins - 1, Math.round(250 / binHz)), bdHi = Math.min(bins - 1, Math.round(3400 / binHz));
  const sibG = new Float32Array(frames).fill(1);
  let sibPrev = 1;
  for (let f = 0; f < frames; f++) {
    const p = pow[f];
    let sib = 0, body = 0;
    for (let b = sbLo; b <= sbHi; b++) sib += p[b];
    for (let b = bdLo; b <= bdHi; b++) body += p[b];
    const verhaeltnis = sib / (body + 1e-12);
    const GRENZE = 0.32;
    let dg = verhaeltnis > GRENZE ? Math.sqrt(GRENZE / verhaeltnis) : 1;
    dg = Math.max(0.42, dg);                    // maximal rund 7 dB -- mehr klingt gelispelt
    sibPrev = dg < sibPrev ? 0.4 * sibPrev + 0.6 * dg : 0.75 * sibPrev + 0.25 * dg;   // schnell zu, langsam auf
    sibG[f] = sibPrev;
  }

  // ── 5) Wiener-Filter mit vorausschauender Signalschaetzung ──
  // Der entscheidende Unterschied zum simplen Abziehen: die Daempfung pro Frequenz wird
  // aus dem VERLAUF ueber die Zeit abgeleitet und geglaettet. Dadurch springen einzelne
  // Frequenzpunkte nicht mehr zufaellig an/aus -- genau das erzeugt sonst das metallische Glucksen.
  const s = Math.max(0, Math.min(1, strength === undefined ? 1 : strength));
  const ALPHA = 0.98;                                   // wie stark der Verlauf mitzaehlt
  // Untergrenze der Daempfung. Bewusst hoch angesetzt: 15 dB saubere, ruhige Absenkung
  // klingen deutlich besser als 25 dB, die dabei pumpen und zirpen.
  const floorG = Math.max(0.15, 0.34 - s * 0.19);
  const gPrev = new Float32Array(bins).fill(1);
  const gamPrev = new Float32Array(bins).fill(1);
  const gSmoothPrev = new Float32Array(bins).fill(1);
  const out = new Float32Array(x.length), norm = new Float32Array(x.length);
  const g = new Float32Array(bins), gs = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    const p = pow[f], nz = noiseBlk[Math.min(nblk - 1, Math.floor(f / BLK))];
    for (let b = 0; b < bins; b++) {
      const nn = Math.max(nz[b], 1e-12) * (0.9 + s * 0.5);
      const gamma = p[b] / nn;                                        // gemessener Abstand zum Stoerteppich
      const inst = Math.max(gamma - 1, 0);
      const xi = Math.max(ALPHA * gPrev[b] * gPrev[b] * gamPrev[b] + (1 - ALPHA) * inst, 1e-4);
      g[b] = Math.max(floorG, xi / (1 + xi));                         // Wiener-Daempfung
      gamPrev[b] = gamma;
    }
    for (let b = 0; b < bins; b++) {                                  // ueber Nachbarfrequenzen glaetten
      const a = g[Math.max(0, b - 2)], b1 = g[Math.max(0, b - 1)];
      const c1 = g[Math.min(bins - 1, b + 1)], c = g[Math.min(bins - 1, b + 2)];
      gs[b] = (a + b1 * 2 + g[b] * 3 + c1 * 2 + c) / 9;
    }
    const sg = sibG[f];
    // Bei sicherer Sprache nur noch ein Viertel der Daempfung anwenden. Die Schaetzung selbst
    // laeuft unveraendert weiter (gPrev/gSmoothPrev), damit der Verlauf nicht durcheinandergeraet.
    const nachlass = 1 - 0.75 * sicherStimme[f];
    for (let b = 0; b < bins; b++) {                                  // ueber die Zeit glaetten
      gs[b] = 0.7 * gsPrevSafe(gSmoothPrev, b) + 0.3 * gs[b];
      if (isClick[f] && b >= hfStart) gs[b] = Math.min(gs[b], floorG);   // Klick wegdaempfen
      gSmoothPrev[b] = gs[b];
      gPrev[b] = gs[b];
      gs[b] = 1 - (1 - gs[b]) * nachlass;
      if (b >= sbLo && b <= sbHi) gs[b] *= sg;                        // Zischlaut-Daempfung obendrauf
    }
    const re = phRe[f], im = phIm[f];
    for (let b = 0; b < bins; b++) {
      re[b] *= gs[b]; im[b] *= gs[b];
      if (b > 0 && b < N / 2) { re[N - b] = re[b]; im[N - b] = -im[b]; }
    }
    fftRadix2(re, im, true);
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      if (off + i >= out.length) break;
      out[off + i] += re[i] * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : x[i];
  return out;
}
function gsPrevSafe(arr, b) { const v = arr[b]; return isFinite(v) ? v : 1; }

function studioEnhanceBuffer(ctx, buffer, strength) {
  try {
    const s = Math.max(0, Math.min(1, strength === undefined ? 1 : strength));
    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      // Gleichspannungs-Versatz abziehen. Viele billige Mikros liefern eine leicht
      // verschobene Nulllinie -- das kostet Pegel und macht den Klang matschig.
      // Auf einer Kopie, damit die Rohaufnahme unberuehrt bleibt (die wird noch gebraucht,
      // wenn man den Effekt wieder abwaehlt).
      const roh = Float32Array.from(buffer.getChannelData(ch));
      let mittel = 0;
      for (let i = 0; i < roh.length; i++) mittel += roh[i];
      mittel /= Math.max(1, roh.length);
      if (Math.abs(mittel) > 0.0008) for (let i = 0; i < roh.length; i++) roh[i] -= mittel;

      const d = denoiseChannel(roh, s, buffer.sampleRate);
      out.copyToChannel(d, ch);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    }

    // Lautheit statt Spitzenwert angleichen: ein einzelnes Knacken oder Atmen setzt sonst
    // den Spitzenwert, und die eigentliche Stimme bleibt zu leise. Gemessen wird deshalb
    // der Mittelwert der wirklich gesprochenen Stellen.
    const d0 = out.getChannelData(0);
    const schwelle = peak * 0.16;
    let sq = 0, n = 0;
    for (let i = 0; i < d0.length; i++) { const a = Math.abs(d0[i]); if (a > schwelle) { sq += d0[i] * d0[i]; n++; } }
    const rms = n > 64 ? Math.sqrt(sq / n) : 0;
    let gain = rms > 0.0005 ? 0.13 / rms : (peak > 0.001 ? 0.7 / peak : 1);
    gain = Math.max(1, Math.min(4, gain));
    if (peak * gain > 0.94) gain = 0.94 / Math.max(peak, 1e-6);   // nichts uebersteuern lassen
    if (gain !== 1) {
      for (let ch = 0; ch < out.numberOfChannels; ch++) {
        const d = out.getChannelData(ch);
        for (let i = 0; i < d.length; i++) d[i] *= gain;
      }
    }
    return out;
  } catch (e) { console.error("Studio-Aufbereitung fehlgeschlagen:", e); return buffer; }
}

// Leichte Spektral-Reinigung ohne Studio-Lautheits-Boost (für Gate-Regler)
function lightDenoiseBuffer(ctx, buffer, strength) {
  try {
    const s = Math.max(0, Math.min(1, strength || 0));
    if (s <= 0.02) return buffer;
    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const roh = Float32Array.from(buffer.getChannelData(ch));
      out.copyToChannel(denoiseChannel(roh, s, buffer.sampleRate), ch);
    }
    return out;
  } catch (e) {
    console.warn("leichte Rauschunterdrückung fehlgeschlagen:", e);
    return buffer;
  }
}

// Gate + (optional) leichte Denoise; Studio-Effekt wie bisher extra
function processTakeBuffer(ctx, buffer, gateAmount, effect, fxAmount) {
  let b = applyGateToBuffer(ctx, buffer, gateAmount);
  const g = Math.max(0, Math.min(1, gateAmount || 0));
  // Auch ohne Studio-Effekt: Gate-Stärke steuert leichte Denoise (max ~0.55)
  if (g > 0.05 && effect !== "studio") {
    b = lightDenoiseBuffer(ctx, b, Math.min(0.55, g * 0.65));
  }
  if (effect === "studio") b = studioEnhanceBuffer(ctx, b, fxAmount === undefined ? 1 : fxAmount);
  return b;
}

function applyGateToBuffer(ctx, buffer, gateAmount) {
  if (!gateAmount || gateAmount <= 0) return buffer;   // Gate aus -> unverändert
  const sr = buffer.sampleRate;
  const winSize = Math.max(1, Math.round(sr * 0.012));     // ~12ms
  const threshold = gateAmount * 0.14;                      // etwas sanfter als früher
  const kneeLo = threshold * 0.45;                          // Soft-Knee-Untergrenze
  const holdSamples = Math.round(sr * 0.28);                 // längeres Hangover
  const attackSamples = Math.round(sr * 0.005);
  const releaseSamples = Math.round(sr * 0.09);
  // Geschlossen nicht hart auf 0 — Restboden schützt leise Sprache
  const closedFloor = Math.max(0.03, 0.14 * (1 - gateAmount));

  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, sr);
  const nWindows = Math.ceil(buffer.length / winSize);
  const rms = new Float32Array(nWindows);
  // Grober Sprachband-Anteil: Differenz Hochpass-ähnlich (Differenz aufeinanderfolgender Samples)
  // + Mid-Energie — schützt Stimme, wenn Mid klar über dem Threshold liegt
  const midRatio = new Float32Array(nWindows);
  for (let w = 0; w < nWindows; w++) {
    let sum = 0, mid = 0, count = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      const start = w * winSize, end = Math.min(buffer.length, start + winSize);
      let prev = start > 0 ? data[start - 1] : 0;
      for (let i = start; i < end; i++) {
        const x = data[i];
        sum += x * x;
        const d = x - prev;           // Hochton-/Transient-Anteil
        mid += (x * x) * 0.55 + (d * d) * 0.45;
        prev = x;
        count++;
      }
    }
    rms[w] = count ? Math.sqrt(sum / count) : 0;
    midRatio[w] = count && sum > 1e-12 ? mid / sum : 0;
  }
  // Soft-Knee-Zielgain pro Fenster + Hangover wenn Sprachband klar da ist
  const targetGain = new Float32Array(nWindows);
  let lastOpenWin = -Infinity;
  for (let w = 0; w < nWindows; w++) {
    const r = rms[w];
    const speechProtect = midRatio[w] > 0.85 && r > kneeLo * 0.7;
    let g;
    if (r >= threshold || speechProtect) g = 1;
    else if (r <= kneeLo) g = closedFloor;
    else {
      const t = (r - kneeLo) / Math.max(1e-9, threshold - kneeLo);
      // smoothstep
      const s = t * t * (3 - 2 * t);
      g = closedFloor + (1 - closedFloor) * s;
    }
    if (g > 0.55) lastOpenWin = w;
    if ((w - lastOpenWin) * winSize <= holdSamples) g = Math.max(g, 0.85);
    targetGain[w] = g;
  }
  const gainCurve = new Float32Array(buffer.length);
  let currentGain = targetGain[0];
  for (let w = 0; w < nWindows; w++) {
    const start = w * winSize, end = Math.min(buffer.length, start + winSize);
    const target = targetGain[w];
    const speed = target > currentGain ? attackSamples : releaseSamples;
    for (let i = start; i < end; i++) {
      currentGain += (target - currentGain) / Math.max(1, speed);
      gainCurve[i] = currentGain;
    }
  }
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch), dst = out.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) dst[i] = src[i] * gainCurve[i];
  }
  return out;
}

function myEffectiveRole(l) {
  // Reihenfolge: Spieler-Wahl > Szenen-Autor-Override (l.effect) > Rollen-Standard
  const base = roleOf(myRole()) || { pan: 0, effect: "none", gain: 1 };
  const amt = myEffectAmounts[l.idx];
  const boost = myLineGains[l.idx];
  const panOv = myLinePans[l.idx];
  const withAmt = (r) => {
    let o = amt === undefined ? r : { ...r, fxAmount: amt };
    if (boost !== undefined && boost !== 1) o = { ...o, gain: (o.gain ?? 1) * boost };
    if (panOv !== undefined) o = { ...o, pan: panOv };
    return o;
  };
  const chosen = myEffectOverrides[l.idx];
  if (chosen) return withAmt({ ...base, effect: chosen });
  return withAmt(effectiveRole(base, l));
}

$("file-video").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  status("scene-status", "Lese Video ein …");
  localVideoBuf = await f.arrayBuffer();
  status("scene-status", "Video geladen (" + Math.round(localVideoBuf.byteLength / 1e6) + " MB). Jetzt Rollen einstellen." +
    (localVideoBuf.byteLength > 60e6 ? " ⚠ Groß — Übertragung dauert." : ""));
  $("local-cfg").style.display = "";
  if (!$("rolecfg-list").children.length) { addRoleCfg(); addRoleCfg(); }
};

function addRoleCfg() {
  const n = $("rolecfg-list").children.length + 1;
  if (n > 4) return;
  const div = document.createElement("div");
  div.className = "rolecfg";
  div.innerHTML = `
    <input type="text" placeholder="Charakter ${n}" value="Charakter ${n}">
    <div><label class="small">Pan L↔R</label><input type="range" min="-1" max="1" step="0.1" value="0"></div>
    <select>${Object.entries(EFFECTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>`;
  $("rolecfg-list").appendChild(div);
}
$("btn-add-role").onclick = addRoleCfg;

$("btn-use-local").onclick = () => {
  const roles = [...$("rolecfg-list").children].map((div, i) => ({
    id: i + 1,
    name: div.querySelector("input[type=text]").value || "Charakter " + (i + 1),
    pan: parseFloat(div.querySelector("input[type=range]").value),
    effect: div.querySelector("select").value,
    gain: 1.0
  }));
  scene = { title: $("file-video").files[0].name.replace(/\.\w+$/, ""), roles };
  resetRoles();
  videoBlobUrl = URL.createObjectURL(new Blob([localVideoBuf], { type: "video/mp4" }));
  showScene(videoBlobUrl);
  conns.forEach(c => sendLocalVideo(c));
  broadcastState();
};

function resetRoles() { players.forEach(p => { p.role = null; p.ready = false; p.done = 0; p.total = 0; }); }

function sendLocalVideo(conn) {
  conn.send({ t: "videoMeta", scene, size: localVideoBuf.byteLength });
  let off = 0;
  const pump = () => {
    while (off < localVideoBuf.byteLength) {
      if (conn.dataChannel && conn.dataChannel.bufferedAmount > 4e6) { setTimeout(pump, 100); return; }
      conn.send({ t: "videoChunk", buf: localVideoBuf.slice(off, off + CHUNK_SIZE) });
      off += CHUNK_SIZE;
    }
  };
  pump();
}

let rxBuf = null, rxOff = 0, rxSize = 0;
function startVideoReceive(msg) {
  scene = msg.scene; rxSize = msg.size; rxBuf = new Uint8Array(rxSize); rxOff = 0;
  $("scene-card").style.display = "";
  $("scene-title").textContent = scene.title;
  $("download-bar").style.display = "";
  renderRoles();
}
function receiveVideoChunk(buf) {
  const arr = new Uint8Array(buf);
  rxBuf.set(arr, rxOff); rxOff += arr.length;
  const bar = $("download-bar");
  if (bar) bar.querySelector("i").style.width = Math.round(rxOff / rxSize * 100) + "%";
  if (rxOff >= rxSize) {
    if (bar) bar.style.display = "none";
    videoBlobUrl = URL.createObjectURL(new Blob([rxBuf], { type: "video/mp4" }));
    rxBuf = null;
    showScene(videoBlobUrl);
    SFX.ok();
    // Nach Reload mit eigenem Host-Video: Phase fortsetzen, sobald Bytes da sind
    if (pendingPhaseRestore) {
      const m = pendingPhaseRestore;
      pendingPhaseRestore = null;
      applyPhaseRestore(Object.assign({}, m, { hatVideoUebertragung: false, forceRestore: true }));
    }
  }
}

function showScene(src) {
  // Robust gegen unsortierte Lines-Arrays (z.B. selbstgebaute Szenen): immer chronologisch sortieren.
  // Sonst kann der Teleprompter beim "Gleich kommt..."-Hinweis die falsche Person zeigen.
  if (scene.lines && scene.lines.length) scene.lines.sort((a, b) => a.t - b.t);
  $("scene-card").style.display = "";
  $("btn-roulette").style.display = isHost ? "" : "none";
  const diff = sceneDifficulty(scene);
  $("scene-title").innerHTML = esc(scene.title) + (diff ? ` <span class="difftag diff-${diff.label.toLowerCase().replace(/[^a-z]/g,"")}">${diff.emoji} ${diff.label}</span>` : "");
  renderRoles();
  beginSceneVideoLoad(src);
}

// ═════════════════════════════════════════════════════════════
// 4) LOBBY-UI
// ═════════════════════════════════════════════════════════════
function avatarColor(name) {
  let h = 0; for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 70%, 55%)`;
}
function playerCard(p) {
  const role = p.role != null && scene ? (scene.roles.find(r => r.id === p.role)?.name || "?") : null;
  const prog = p.total > 0 ? `<div class="pbar"><i style="width:${Math.round(p.done / p.total * 100)}%"></i></div><span class="tag">${p.done}/${p.total} Lines</span>` : "";
  let loadHtml = "";
  if (scene && scene.videoUrl) {
    if (!p.videoReady) {
      const pct = Math.max(0, Math.min(100, p.loadPct || 0));
      loadHtml = `<div class="pbar load"><i style="width:${pct}%"></i></div><span class="pload">📥 Video ${pct}%</span>`;
    } else if (!p.total) {
      loadHtml = `<span class="pload done">📥 Video fertig</span>`;
    }
  }
  const micDot = p.id === myId ? `<span id="mic-live-dot" title="Dein Mikro — leuchtet, wenn gerade Ton ankommt" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3a3a46;margin-left:6px"></span>` : "";
  // Wer rausgeflogen ist, behält seinen Platz — das muss man sehen, damit niemand denkt
  // die Runde hängt. Mit Restzeit, bis der Platz freigegeben wird.
  const wegTag = p.offline
    ? `<span class="tag offline-cd" data-offline-cd style="color:#e8a33d">${escOfflineCountdown(p)}</span>`
    : "";
  const loadingCls = (scene && scene.videoUrl && !p.videoReady) ? " loading" : "";
  return `<div class="player ${p.ready ? "ready" : ""}${loadingCls}" data-pid="${p.id}" style="${p.eliminated ? "opacity:.5" : p.offline ? "opacity:.55" : ""}">
    ${avatarHTML(p)}
    <div class="pinfo">
      <span class="pname">${esc(p.name)}${micDot}</span>
      ${p.eliminated ? '<span class="prole" style="color:var(--hot)">🔪 eliminiert</span>' : `<span class="prole ${role ? "" : "empty"}">${role ? "🎭 " + esc(role) : "noch keine Rolle"}</span>`}
      ${wegTag}${p.ready && !p.total ? '<span class="tag" style="color:var(--ok)">bereit</span>' : ""}${loadHtml}${prog}
    </div>
  </div>`;
}
function escOfflineCountdown(p) {
  const restSek = p.offline && p.offlineBis ? Math.max(0, Math.round((p.offlineBis - Date.now()) / 1000)) : 0;
  return "📴 Verbindung weg" + (restSek
    ? " · kommt hoffentlich zurück (" + Math.floor(restSek / 60) + ":" + String(restSek % 60).padStart(2, "0") + ")"
    : "");
}
function renderPlayers() { $("player-list").innerHTML = players.map(playerCard).join(""); }
// Offline-Restzeit: nur Text-Tags ticken, kein kompletter Listen-Rebuild
setInterval(() => {
  if (!players.some(p => p.offline)) return;
  for (const p of players) {
    if (!p.offline) continue;
    const text = escOfflineCountdown(p);
    document.querySelectorAll('.player[data-pid="' + p.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"] [data-offline-cd]').forEach(el => {
      if (el.textContent !== text) el.textContent = text;
    });
  }
}, 1000);
function renderBoothPlayers() {
  const html = players.map(playerCard).join("");
  $("booth-players").innerHTML = html;
  $("wait-players").innerHTML = html;
}

function renderRoles() {
  if (!scene) return;
  const lineCount = (rid) => scene.lines ? scene.lines.filter(l => l.chars.includes(rid)).length : null;
  $("role-list").innerHTML = scene.roles.map(r => {
    const owner = players.find(p => p.role === r.id);
    const mine = owner && owner.id === myId;
    const lc = lineCount(r.id);
    return `<button class="rolebtn ${mine ? "mine" : owner ? "taken" : ""}" data-r="${r.id}" ${owner && !mine ? "disabled" : ""}>
      <span>${esc(r.name)}${lc != null ? ` <span class="meta">· ${lc} Lines</span>` : ""}</span>
      <span class="meta">${owner ? esc(owner.name) : "frei"} · Pan ${r.pan > 0 ? "R" : r.pan < 0 ? "L" : "Mitte"} · ${EFFECTS[r.effect] || r.effect}</span>
    </button>`;
  }).join("");
  $("role-list").querySelectorAll(".rolebtn").forEach(b => b.onclick = () => pickRole(parseInt(b.dataset.r)));
}

function pickRole(roleId) {
  if (match.mode === "rounds") { status("lobby-status", "🎲 Im Match werden Rollen zufällig verteilt — du kannst nicht selbst wählen.", true); return; }
  if (isHost) {
    const taken = players.some(p => p.role === roleId && p.id !== myId);
    if (taken) return;
    const me = players.find(p => p.id === myId);
    me.role = roleId; me.ready = false;
    broadcastState(); renderRoles();
  } else sendHost({ t: "pickRole", role: roleId });
}


// Echter Zufallsmix (Fisher-Yates) — Math.random()-0.5 ist ungleichmäßig und ließ
// bei vielen Rollen oft immer dieselben oberen Rollen übrig.
function mischen(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

$("btn-roulette").onclick = () => {
  if (!isHost || !scene) return;
  const shuffledPlayers = mischen(players);
  // WICHTIG: auch die Rollen mischen — sonst kriegen 4 Spieler bei 20 Rollen
  // immer nur Rolle 1–4 („die obersten“), nie die weiter hinten.
  const roleIds = mischen(scene.roles.map(r => r.id));
  const n = Math.min(roleIds.length, shuffledPlayers.length);
  players.forEach(p => { p.role = null; p.ready = false; });
  for (let i = 0; i < n; i++) shuffledPlayers[i].role = roleIds[i];
  broadcastState(); renderRoles();
  status("lobby-status", "🎲 Rollen ausgewürfelt! Wer keine hat, ist Zuschauer. Jetzt alle „Bin bereit“.");
  SFX.done();
};


// ═════════════════════════════════════════════════════════════
// MATCH-SYSTEM: Runden, Gesamtwertung, Finale
// ═════════════════════════════════════════════════════════════
let match = { mode: "free", rounds: 3, round: 1, totals: {}, autoRoulette: true, buddyGivers: {} };
let myBuddyUsed = false;   // SynchroBuddy nur 1× pro ganzem Match (nicht jede Bewertungsrunde)
const mgWins = {};   // Arena-Siege der Session

function hostSettingsChanged() {
  if (!isHost) return;
  const prevMode = match.mode;
  match.mode = $("set-mode").value;
  match.rounds = parseInt($("set-rounds").value);
  match.autoRoulette = $("set-roulette").checked;
  syncModePicker(match.mode);
  // Im Runden- UND Battle-Royale-Modus ist alles Zufall: Rollenwahl & Szenenwahl werden ausgeblendet
  const rnd = match.mode === "rounds" || match.mode === "elimination";
  const duell = match.mode === "duell";
  $("rounds-opts").style.display = (match.mode === "rounds") ? "" : "none";
  $("host-scene").style.display = (rnd || duell) ? "none" : "";
  $("duel-setup").style.display = duell ? "" : "none";
  if (duell) populateDuelSceneSelect();
  // WICHTIG: Szenenliste immer (neu) laden, damit das Dropdown im Freien Modus gefüllt ist
  if (!rnd && !duell) loadSceneList();

  // FIX: Beim Moduswechsel eine evtl. schon geladene Szene/Rollen zurücksetzen —
  // sonst bleiben z.B. manuell gewählte Free-Modus-Rollen im Runden-Modus aktiv nutzbar.
  if (match.mode !== prevMode) {
    scene = null; clearSceneVideoState();
    scenePool = []; duelInfo = null; duelStagedScene = null;
    players.forEach(p => { p.role = null; p.ready = false; p.timesSpectated = 0; p.timesPlayed = 0; p.eliminated = false; });
    $("scene-card").style.display = "none";
    $("btn-go-round").style.display = "none";
    $("btn-start").style.display = "";
    broadcast({ t: "sceneReset" });
  }

  broadcastSettings();
  broadcastState();
}
function broadcastSettings() {
  broadcast({ t: "settings", mode: match.mode, rounds: match.rounds, round: match.round, autoRoulette: match.autoRoulette, blind: !!(scene && scene.blind) });
  renderSettingsView();
}
function renderSettingsView(s) {
  const el = $("settings-view");
  if (!el) return;
  const mode = s ? s.mode : match.mode;
  const rounds = s ? s.rounds : match.rounds, round = s ? s.round : match.round;
  const rl = s ? s.autoRoulette : match.autoRoulette;
  const bl = s ? s.blind : !!(scene && scene.blind);
  const activeLeft = players.filter(p => !p.eliminated).length;
  if (mode === "elimination") {
    el.innerHTML = `🔪 <b>Battle Royale · Runde ${round}</b> · ${activeLeft} noch im Rennen · 🎲 Zufalls-Szenen &amp; -Rollen · 🕶 Blind: ${bl ? "an" : "aus"}` + (isHost ? "" : ' <span class="tag">(Host)</span>');
  } else if (mode === "rounds") {
    el.innerHTML = `🏆 <b>Match · Runde ${round}/${rounds}</b> · 🎲 Zufalls-Szenen &amp; -Rollen · 🕶 Blind: ${bl ? "an" : "aus"}` + (isHost ? "" : ' <span class="tag">(Host)</span>');
  } else if (mode === "duell") {
    el.innerHTML = `🥊 <b>Duell-Modus</b> · Host wählt Szene, Rolle &amp; die zwei Duellanten · Rest schaut zu &amp; stimmt danach ab` + (isHost ? "" : ' <span class="tag">(Host)</span>');
  } else {
    el.innerHTML = `🎮 <b>Freies Spiel</b> · Szene &amp; Rollen frei wählbar · 🕶 Blind: ${bl ? "an" : "aus"}` + (isHost ? "" : ' <span class="tag">(Host)</span>');
  }
}
function renderWins() {
  const el = $("mg-wins");
  if (!el) return;
  const entries = Object.entries(mgWins).sort((a, b) => b[1] - a[1]);
  el.innerHTML = entries.length ? "🎖 Arena-Siege: " + entries.map(([pid, n]) => `<b>${esc(nameOf(pid))}</b> ×${n}`).join(" · ") : "";
}
function addWin(pid) {
  if (!isHost || !pid) return;
  mgWins[pid] = (mgWins[pid] || 0) + 1;
  broadcast({ t: "wins", wins: mgWins });
  renderWins();
}

$("btn-ready").onclick = async () => {
  const me = players.find(p => p.id === myId);
  if (me?.role == null) {
    const free = scene ? scene.roles.some(r => !players.find(p => p.role === r.id)) : true;
    return status("lobby-status", free ? "Erst eine Rolle aussuchen! (Oder ohne Rolle einfach zuschauen 🍿)" : "Alle Rollen sind weg — du bist Zuschauer und siehst die Premiere trotzdem! 🍿", !free ? false : true), free && SFX.err();
  }
  if (!isHost && !videoBlobUrl && !scene?.videoUrl) return status("lobby-status", "Video lädt noch …", true);
  if (scene?.videoUrl && !myVideoReady) {
    return status("lobby-status", "Video lädt noch (" + myLoadPct + "%) — warte bis es bei dir fertig ist, dann „Bin bereit“.", true), SFX.err();
  }
  if (!(await ensureMic())) return;
  if (isHost) { me.ready = true; broadcastState(); }
  else sendHost({ t: "ready" });
  status("lobby-status", "✅ Bereit! Warten auf die anderen …");
  SFX.ok();
  burstConfetti();
};

function checkStartable() {
  if (!isHost) return;
  if (match.mode === "duell") {
    // Duell hat seinen eigenen Start-Button (🥊 Duell starten) — der normale Button bleibt aussen vor
    $("btn-start").style.display = "none";
    return;
  }
  if ((match.mode === "rounds" || match.mode === "elimination") && !scene) {
    // Match noch nicht gestartet → Button startet das Match
    $("btn-start").style.display = "";
    $("btn-start").disabled = players.length < 2;
    if (match.mode === "elimination") {
      $("btn-start").textContent = "🔪 Battle Royale starten (" + players.length + " Spieler)";
      $("start-hint").textContent = players.length < 2 ? "Mindestens 2 Spieler nötig!" : "Zufalls-Szenen & -Rollen — nach jeder Runde fliegt der Schlechteste raus, bis nur noch einer übrig ist!";
    } else {
      $("btn-start").textContent = "🎲 Match starten (" + match.rounds + " Runden)";
      $("start-hint").textContent = "Zufalls-Szene & zufällige Rollen für alle. Los geht's, sobald du startest!";
    }
    return;
  }
  $("btn-start").textContent = "🔴 Session starten";
  const speakers = players.filter(p => p.role != null);
  // Wer gerade rausgeflogen ist, darf den Start nicht blockieren — sein Platz bleibt
  // ja trotzdem frei, er kann jederzeit zurückkommen.
  const anwesend = speakers.filter(p => !p.offline);
  const weg = speakers.filter(p => p.offline);
  const stillLoading = anwesend.filter(p => !p.videoReady);
  const notReady = anwesend.filter(p => p.videoReady && !p.ready);
  const ok = anwesend.length >= 1 && anwesend.every(p => p.ready && p.videoReady);
  const spectators = players.length - speakers.length;
  $("btn-start").disabled = !ok;
  if (ok) {
    $("start-hint").textContent = "Los geht's! " + (spectators ? spectators + " Zuschauer gucken zu. " : "Unbesetzte Rollen sprechen original. ")
      + (weg.length ? "⚠ " + weg.map(p => p.name).join(", ") + " hat gerade keine Verbindung — Platz bleibt frei." : "");
  } else if (stillLoading.length) {
    $("start-hint").textContent = "📥 Video lädt noch: " + stillLoading.map(p => p.name + " " + (p.loadPct || 0) + "%").join(" · ")
      + (notReady.length ? " — danach noch „bereit“: " + notReady.map(p => p.name).join(", ") : "");
  } else {
    $("start-hint").textContent = "Warte, bis alle Sprecher „bereit“ sind …";
  }
}



function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

$("btn-mic-test").onclick = async () => {
  if (!(await ensureMic())) return;
  status("lobby-status", "🎤 Sprich jetzt 3 Sekunden …");
  const rec = new MediaRecorder(recStream(), { mimeType: pickMime() });
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = async () => {
    status("lobby-status", "Abspielen mit deinem Rollen-Effekt …");
    const buf = await new Blob(chunks).arrayBuffer();
    const ctx = getCtx();
    const audio = await ctx.decodeAudioData(buf);
    const me = players.find(p => p.id === myId);
    const role = scene?.roles.find(r => r.id === me?.role) || { pan: 0, effect: "none", gain: 1 };
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.playbackRate.value = effectPitch(role.effect);
    src.connect(buildChain(ctx, role, ctx.destination));
    src.start();
    src.onended = () => status("lobby-status", "So klingst du im Take. Passt? Dann „Bin bereit“.");
  };
  rec.start();
  setTimeout(() => rec.stop(), 3000);
};

// ═════════════════════════════════════════════════════════════
// 5) SESSION-START (Host)
// ═════════════════════════════════════════════════════════════

// Im Runden-Modus: Zufalls-Szene laden + Rollen würfeln (Host)
// ── FAIRE Szenen-Auswahl: solange nicht alle Szenen dran waren, wird keine wiederholt.
// Nach einer vollen Runde durch den Pool startet ein neuer, frisch gemischter Durchlauf.
let scenePool = [];
async function pickRandomScene() {
  const playable = sceneList.filter(s => s.lines && s.lines.length && s.id !== "testplace");
  if (!scenePool.length) {
    scenePool = [...playable].sort(() => Math.random() - 0.5);   // frisch mischen, erst wenn der Stapel leer ist
  }
  const s = scenePool.pop();
  scene = JSON.parse(JSON.stringify(s));
  scene.blind = $("blind-mode") ? $("blind-mode").checked : false;
  clearSceneVideoState();
  rouletteRoles();
  showScene(sceneVideoSrc());
  broadcast({ t: "scene", scene });
  broadcastSettings();
  broadcastState();
}
// ── FAIRE Rollenverteilung: wer schon (öfter) Zuschauer war, ist garantiert bevorzugt dran.
// Bei exakt gleichem Zuschauer-Stand entscheidet der Zufall — sonst nie.
function rouletteRoles() {
  // Auch hier Rollen mischen — sonst landen bei wenigen Spielern und vielen Rollen
  // immer nur die ersten Einträge aus scenes.json.
  const roleIds = mischen(scene.roles.map(r => r.id));
  const eligible = players.filter(p => !p.eliminated);   // Eliminierte sind für IMMER Zuschauer (Battle Royale)
  const n = Math.min(roleIds.length, eligible.length);

  const ranked = eligible.map(p => ({ p, benched: p.timesSpectated || 0, rnd: Math.random() }))
    .sort((a, b) => b.benched - a.benched || b.rnd - a.rnd);

  const playing = ranked.slice(0, n).map(x => x.p);
  const spectating = ranked.slice(n).map(x => x.p);

  players.forEach(p => { p.role = null; p.ready = false; });
  const shuffledPlaying = mischen(playing);
  shuffledPlaying.forEach((p, i) => { p.role = roleIds[i]; });

  // Fairness-Zähler fortschreiben: Bank-Zeit steigt, Spielzeit steigt — Grundlage für die nächste Runde
  spectating.forEach(p => { p.timesSpectated = (p.timesSpectated || 0) + 1; });
  playing.forEach(p => { p.timesPlayed = (p.timesPlayed || 0) + 1; });
}

$("btn-start").onclick = async () => {
  if ((match.mode === "rounds" || match.mode === "elimination") && !scene) {
    // Match-Kickoff: Zufalls-Szene laden, dann warten auf Bereit
    await pickRandomScene();
    const label = match.mode === "elimination" ? "🔪 Runde 1: Szene &amp; Rollen ausgewürfelt!" : "🎲 Runde 1: Szene &amp; Rollen ausgewürfelt!";
    status("lobby-status", label + " Alle „Bin bereit“ drücken.");
    $("btn-start").style.display = "none";
    $("btn-go-round").style.display = "";
    return;
  }
  startSession();
};
$("btn-go-round").onclick = () => startSession();
function startSession() {
  const speakers = players.filter(p => p.role != null);
  const anwesend = speakers.filter(p => !p.offline);
  if (!anwesend.length || !anwesend.every(p => p.ready && p.videoReady)) {
    const loading = anwesend.filter(p => !p.videoReady);
    status("lobby-status", loading.length
      ? "Noch nicht — Video lädt bei: " + loading.map(p => p.name + " " + (p.loadPct || 0) + "%").join(", ")
      : "Es müssen erst alle Sprecher „bereit“ sein!", true);
    SFX.err(); return;
  }
  stopLobbyPreview();
  if (scene.lines?.length) { broadcast({ t: "goLines" }); startBooth(); }
  else { broadcast({ t: "go" }); startRealtime(); }
}

// ═════════════════════════════════════════════════════════════
// 6) LINE-BOOTH — Zeile für Zeile, unendlich Versuche
// ═════════════════════════════════════════════════════════════
let myLines = [], curLine = 0, takes = {};   // takes: lineIdx → ArrayBuffer
let outtakes = [];   // verworfene Takes fürs Outtakes-Reel [{lineIdx,text,t,end,buf,name}]
const OUTTAKE_MAX = 8;          // pro Spieler in der Booth
const OUTTAKE_POOL_MAX = 24;    // gemischter Pool für die Premiere (alle zusammen)
let collectedOuttakes = new Map(); // host: peerId -> outtake[]
function outtakeKey(o) {
  return String(o.name || "?") + "|" + String(o.lineIdx);
}
/** Pro Sprecher+Line nur den neuesten Blooper behalten — sonst spielt dieselbe Szene 2–3×. */
function dedupeOuttakes(list) {
  const map = new Map();
  for (const o of list || []) {
    if (!o || o.lineIdx == null) continue;
    map.set(outtakeKey(o), o);
  }
  return [...map.values()];
}
function pushLocalOuttake(ot) {
  const key = outtakeKey(ot);
  outtakes = outtakes.filter(o => outtakeKey(o) !== key);
  outtakes.push(ot);
  if (outtakes.length > OUTTAKE_MAX) outtakes.shift();
}
let lineRec = null, lineChunks = [], recTimer = null, recStartT = 0, recMax = 0;


function myRole() { return players.find(p => p.id === myId)?.role; }
function roleOf(id) { return scene?.roles?.find(r => r.id === id); }

// Findet den frühesten Startzeitpunkt, an dem DIESELBE Rolle danach wieder spricht —
// nur DAS darf eine laufende Aufnahme beschneiden, nicht die Lines anderer Charaktere.
function nextSameRoleStart(lineIdx) {
  const l = scene.lines[lineIdx];
  const roleSet = new Set(l.chars);
  let best = null;
  for (let i = 0; i < scene.lines.length; i++) {
    if (i === lineIdx) continue;
    const other = scene.lines[i];
    if (other.t > l.t + 0.01 && other.chars.some(c => roleSet.has(c))) {
      if (best === null || other.t < best) best = other.t;
    }
  }
  return best;
}


// ── Duell-Setup: Szene wählen, dann Rolle + beide Duellanten festlegen ──
function populateDuelSceneSelect() {
  const sel = $("duel-scene-select");
  sel.innerHTML = sceneList.length
    ? sceneList.map((s, i) => `<option value="${i}">${esc(s.title)}</option>`).join("")
    : "<option>— Szenen laden… —</option>";
}
$("btn-duel-load-scene").onclick = () => {
  const s = sceneList[$("duel-scene-select").value];
  if (!s) return;
  duelStagedScene = JSON.parse(JSON.stringify(s));
  $("duel-role-select").innerHTML = duelStagedScene.roles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  const playerOpts = players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("duel-player-a").innerHTML = playerOpts;
  $("duel-player-b").innerHTML = playerOpts;
  if (players[1]) $("duel-player-b").value = players[1].id;
  $("duel-pickers").style.display = "flex";
  status("duel-setup-status", "Szene geladen — jetzt Rolle & beide Duellanten wählen.");
};
$("btn-duel-start").onclick = () => {
  const roleId = parseInt($("duel-role-select").value);
  const aId = $("duel-player-a").value, bId = $("duel-player-b").value;
  if (aId === bId) return status("duel-setup-status", "Duellant A und B müssen unterschiedlich sein!", true), SFX.err();
  duelInfo = { roleId, aId, bId };
  scene = JSON.parse(JSON.stringify(duelStagedScene));
  clearSceneVideoState();
  players.forEach(p => {
    p.role = (p.id === aId || p.id === bId) ? roleId : null;
    p.ready = true;
    p.loadPct = 0;
    p.videoReady = false;
  });
  Object.keys(duelSubs).forEach(k => delete duelSubs[k]);
  Object.keys(duelVotes).forEach(k => delete duelVotes[k]);
  broadcast({ t: "scene", scene });
  showScene(sceneVideoSrc());
  broadcast({ t: "duelSetupInfo", duelInfo });
  broadcastState();
  status("duel-setup-status", "🥊 Duell steht: " + nameOf(aId) + " vs " + nameOf(bId) + " als " + duelStagedScene.roles.find(r => r.id === roleId).name + " — warte auf Video-Download …");
  broadcast({ t: "goLines" });
  queueOrStartBooth();
};

function startBooth() {
  stopLobbyPreview();
  const rid = myRole();
  if (rid == null) {                      // Zuschauer
    show("scr-wait");
    renderBoothPlayers();
    $("duel-waiting-note").style.display = match.mode === "duell" ? "" : "none";
    const me0 = players.find(p => p.id === myId);
    const bench = me0 ? (me0.timesSpectated || 0) : 0;
    status("wait-status", match.mode === "duell"
      ? "🥊 Duell läuft — " + nameOf(duelInfo?.aId) + " vs " + nameOf(duelInfo?.bId) + " nehmen unabhängig voneinander auf. Danach hört ihr beide Versionen und stimmt ab!"
      : "🍿 Du bist Zuschauer — die Premiere startet automatisch, wenn alle fertig sind." + (match.mode === "rounds" ? " (Nächste Runde bist du garantiert bevorzugt dran, " + bench + "x gebankt bisher.)" : ""));
    return;
  }
  myLines = scene.lines.map((l, i) => ({ ...l, idx: i })).filter(l => l.chars.includes(rid));
  curLine = 0; takes = {}; outtakes = []; myEffectOverrides = {}; myEffectAmounts = {}; myLineGains = {}; myLinePans = {};
  const r = roleOf(rid);
  $("booth-rolename").textContent = r.name;
  const av = scene.avatars?.[String(rid)];
  $("booth-avatar").style.display = av ? "" : "none";
  if (av) $("booth-avatar").src = assetUrl(av);
  const bv = $("booth-video");
  bv.src = sceneVideoSrc();
  $("btn-line-rec").disabled = true;
  status("booth-status", "⏳ Video lädt — einen Moment …");
  setBar("booth-bar", 30);
  waitCanPlay(bv).then(() => {
    setBar("booth-bar", 100);
    $("btn-line-rec").disabled = false;
    status("booth-status", "Unendlich Versuche — nimm auf, bis es sitzt.");
    SFX.ok();
  });
  sendProgress();
  show("scr-booth");
  $("onair").classList.add("live");
  SFX.go();
  startVizOn("viz");
  renderLine();
}

function renderLine() {
  const l = myLines[curLine];
  if (!l) return finishBooth();
  origReqId++;   // Line gewechselt -> jede noch wartende "Original anhören"-Anfrage von vorher wird ungültig
  if (origSrc) { try { origSrc.stop(); } catch {} origSrc = null; }
  stopRecCue();
  const ob = $("btn-line-orig"); if (ob) ob.textContent = "🗣 Original anhören";
  syncBoothGateUI();
  $("booth-count").innerHTML = `${curLine + 1}/${myLines.length}<small>Voiceline</small>`;
  $("line-who").textContent = l.who + (l.chars.length > 1 ? " (zusammen!)" : "");
  $("line-text").textContent = l.text;
  $("line-de").textContent = (l.de && !scene.blind) ? "🇩🇪 " + l.de : (scene.blind ? "🕶 Blind-Modus — improvisier!" : "");
  showLineDuration(l);
  $("booth-video").currentTime = l.t;
  $("btn-line-play").disabled = !takes[l.idx] || takes[l.idx] === "SKIP";
  $("btn-line-next").disabled = !takes[l.idx];
  const prevBtn = $("btn-line-prev");
  if (prevBtn) { prevBtn.style.display = redoMode !== null ? "none" : ""; prevBtn.disabled = curLine <= 0; }
  $("btn-line-next").textContent = redoMode !== null ? "✅ Aktualisieren & zurück" : "✅ Passt, weiter";
  const sk = $("btn-line-skip"); if (sk) sk.style.display = lineHasOrig(l) ? "" : "none";
  const og = $("btn-line-orig"); if (og) og.style.display = (lineHasOrig(l) && !scene.blind) ? "" : "none";
  const cueWrap = $("rec-cue-wrap");
  if (cueWrap) cueWrap.style.display = (lineHasOrig(l) && !scene.blind) ? "" : "none";
  const efSel = $("my-effect-select");
  if (efSel) {
    const baseRole = roleOf(myRole()) || { effect: "none" };
    const sceneDefault = effectiveRole(baseRole, l).effect;
    efSel.innerHTML = `<option value="">🎭 Standard (${esc(EFFECTS[sceneDefault] || sceneDefault)})</option>` +
      Object.entries(EFFECTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    efSel.value = myEffectOverrides[l.idx] || "";
  }
  syncFxAmountUI(l);
  syncLineGainUI(l);
  syncLinePanUI(l);
  stopFxPreview(); fxPreviewRaw = null; fxPreviewCacheKey = null;
  $("rectime-fill").style.width = "0";
  if (lineHasOrig(l)) previewRefViz(l); else { cancelAnimationFrame(vizRAF); const c = $("viz"); if (c) { const g = c.getContext("2d"); g.clearRect(0,0,c.width,c.height); } }
  status("booth-status", takes[l.idx] ? "Take gespeichert — anhören, neu aufnehmen oder weiter." : "Unendlich Versuche — nimm auf, bis es sitzt.");
}

// Szenen-Ausschnitt zum Reinhören

// Original-Voiceline anhören (Aussprache-Referenz, z. B. "Surprise Mothafucka")

// Voice-Track: eine lange Stimmen-Spur, aus der Lines per Zeitfenster geschnitten werden.
// Cache pro URL (wie origCache) statt einer globalen Variable: dadurch kann die Spur einer
// vorherigen Szene nie hängenbleiben, egal an welcher Stelle `scene` neu gesetzt wird.
const voiceTrackCache = new Map();     // url -> AudioBuffer
const voiceTrackLoading = new Map();   // url -> laufender Ladevorgang
async function getVoiceTrack() {
  const url = scene && scene.voiceTrack && assetUrl(scene.voiceTrack);
  if (!url) return null;
  if (voiceTrackCache.has(url)) return voiceTrackCache.get(url);
  if (voiceTrackLoading.has(url)) return voiceTrackLoading.get(url);
  const load = (async () => {
    try {
      const ctx = getCtx();
      const raw = await (await fetch(url)).arrayBuffer();
      const buf = await ctx.decodeAudioData(raw);
      voiceTrackCache.set(url, buf);
      return buf;
    } catch (e) {
      console.warn("Voice-Track nicht ladbar:", e);
      return null;   // Fehlschlag nicht cachen, damit ein erneuter Klick es nochmal versucht
    } finally {
      voiceTrackLoading.delete(url);
    }
  })();
  voiceTrackLoading.set(url, load);
  return load;
}
// Schneidet ein Stück [t, end] aus dem Voice-Track als eigenen AudioBuffer
function sliceBuffer(full, t, end) {
  const ctx = getCtx();
  const sr = full.sampleRate;
  const from = Math.max(0, Math.floor(t * sr));
  const to = Math.min(full.length, Math.floor(end * sr));
  const len = Math.max(1, to - from);
  const out = ctx.createBuffer(full.numberOfChannels, len, sr);
  for (let ch = 0; ch < full.numberOfChannels; ch++) {
    out.getChannelData(ch).set(full.getChannelData(ch).subarray(from, to));
  }
  return out;
}
// Holt den Original-AudioBuffer einer Line: entweder aus l.orig ODER aus dem Voice-Track
async function getLineOrigBuffer(l) {
  if (l.orig) {
    const ctx = getCtx();
    const url = assetUrl(l.orig);
    if (!origCache.has(url)) {
      const buf = await (await fetch(url)).arrayBuffer();
      origCache.set(url, await ctx.decodeAudioData(buf));
    }
    return origCache.get(url);
  }
  const full = await getVoiceTrack();
  if (full) return sliceBuffer(full, l.t, l.end);
  return null;
}
function lineHasOrig(l) { return !!(l.orig || scene.voiceTrack); }

const origCache = new Map();
let origSrc = null, origReqId = 0;
$("btn-line-orig").onclick = async () => {
  const l = myLines[curLine];
  if (!lineHasOrig(l)) return;
  if (origSrc) { try { origSrc.stop(); } catch {} origSrc = null; $("btn-line-orig").textContent = "🗣 Original anhören"; $("booth-video").pause(); return; }
  const ctx = getCtx();
  const myReqId = ++origReqId;   // eigener Zähler-Wert -- wenn sich die Line inzwischen geändert hat, brechen wir unten ab
  try {
    $("btn-line-orig").textContent = "⏳ …";
    const buffer = await getLineOrigBuffer(l);
    if (myReqId !== origReqId) return;   // zwischenzeitlich wurde die Line gewechselt oder neu geklickt -> diese veraltete Anfrage verwerfen, NICHT mehr abspielen
    if (!buffer) throw new Error("kein Original");
    // Video läuft synchron mit, Original-Stimme liegt drüber (Video leise)
    const v = $("booth-video");
    v.pause(); v.currentTime = l.t; v.volume = boothVol * 0.45; v.playbackRate = practiceSpeed;
    await v.play().catch(() => {});
    if (myReqId !== origReqId) return;   // sicherheitshalber nach dem await auf v.play() nochmal prüfen
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = practiceSpeed;
    src.connect(ctx.destination);
    src.start();
    origSrc = src;
    $("btn-line-orig").textContent = "⏹ Stopp";
    src.onended = () => { if (origSrc === src) { origSrc = null; $("btn-line-orig").textContent = "🗣 Original anhören"; v.pause(); } };
  } catch (e) {
    if (myReqId !== origReqId) return;
    $("btn-line-orig").textContent = "🗣 Original anhören";
    status("booth-status", "Original-Audio nicht ladbar — GitHub Pages noch am Deployen?", true);
  }
};


// Übungs-Tempo: Szene & Original langsamer ansehen/anhören — die AUFNAHME läuft
// immer in Normal-Tempo, damit das Endergebnis richtig klingt.
let practiceSpeed = 1;
document.querySelectorAll(".speedbtn").forEach(b => b.onclick = () => {
  practiceSpeed = parseFloat(b.dataset.s);
  document.querySelectorAll(".speedbtn").forEach(x => x.classList.toggle("mine", x === b));
});

let sceneStopHandler = null;
$("btn-line-scene").onclick = () => {
  const l = myLines[curLine];
  const v = $("booth-video");
  if (sceneStopHandler) { v.removeEventListener("timeupdate", sceneStopHandler); sceneStopHandler = null; }
  if (!v.paused) { v.pause(); $("btn-line-scene").textContent = "🎬 Szene ansehen"; return; }   // 2. Klick = Stopp
  v.currentTime = Math.max(0, l.t - 0.5);
  v.volume = boothVol; v.playbackRate = practiceSpeed;
  v.play();
  $("btn-line-scene").textContent = "⏹ Stopp";
  sceneStopHandler = () => {
    if (v.currentTime >= l.end + 0.3) {
      v.pause();
      v.removeEventListener("timeupdate", sceneStopHandler); sceneStopHandler = null;
      $("btn-line-scene").textContent = "🎬 Szene ansehen";
    }
  };
  v.addEventListener("timeupdate", sceneStopHandler);
};

let recBusy = false;
let recCueSrc = null, recCueGain = null;   // Original-Cue nur im Ohr, nie im MediaRecorder
function stopRecCue() {
  if (recCueSrc) { try { recCueSrc.stop(); } catch {} recCueSrc = null; }
  recCueGain = null;
}
function cueWhileRecOn() {
  const c = $("rec-cue-orig");
  return !!(c && c.checked && scene && !scene.blind);
}
function cueVolNow() {
  const cv = $("rec-cue-vol");
  const v = cv ? parseFloat(cv.value) : 0.45;
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.45;
}
async function startRecCue(l) {
  stopRecCue();
  if (!cueWhileRecOn() || !lineHasOrig(l)) return;
  try {
    const ctx = getCtx();
    const buffer = await getLineOrigBuffer(l);
    if (!buffer || !recording) return;   // Aufnahme schon wieder vorbei
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = cueVolNow();
    src.connect(g); g.connect(ctx.destination);   // nur Lautsprecher/Kopfhörer — nicht ins Mic-Rec
    src.start();
    recCueSrc = src;
    recCueGain = g;
    src.onended = () => { if (recCueSrc === src) { recCueSrc = null; recCueGain = null; } };
  } catch (e) { console.warn("Rec-Cue Original:", e); }
}
function boothButtons_unused(dis) { ["btn-line-scene","btn-line-play","btn-line-next","btn-line-skip"].forEach(id => $(id).disabled = dis || (id !== "btn-line-scene" && $(id).disabled)); if(!dis) renderLine._keep || 0; }
$("btn-line-rec").onclick = async () => {
  if (lineRec && lineRec.state === "recording") { stopLineRec(); return; }
  if (recBusy) {
    // Notaus: Falls ein früherer Start hängen geblieben ist, nach 6s Reset erlauben
    if (performance.now() - (recBusy.t || 0) > 6000) forceRecReset();
    return;
  }
  recBusy = { t: performance.now() };
  stopRecCue();
  // Original-Anhören stoppen, sonst doppelt mit Cue
  if (origSrc) { try { origSrc.stop(); } catch {} origSrc = null; const ob = $("btn-line-orig"); if (ob) ob.textContent = "🗣 Original anhören"; }
  ["btn-line-scene","btn-line-play","btn-line-next","btn-line-skip","btn-line-orig"].forEach(id => { const el = $(id); if (el) el.disabled = true; });
  status("booth-status", "🎯 Bereite Aufnahme vor …");
  try {
    if ($("rec-timer").checked) {
      if ($("rec-wipe") && $("rec-wipe").checked) await wipeCountdown();
      else await recCountdown();
    }
    const l = myLines[curLine];
    // Adaptiver Puffer: nicht in die nächste Line reinlaufen
    recMax = recWindowFor(l);
    const v = $("booth-video");
    v.pause(); v.currentTime = l.t; v.volume = boothVol; v.playbackRate = 1;
    await new Promise(res => {
      const to = setTimeout(res, 4000);
      const h = () => { clearTimeout(to); v.removeEventListener("seeked", h); res(); };
      v.addEventListener("seeked", h);
    });
    lineChunks = [];
    lineRec = new MediaRecorder(recStream(), { mimeType: pickMime() });
    lineRec.ondataavailable = e => { if (e.data.size) lineChunks.push(e.data); };
    lineRec.onstop = onLineRecorded;
    await v.play();
    // KEIN Event-Warten mehr (Race!): pollen, bis das Video wirklich läuft
    await new Promise(res => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        if (v.currentTime > l.t + 0.03 || performance.now() - t0 > 2500) { clearInterval(iv); res(); }
      }, 16);
    });
    lineRec.start();
    recBusy = false;
    recording = true;
    // Cue parallel zum Mic starten (nur Wiedergabe, nicht in der Aufnahme)
    startRecCue(l);
    startDualViz("viz", l, recMax);
    SFX.rec();
    $("btn-line-rec").textContent = "⏹ Stopp";
    $("btn-line-rec").classList.add("recording");
    recStartT = performance.now();
    clearInterval(recTimer);
    recTimer = setInterval(() => {
      const el = (performance.now() - recStartT) / 1000;
      $("rectime-fill").style.width = Math.min(100, el / recMax * 100) + "%";
      if (el >= recMax) stopLineRec();
    }, 50);
    const cueHint = cueWhileRecOn() && lineHasOrig(l) ? " · Original im Ohr" : "";
    status("booth-status", "🔴 Aufnahme läuft … (stoppt automatisch nach " + recMax.toFixed(1) + "s)" + cueHint);
  } catch (e) {
    console.error("Rec-Start fehlgeschlagen:", e);
    forceRecReset();
    status("booth-status", "⚠ Aufnahme-Start hakte — nochmal drücken!", true);
  }
};

// Alles zurücksetzen, falls ein Start hängen bleibt
function forceRecReset() {
  recBusy = false;
  recording = false;
  clearInterval(recTimer);
  stopRecCue();
  try { $("booth-video").pause(); } catch {}
  if (lineRec && lineRec.state === "recording") { try { lineRec.stop(); } catch {} }
  $("btn-line-rec").textContent = "⏺ Aufnehmen";
  $("btn-line-rec").classList.remove("recording");
  $("btn-line-rec").disabled = false;
  ["btn-line-scene","btn-line-orig"].forEach(id => { const el = $(id); if (el) el.disabled = false; });
  renderLine();
}


function recCountdown() {
  return new Promise(res => {
    const b = $("btn-line-rec");
    let n = 3;
    b.disabled = true;
    b.textContent = "⏱ " + n + " …";
    SFX.beep();
    const iv = setInterval(() => {
      n--;
      if (n === 0) { clearInterval(iv); b.disabled = false; SFX.go(); res(); }
      else { b.textContent = "⏱ " + n + " …"; SFX.beep(); }
    }, 800);
  });
}

// Weiße Balken nur in der Line-Booth — nie bei Premiere/Playback
function wipeCountdown() {
  return new Promise(res => {
    const el = $("wipe-booth");
    const num = el && el.querySelector(".wipe-num");
    if (!el || !document.querySelector("#scr-booth.active")) { recCountdown().then(res); return; }
    el.classList.remove("run", "flash");
    el.classList.add("show");
    void el.offsetWidth;
    el.classList.add("run");
    let n = 3;
    if (num) num.textContent = n;
    SFX.beep();
    const iv = setInterval(() => {
      n--;
      if (n <= 0) {
        clearInterval(iv);
        el.classList.add("flash");
        SFX.go();
        setTimeout(() => {
          el.classList.remove("show", "run", "flash");
          if (num) num.textContent = "3";
          res();
        }, 100);
      } else {
        if (num) num.textContent = n;
        SFX.beep();
      }
    }, 900);
  });
}

function preferWipe() {
  return !!( $("rec-wipe") && $("rec-wipe").checked );
}

// Theater-Vorhang — nur Podest-Finale (schnell, ohne Premiere-Verzögerung)
function curtainsShow(closed) {
  const el = $("cinema-curtains");
  if (!el) return;
  el.classList.add("show");
  el.classList.toggle("open", !closed);
}
function curtainsOpen() {
  return new Promise(res => {
    const el = $("cinema-curtains");
    if (!el) { res(); return; }
    curtainsShow(true);
    void el.offsetWidth;
    requestAnimationFrame(() => {
      el.classList.add("open");
      setTimeout(res, 720);
    });
  });
}
function curtainsClose() {
  return new Promise(res => {
    const el = $("cinema-curtains");
    if (!el) { res(); return; }
    el.classList.add("show");
    el.classList.remove("open");
    setTimeout(() => { el.classList.remove("show"); res(); }, 650);
  });
}

function stopLineRec() {
  recBusy = false;
  recording = false;
  clearInterval(recTimer);
  stopRecCue();
  $("booth-video").pause();
  if (lineRec && lineRec.state === "recording") lineRec.stop();
  $("btn-line-rec").textContent = "⏺ Nochmal aufnehmen";
  $("btn-line-rec").classList.remove("recording");
  SFX.stop();
}

async function onLineRecorded() {
  recBusy = false;
  ["btn-line-scene","btn-line-skip","btn-line-orig"].forEach(id => { const el = $(id); if (el) el.disabled = false; });
  const l = myLines[curLine];
  const prev = takes[l.idx];
  // Alten Take als Outtake behalten (Blooper-Reel nach der Premiere)
  if (prev && prev !== "SKIP" && prev.byteLength) {
    try {
      pushLocalOuttake({
        lineIdx: l.idx,
        text: l.de || l.text || ("Line " + (l.idx + 1)),
        t: l.t,
        end: l.end,
        buf: prev.slice(0),
        name: myName
      });
      updateOuttakesBtn();
    } catch {}
  }
  takes[l.idx] = await new Blob(lineChunks, { type: lineChunks[0]?.type }).arrayBuffer();
  $("btn-line-play").disabled = false;
  $("btn-line-next").disabled = false;
  status("booth-status", "Take im Kasten! Anhören oder direkt weiter.");
}

let previewSrc = null;
$("btn-line-play").onclick = async () => {
  const l = myLines[curLine];
  if (!takes[l.idx] || takes[l.idx] === "SKIP") return;
  if (previewSrc) { try { previewSrc.stop(); } catch {} previewSrc = null; }
  const ctx = getCtx();
  const rawBuf = await ctx.decodeAudioData(await toArrayBuffer(takes[l.idx]));
  const _r = myEffectiveRole(myLines[curLine] || {});
  const buf = processTakeBuffer(ctx, rawBuf, micSettings.gate, _r.effect, _r.fxAmount);   // Gate + ggf. Studio-Aufbereitung
  // Videobild läuft synchron mit (leise), kein Standbild mehr
  const v = $("booth-video");
  v.pause(); v.currentTime = l.t; v.volume = boothVol * 0.6; v.playbackRate = 1;
  await v.play();
  const effRole = myEffectiveRole(myLines[curLine]);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = effectPitch(effRole.effect);
  src.connect(buildChain(ctx, effRole, ctx.destination));
  src.start();
  previewSrc = src;
  src.onended = () => { if (previewSrc === src) previewSrc = null; v.pause(); };
};

function bufferPeak(buf) {
  let p = 0;
  // Jeden Wert pruefen -- kurze Spitzen wuerden beim Ueberspringen sonst untergehen,
  // und genau die sind es, die beim Lauterdrehen als Erstes uebersteuern.
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > p) p = v; }
  }
  return p;
}

function syncLineGainUI(l) {
  const sl = $("my-line-gain"), val = $("my-line-gain-val"), warn = $("my-line-gain-warn");
  if (!sl || !l) return;
  const g = myLineGains[l.idx];
  sl.value = g === undefined ? 1 : g;
  if (val) val.textContent = Math.round(parseFloat(sl.value) * 100) + "%";
  // Warnen, wenn die Aufnahme durch das Anheben in die Uebersteuerung laeuft (klingt dann kratzig).
  // takes[] sind ArrayBuffers — Peak erst nach Decode; hier nur grob ausblenden wenn kein Take.
  if (warn) {
    const t = takes[l.idx];
    if (!t || t === "SKIP") { warn.style.display = "none"; }
    else {
      // Async Peak-Check, damit die UI nicht hakt und ArrayBuffer nicht falsch gelesen wird
      const gainNow = parseFloat(sl.value);
      toArrayBuffer(t).then(ab => getCtx().decodeAudioData(ab.slice(0))).then(buf => {
        if (myLines[curLine] !== l) return; // Line inzwischen gewechselt
        warn.style.display = (bufferPeak(buf) * gainNow > 0.99) ? "" : "none";
      }).catch(() => { warn.style.display = "none"; });
    }
  }
}

function syncLinePanUI(l) {
  const wrap = $("my-line-pan");
  if (!wrap || !l) return;
  const base = roleOf(myRole()) || { pan: 0 };
  const rolePan = base.pan ?? 0;
  const active = panPresetId(myLinePans[l.idx]);
  wrap.innerHTML = LINE_PAN_PRESETS.map(p => {
    const lab = p.id === "auto" ? ("Auto (" + panLabel(rolePan) + ")") : p.label;
    return `<button type="button" class="pan-btn${p.id === active ? " on" : ""}" data-pan="${p.id}" title="${esc(p.tip)}">${esc(lab)}</button>`;
  }).join("");
  wrap.querySelectorAll(".pan-btn").forEach(btn => {
    btn.onclick = () => {
      const preset = LINE_PAN_PRESETS.find(p => p.id === btn.dataset.pan);
      if (!preset) return;
      if (preset.pan === undefined) delete myLinePans[l.idx];
      else myLinePans[l.idx] = preset.pan;
      syncLinePanUI(l);
      fxPreviewCacheKey = null;
      if (fxPreviewSrc) { clearTimeout(fxRestartT); fxRestartT = setTimeout(startFxPreview, 220); }
      SFX.click();
    };
  });
}

function syncFxAmountUI(l) {
  const sl = $("my-effect-amount"), val = $("my-effect-amount-val");
  if (!sl || !l) return;
  const amt = myEffectAmounts[l.idx];
  sl.value = amt === undefined ? 1 : amt;
  if (val) val.textContent = Math.round(parseFloat(sl.value) * 100) + "%";
  // Bei "Normal" bringt der Regler nichts -- dann ausgrauen statt Verwirrung stiften
  const eff = myEffectiveRole(l).effect;
  const off = !eff || eff === "none";
  sl.disabled = off;
  sl.style.opacity = off ? ".35" : "1";
}

$("my-effect-select").onchange = () => {
  const l = myLines[curLine];
  if (!l) return;
  const v = $("my-effect-select").value;
  if (v) myEffectOverrides[l.idx] = v; else delete myEffectOverrides[l.idx];
  syncFxAmountUI(l);
  fxPreviewCacheKey = null;
  if (fxPreviewSrc) startFxPreview();
  SFX.click();
};
$("my-effect-amount") && ($("my-effect-amount").oninput = e => {
  const l = myLines[curLine];
  if (!l) return;
  const v = parseFloat(e.target.value);
  if (v >= 0.999) delete myEffectAmounts[l.idx]; else myEffectAmounts[l.idx] = v;
  const val = $("my-effect-amount-val");
  if (val) val.textContent = Math.round(v * 100) + "%";
  // laeuft gerade eine Vorschau? Dann mit der neuen Staerke direkt neu abspielen
  if (fxPreviewSrc) { clearTimeout(fxRestartT); fxRestartT = setTimeout(startFxPreview, 220); }
});
let fxRestartT = null;

$("my-line-gain") && ($("my-line-gain").oninput = e => {
  const l = myLines[curLine];
  if (!l) return;
  const v = parseFloat(e.target.value);
  if (Math.abs(v - 1) < 0.001) delete myLineGains[l.idx]; else myLineGains[l.idx] = v;
  syncLineGainUI(l);
  if (fxPreviewSrc) { clearTimeout(fxRestartT); fxRestartT = setTimeout(startFxPreview, 220); }
});

// 🔊 Vorhoeren: spielt den eigenen Take (oder ersatzweise das Original) durch den aktuell
// eingestellten Effekt -- damit man Effekt UND Staerke hoert, bevor man sich festlegt.
let fxPreviewSrc = null, fxPreviewRaw = null, fxPreviewIsTake = false, fxPreviewCacheKey = null, fxPreviewCacheBuf = null;
async function fxPreview() {
  const btn = $("btn-fx-preview");
  const l = myLines[curLine];
  if (!l || !btn) return;
  if (fxPreviewSrc) { stopFxPreview(); return; }
  try {
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();   // Browser pausieren den Ton bis zur ersten Geste
    let raw = takes[l.idx] || null;
    if (!raw) {
      btn.textContent = "⏳ …";
      try { raw = await getLineOrigBuffer(l); } catch {}
    }
    if (!raw) {
      status("booth-status", "Zum Vorhören erst aufnehmen — oder eine Szene mit Original wählen.", true);
      btn.textContent = "🔊 Vorhören"; return;
    }
    fxPreviewRaw = raw;
    fxPreviewIsTake = !!takes[l.idx];
    startFxPreview();
  } catch (e) {
    console.error("Vorhören fehlgeschlagen:", e);
    status("booth-status", "Vorhören hat nicht geklappt — nochmal versuchen.", true);
    btn.textContent = "🔊 Vorhören";
  }
}

function stopFxPreview() {
  if (fxPreviewSrc) { try { fxPreviewSrc.stop(); } catch {} fxPreviewSrc = null; }
  const btn = $("btn-fx-preview"); if (btn) btn.textContent = "🔊 Vorhören";
}

function startFxPreview() {
  const l = myLines[curLine];
  const btn = $("btn-fx-preview");
  if (!l || !fxPreviewRaw) return;
  if (fxPreviewSrc) { try { fxPreviewSrc.stop(); } catch {} fxPreviewSrc = null; }
  const ctx = getCtx();
  const role = myEffectiveRole(l);
  // Aufbereitung kann bei „Studio" rechenintensiv sein -> Ergebnis je Einstellung merken,
  // damit man am Stärke-Regler ziehen kann, ohne dass es jedes Mal neu rechnet und hakt.
  const key = role.effect + "|" + (role.fxAmount === undefined ? 1 : role.fxAmount) + "|" + (role.gain ?? 1) + "|" + (role.pan ?? 0) + "|" + micSettings.gate + "|" + (fxPreviewIsTake ? "t" : "o");
  let buf;
  if (fxPreviewCacheKey === key && fxPreviewCacheBuf) buf = fxPreviewCacheBuf;
  else {
    buf = fxPreviewIsTake ? processTakeBuffer(ctx, fxPreviewRaw, micSettings.gate, role.effect, role.fxAmount) : fxPreviewRaw;
    fxPreviewCacheKey = key; fxPreviewCacheBuf = buf;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(buildChain(ctx, role, ctx.destination));
  src.start();
  fxPreviewSrc = src;
  if (btn) btn.textContent = "⏹ Stopp";
  src.onended = () => { if (fxPreviewSrc === src) { fxPreviewSrc = null; if (btn) btn.textContent = "🔊 Vorhören"; } };
}
$("btn-fx-preview") && ($("btn-fx-preview").onclick = fxPreview);
$("btn-line-prev").onclick = () => {
  if (redoMode !== null || curLine <= 0) return;
  curLine--; renderLine(); SFX.click();
};
$("btn-line-next").onclick = () => {
  if (redoMode !== null) { finishRedo(); return; }
  SFX.ok();
  curLine++;
  sendProgress();
  renderLine();
};
$("btn-line-skip").onclick = () => {
  const l = myLines[curLine];
  takes[l.idx] = "SKIP";              // Marker: diese Line behält das Original-Audio
  SFX.ok();
  if (redoMode !== null) { finishRedo(); return; }
  curLine++;
  sendProgress();
  renderLine();
};

function sendProgress(force) {
  const done = Object.keys(takes).length, total = myLines.length;
  const me = players.find(p => p.id === myId);
  if (me) { me.done = done; me.total = total; }
  if (isHost) broadcastState(force ? undefined : { throttle: true });
  else sendHost({ t: "progress", done, total });
}

function serializeOuttakes() {
  return dedupeOuttakes(outtakes).map(o => ({
    lineIdx: o.lineIdx,
    text: o.text,
    t: o.t,
    end: o.end,
    name: o.name || myName,
    buf: o.buf
  }));
}

/** Boost-/Pan-Werte extra mitschicken — PeerJS verliert Nebenfelder neben ArrayBuffers manchmal. */
function boostMapFromItems(items) {
  const m = {};
  for (const it of items) {
    if (it.boost != null && it.boost !== 1 && it.idx != null) m[it.idx] = it.boost;
  }
  return m;
}
function attachBoosts(items, boostByIdx) {
  if (!items || !boostByIdx) return items;
  for (const it of items) {
    if (it.boost != null) continue;
    const b = boostByIdx[it.idx] ?? boostByIdx[String(it.idx)];
    if (b != null) it.boost = b;
  }
  return items;
}
function panMapFromItems(items) {
  const m = {};
  for (const it of items) {
    if (it.pan != null && it.idx != null) m[it.idx] = it.pan;
  }
  return m;
}
function attachPans(items, panByIdx) {
  if (!items || !panByIdx) return items;
  for (const it of items) {
    if (it.pan != null) continue;
    const p = panByIdx[it.idx] ?? panByIdx[String(it.idx)];
    if (p != null) it.pan = p;
  }
  return items;
}
function attachTrackMeta(items, msg) {
  return attachPans(attachBoosts(items, msg && msg.boostByIdx), msg && msg.panByIdx);
}
/** Alle Takes einer Mix-Nachricht → Boost/Pan-Maps (für Host→Gast-Broadcast). */
function metaMapsFromTracks(tracks) {
  const all = [];
  for (const tr of tracks || []) {
    if (tr && tr.items) for (const it of tr.items) all.push(it);
  }
  return { boostByIdx: boostMapFromItems(all), panByIdx: panMapFromItems(all) };
}
function attachMetaToTracks(tracks, msg) {
  if (!tracks || !msg) return tracks;
  for (const tr of tracks) {
    if (tr && tr.items) attachTrackMeta(tr.items, msg);
  }
  return tracks;
}
/** Eigene Booth-Einstellungen nachziehen, falls PeerJS Meta unterwegs verloren hat. */
function applyLocalLineMeta(tracks) {
  const rid = myRole();
  if (rid == null || !tracks) return;
  for (const tr of tracks) {
    if (!tr || tr.role !== rid || !tr.items) continue;
    for (const it of tr.items) {
      if (it.boost == null && myLineGains[it.idx] != null) it.boost = myLineGains[it.idx];
      if (it.pan == null && myLinePans[it.idx] != null) it.pan = myLinePans[it.idx];
    }
  }
}
/** Mix an alle schicken — Boost/Pan extra, weil sie neben Audio-Buffern oft verloren gehen. */
function publishMix(data) {
  finalTracksData = data;
  const maps = metaMapsFromTracks(data);
  broadcast({ t: "mix", data, ...maps });
  loadMix(data);
}

function finishBooth() {
  cancelAnimationFrame(vizRAF);
  $("onair").classList.remove("live");
  SFX.done();
  sendProgress(true);   // letzten Fortschritt sofort pushen (kein Debounce-Rest)
  show("scr-wait");
  renderBoothPlayers();
  const items = myLines.filter(l => takes[l.idx] && takes[l.idx] !== "SKIP")
    .map(l => ({ startAt: l.t, idx: l.idx, buf: takes[l.idx], effect: myEffectOverrides[l.idx] || undefined, fxAmount: myEffectAmounts[l.idx], boost: myLineGains[l.idx], pan: myLinePans[l.idx], gate: micSettings.gate }));
  const ots = serializeOuttakes();
  const boostByIdx = boostMapFromItems(items);
  const panByIdx = panMapFromItems(items);
  if (match.mode === "duell" && duelInfo) {
    if (isHost) collectDuelSubmit(myId, items);
    else sendHost({ t: "duelSubmit", playerId: myId, items, boostByIdx, panByIdx });
    status("wait-status", "🥊 Dein Take ist im Kasten! Warte auf den anderen Duellanten …");
    return;
  }
  if (isHost) collectTracks(myRole(), items, ots, myId);
  else sendHost({ t: "tracks", role: myRole(), items, boostByIdx, panByIdx, outtakes: ots });
}

// ═════════════════════════════════════════════════════════════
// 7) REALTIME-MODUS (Szenen ohne Line-Timings)
// ═════════════════════════════════════════════════════════════
let rtRecorder = null, rtChunks = [];

async function startRealtime() {
  stopLobbyPreview();
  const rid = myRole();
  if (rid == null) {                       // Zuschauer — wie im Line-Booth, sonst stürzt die Seite ab
    show("scr-wait");
    renderBoothPlayers();
    const dn = $("duel-waiting-note"); if (dn) dn.style.display = "none";
    status("wait-status", "🍿 Du bist Zuschauer — die Premiere startet automatisch, wenn alle fertig sind.");
    return;
  }
  const role = roleOf(rid) || { name: "—" };
  $("rec-role").textContent = "🎭 Du bist: " + role.name;
  const v = $("rec-video");
  v.src = sceneVideoSrc();
  attachPrompter(v, $("rec-prompter"), myRole());
  show("scr-record");
  await countdown();
  $("onair").classList.add("live");
  rtChunks = [];
  rtRecorder = new MediaRecorder(recStream(), { mimeType: pickMime() });
  rtRecorder.ondataavailable = e => { if (e.data.size) rtChunks.push(e.data); };
  rtRecorder.onstop = async () => {
    $("onair").classList.remove("live");
    status("rec-status", "Aufnahme fertig — sammle alle Spuren ein …");
    const buf = await new Blob(rtChunks, { type: rtChunks[0]?.type }).arrayBuffer();
    const items = [{ startAt: 0, buf }];
    if (isHost) collectTracks(myRole(), items);
    else sendHost({ t: "tracks", role: myRole(), items });
  };
  rtRecorder.start();
  v.currentTime = 0;
  await v.play();
  v.onended = () => { if (rtRecorder.state !== "inactive") rtRecorder.stop(); };
}

// opts.wipe !== false → Balken nur wenn Checkbox an UND Booth aktiv
function countdown(opts = {}) {
  if (opts.wipe !== false && preferWipe() && document.querySelector("#scr-booth.active")) {
    return wipeCountdown();
  }
  return new Promise(res => {
    const el = $("countdown"), num = el.querySelector("div");
    el.classList.add("show");
    let n = 3;
    num.textContent = n; SFX.beep();
    const iv = setInterval(() => {
      n--;
      if (n === 0) { clearInterval(iv); el.classList.remove("show"); SFX.go(); res(); }
      else { num.textContent = n; SFX.beep(); }
    }, 900);
  });
}


// ═════════════════════════════════════════════════════════════
// WARTE-ARENA: TicTacToe (Host verwaltet, alle im Warte-Screen)
// ═════════════════════════════════════════════════════════════
let ttt = { p: [], board: Array(9).fill(null), turn: 0, winner: null };
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function tttAction(a) { if (isHost) tttHandle(a, myId); else sendHost({ t: "ttt", a }); }
function tttHandle(a, pid) {
  if (a.k === "join" && ttt.p.length < 2 && !ttt.p.includes(pid) && !ttt.winner) ttt.p.push(pid);
  if (a.k === "move" && !ttt.winner && ttt.p.length === 2 && ttt.p[ttt.turn] === pid && ttt.board[a.i] == null) {
    ttt.board[a.i] = ttt.turn === 0 ? "X" : "O";
    for (const w of TTT_WINS) if (w.every(i => ttt.board[i] === ttt.board[w[0]] && ttt.board[i])) { ttt.winner = ttt.turn; addWin(ttt.p[ttt.turn]); }
    if (ttt.winner == null && ttt.board.every(c => c)) ttt.winner = -1;   // Unentschieden
    if (ttt.winner == null) ttt.turn = 1 - ttt.turn;
  }
  if (a.k === "reset") { ttt = { p: ttt.winner != null ? [...ttt.p].reverse() : [], board: Array(9).fill(null), turn: 0, winner: null }; if (a.hard) ttt.p = []; }
  broadcast({ t: "tttState", ttt });
  renderTTT();
}
function nameOf(pid) { return players.find(p => p.id === pid)?.name || "?"; }
function onWaitScreen() { return !!document.querySelector("#scr-wait.active"); }   // nur Sound spielen, wenn man die Warte-Arena wirklich SIEHT

function renderTTT() {
  const board = $("ttt-board");
  if (!board) return;
  const iAmIn = ttt.p.includes(myId);
  const myTurn = iAmIn && ttt.p[ttt.turn] === myId && ttt.p.length === 2 && ttt.winner == null;
  board.innerHTML = ttt.board.map((c, i) =>
    `<button class="tttcell" data-i="${i}" ${c || !myTurn ? "disabled" : ""} style="${c === "X" ? "color:var(--amber)" : c === "O" ? "color:var(--violet)" : ""}">${c || ""}</button>`
  ).join("");
  board.querySelectorAll(".tttcell").forEach(b => b.onclick = () => tttAction({ k: "move", i: parseInt(b.dataset.i) }));
  $("btn-ttt-join").style.display = (!iAmIn && ttt.p.length < 2) ? "" : "none";
  let info;
  if (ttt.p.length < 2) info = ttt.p.length === 0 ? "Zwei Wartende können zocken — wer traut sich?" : nameOf(ttt.p[0]) + " wartet auf einen Gegner …";
  else if (ttt.winner === -1) info = "Unentschieden! 🤝";
  else if (ttt.winner != null) info = "🏆 " + nameOf(ttt.p[ttt.winner]) + " gewinnt!";
  else info = (myTurn ? "🫵 DU bist dran (" : nameOf(ttt.p[ttt.turn]) + " ist dran (") + (ttt.turn === 0 ? "X" : "O") + ")";
  $("ttt-info").textContent = nameOf(ttt.p[0] || "") && ttt.p.length === 2 ? nameOf(ttt.p[0]) + " (X) vs " + nameOf(ttt.p[1]) + " (O) — " + info : info;
}
document.addEventListener("DOMContentLoaded", () => {
  $("btn-ttt-join").onclick = () => tttAction({ k: "join" });
  $("btn-ttt-reset").onclick = () => tttAction({ k: "reset" });
  renderTTT();
  $("btn-rps-join") && ($("btn-rps-join").onclick = () => rpsAction({ k: "join" }));
  $("btn-rps-reset") && ($("btn-rps-reset").onclick = () => rpsAction({ k: "reset" }));
  renderRPS();
  $("btn-dice-join") && ($("btn-dice-join").onclick = () => diceAction({ k: "join" }));
  $("btn-dice-reset") && ($("btn-dice-reset").onclick = () => diceAction({ k: "reset" }));
  renderDice();
  initDrawCanvas("draw-canvas", "draw-colors", "draw-size", "btn-draw-clear", "btn-draw-eraser");
  $("bg-start") && ($("bg-start").onclick = () => bgStart());
  $("bg-stop") && ($("bg-stop").onclick = () => bgStop(true, true));
  $("bg-vol") && ($("bg-vol").oninput = e => { BG.vol = parseFloat(e.target.value); if (BG.audio) BG.audio.volume = BG.vol; });
  startFunFactRotation();
});


// ═════════════════════════════════════════════════════════════
// WARTE-ARENA 2: Klick-Battle (10 Sekunden, alle Wartenden)
// ═════════════════════════════════════════════════════════════
let cbActive = false, cbClicks = 0, cbTimer = null;
function cbStart() {
  if (isHost) { broadcast({ t: "cbGo" }); cbRun(); }
  else sendHost({ t: "cb", a: { k: "start" } });
}
function cbRun() {
  cbActive = true; cbClicks = 0;
  $("cb-btn").style.display = ""; $("btn-cb-start").style.display = "none";
  $("cb-result").innerHTML = "";
  let left = 10;
  $("cb-info").textContent = "⚡ LOS! Klick was das Zeug hält — " + left + "s";
  if (onWaitScreen()) SFX.go();
  clearInterval(cbTimer);
  cbTimer = setInterval(() => {
    left--;
    $("cb-info").textContent = left > 0 ? "⚡ " + left + "s — KLICK KLICK KLICK!" : "Zeit um!";
    if (left <= 0) {
      clearInterval(cbTimer);
      cbActive = false;
      $("cb-btn").style.display = "none"; $("btn-cb-start").style.display = "";
      if (isHost) cbScore(myId, cbClicks); else sendHost({ t: "cb", a: { k: "score", n: cbClicks } });
    }
  }, 1000);
}
const cbScores = new Map();
function cbScore(pid, n) {
  cbScores.set(pid, n);
  clearTimeout(cbScore._t);
  cbScore._t = setTimeout(() => {
    const list = [...cbScores.entries()].sort((a, b) => b[1] - a[1]);
    broadcast({ t: "cbResult", list });
    cbShowResult(list);
    if (list.length) addWin(list[0][0]);
    cbScores.clear();
  }, 1500);
}
function cbShowResult(list) {
  $("cb-result").innerHTML = list.map(([pid, n], i) =>
    `<div>${i === 0 ? "🏆" : i === 1 ? "🥈" : i === 2 ? "🥉" : "•"} <b>${esc(nameOf(pid))}</b> — ${n} Klicks</div>`).join("");
  $("cb-info").textContent = list.length ? "Ergebnis! Revanche?" : "Zwei Wartende, ein Button — wer klickt schneller?";
  if (onWaitScreen()) SFX.done();
}
document.addEventListener("DOMContentLoaded", () => {
  $("btn-cb-start").onclick = cbStart;
  $("cb-btn").onclick = () => { if (cbActive) { cbClicks++; $("cb-btn").textContent = "🔥 " + cbClicks; } };
});


// ═════════════════════════════════════════════════════════════
// WARTE-ARENA 5: Schnick-Schnack-Schnuck (2 Wartende)
// ═════════════════════════════════════════════════════════════
let rps = { p: [], picks: {}, wins: {}, lastResult: null };
const RPS_ICON = { rock: "✊", paper: "✋", scissors: "✌️" };
const RPS_BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };
function rpsAction(a) { if (isHost) rpsHandle(a, myId); else sendHost({ t: "rps", a }); }
function rpsHandle(a, pid) {
  if (a.k === "join" && rps.p.length < 2 && !rps.p.includes(pid)) { rps.p.push(pid); rps.wins[pid] = 0; }
  if (a.k === "pick" && rps.p.includes(pid) && rps.p.length === 2 && !rps.lastResult) {
    rps.picks[pid] = a.choice;
    if (Object.keys(rps.picks).length === 2) {
      const [a1, a2] = rps.p, c1 = rps.picks[a1], c2 = rps.picks[a2];
      let winner = null;
      if (c1 !== c2) winner = RPS_BEATS[c1] === c2 ? a1 : a2;
      if (winner) { rps.wins[winner]++; addWin(winner); }
      rps.lastResult = { c1, c2, winner };
      broadcast({ t: "rpsState", rps }); renderRPS();
      setTimeout(() => { rps.picks = {}; rps.lastResult = null; broadcast({ t: "rpsState", rps }); renderRPS(); }, 2200);
      return;
    }
  }
  if (a.k === "reset") rps = { p: Object.keys(rps.wins).length ? [...rps.p].reverse() : [], picks: {}, wins: {}, lastResult: null };
  broadcast({ t: "rpsState", rps });
  renderRPS();
}
function renderRPS() {
  const el = $("rps-area"); if (!el) return;
  const iAmIn = rps.p.includes(myId);
  const bothIn = rps.p.length === 2;
  $("btn-rps-join").style.display = (!iAmIn && rps.p.length < 2) ? "" : "none";
  if (!bothIn) { el.innerHTML = ""; $("rps-info").textContent = rps.p.length === 0 ? "Zwei Wartende können zocken — wer traut sich?" : nameOf(rps.p[0]) + " wartet auf einen Gegner …"; return; }
  const [a1, a2] = rps.p;
  if (rps.lastResult) {
    const { c1, c2, winner } = rps.lastResult;
    $("rps-info").textContent = winner ? "🏆 " + nameOf(winner) + " gewinnt die Runde!" : "🤝 Unentschieden!";
    el.innerHTML = `<div style="display:flex;gap:24px;justify-content:center;font-size:3rem">
      <div style="text-align:center"><div>${RPS_ICON[c1]}</div><div class="tag">${esc(nameOf(a1))}</div></div>
      <div style="align-self:center;font-size:1.4rem">⚔️</div>
      <div style="text-align:center"><div>${RPS_ICON[c2]}</div><div class="tag">${esc(nameOf(a2))}</div></div>
    </div>`;
    if (onWaitScreen()) winner ? SFX.done() : SFX.beep();
  } else {
    const myTurn = iAmIn && !rps.picks[myId];
    $("rps-info").textContent = nameOf(a1) + " (" + (rps.wins[a1]||0) + ") vs " + nameOf(a2) + " (" + (rps.wins[a2]||0) + ")" + (iAmIn ? (rps.picks[myId] ? " — warte auf Gegner …" : " — wähl deinen Zug!") : " — beide wählen gerade …");
    el.innerHTML = !myTurn ? "" : `<div style="display:flex;gap:10px;justify-content:center">${Object.entries(RPS_ICON).map(([k,ic]) => `<button class="big" data-k="${k}" style="font-size:1.8rem;padding:14px 20px">${ic}</button>`).join("")}</div>`;
    el.querySelectorAll("button").forEach(b => b.onclick = () => rpsAction({ k: "pick", choice: b.dataset.k }));
  }
}

// ═════════════════════════════════════════════════════════════
// WARTE-ARENA 6: Würfel-Duell (2 Wartende)
// ═════════════════════════════════════════════════════════════
let dice = { p: [], rolls: {}, winner: null };
function diceAction(a) { if (isHost) diceHandle(a, myId); else sendHost({ t: "dice", a }); }
function diceHandle(a, pid) {
  if (a.k === "join" && dice.p.length < 2 && !dice.p.includes(pid)) dice.p.push(pid);
  if (a.k === "roll" && dice.p.includes(pid) && dice.rolls[pid] == null && !dice.winner) {
    dice.rolls[pid] = 1 + Math.floor(Math.random() * 6);
    if (Object.keys(dice.rolls).length === 2) {
      const [a1, a2] = dice.p;
      if (dice.rolls[a1] !== dice.rolls[a2]) { dice.winner = dice.rolls[a1] > dice.rolls[a2] ? a1 : a2; addWin(dice.winner); }
      else dice.winner = "tie";
    }
  }
  if (a.k === "reset") dice = { p: dice.winner && dice.winner !== "tie" ? [...dice.p].reverse() : dice.p, rolls: {}, winner: null };
  broadcast({ t: "diceState", dice });
  renderDice();
}
const DICE_FACE = ["⚀","⚁","⚂","⚃","⚄","⚅"];
function renderDice() {
  const el = $("dice-area"); if (!el) return;
  const iAmIn = dice.p.includes(myId);
  $("btn-dice-join").style.display = (!iAmIn && dice.p.length < 2) ? "" : "none";
  if (dice.p.length < 2) { el.innerHTML = ""; $("dice-info").textContent = dice.p.length === 0 ? "Zwei Wartende können zocken — wer traut sich?" : nameOf(dice.p[0]) + " wartet auf einen Gegner …"; return; }
  const [a1, a2] = dice.p;
  const r1 = dice.rolls[a1], r2 = dice.rolls[a2];
  el.innerHTML = `<div style="display:flex;gap:24px;justify-content:center;font-size:3.2rem">
    <div style="text-align:center"><div>${r1 ? DICE_FACE[r1-1] : "🎲"}</div><div class="tag">${esc(nameOf(a1))}</div></div>
    <div style="align-self:center;font-size:1.2rem">vs</div>
    <div style="text-align:center"><div>${r2 ? DICE_FACE[r2-1] : "🎲"}</div><div class="tag">${esc(nameOf(a2))}</div></div>
  </div>`;
  if (dice.winner) {
    $("dice-info").textContent = dice.winner === "tie" ? "🤝 Unentschieden! Nochmal?" : "🏆 " + nameOf(dice.winner) + " gewinnt (" + Math.max(r1,r2) + " vs " + Math.min(r1,r2) + ")!";
    if (onWaitScreen()) dice.winner === "tie" ? SFX.beep() : SFX.done();
  } else if (iAmIn && dice.rolls[myId] == null) {
    $("dice-info").textContent = "🎲 Du bist dran — würfeln!";
  } else {
    $("dice-info").textContent = nameOf(a1) + " vs " + nameOf(a2) + " — warte auf beide Würfe …";
  }
}
$("btn-dice-roll") && ($("btn-dice-roll").onclick = () => diceAction({ k: "roll" }));

// ═════════════════════════════════════════════════════════════
// 🎨 Kritzel-Board: alle warten zusammen malen auf derselben Leinwand
// ═════════════════════════════════════════════════════════════
let drawBoard = { strokes: [] };
let drawColor = "#ffc95c", drawSize = 4;
let drawing = false, curStroke = null, lastSentLen = 0, drawThrottle = null;
const DRAW_COLORS = ["#ffc95c", "#ff5470", "#7c5cff", "#4ade80", "#4ac9e8", "#f5f5f5", "#3a3a46",
  "#ff8a3d", "#ff4dd8", "#4d7bff", "#2fbf71", "#e8e037", "#8a4b2f", "#000000"];
const DRAW_CANVAS_IDS = ["draw-canvas"];   // nur noch EIN Canvas -- festes Seitenpanel statt Duplikat pro Screen

function drawAction(a) { if (isHost) drawHandle(a, myId); else sendHost({ t: "draw", a }); }
function drawHandle(a, pid) {
  if (a.k === "stroke") {
    const idx = drawBoard.strokes.findIndex(s => s.id === a.stroke.id);
    if (idx >= 0) drawBoard.strokes[idx] = a.stroke; else drawBoard.strokes.push(a.stroke);
  } else if (a.k === "clear") {
    drawBoard = { strokes: [] };
  }
  broadcast({ t: "drawState", drawBoard });
  renderDrawBoard();
}
function drawCanvasCtx(canvasId) {
  const c = $(canvasId);
  if (!c) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth * dpr, h = c.clientHeight * dpr;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c.getContext("2d");
}
const DRAW_BG = "#0e0e13";
function strokeVisual(color, size) {
  // "eraser" ist keine echte Farbe -- male stattdessen mit der Canvas-Hintergrundfarbe und etwas dicker
  return color === "eraser" ? { color: DRAW_BG, width: size * 2.2 } : { color, width: size };
}
function drawOneStroke(g, c, s) {
  if (!s || !s.points.length) return;
  const v = strokeVisual(s.color, s.size || 4);
  g.strokeStyle = v.color; g.lineWidth = v.width * (window.devicePixelRatio || 1);
  g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath();
  s.points.forEach((p, i) => {
    const x = p[0] * c.width, y = p[1] * c.height;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
}
function renderDrawBoardOn(canvasId) {
  const g = drawCanvasCtx(canvasId);
  if (!g) return;
  const c = $(canvasId);
  const live = (drawing && curStroke) ? curStroke : null;
  g.clearRect(0, 0, c.width, c.height);
  for (const s of drawBoard.strokes) {
    if (live && s.id === live.id) continue;   // gespeicherte Fassung ist älter — gleich kommt die aktuelle
    drawOneStroke(g, c, s);
  }
  // Den eigenen Strich, an dem gerade gezogen wird, immer zuletzt und in seiner neuesten Fassung zeichnen.
  // Sonst verschwindet der zuletzt gezogene Teil bei jedem Neuaufbau kurz -> sichtbares Flackern.
  if (live) drawOneStroke(g, c, live);
}
function renderDrawBoard() { DRAW_CANVAS_IDS.forEach(renderDrawBoardOn); }
const DRAW_CANVAS_COLOR_IDS = ["draw-colors"];
const DRAW_ERASER_IDS = ["btn-draw-eraser"];
function drawColorPicker(colorsId) {
  const wrap = $(colorsId);
  if (!wrap) return;
  wrap.innerHTML = DRAW_COLORS.map(c => `<button class="colorbtn" data-c="${c}" style="width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${c === drawColor ? "var(--amber)" : "transparent"};padding:0"></button>`).join("");
  wrap.querySelectorAll(".colorbtn").forEach(b => b.onclick = () => {
    drawColor = b.dataset.c;
    syncDrawToolUI();
  });
}
function syncDrawToolUI() {
  DRAW_CANVAS_COLOR_IDS.forEach(drawColorPicker);
  DRAW_ERASER_IDS.forEach(id => { const b = $(id); if (b) b.style.borderColor = drawColor === "eraser" ? "var(--amber)" : "var(--line)"; });
}
function initDrawCanvas(canvasId, colorsId, sizeId, clearId, eraserId) {
  const c = $(canvasId);
  if (!c || c.__wired) return;
  c.__wired = true;
  drawColorPicker(colorsId);
  renderDrawBoardOn(canvasId);
  const posOf = (e) => {
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return [0.5, 0.5];   // Canvas noch nicht fertig gelayoutet -> keine kaputten/verzerrten Punkte erzeugen
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return [Math.min(1, Math.max(0, cx / r.width)), Math.min(1, Math.max(0, cy / r.height))];
  };
  const start = (e) => {
    e.preventDefault();
    drawing = true;
    curStroke = { id: myId + "_" + Date.now(), color: drawColor, size: drawSize, points: [posOf(e)] };
    lastSentLen = 0;
    renderDrawBoardOn(canvasId); drawLiveSegment();
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    curStroke.points.push(posOf(e));
    drawLiveSegment();
    if (!drawThrottle) drawThrottle = setTimeout(() => { drawThrottle = null; flushStroke(); }, 90);
  };
  const end = () => {
    if (!drawing) return;
    drawing = false;
    flushStroke();
    curStroke = null;
  };
  function drawLiveSegment() {
    const g = drawCanvasCtx(canvasId);
    const pts = curStroke.points;
    if (pts.length < 2) return;
    const v = strokeVisual(curStroke.color, curStroke.size);
    g.strokeStyle = v.color; g.lineWidth = v.width * (window.devicePixelRatio || 1);
    g.lineCap = "round"; g.lineJoin = "round";
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    g.beginPath(); g.moveTo(a[0] * c.width, a[1] * c.height); g.lineTo(b[0] * c.width, b[1] * c.height); g.stroke();
  }
  function flushStroke() {
    if (!curStroke || curStroke.points.length === lastSentLen) return;
    lastSentLen = curStroke.points.length;
    drawAction({ k: "stroke", stroke: { ...curStroke, points: [...curStroke.points] } });
  }
  c.addEventListener("mousedown", start); c.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  c.addEventListener("touchstart", start, { passive: false }); c.addEventListener("touchmove", move, { passive: false });
  c.addEventListener("touchend", end);
  $(sizeId) && ($(sizeId).oninput = e => drawSize = parseInt(e.target.value));
  $(clearId) && ($(clearId).onclick = () => drawAction({ k: "clear" }));
  $(eraserId) && ($(eraserId).onclick = () => { drawColor = "eraser"; syncDrawToolUI(); });
}

// ═════════════════════════════════════════════════════════════
// BEWERTUNGS-SHOW: Nach der Premiere Sterne + optional SynchroBuddy
// ═════════════════════════════════════════════════════════════
let pendingRate = false, myStars = {}, myBuddy = null, rateSent = false;
const allRatings = new Map();   // Host: voterId → { scores, buddy }
const BUDDY_BONUS = 1.0;        // Extra-Punkte pro erhaltenem SynchroBuddy

function showRateCard() {
  document.body.classList.remove("cinema");
  const c = $("cinema-curtains"); if (c) c.classList.remove("show", "open");
  const speakers = players.filter(p => p.role != null && !p.offline && p.id !== myId);
  const anySpeakers = players.filter(p => p.role != null && !p.offline).length >= 2;
  if (!anySpeakers) {
    status("play-status", "Zu wenig Sprecher für eine Bewertung — weiter ohne Sterne.");
    return;
  }
  myStars = {}; myBuddy = null; rateSent = false; ratingDone = false; allRatings.clear();
  const rp = $("rate-progress"); if (rp) rp.textContent = "";
  $("rate-card").style.display = "";
  $("rate-result").innerHTML = "";
  $("btn-rate-submit").style.display = "";
  $("btn-rate-force").style.display = "none";
  updateOuttakesBtn();
  const canBuddy = !myBuddyUsed && speakers.length > 0;
  const hint = $("buddy-hint");
  if (hint) {
    hint.style.display = speakers.length ? "" : "none";
    hint.innerHTML = myBuddyUsed
      ? "🤝 SynchroBuddy hast du in diesem Match schon vergeben."
      : "🤝 Optional: gib <b>einem</b> Sprecher einen <b>SynchroBuddy</b>-Sticker (nur <b>1× pro Match</b>) — Extra-Punkte!";
  }
  if (!speakers.length) {
    $("rate-rows").innerHTML = '<p class="sub">Du warst der einzige Sprecher — die anderen bewerten dich gerade… 👀</p>';
    $("btn-rate-submit").style.display = "none";
    sendRating({}, null);
    return;
  }
  $("rate-rows").innerHTML = speakers.map(p => `
    <div class="raterow" data-p="${p.id}">
      ${avatarHTML(p)}
      <div class="rateinfo">
        <span class="ratename">${esc(p.name)}</span>
        <span class="tag">🎭 ${esc(scene.roles.find(r => r.id === p.role)?.name || "")}</span>
      </div>
      <div class="starrow">${[1,2,3,4,5].map(n => `<button class="starbtn" data-n="${n}">★</button>`).join("")}</div>
      ${canBuddy ? `<button type="button" class="buddy-btn" data-buddy="${p.id}" title="SynchroBuddy geben (1× pro Match)">🤝</button>` : ""}
    </div>`).join("");
  $("rate-rows").querySelectorAll(".raterow").forEach(row => {
    row.querySelectorAll(".starbtn").forEach(b => b.onclick = () => {
      const n = parseInt(b.dataset.n);
      myStars[row.dataset.p] = n;
      row.querySelectorAll(".starbtn").forEach(x => {
        const on = parseInt(x.dataset.n) <= n;
        x.classList.toggle("on", on);
        if (on) { x.classList.remove("pop"); void x.offsetWidth; x.classList.add("pop"); }
      });
      row.classList.toggle("rated", true);
      $("btn-rate-submit").disabled = Object.keys(myStars).length < speakers.length;
      SFX.click();
    });
    const bb = row.querySelector(".buddy-btn");
    if (bb) bb.onclick = () => {
      const id = bb.dataset.buddy;
      myBuddy = (myBuddy === id) ? null : id;
      $("rate-rows").querySelectorAll(".buddy-btn").forEach(x => x.classList.toggle("on", x.dataset.buddy === myBuddy));
      SFX.click();
    };
  });
  $("btn-rate-submit").disabled = true;
}

$("btn-rate-submit").onclick = () => {
  if (rateSent) return;
  rateSent = true;
  $("btn-rate-submit").disabled = true;
  $("btn-rate-submit").textContent = "✅ Abgeschickt — warte auf die anderen …";
  // Buddy nur 1× pro Match — lokal sofort merken, Host prüft zusätzlich
  const buddy = (!myBuddyUsed && myBuddy) ? myBuddy : null;
  if (buddy) myBuddyUsed = true;
  sendRating(myStars, buddy);
};
let rateForceTimer = null;
function sendRating(scores, buddy) {
  if (isHost) {
    collectRating(myId, scores, buddy);
    clearTimeout(rateForceTimer);
    rateForceTimer = setTimeout(() => {
      const need = onlinePlayers().length;
      if (allRatings.size < need) {
        const btn = $("btn-rate-force");
        if (btn) btn.style.display = "";
      }
    }, 25000);
  } else sendHost({ t: "rate", scores, buddy: buddy || null });
}
function collectRating(voterId, scores, buddy) {
  if (!match.buddyGivers) match.buddyGivers = {};
  // SynchroBuddy nur einmal pro Match und Wähler
  let okBuddy = buddy || null;
  if (okBuddy && match.buddyGivers[voterId]) okBuddy = null;
  if (okBuddy) match.buddyGivers[voterId] = okBuddy;
  allRatings.set(voterId, { scores: scores || {}, buddy: okBuddy });
  updateRateProgress();
  maybeFinishRating();
}
function maybeFinishRating() {
  if (!isHost || ratingDone) return;
  const onlineIds = new Set(onlinePlayers().map(p => p.id));
  if (!onlineIds.size) return;
  const onlineVoted = [...allRatings.keys()].filter(id => onlineIds.has(id)).length;
  if (onlineVoted >= onlineIds.size) finishRating();
}
function updateRateProgress() {
  if (!isHost) return;
  const onlineIds = new Set(onlinePlayers().map(p => p.id));
  const have = [...allRatings.keys()].filter(id => onlineIds.has(id)).length;
  const total = onlineIds.size;
  const el = $("rate-progress");
  if (el) el.textContent = "🗳 " + have + "/" + total + " online haben abgestimmt" + (have < total ? " …" : " — alle fertig!");
  const btn = $("btn-rate-force");
  if (btn && have >= total) btn.style.display = "none";
}
$("btn-rate-force").onclick = () => { if (confirm("Wirklich ohne die fehlenden Stimmen weiter?")) finishRating(); };
let ratingDone = false;
function finishRating() {
  if (!isHost || ratingDone) return;
  ratingDone = true;
  clearTimeout(rateForceTimer);
  const sums = {}, counts = {}, buddyCounts = {};
  allRatings.forEach(entry => {
    const scores = entry.scores || entry; // Rückwärtskompat falls altes Format
    const buddy = entry.buddy || null;
    for (const [pid, n] of Object.entries(scores)) {
      if (typeof n !== "number") continue;
      sums[pid] = (sums[pid] || 0) + n;
      counts[pid] = (counts[pid] || 0) + 1;
    }
    if (buddy) buddyCounts[buddy] = (buddyCounts[buddy] || 0) + 1;
  });
  const results = Object.keys(sums).map(pid => {
    const avgStars = sums[pid] / counts[pid];
    const buddies = buddyCounts[pid] || 0;
    return {
      id: pid,
      name: nameOf(pid),
      avg: avgStars + buddies * BUDDY_BONUS,
      avgStars,
      buddies,
      votes: counts[pid]
    };
  }).sort((a, b) => b.avg - a.avg);
  results.forEach(r => { match.totals[r.id] = (match.totals[r.id] || 0) + r.avg; });

  let eliminatedName = null;
  if (match.mode === "elimination" && results.length > 1) {
    const worstScore = results[results.length - 1].avg;
    const worstCandidates = results.filter(r => Math.abs(r.avg - worstScore) < 0.0001);
    const out = worstCandidates[Math.floor(Math.random() * worstCandidates.length)];
    const p = players.find(pl => pl.id === out.id);
    if (p) { p.eliminated = true; eliminatedName = p.name; }
  }

  broadcast({ t: "rateResult", results, eliminatedName });
  showRateResult(results, eliminatedName);
  allRatings.clear();

  const activeLeft = players.filter(p => !p.eliminated).length;
  const btn = $("btn-next-round");
  btn.style.display = "";
  if (match.mode === "elimination") {
    btn.textContent = activeLeft > 1 ? ("▶ Nächste Runde (" + activeLeft + " noch im Rennen)") : "🏆 Champion küren!";
  } else {
    btn.textContent = match.round < match.rounds ? ("▶ Nächste Runde (" + (match.round + 1) + "/" + match.rounds + ")") : "🏁 Finale anzeigen!";
  }
}

$("btn-next-round").onclick = async () => {
  if (!isHost) return;
  $("btn-next-round").style.display = "none";

  const activeLeft = players.filter(p => !p.eliminated).length;
  const continueMatch = match.mode === "elimination" ? activeLeft > 1 : match.round < match.rounds;

  if (continueMatch) {
    match.round++;
    if (match.mode === "rounds" || match.mode === "elimination") {
      // Kurze Verschnaufpause mit Countdown, bevor's in die naechste Runde geht
      for (let s = 3; s >= 1; s--) { $("btn-next-round").style.display = "none"; status("rate-progress", "⏳ Nächste Runde in " + s + " …"); await new Promise(r => setTimeout(r, 1000)); }
      // Neue Zufalls-Szene + neue Zufalls-Rollen, zurück in die Lobby zum Bereitmachen
      backToLobby(true);
      await pickRandomScene();
      const label = match.mode === "elimination" ? ("🔪 Runde " + match.round + " — " + activeLeft + " noch im Rennen!") : ("🎲 Runde " + match.round + "/" + match.rounds);
      status("lobby-status", label + ": neue Szene &amp; Rollen! Alle „Bin bereit“.");
      $("btn-go-round").style.display = "";
      broadcast({ t: "nextRound", round: match.round, players, scene });
      return;
    }
    broadcast({ t: "nextRound", round: match.round, players });
    startNewRound();
  } else {
    const list = Object.entries(match.totals).map(([pid, sum]) => ({ id: pid, name: nameOf(pid), sum }))
      .sort((a, b) => b.sum - a.sum);
    const championName = match.mode === "elimination" ? (players.find(p => !p.eliminated)?.name || list[0]?.name) : null;
    broadcast({ t: "matchEnd", list, rounds: match.rounds, championName });
    showFinal(list, match.rounds, championName);
  }
};

function startNewRound() {
  resetForNewRound();
  broadcastSettings && isHost && broadcastSettings();
  renderSettingsView();
  status("lobby-status", "🎬 Runde " + match.round + "/" + match.rounds + (match.autoRoulette ? " — neue Rollen ausgewürfelt!" : "") + " Alle wieder „Bin bereit“!");
  SFX.go();
}

// ═══ ANIMIERTES FINALE — Awards-Show mit Riser, Scheinwerfer, Applaus ═══
function showFinal(list, rounds, championName) {
  show("scr-final");
  $("leave-btn").style.display = "";
  // Kinosaal/Vorhang nur hier am Podest — kurz auf, dann Reveal
  curtainsShow(true);
  requestAnimationFrame(() => { setTimeout(() => curtainsOpen(), 80); });

  // Bei Battle Royale: Champion steht unabhängig von der Punktsumme immer auf Platz 1
  let ordered = [...list];
  if (championName) {
    ordered.sort((a, b) => (a.name === championName ? -1 : b.name === championName ? 1 : 0));
  }
  const top3 = ordered.slice(0, 3);
  const also = ordered.slice(3, 5);   // 4. & 5. unter dem Podium
  const rest = ordered.slice(5);

  $("final-sub").textContent = championName
    ? "🔪 Battle Royale beendet — " + championName + " hat als Einzige(r) überlebt!"
    : rounds + " Runde" + (rounds > 1 ? "n" : "") + " gespielt — hier ist eure Gesamtwertung:";

  const stage = $("podium-stage");
  if (stage) stage.classList.remove("alive");
  const champEl = $("podium-champ");
  if (champEl) { champEl.textContent = ""; champEl.classList.remove("show"); }

  const fillSlot = (slotId, entry) => {
    const el = $(slotId);
    if (!el) return;
    if (!entry) { el.style.display = "none"; el.classList.remove("show", "pop"); return; }
    el.style.display = "";
    el.classList.remove("show", "pop");
    const p = players.find(pl => pl.id === entry.id);
    el.querySelector(".p-avatar-wrap").innerHTML = p ? avatarHTML(p) : "";
    el.querySelector(".p-name").textContent = entry.name;
    el.querySelector(".p-score").textContent = entry.sum.toFixed(1) + " ★";
  };
  fillSlot("podium-1", top3[0]);
  fillSlot("podium-2", top3[1]);
  fillSlot("podium-3", top3[2]);

  const fillAlso = (slotId, entry, rank) => {
    const el = $(slotId);
    if (!el) return;
    if (!entry) { el.style.display = "none"; el.classList.remove("show"); return; }
    el.style.display = "";
    el.classList.remove("show");
    const p = players.find(pl => pl.id === entry.id);
    el.querySelector(".p-avatar-wrap").innerHTML = p ? avatarHTML(p) : "";
    el.querySelector(".p-name").textContent = entry.name;
    el.querySelector(".p-score").textContent = entry.sum.toFixed(1) + " ★";
    const rk = el.querySelector(".also-rank");
    if (rk) rk.textContent = rank + ".";
  };
  fillAlso("podium-4", also[0], 4);
  fillAlso("podium-5", also[1], 5);

  $("final-rest").innerHTML = rest.map((r, i) => `
    <div class="finalrow">
      <span class="tag">${i + 6}.</span>
      <span class="fname">${esc(r.name)}</span>
      <span class="fscore">${r.sum.toFixed(1)} ★</span>
    </div>`).join("");

  if (isHost) $("btn-back-lobby").style.display = "";

  // 🌑 Dunkel + Riser baut Spannung auf → Scheinwerfer → 3 → 2 → 1 → Applaus → 4./5.
  const blackout = $("podium-blackout");
  blackout.className = "podium-blackout";
  void blackout.offsetWidth;
  blackout.classList.add("in");

  const spot = $("podium-spotlight");
  spot.className = "spotlight";

  const REVEAL_START = 4200;      // Enthüllung startet, während der Riser (~6.2s) noch hochzieht
  SFX.riser();

  const steps = [];
  if (top3[2]) steps.push({ id: "podium-3", settle: "settle-3", sweepMs: 900, gap: 750 });
  if (top3[1]) steps.push({ id: "podium-2", settle: "settle-2", sweepMs: 850, gap: 900 });
  if (top3[0]) steps.push({ id: "podium-1", settle: "settle-1", sweepMs: 1100, gap: 400, winner: true });

  setTimeout(() => {
    blackout.classList.remove("in");
    blackout.classList.add("out");
  }, REVEAL_START - 400);

  let t = REVEAL_START;
  steps.forEach((step, i) => {
    setTimeout(() => { spot.className = "spotlight sweeping"; }, t);
    t += step.sweepMs;
    setTimeout(() => { spot.className = "spotlight " + step.settle; }, t);
    setTimeout(() => {
      const el = $(step.id);
      if (!el) return;
      el.classList.add("show", "pop");
      if (step.winner) {
        SFX.winner();
        // Applaus-Stärke nach Abstand Platz 1 ↔ 2
        const gap = top3[1] ? Math.max(0, (top3[0].sum || 0) - (top3[1].sum || 0)) : 99;
        let vol = 0.42, holdMs = 9000, label = "knapp";
        if (!top3[1] || gap >= 2.5) { vol = 0.78; holdMs = 16000; label = "dominant"; }
        else if (gap >= 1.0) { vol = 0.6; holdMs = 12500; label = "klar"; }
        else if (gap >= 0.4) { vol = 0.5; holdMs = 10500; label = "solide"; }
        const applause = SFX.applause(vol);
        setTimeout(() => SFX.fadeStop(applause, 1800), holdMs);
        burstConfetti(true);
        setTimeout(() => burstConfetti(true), 700);
        setTimeout(() => burstConfetti(gap >= 1 ? true : false), 1400);
        if (stage) stage.classList.add("alive");
        if (champEl && top3[0]) {
          const gapTxt = top3[1] ? (label === "dominant" ? " · klare Sache!" : label === "knapp" ? " · knapper Sieg!" : "") : "";
          champEl.textContent = "👑 " + top3[0].name.toUpperCase() + " — CHAMPION" + gapTxt;
          champEl.classList.add("show");
        }
      } else {
        SFX.beep();
        burstConfetti(false);
      }
    }, t + 140);
    t += step.gap;
  });

  // 4. & 5. nach dem Sieger unter den Säulen einblenden
  const alsoAt = t + 600;
  setTimeout(() => {
    ["podium-4", "podium-5"].forEach((id, i) => {
      setTimeout(() => {
        const el = $(id);
        if (el && el.style.display !== "none") {
          el.classList.add("show");
          SFX.beep();
        }
      }, i * 350);
    });
  }, alsoAt);

  setTimeout(() => {
    spot.className = "spotlight hide";
    blackout.className = "podium-blackout";
  }, alsoAt + 1800);
}

$("btn-back-lobby").onclick = () => {
  if (!isHost) return;
  SFX.back();
  broadcast({ t: "matchLobby" });
  backToLobby();
};
function backToLobby(keepMatch) {
  document.body.classList.remove("cinema");
  const c = $("cinema-curtains"); if (c) c.classList.remove("show", "open");
  if (!keepMatch) { match.round = 1; match.totals = {}; match.buddyGivers = {}; myBuddyUsed = false; }
  players.forEach(p => { p.ready = false; p.done = 0; p.total = 0; p.prem = false; });
  mixItems = []; collected.clear(); collectedOuttakes.clear(); takes = {}; outtakes = []; outtakesCache = null;
  finalTracksData = null; premiereLocked = false; redoMode = null;
  pendingRate = false; rateSent = false; ratingDone = false; allRatings.clear(); myStars = {}; myBuddy = null;
  $("rate-card").style.display = "none"; $("rate-rows").innerHTML = ""; $("rate-result").innerHTML = "";
  $("btn-next-round").style.display = "none"; $("btn-rate-submit").disabled = true;
  $("btn-rate-submit").textContent = "Bewertung abschicken";
  updateOuttakesBtn();
  show("scr-lobby");
  $("leave-btn").style.display = "";
  if (isHost) { broadcastState(); }
  renderSettingsView();
  updateLobbyMusic();
  if (!keepMatch) status("lobby-status", "🏠 Zurück in der Lobby!");
}
function showRateResult(results, eliminatedName) {
  $("btn-rate-submit").style.display = "none";
  $("btn-rate-force").style.display = "none";
  $("rate-rows").innerHTML = "";
  const hint = $("buddy-hint"); if (hint) hint.style.display = "none";
  const rows = $("rate-result");
  rows.innerHTML = results.map((r, i) => {
    const p = players.find(pl => pl.id === r.id);
    const buddyBit = r.buddies
      ? `<span class="buddy-badge">🤝 ×${r.buddies} SynchroBuddy${r.buddies > 1 ? "s" : ""} (+${(r.buddies * BUDDY_BONUS).toFixed(0)})</span>`
      : "";
    const scoreLabel = r.avgStars != null
      ? `${r.avg.toFixed(1)} ★` + (r.buddies ? ` <span class="tag" style="color:var(--muted)">(${r.avgStars.toFixed(1)}+Buddy)</span>` : "")
      : `${r.avg.toFixed(1)} ★`;
    return `<div class="raterow resultrow ${i === 0 ? "winner" : ""}" style="opacity:0;transform:translateX(-14px)">
      ${p ? avatarHTML(p) : ""}
      <div class="rateinfo">
        <span class="ratename">${i === 0 ? "🏆 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : "• "}${esc(r.name)}</span>
        ${i === 0 ? '<span class="tag" style="color:var(--amber)">Bester Synchronsprecher!</span>' : `<span class="tag">${r.votes} Stimmen</span>`}
        ${buddyBit}
      </div>
      <span class="resultscore">${scoreLabel}</span>
    </div>`;
  }).join("") + (eliminatedName ? `<div class="raterow" style="border-color:var(--hot);opacity:0">🔪 <b>${esc(eliminatedName)}</b> ist raus aus dem Battle Royale!</div>` : "");
  [...rows.children].forEach((row, i) => {
    setTimeout(() => { row.style.transition = "opacity .4s, transform .4s"; row.style.opacity = "1"; row.style.transform = "translateX(0)"; }, i * 150);
  });
  SFX.done();
  updateOuttakesBtn();
}

function outtakesCacheReady() {
  return !!(outtakesCache && outtakesCache.blob && outtakesCache.blob.size > 1000);
}
function updateOuttakesBtn() {
  const bar = $("outtakes-bar");
  const otBtn = $("btn-outtakes");
  const dlBtn = $("btn-outtakes-dl");
  const hint = $("outtakes-bar-hint");
  const ovDl = $("btn-outtakes-dl-overlay");
  if (!outtakes.length) {
    if (bar) bar.classList.remove("show");
    if (ovDl) ovDl.style.display = "none";
    return;
  }
  if (bar) bar.classList.add("show");
  if (otBtn) otBtn.textContent = "🎬 Outtakes anschauen (" + outtakes.length + ")";
  if (dlBtn) {
    if (outtakesCacheReady()) {
      dlBtn.textContent = "⬇ Sofort speichern (fertig!)";
    } else if (outtakesCachePending || (outtakesPlaying && outtakesQuietJob)) {
      dlBtn.textContent = "⬇ Speichern (schneidet noch …)";
    } else {
      dlBtn.textContent = "⬇ Outtakes speichern (" + outtakes.length + ")";
    }
  }
  if (hint) {
    hint.textContent = outtakesCacheReady()
      ? outtakes.length + " Bloopers · Sofort speichern bereit"
      : (outtakesCachePending || outtakesQuietJob)
        ? outtakes.length + " Bloopers · wird im Hintergrund geschnitten …"
        : outtakes.length + " Bloopers · Speichern schneidet kurz im Hintergrund";
  }
  if (ovDl) {
    ovDl.style.display = "";
    ovDl.textContent = outtakesCacheReady() ? "⬇ Sofort speichern" : "⬇ Reel speichern";
  }
}

// ── Outtakes-Reel: anschauen + Hintergrund-Schnitt für Sofort-Speichern ──
let outtakeAbort = false;
let outtakesPlaying = false;
let outtakesQuietJob = false;     // true = stiller Hintergrund-Schnitt (kein Overlay)
let outtakesCache = null;         // { blob, endung }
let outtakesCachePending = null;  // Promise → cache, während Hintergrund läuft
let outtakesCacheResolve = null;
let outtakesPrecacheTimer = null;

function resolveOuttakesCachePending(val) {
  if (outtakesCacheResolve) {
    const r = outtakesCacheResolve;
    outtakesCacheResolve = null;
    outtakesCachePending = null;
    try { r(val); } catch {}
  } else {
    outtakesCachePending = null;
  }
}

function scheduleOuttakesPrecache() {
  clearTimeout(outtakesPrecacheTimer);
  if (!outtakes.length || outtakesCacheReady()) return;
  outtakesPrecacheTimer = setTimeout(() => {
    if (!outtakes.length || outtakesCacheReady() || outtakesPlaying || outtakesCachePending) return;
    // Stiller Schnitt im Hintergrund — Speichern danach sofort
    playOuttakesReel({ quiet: true }).catch(e => console.warn("Outtakes-Precache:", e));
  }, 800);
}

async function playOuttakesReel(opts) {
  const saveFile = !!(opts && opts.save);
  const quiet = !!(opts && opts.quiet);   // Hintergrund: kein Overlay, kein Lautsprecher
  // Sichtbares Anschauen unterbricht stillen Precache
  if (outtakesPlaying) {
    if (quiet) return;
    if (outtakesQuietJob) {
      outtakeAbort = true;
      const t0 = performance.now();
      while (outtakesPlaying && performance.now() - t0 < 8000) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (outtakesPlaying) return;
    } else return;
  }
  if (!outtakes.length) return;

  // Sofort sperren (vor jedem await)
  outtakesPlaying = true;
  outtakesQuietJob = quiet;
  outtakeAbort = false;
  outtakes = dedupeOuttakes(outtakes);
  const reel = outtakes.slice();
  const ov = $("outtakes-overlay");
  const v = $("outtakes-video");
  const lab = $("outtakes-label");
  const lineEl = $("outtakes-line");
  const recStat = $("outtakes-rec-status");
  if (!ov || !v) {
    outtakesPlaying = false; outtakesQuietJob = false;
    resolveOuttakesCachePending(null);
    return;
  }

  const auchCachen = quiet || saveFile || !outtakesCacheReady();
  if (auchCachen) {
    outtakesCache = null;
    if (!outtakesCachePending) {
      outtakesCachePending = new Promise(res => { outtakesCacheResolve = res; });
    }
  }

  if (!quiet) ov.classList.add("show");
  if (recStat) {
    if (quiet) {
      recStat.style.display = "none";
    } else if (saveFile || auchCachen) {
      recStat.style.display = "";
      recStat.textContent = saveFile ? "🔴 Nimmt Outtakes auf (Bild+Ton) …" : "💾 Schneidet mit — Speichern danach sofort";
      recStat.style.color = saveFile ? "var(--hot)" : "var(--amber)";
    } else recStat.style.display = "none";
  }
  if (quiet) status("play-status", "🎬 Outtakes werden im Hintergrund geschnitten — Speichern gleich sofort …");
  updateOuttakesBtn();

  v.src = sceneVideoSrc() || "";
  try { await waitCanPlay(v, 8000); } catch {}
  const ctx = getCtx();
  if (ctx.state === "suspended") try { await ctx.resume(); } catch {}

  let vidGain = null;
  try {
    vidGain = ctx.createGain();
    vidGain.gain.value = 0.35;
    elementSource(ctx, v).connect(vidGain);
    if (!quiet) vidGain.connect(ctx.destination);
  } catch (e) { console.warn("Outtakes video-audio:", e); }
  v.volume = 0;
  v.muted = true;

  let fileRec = null, frames = null, recDest = null, chunks = [];
  const mime = outtakesMime();
  const endung = mime.startsWith("video/mp4") ? "mp4" : "webm";
  if (auchCachen) {
    try {
      recDest = ctx.createMediaStreamDestination();
      if (vidGain) vidGain.connect(recDest);
      frames = frameSource(v, { alwaysRaf: true });
      await new Promise(r => {
        const t0 = performance.now();
        const iv = setInterval(() => {
          if (frames) try { frames.paint(); } catch {}
          if ((v.videoWidth > 0 && frames && frames.count() >= 4) || performance.now() - t0 > 2500) {
            clearInterval(iv); r();
          }
        }, 32);
      });
      const vTrack = frames.stream.getVideoTracks()[0];
      if (vTrack) try { vTrack.enabled = true; } catch {}
      const stream = new MediaStream([
        ...frames.stream.getVideoTracks(),
        ...recDest.stream.getAudioTracks()
      ]);
      fileRec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_500_000 });
      fileRec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      fileRec.start(200);
      holdPremWakeLock();
    } catch (e) {
      console.warn("Outtakes-Recorder startet nicht:", e);
      fileRec = null;
      if (!quiet && recStat && saveFile) {
        recStat.style.display = "";
        recStat.textContent = "⚠ Aufnehmen nicht möglich — nur Anschauen";
        recStat.style.color = "var(--hot)";
      }
    }
  }

  for (let i = 0; i < reel.length; i++) {
    if (outtakeAbort) break;
    const ot = reel[i];
    const who = ot.name ? (" · " + ot.name) : "";
    if (!quiet) {
      if (lab) lab.textContent = "OUTTAKE " + (i + 1) + "/" + reel.length + who;
      if (lineEl) lineEl.textContent = "„" + ot.text + "“";
    }
    let src = null;
    try {
      v.pause();
      v.currentTime = Math.max(0, ot.t - 0.15);
      await new Promise(r => { const h = () => { v.removeEventListener("seeked", h); r(); }; v.addEventListener("seeked", h); setTimeout(r, 600); });
      if (frames) try { frames.paint(); } catch {}
      const buf = await ctx.decodeAudioData(await toArrayBuffer(ot.buf.slice ? ot.buf.slice(0) : ot.buf));
      src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain(); g.gain.value = 1.1;
      src.connect(g);
      if (!quiet) g.connect(ctx.destination);
      if (recDest) g.connect(recDest);
      await v.play().catch(() => {});
      if (frames) try { frames.paint(); } catch {}
      src.start();
      const dur = Math.min(buf.duration, Math.max(0.8, (ot.end - ot.t) + 0.4));
      await new Promise(r => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(t); r(); };
        const t = setTimeout(finish, dur * 1000);
        const skip = () => { try { src.stop(); } catch {} finish(); };
        const btn = $("btn-outtakes-skip");
        if (btn && !quiet) btn.onclick = skip;
        src.onended = finish;
      });
    } catch (e) { console.warn("Outtake skip:", e); }
    try { if (src) src.stop(); } catch {}
    v.pause();
    if (frames) try { frames.paint(); } catch {}
  }

  if (fileRec && fileRec.state !== "inactive") {
    await new Promise(r => { fileRec.onstop = r; try { fileRec.stop(); } catch { r(); } });
  }
  if (frames) frames.stop();
  if (recDest && vidGain) try { vidGain.disconnect(recDest); } catch {}
  releasePremWakeLock();

  let cacheOk = null;
  if (fileRec && chunks.length && !outtakeAbort) {
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    if (blob.size > 1000) {
      outtakesCache = { blob, endung };
      cacheOk = outtakesCache;
      if (saveFile) {
        const name = (scene?.id || "synchro") + "_outtakes." + endung;
        const wie = await saveBlob(blob, name);
        if (wie === "abort") status("play-status", "Outtakes-Speichern abgebrochen.");
        else {
          status("play-status", "✅ Outtakes gespeichert!");
          SFX.done();
        }
      } else if (quiet) {
        status("play-status", "✅ Outtakes fertiggeschnitten — Sofort speichern bereit!");
      } else {
        status("play-status", "✅ Outtakes durch — Speichern ist jetzt sofort bereit!");
      }
    } else if (saveFile) {
      status("play-status", "⚠ Outtakes-Mitschnitt war leer — Fenster im Vordergrund lassen und nochmal versuchen.", true);
    }
  } else if (outtakeAbort && quiet) {
    // abgebrochen zugunsten sichtbarem Anschauen — ok
  }

  if (auchCachen) resolveOuttakesCachePending(cacheOk);

  if (recStat) { recStat.style.display = "none"; recStat.style.color = ""; }
  if (!quiet) ov.classList.remove("show");
  v.pause();
  outtakesPlaying = false;
  outtakesQuietJob = false;
  updateOuttakesBtn();
  if (!saveFile && !quiet) SFX.ok();
}

async function downloadOuttakes() {
  if (!outtakes.length) return;
  // Schon fertig vom Hintergrund-Schnitt?
  if (outtakesCacheReady()) {
    const name = (scene?.id || "synchro") + "_outtakes." + outtakesCache.endung;
    const wie = await saveBlob(outtakesCache.blob, name);
    if (wie === "abort") return status("play-status", "Outtakes-Speichern abgebrochen.");
    status("play-status", "✅ Outtakes sofort gespeichert!");
    SFX.done();
    return;
  }
  // Hintergrund läuft noch → warten, dann speichern (kein zweites Abspielen)
  if (outtakesCachePending) {
    status("play-status", "⏳ Outtakes werden noch fertiggeschnitten — einen Moment …");
    updateOuttakesBtn();
    try {
      const c = await outtakesCachePending;
      if (c && c.blob && c.blob.size > 1000) {
        const name = (scene?.id || "synchro") + "_outtakes." + c.endung;
        const wie = await saveBlob(c.blob, name);
        if (wie === "abort") return status("play-status", "Outtakes-Speichern abgebrochen.");
        status("play-status", "✅ Outtakes gespeichert!");
        SFX.done();
        updateOuttakesBtn();
        return;
      }
    } catch {}
  }
  if (outtakesPlaying && !outtakesQuietJob) {
    status("play-status", "Outtakes laufen noch — danach ist Speichern sofort bereit.", true);
    return;
  }
  // Noch kein Cache → still im Hintergrund schneiden und direkt speichern
  status("play-status", "🎬 Schneide Outtakes im Hintergrund — Fenster offen lassen …");
  await playOuttakesReel({ quiet: true, save: true });
}
$("btn-outtakes") && ($("btn-outtakes").onclick = () => {
  SFX.click();
  // Host startet für alle — Gäste dürfen lokal trotzdem nachstarten, falls sie verpasst haben
  if (isHost) broadcast({ t: "playOuttakes" });
  playOuttakesReel();
});
$("btn-outtakes-dl") && ($("btn-outtakes-dl").onclick = () => { SFX.click(); downloadOuttakes(); });
$("btn-outtakes-dl-overlay") && ($("btn-outtakes-dl-overlay").onclick = () => { SFX.click(); downloadOuttakes(); });
$("btn-outtakes-close") && ($("btn-outtakes-close").onclick = () => {
  outtakeAbort = true;
  $("outtakes-overlay").classList.remove("show");
  const v = $("outtakes-video"); if (v) v.pause();
});

// Timer / Wipe / Cue-Einstellungen merken
(() => {
  const t = $("rec-timer"), w = $("rec-wipe"), c = $("rec-cue-orig"), cv = $("rec-cue-vol"), cvl = $("rec-cue-vol-val");
  try {
    if (t && localStorage.getItem("ss_rec_timer") != null) t.checked = localStorage.getItem("ss_rec_timer") === "1";
    if (w && localStorage.getItem("ss_rec_wipe") === "1") w.checked = true;
    if (c && localStorage.getItem("ss_rec_cue") === "1") c.checked = true;
    if (cv && localStorage.getItem("ss_rec_cue_vol") != null) {
      cv.value = localStorage.getItem("ss_rec_cue_vol");
      if (cvl) cvl.textContent = Math.round(parseFloat(cv.value) * 100) + "%";
    }
  } catch {}
  if (t) t.onchange = () => { try { localStorage.setItem("ss_rec_timer", t.checked ? "1" : "0"); } catch {} };
  if (w) w.onchange = () => { try { localStorage.setItem("ss_rec_wipe", w.checked ? "1" : "0"); } catch {} };
  if (c) c.onchange = () => { try { localStorage.setItem("ss_rec_cue", c.checked ? "1" : "0"); } catch {} };
  if (cv) cv.oninput = () => {
    const v = parseFloat(cv.value);
    if (cvl) cvl.textContent = Math.round(v * 100) + "%";
    if (recCueGain) try { recCueGain.gain.value = v; } catch {}
    try { localStorage.setItem("ss_rec_cue_vol", String(v)); } catch {}
  };
})();


// ═════════════════════════════════════════════════════════════
// WARTE-ARENA 3+4: Reaktions-Duell & Tipp-Renner
// ═════════════════════════════════════════════════════════════
// — Reaktion —
let rxWaiting = false, rxGreenAt = 0, rxDone = false;
const rxScores = new Map(), tpScores = new Map();

$("btn-rx-start").onclick = () => {
  const delay = 1500 + Math.random() * 3500;
  if (isHost) { broadcast({ t: "rxGo", delay }); rxRun(delay); }
  else sendHost({ t: "mg", k: "rxStart" });
};
function rxRun(delay) {
  rxWaiting = true; rxDone = false;
  $("rx-pad").style.display = ""; $("btn-rx-start").style.display = "none";
  $("rx-result").innerHTML = "";
  const pad = $("rx-pad");
  pad.style.background = "#5c1a1e"; pad.textContent = "WARTE AUF GRÜN …";
  rxGreenAt = 0;
  setTimeout(() => {
    if (!rxWaiting) return;
    rxGreenAt = performance.now();
    pad.style.background = "#1a5c34"; pad.textContent = "JETZT! KLICK!";
    if (onWaitScreen()) SFX.go();
  }, delay);
}
$("rx-pad") && ($("rx-pad").onclick = () => {
  if (!rxWaiting || rxDone) return;
  rxDone = true; rxWaiting = false;
  let ms;
  if (!rxGreenAt) { ms = 9999; $("rx-pad").textContent = "ZU FRÜH! 😅"; SFX.err(); }
  else { ms = Math.round(performance.now() - rxGreenAt); $("rx-pad").textContent = ms + " ms!"; SFX.ok(); }
  setTimeout(() => { $("rx-pad").style.display = "none"; $("btn-rx-start").style.display = ""; }, 1200);
  if (isHost) mgScore("rx", myId, ms); else sendHost({ t: "mg", k: "rxScore", ms });
});

// — Tipp-Renner (eigene, kurze Phrasen) —
const TP_PHRASES = ["synchronstudio läuft heiß", "wer klickt der spricht", "mikro an hirn aus", "premiere in drei zwei eins", "der take sitzt beim ersten mal", "kopfhörer auf und los", "gate offen stimme raus", "voll auf die lippen getimet"];
let tpPhrase = "", tpStartT = 0, tpDone = false;
$("btn-tp-start").onclick = () => {
  const phrase = TP_PHRASES[Math.floor(Math.random() * TP_PHRASES.length)];
  if (isHost) { broadcast({ t: "tpGo", phrase }); tpRun(phrase); }
  else sendHost({ t: "mg", k: "tpStart" });
};
function tpRun(phrase) {
  tpPhrase = phrase; tpDone = false; tpStartT = performance.now();
  $("tp-area").style.display = ""; $("btn-tp-start").style.display = "none";
  $("tp-result").innerHTML = "";
  $("tp-phrase").textContent = "„" + phrase + "“";
  const inp = $("tp-input");
  inp.value = ""; inp.disabled = false; inp.focus();
  inp.oninput = () => {
    if (tpDone) return;
    if (inp.value.trim().toLowerCase() === tpPhrase) {
      tpDone = true; inp.disabled = true;
      const ms = Math.round(performance.now() - tpStartT);
      $("tp-phrase").textContent = "✅ " + (ms / 1000).toFixed(2) + "s!";
      SFX.ok();
      setTimeout(() => { $("tp-area").style.display = "none"; $("btn-tp-start").style.display = ""; }, 1200);
      if (isHost) mgScore("tp", myId, ms); else sendHost({ t: "mg", k: "tpScore", ms });
    }
  };
}

// — Auswertung (Host sammelt, kleinste Zeit gewinnt) —
function mgScore(game, pid, ms) {
  const map = game === "rx" ? rxScores : tpScores;
  map.set(pid, ms);
  clearTimeout(mgScore["_t" + game]);
  mgScore["_t" + game] = setTimeout(() => {
    const list = [...map.entries()].sort((a, b) => a[1] - b[1]);
    broadcast({ t: "mgResult", game, list });
    mgShowResult(game, list);
    if (list.length && list[0][1] < 9999) addWin(list[0][0]);
    map.clear();
  }, game === "rx" ? 4000 : 15000);
}
function mgShowResult(game, list) {
  const el = $(game === "rx" ? "rx-result" : "tp-result");
  el.innerHTML = list.map(([pid, ms], i) =>
    `<div>${i === 0 ? "🏆" : i === 1 ? "🥈" : i === 2 ? "🥉" : "•"} <b>${esc(nameOf(pid))}</b> — ${ms >= 9999 ? "zu früh 😅" : game === "rx" ? ms + " ms" : (ms / 1000).toFixed(2) + "s"}</div>`).join("");
  if (onWaitScreen()) SFX.done();
}

// ═════════════════════════════════════════════════════════════
// 8) HOST: Spuren einsammeln → Mix an alle
// ═════════════════════════════════════════════════════════════
const collected = new Map();   // role → items

// ── Redo starten: springt für GENAU eine Line zurück in die Booth-Aufnahme ──
function redoLine(lineIdx, fromScreen) {
  if (premiereLocked) return;
  const idxInMyLines = myLines.findIndex(l => l.idx === lineIdx);
  if (idxInMyLines < 0) return;
  redoMode = lineIdx;
  redoReturnScreen = fromScreen;
  curLine = idxInMyLines;
  const bv = $("booth-video");
  bv.src = sceneVideoSrc();
  const rid = myRole();
  const av = scene.avatars?.[String(rid)];
  $("booth-avatar").style.display = av ? "" : "none";
  if (av) $("booth-avatar").src = assetUrl(av);
  $("booth-rolename").textContent = roleOf(rid).name + " (Korrektur)";
  setBar("booth-bar", 30);
  waitCanPlay(bv).then(() => { setBar("booth-bar", 100); $("btn-line-rec").disabled = false; });
  show("scr-booth");
  $("onair").classList.add("live");
  startVizOn("viz");
  renderLine();
}

// ── Redo abschließen: aktualisierten Take an den Host schicken, zurück zur Warte-/Premiere-Ansicht ──
function finishRedo() {
  const l = myLines[curLine];
  const buf = takes[l.idx];
  const startAt = l.t;
  const lineIdx = l.idx;
  const effect = myEffectOverrides[l.idx] || undefined;
  const gate = micSettings.gate;
  const boost = myLineGains[l.idx];
  const fxAmount = myEffectAmounts[l.idx];
  const pan = myLinePans[l.idx];
  redoMode = null;
  cancelAnimationFrame(vizRAF);
  $("onair").classList.remove("live");
  const back = redoReturnScreen || "scr-wait";
  show(back);
  if (buf && buf !== "SKIP") {
    if (isHost) applyTrackUpdate(myRole(), lineIdx, startAt, buf, effect, gate, boost, fxAmount, pan);
    else sendHost({
      t: "trackUpdate", role: myRole(), lineIdx, startAt, buf,
      effect, gate, boost, fxAmount, pan,
      // Meta ohne Audio-Buffer — PeerJS streicht Nebenfelder neben buf manchmal
      trackMeta: { effect, gate, boost, fxAmount, pan },
    });
  }
  status(back === "scr-playback" ? "play-status" : "wait-status", "✅ Line aktualisiert! Wird im Endergebnis berücksichtigt.");
  renderRedoPanel("redo-panel-wait");
  renderRedoPanel("redo-panel-prem");
  SFX.done();
}

// ── Panel mit den eigenen Lines + "Neu aufnehmen"-Button je Line ──
function renderRedoPanel(containerId) {
  const el = $(containerId);
  if (!el) return;
  if (premiereLocked || !scene || !scene.lines) { el.innerHTML = ""; return; }
  const rid = myRole();
  if (rid == null) { el.innerHTML = ""; return; }   // Zuschauer haben nichts zu korrigieren
  const mine = scene.lines.map((l, i) => ({ ...l, idx: i })).filter(l => l.chars.includes(rid));
  if (!mine.length) { el.innerHTML = ""; return; }
  const fromScreen = containerId === "redo-panel-wait" ? "scr-wait" : "scr-playback";
  el.innerHTML = `<div class="tag" style="margin:10px 0 6px">🔁 Eine deiner Lines noch nicht zufrieden?</div>` +
    mine.map(l => `<div class="row" style="justify-content:space-between;background:#14141b;border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-bottom:6px;gap:10px">
      <span style="font-size:.85rem;flex:1">${esc(l.text.slice(0, 55))}${l.text.length > 55 ? "…" : ""}</span>
      <button class="ghost redo-btn" data-idx="${l.idx}" style="padding:5px 12px;font-size:.8rem;white-space:nowrap">🔁 Neu aufnehmen</button>
    </div>`).join("");
  el.querySelectorAll(".redo-btn").forEach(b => b.onclick = () => redoLine(parseInt(b.dataset.idx), fromScreen));
}

// ── Host: patcht einen einzelnen Take in den bestehenden Mix und verteilt neu ──
async function applyTrackUpdate(role, lineIdx, startAt, rawBuf, effect, gate, boost, fxAmount, pan) {
  if (!finalTracksData) return;
  try {
    const ctx = getCtx();
    const ab = await toArrayBuffer(rawBuf);
    const entry = { startAt, idx: lineIdx, buf: ab, effect, gate, boost, fxAmount, pan };
    finalTracksData = finalTracksData.map(track => {
      if (track.role !== role) return track;
      const items = track.items.filter(it => it.idx !== lineIdx);
      items.push(entry);
      return { role, items };
    });
    if (!finalTracksData.some(t => t.role === role)) finalTracksData.push({ role, items: [entry] });
    publishMix(finalTracksData);
  } catch (e) { console.error("Track-Update fehlgeschlagen:", e); }
}


// ── Duell: beide Einreichungen sammeln, dann zwei komplette Mixe bauen ──
function collectDuelSubmit(playerId, items) {
  duelSubs[playerId] = items;
  if (duelSubs[duelInfo.aId] && duelSubs[duelInfo.bId]) assembleDuelMixes();
}
function assembleDuelMixes() {
  if (!isHost) return;
  const dataA = [{ role: duelInfo.roleId, items: duelSubs[duelInfo.aId] }];
  const dataB = [{ role: duelInfo.roleId, items: duelSubs[duelInfo.bId] }];
  broadcast({
    t: "duelReady", dataA, dataB, duelInfo,
    metaA: metaMapsFromTracks(dataA),
    metaB: metaMapsFromTracks(dataB),
  });
  loadDuelSequence(dataA, dataB, duelInfo);
}

// ── Beide Versionen nacheinander abspielen, dann Abstimm-Screen zeigen ──
async function decodeDuelData(data) {
  const ctx = getCtx();
  const items = [];
  for (const track of data) {
    for (const item of track.items) {
      try {
        const ab = await toArrayBuffer(item.buf);
        items.push({ role: track.role, startAt: item.startAt, lineIdx: item.idx, buffer: processTakeBuffer(ctx, await ctx.decodeAudioData(ab), item.gate, item.effect || (roleOf(track.role) || {}).effect, item.fxAmount), effect: item.effect, fxAmount: item.fxAmount, boost: item.boost, pan: item.pan });
      } catch (e) { console.warn("Duell-Spur kaputt:", e); }
    }
  }
  // Alle anderen Rollen (nicht die Duell-Rolle) sprechen original, falls vorhanden
  if (scene && scene.lines) {
    const coveredIdx = new Set(items.map(i => i.lineIdx));
    for (let i = 0; i < scene.lines.length; i++) {
      const l = scene.lines[i];
      if (!lineHasOrig(l) || coveredIdx.has(i)) continue;
      try {
        const buffer = await getLineOrigBuffer(l);
        if (buffer) {
          items.push({
            role: null, startAt: l.t, lineIdx: i, buffer,
            isOrig: true, origRoles: Array.isArray(l.chars) ? l.chars.slice() : []
          });
        }
      } catch {}
    }
  }
  return items;
}

async function loadDuelSequence(dataA, dataB, info) {
  duelInfo = info;
  show("scr-playback");
  $("btn-replay").style.display = "none"; $("btn-download-audio").style.display = "none";
  $("btn-download").style.display = "none"; $("btn-again").style.display = "none"; $("btn-back").style.display = "none";
  const otDuel = $("btn-outtakes"); if (otDuel) otDuel.style.display = "none";
  $("prem-status").textContent = "";   // veraltete "X/Y geladen"-Anzeige vom normalen Modus ausblenden, gilt hier nicht
  $("btn-prem-start").style.display = "none";
  status("play-status", "🥊 Bereite beide Versionen vor …");

  const itemsA = await decodeDuelData(dataA);
  const itemsB = await decodeDuelData(dataB);

  const pv = $("play-video");
  pv.src = sceneVideoSrc();
  attachPrompter(pv, $("play-prompter"), null);
  await waitCanPlay(pv, 25000);

  const playOnce = (items, label) => new Promise(resolve => {
    status("play-status", "🥊 " + label);
    mixItems = items;
    pv.addEventListener("ended", resolve, { once: true });
    playMix(false);
  });

  const runSequence = async () => {
    $("btn-duel-play-start").style.display = "none";
    await playOnce(itemsA, "Take 1: " + nameOf(duelInfo.aId));
    for (let s = 3; s >= 1; s--) { status("play-status", "⏳ Take 2 in " + s + " …"); await new Promise(r => setTimeout(r, 1000)); }
    await playOnce(itemsB, "Take 2: " + nameOf(duelInfo.bId));
    showDuelVote();
  };

  if (isHost) {
    status("play-status", "✅ Beide Versionen bereit — du entscheidest, wann's losgeht!");
    $("btn-duel-play-start").style.display = "";
    $("btn-duel-play-start").onclick = () => { broadcast({ t: "duelPlayGo" }); runSequence(); };
  } else {
    status("play-status", "✅ Bereit — warte, bis der Host startet …");
    window.__duelRunSequence = runSequence;   // Gast wartet auf die "duelPlayGo"-Nachricht vom Host
  }
}

// ── Abstimm-Screen: alle außer den beiden Duellanten stimmen ab ──
function showDuelVote() {
  show("scr-duel-vote");
  $("leave-btn").style.display = "";
  const pA = players.find(p => p.id === duelInfo.aId), pB = players.find(p => p.id === duelInfo.bId);
  $("btn-vote-a").innerHTML = (pA ? avatarHTML(pA) : "") + `<b>${esc(nameOf(duelInfo.aId))}</b><span class="tag">Take 1</span>`;
  $("btn-vote-b").innerHTML = (pB ? avatarHTML(pB) : "") + `<b>${esc(nameOf(duelInfo.bId))}</b><span class="tag">Take 2</span>`;
  $("duel-result").innerHTML = "";
  $("btn-duel-back").style.display = "none";
  const amDuelist = myId === duelInfo.aId || myId === duelInfo.bId;
  const soloDuel = duelNeutralIds().length === 0;   // nur die beiden Duellanten im Raum
  $("btn-vote-a").disabled = amDuelist && !soloDuel;
  $("btn-vote-b").disabled = amDuelist && !soloDuel;
  status("duel-vote-status", soloDuel
    ? "Ihr seid nur zu zweit — also stimmt ihr selbst ab. Seid ehrlich 😄"
    : amDuelist ? "Als Duellant darfst du nicht über dich selbst abstimmen 😄" : "Klick auf die Version, die dir besser gefallen hat!");
}
// Wer darf abstimmen? Normalerweise alle außer den Duellanten. Sind aber NUR die beiden
// Duellanten im Raum, dürfen sie selbst ran — sonst könnte niemand abstimmen und der
// Abstimm-Screen würde für immer stehen bleiben.
function duelNeutralIds() {
  return players.filter(p => p.id !== duelInfo.aId && p.id !== duelInfo.bId).map(p => p.id);
}
function duelVoterIds() {
  const neutral = duelNeutralIds();
  return neutral.length ? neutral : players.filter(p => p.id === duelInfo.aId || p.id === duelInfo.bId).map(p => p.id);
}
$("btn-vote-a").onclick = () => castDuelVote("a");
$("btn-vote-b").onclick = () => castDuelVote("b");
function castDuelVote(choice) {
  if (!duelVoterIds().includes(myId)) return;
  $("btn-vote-a").disabled = true; $("btn-vote-b").disabled = true;
  status("duel-vote-status", "✅ Stimme abgegeben — warte auf die anderen …");
  SFX.click();
  if (isHost) collectDuelVote(myId, choice);
  else sendHost({ t: "duelVote", choice });
}
function collectDuelVote(voterId, choice) {
  duelVotes[voterId] = choice;
  maybeFinishDuelVote();
}
function maybeFinishDuelVote() {
  if (!isHost || !duelInfo) return;
  const tally = { a: Object.values(duelVotes).filter(v => v === "a").length, b: Object.values(duelVotes).filter(v => v === "b").length };
  broadcast({ t: "duelVoteBroadcast", tally });
  showDuelVoteLive(tally);
  const voters = duelVoterIds();
  // Nur noch Stimmen von Leuten zählen, die auch wirklich noch im Raum sind
  const abgegeben = Object.keys(duelVotes).filter(id => voters.includes(id)).length;
  if (voters.length && abgegeben >= voters.length) finishDuelVote(tally);
}
function showDuelVoteLive(tally) {
  $("duel-vote-sub").textContent = "Stimmen bisher: " + nameOf(duelInfo.aId) + " " + tally.a + " : " + tally.b + " " + nameOf(duelInfo.bId);
}
function finishDuelVote(tally) {
  if (!isHost) return;
  let winner = tally.a > tally.b ? "a" : tally.b > tally.a ? "b" : "tie";
  const result = { tally, winner, aName: nameOf(duelInfo.aId), bName: nameOf(duelInfo.bId) };
  broadcast({ t: "duelResult", result });
  showDuelResult(result);
  addWin(winner === "a" ? duelInfo.aId : winner === "b" ? duelInfo.bId : null);
}
function showDuelResult(result) {
  $("btn-vote-a").disabled = true; $("btn-vote-b").disabled = true;
  const { tally, winner, aName, bName } = result;
  $("duel-result").innerHTML = winner === "tie"
    ? `<div class="raterow">🤝 Unentschieden! ${tally.a} : ${tally.b}</div>`
    : `<div class="raterow winner" style="border-color:var(--amber);box-shadow:0 0 16px rgba(255,201,92,.3)">🏆 <b>${esc(winner === "a" ? aName : bName)}</b> gewinnt das Duell! (${tally.a} : ${tally.b})</div>`;
  status("duel-vote-status", "");
  if (isHost) $("btn-duel-back").style.display = "";
  SFX.done();
  if (winner !== "tie") burstConfetti();
}
$("btn-duel-back").onclick = () => {
  if (!isHost) return;
  duelInfo = null; duelStagedScene = null;
  Object.keys(duelSubs).forEach(k => delete duelSubs[k]);
  Object.keys(duelVotes).forEach(k => delete duelVotes[k]);
  broadcast({ t: "again" });
  backToLobby();
};

function collectTracks(role, items, ots, fromId) {
  if (role != null) collected.set(role, items);
  if (ots && ots.length && fromId != null) collectedOuttakes.set(fromId, ots);
  maybeFinishTracks();
}
function publishOuttakesPool() {
  const pool = [];
  for (const [, list] of collectedOuttakes) {
    for (const o of list) pool.push(o);
  }
  // Doppelte derselben Line/Person raus (mehrfaches Neuaufnehmen)
  const unique = dedupeOuttakes(pool);
  // Mischen, damit nicht immer derselbe Spieler zuerst kommt
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = unique[i]; unique[i] = unique[j]; unique[j] = tmp;
  }
  outtakes = unique.slice(0, OUTTAKE_POOL_MAX);
  collectedOuttakes.clear();
  outtakesCache = null;
  resolveOuttakesCachePending(null);
  updateOuttakesBtn();
  broadcast({ t: "outtakesPool", items: outtakes });
  scheduleOuttakesPrecache();
}
// Getrennt aufrufbar, damit auch ein Verbindungsabbruch die Premiere auslösen kann:
// wer weg ist, wird nicht mehr gebraucht — sonst wartet die Runde endlos auf seine Spur.
let forceMixTimer = null;
function maybeFinishTracks(force) {
  if (!isHost || !collected.size) return;
  // Offline-Plätze nicht mitzählen — sonst wartet die Premiere ewig auf Rausgeflogene
  const neededRoles = new Set(players.filter(p => p.role != null && !p.offline).map(p => p.role));
  if (!force && collected.size < neededRoles.size) {
    clearTimeout(forceMixTimer);
    forceMixTimer = setTimeout(syncForceMixBtn, 45000);   // Notausgang erst anbieten, wenn es wirklich hängt
    return;
  }
  clearTimeout(forceMixTimer);
  const data = [...collected.entries()].map(([r, it]) => ({ role: r, items: it }));
  publishOuttakesPool();
  publishMix(data);   // Boost/Pan extra mitschicken — sonst hoeren Gäste wieder 100 %
  collected.clear();
  syncForceMixBtn();
}
// Notausgang für den Host, falls jemand hängt, ohne die Verbindung sauber zu schließen
function syncForceMixBtn() {
  const btn = $("btn-force-mix");
  if (!btn) return;
  const needed = new Set(players.filter(p => p.role != null && !p.offline).map(p => p.role)).size;
  const waiting = isHost && collected.size > 0 &&
    collected.size < needed &&
    !!document.querySelector("#scr-wait.active");
  btn.style.display = waiting ? "" : "none";
}
$("btn-force-mix") && ($("btn-force-mix").onclick = () => {
  if (!isHost) return;
  $("btn-force-mix").style.display = "none";
  status("wait-status", "🎬 Starte die Premiere mit den vorhandenen Spuren …");
  maybeFinishTracks(true);
});
function checkAllDone() { /* Fortschritt läuft über state-Broadcasts */ }

// ═════════════════════════════════════════════════════════════
// 9) PREMIERE — Web-Audio-Engine + Download
// ═════════════════════════════════════════════════════════════

// P2P-empfangene Binärdaten kommen je nach Browser als ArrayBuffer, TypedArray
// oder Blob an — decodeAudioData will exakt einen ArrayBuffer. Normalisieren:
async function toArrayBuffer(x) {
  if (x instanceof ArrayBuffer) return x.slice(0);
  if (ArrayBuffer.isView(x)) return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
  if (x instanceof Blob) return await x.arrayBuffer();
  throw new Error("Unbekanntes Binärformat: " + Object.prototype.toString.call(x));
}

async function loadMix(data, metaMsg) {
  if (!scene) {
    status("play-status", "⚠ Szene fehlt noch — kurz warten oder Seite neu laden.", true);
    return;
  }
  // PeerJS streicht Boost/Pan oft neben den Audio-Buffern — Maps / eigene Booth-Werte nachziehen
  if (metaMsg) attachMetaToTracks(data, metaMsg);
  applyLocalLineMeta(data);
  show("scr-playback");
  status("play-status", "Dekodiere Spuren …");
  invalidatePremCache();
  const ctx = getCtx();
  mixItems = [];
  let okCount = 0, failCount = 0;
  for (const track of data) {
    for (const item of track.items) {
      try {
        const ab = await toArrayBuffer(item.buf);
        mixItems.push({ role: track.role, startAt: item.startAt, lineIdx: item.idx, buffer: processTakeBuffer(ctx, await ctx.decodeAudioData(ab), item.gate, item.effect || (roleOf(track.role) || {}).effect, item.fxAmount), effect: item.effect, fxAmount: item.fxAmount, boost: item.boost, pan: item.pan });
        okCount++;
      } catch (e) { failCount++; console.warn("Spur kaputt:", track.role, e); }
    }
  }
  console.log("Mix geladen:", okCount, "Spuren ok,", failCount, "fehlgeschlagen");
  if (failCount) status("play-status", "⚠ " + failCount + " Spur(en) konnten nicht geladen werden — F12 → Console.", true);
  setBar("prem-bar", 70);
  // Original-Stimmen für alle Lines, die KEIN Spieler eingesprochen hat
  // (unbesetzte Rollen + übersprungene Lines)
  if (scene.lines) {
    const hasIdx = data.some(t => t.items.some(i => i.idx != null));
    const coveredIdx = new Set();
    const playedRoles = new Set(data.map(t => t.role));
    data.forEach(t => t.items.forEach(i => { if (i.idx != null) coveredIdx.add(i.idx); }));
    for (let i = 0; i < scene.lines.length; i++) {
      const l = scene.lines[i];
      if (!lineHasOrig(l)) continue;
      const covered = hasIdx ? coveredIdx.has(i) : l.chars.some(c => playedRoles.has(c));
      if (covered) continue;
      try {
        const buffer = await getLineOrigBuffer(l);
        if (buffer) {
          mixItems.push({
            role: null, startAt: l.t, lineIdx: i, buffer,
            isOrig: true, origRoles: Array.isArray(l.chars) ? l.chars.slice() : []
          });
        }
      } catch { console.warn("Original fehlt für Line", i); }
    }
  }
  // Video KOMPLETT vorladen, damit die Premiere bei allen gleichzeitig & ruckelfrei startet
  const pv = $("play-video");
  pv.src = sceneVideoSrc();
  attachPrompter(pv, $("play-prompter"), null);
  status("play-status", "⏳ Video wird vorgeladen …");
  await waitCanPlay(pv, 25000);
  setBar("prem-bar", 100);
  // Fertig geladen → beim Host melden
  const me = players.find(p => p.id === myId);
  if (me) me.prem = true;
  $("btn-replay").disabled = true;
  $("btn-download").disabled = true;
  initPremOrigFromMix();
  if (isHost) { broadcastState(); renderPremState(); broadcastPremOrig(); }
  else { sendHost({ t: "premReady" }); status("play-status", "✅ Fertig geladen — warte, bis der Host die Premiere startet …"); }
  renderRedoPanel("redo-panel-prem");
  updateOuttakesBtn();
  SFX.ok();
}

function renderPremStateGuest() {
  const active = onlinePlayers();
  const total = active.length, ready = active.filter(p => p.prem).length;
  const el = $("prem-status");
  if (el) el.textContent = "📦 " + ready + "/" + total + " online haben fertig geladen" + (ready < total ? " …" : " — warte auf den Host!");
}
function renderPremState() {
  const active = onlinePlayers();
  const total = active.length;
  const ready = active.filter(p => p.prem).length;
  const el = $("prem-status");
  if (el) el.textContent = "📦 " + ready + "/" + total + " online haben fertig geladen" + (ready < total ? " …" : " — alle bereit!");
  if (isHost) {
    const btn = $("btn-prem-start");
    if (btn) {
      btn.style.display = "";
      btn.disabled = total > 0 && ready < total;
    }
  }
}

function isOrigItemAudible(item) {
  if (!item || !item.isOrig) return true;
  if (!premOrigOn) return false;
  const roles = item.origRoles || [];
  if (!roles.length) return true;
  return !roles.some(r => premOrigMuted.has(r));
}

function initPremOrigFromMix() {
  const map = new Map();
  for (const it of mixItems) {
    if (!it.isOrig || !it.origRoles) continue;
    for (const rid of it.origRoles) {
      if (map.has(rid)) continue;
      const role = roleOf(rid);
      map.set(rid, (role && role.name) || ("Rolle " + rid));
    }
  }
  premOrigUnfilled = [...map.entries()].map(([id, name]) => ({ id, name }));
  // Beim frischen Mix: Standard an, nichts stumm — außer Host hatte schon Einstellungen
  // (bei Gästen überschreibt applyPremOrigMsg danach)
  if (isHost) {
    premOrigOn = true;
    premOrigMuted = new Set();
  }
  renderPremOrigPanel();
}

function renderPremOrigPanel() {
  const panel = $("prem-orig-panel");
  const rolesEl = $("prem-orig-roles");
  const master = $("prem-orig-master");
  if (!panel || !rolesEl || !master) return;
  const hasOrig = premOrigUnfilled.length > 0;
  panel.style.display = hasOrig ? "" : "none";
  master.checked = premOrigOn;
  master.disabled = !isHost;
  rolesEl.innerHTML = "";
  for (const r of premOrigUnfilled) {
    const lab = document.createElement("label");
    lab.style.cssText = "display:flex;gap:6px;align-items:center;padding:4px 8px;border:1px solid var(--line);border-radius:8px;cursor:pointer;font-size:13px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = premOrigOn && !premOrigMuted.has(r.id);
    cb.disabled = !isHost || !premOrigOn;
    cb.dataset.roleId = String(r.id);
    cb.onchange = () => {
      if (!isHost) return;
      const id = +cb.dataset.roleId;
      if (cb.checked) premOrigMuted.delete(id);
      else premOrigMuted.add(id);
      broadcastPremOrig();
      invalidatePremCache();
    };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(r.name));
    rolesEl.appendChild(lab);
  }
}

function broadcastPremOrig() {
  if (!isHost) return;
  broadcast({ t: "premOrig", on: !!premOrigOn, muted: [...premOrigMuted] });
}

function applyPremOrigMsg(msg) {
  premOrigOn = !!msg.on;
  premOrigMuted = new Set(Array.isArray(msg.muted) ? msg.muted : []);
  renderPremOrigPanel();
  if (!premiereLocked) invalidatePremCache();
}

function updatePremPauseBtn() {
  const btn = $("btn-prem-pause");
  if (!btn) return;
  const v = $("play-video");
  const laeuft = premiereLocked && aktuellePhase() === "scr-playback" && v && !v.ended;
  if (!isHost || !laeuft) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "";
  btn.textContent = premPaused ? "▶ Weiter für alle" : "⏸ Pause für alle";
}

function premPauseAll(fromHostClick) {
  premPaused = true;
  invalidatePremCache();
  const v = $("play-video");
  try { if (v) v.pause(); } catch {}
  try { if (audioCtx && audioCtx.state === "running") audioCtx.suspend(); } catch {}
  updatePremPauseBtn();
  if (fromHostClick && isHost) broadcast({ t: "premPause" });
  status("play-status", "⏸ Pause");
}

function premResumeAll(fromHostClick) {
  premPaused = false;
  const ctx = getCtx();
  const v = $("play-video");
  Promise.resolve(ctx.resume()).catch(() => {}).then(() => {
    try { if (v && v.paused && !v.ended) v.play(); } catch {}
  });
  updatePremPauseBtn();
  if (fromHostClick && isHost) broadcast({ t: "premResume" });
  status("play-status", "🍿 Premiere!");
}

function premStart() {
  premiereLocked = true;
  premPaused = false;
  renderRedoPanel("redo-panel-wait"); renderRedoPanel("redo-panel-prem");
  pendingRate = true;
  $("btn-replay").disabled = false;
  $("btn-download").disabled = false;
  $("btn-prem-start") && ($("btn-prem-start").style.display = "none");
  status("play-status", "🍿 Premiere!");
  updateOuttakesBtn();
  updatePremPauseBtn();
  // Zahlen-Countdown — weiße Balken nur in der Booth, nie hier
  countdown({ wipe: false }).then(() => playMix(false));
}

$("btn-prem-start").onclick = () => {
  broadcast({ t: "premGo" });
  premStart();
};
$("btn-prem-pause") && ($("btn-prem-pause").onclick = () => {
  if (!isHost || !premiereLocked) return;
  if (premPaused) premResumeAll(true);
  else premPauseAll(true);
});
$("prem-orig-master") && ($("prem-orig-master").onchange = () => {
  if (!isHost) return;
  premOrigOn = !!$("prem-orig-master").checked;
  renderPremOrigPanel();
  broadcastPremOrig();
  invalidatePremCache();
});
$("btn-replay").onclick = () => { invalidatePremCache(); playMix(false); };
$("btn-download").onclick = () => downloadPremiere();
$("btn-download-audio").onclick = () => exportAudioFast();

const elemSrcMap = new Map();
function elementSource(ctx, v) {
  if (!elemSrcMap.has(v)) elemSrcMap.set(v, ctx.createMediaElementSource(v));
  return elemSrcMap.get(v);
}


// Ein einziger, dauerhafter Audio-Graph für die Premiere.
// (Vorher wurde pro "Nochmal abspielen" ein neuer Kompressor gebaut und der
//  Video-Ton blieb mit ALLEN alten verbunden → wurde immer lauter. Gefixt.)
let premNodes = null;
const premVol = { master: 1, voice: 1, video: 1 };
function premGraph(ctx, v) {
  if (!premNodes) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 20;
    comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.15;
    const masterGain = ctx.createGain();
    const voiceGain = ctx.createGain();
    const vidGain = ctx.createGain();
    voiceGain.connect(comp); vidGain.connect(comp);
    comp.connect(masterGain); masterGain.connect(ctx.destination);
    elementSource(ctx, v).connect(vidGain);
    premNodes = { comp, masterGain, voiceGain, vidGain };
    applyPremVol();
  }
  return premNodes;
}
function applyPremVol() {
  if (!premNodes) return;
  premNodes.masterGain.gain.value = premVol.master;
  premNodes.voiceGain.gain.value = premVol.voice;
  premNodes.vidGain.gain.value = premVol.video;
}


// ── WAV-Encoder (reines JS, keine Bibliothek nötig) ──
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, dataSize, true);
  const channels = []; for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ── Schneller Ton-Export: rendert den kompletten Mix OHNE Echtzeit-Warten ──
async function exportAudioFast() {
  try {
    status("play-status", "⚡ Rendere Ton … (dauert nur Sekunden, kein Zuschauen nötig)");
    const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const fromLines = scene?.lines?.length ? Math.max(...scene.lines.map(l => l.end)) : 0;
    const fromMix = mixItems.length ? Math.max(...mixItems.map(i => i.startAt + (i.buffer?.duration || 0))) : 0;
    const fromVid = $("play-video")?.duration || 0;
    const lastEnd = Math.max(1, fromLines, fromMix, fromVid) + 1.5;
    const offlineCtx = new OfflineCtor(2, Math.ceil(lastEnd * 44100), 44100);

    const master = offlineCtx.createDynamicsCompressor();
    master.threshold.value = -18; master.knee.value = 20; master.ratio.value = 4; master.attack.value = 0.005; master.release.value = 0.15;
    master.connect(offlineCtx.destination);

    // Video-eigene Tonspur (Musik/SFX) mit reinrechnen
    try {
      const videoBuf = await (await fetch(sceneVideoSrc())).arrayBuffer();
      const videoAudio = await offlineCtx.decodeAudioData(videoBuf.slice(0));
      const vSrc = offlineCtx.createBufferSource();
      vSrc.buffer = videoAudio;
      vSrc.connect(master);
      vSrc.start(0);
    } catch (e) { console.warn("Video-Ton nicht verfügbar für Offline-Export:", e); }

    for (const item of mixItems) {
      if (item.isOrig && !isOrigItemAudible(item)) continue;
      let role = item.role != null ? (roleOf(item.role) || { pan: 0, effect: "none", gain: 1 }) : { pan: 0, effect: "none", gain: 1 };
      if (scene.lines && item.lineIdx != null) role = effectiveRole(role, scene.lines[item.lineIdx]);
      if (item.effect) role = { ...role, effect: item.effect };
      if (item.fxAmount !== undefined) role = { ...role, fxAmount: item.fxAmount };
      if (item.boost != null && item.boost !== 1) role = { ...role, gain: (role.gain ?? 1) * item.boost };
      if (item.pan != null) role = { ...role, pan: item.pan };
      const src = offlineCtx.createBufferSource();
      src.buffer = item.buffer;
      src.playbackRate.value = effectPitch(role.effect);
      src.connect(buildChain(offlineCtx, role, master));
      let maxDur = item.buffer.duration;
      if (scene.lines && item.lineIdx != null) {
        const l = scene.lines[item.lineIdx];
        const cutoffT = nextSameRoleStart(item.lineIdx);
        maxDur = Math.min(maxDur, ((cutoffT != null ? cutoffT : l.end + 0.8) - l.t) + 0.25);
      }
      const when = Math.max(0, item.startAt + syncOffsetMs / 1000);
      src.start(when, 0, maxDur);
    }

    const rendered = await offlineCtx.startRendering();
    const blob = audioBufferToWav(rendered);
    const wie = await saveBlob(blob, (scene?.id || "synchro") + "_ton.wav");
    if (wie === "abort") { status("play-status", "Speichern abgebrochen."); return; }
    status("play-status", "✅ Ton gespeichert (WAV, sofort)! Einfach auf die Videospur in CapCut/Premiere/AE ziehen.");
    SFX.done();
  } catch (e) {
    console.error("Schneller Ton-Export fehlgeschlagen:", e);
    status("play-status", "❌ Ton-Export hat nicht geklappt — F12-Konsole für Details.", true);
  }
}

// Bestes Videoformat, das dieser Browser aufnehmen kann. MP4 hat Vorrang, weil man das
// ohne Umwandeln bei TikTok, Insta und WhatsApp hochladen kann.
function videoMime() {
  const kandidaten = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of kandidaten) if (MediaRecorder.isTypeSupported(m)) return m;
  return "video/webm";
}

// Malt das laufende Video fortlaufend auf eine Leinwand und gibt einen Bildstrom davon
// zurück. requestVideoFrameCallback trifft genau die echten Videobilder; where es das nicht
// gibt (oder Outtakes mit Pause/Seek), alwaysRaf: Dauer-RAF damit MediaRecorder nicht
// nur Ton speichert.
function frameSource(v, opts) {
  const alwaysRaf = !!(opts && opts.alwaysRaf);
  const c = document.createElement("canvas");
  c.width = v.videoWidth || 1280;
  c.height = v.videoHeight || 720;
  const g2 = c.getContext("2d", { alpha: false, desynchronized: true });
  let laeuft = true, bilder = 0, rafId = null;

  const malen = () => {
    if (!laeuft) return;
    if (v.videoWidth && (c.width !== v.videoWidth || c.height !== v.videoHeight)) {
      c.width = v.videoWidth; c.height = v.videoHeight;
    }
    try {
      if (v.readyState >= 2) { g2.drawImage(v, 0, 0, c.width, c.height); bilder++; }
    } catch {}
  };
  // Outtakes: immer RAF — bei Pause/Seek liefert rVFC keine Frames → Datei ohne Bild
  if (!alwaysRaf && typeof v.requestVideoFrameCallback === "function") {
    const schritt = () => { if (!laeuft) return; malen(); v.requestVideoFrameCallback(schritt); };
    v.requestVideoFrameCallback(schritt);
  } else {
    const schritt = () => { if (!laeuft) return; malen(); rafId = requestAnimationFrame(schritt); };
    rafId = requestAnimationFrame(schritt);
  }
  malen();   // erstes Bild sofort, damit der Strom nicht schwarz anfängt

  return {
    stream: c.captureStream(30),
    count: () => bilder,
    paint: malen,
    stop: () => { laeuft = false; if (rafId) cancelAnimationFrame(rafId); }
  };
}
// Outtakes: WebM bevorzugen — MP4-Encoder droppt bei Canvas-Capture oft die Bildspur
function outtakesMime() {
  const kandidaten = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
  ];
  for (const m of kandidaten) if (MediaRecorder.isTypeSupported(m)) return m;
  return "video/webm";
}

// Beim ersten Anschauen der Premiere wird das fertige Video schon mitgeschnitten.
// Danach ist „Speichern“ sofort fertig — niemand muss die Szene nochmal durchsitzen.
let premCache = null;          // { blob, endung, volSig, fps }
let premCachePending = null;   // Promise → premCache, solange gerade mitgeschnitten wird
let premCacheResolve = null;   // Resolver zum sauberen Abbrechen
let premCacheGen = 0;          // Generation — veraltete Mitschnitte nicht übernehmen
let premCacheDirty = false;    // Lautstärke/Sync geändert — alter Cache ggf. veraltet
let premActiveRecorder = null; // laufender MediaRecorder (zum sauberen Stoppen)
let premRecacheTimer = null;
let premWakeLock = null;
function premVolSig() { return JSON.stringify(premVol) + "|" + syncOffsetMs; }
function premCacheReady(c) {
  return !!(c && c.blob && c.blob.size > 1000);
}
function stopPremRecorder() {
  const rec = premActiveRecorder;
  premActiveRecorder = null;
  if (rec && rec.state !== "inactive") {
    try { rec.stop(); } catch {}
  }
}
function invalidatePremCache() {
  clearTimeout(premRecacheTimer);
  premRecacheTimer = null;
  premCache = null;
  premCacheDirty = false;
  premCacheGen++;              // laufende Recorder werden beim Stop irrelevant
  stopPremRecorder();
  if (premCacheResolve) {
    const r = premCacheResolve;
    premCacheResolve = null;
    premCachePending = null;
    try { r(null); } catch {}
  } else {
    premCachePending = null;
  }
  updateDownloadBtnLabel();
}
function updateDownloadBtnLabel() {
  const btn = $("btn-download");
  if (!btn) return;
  if (premCachePending) {
    btn.textContent = "⬇ Video speichern (schneidet noch …)";
    btn.title = "Mitschnitt vom ersten Anschauen läuft — Klick wartet kurz, dann sofort fertig";
  } else if (premCacheReady(premCache) && !premCacheDirty && premCache.volSig === premVolSig()) {
    btn.textContent = "⬇ Sofort speichern (fertig!)";
    btn.title = "Schon beim ersten Anschauen mitgeschnitten — Download startet sofort";
  } else if (premCacheReady(premCache) && premCacheDirty) {
    btn.textContent = "⬇ Video speichern";
    btn.title = "Lautstärke/Sync geändert — speichert den Mitschnitt vom Anschauen (oder schneidet neu wenn nötig)";
  } else {
    btn.textContent = "⬇ Komplettes Video speichern";
    btn.title = "Schneidet einmal im Hintergrund (Fenster bitte offen lassen)";
  }
}
async function holdPremWakeLock() {
  try {
    if (premWakeLock) return;
    if (navigator.wakeLock && navigator.wakeLock.request) {
      premWakeLock = await navigator.wakeLock.request("screen");
      premWakeLock.addEventListener("release", () => { premWakeLock = null; });
    }
  } catch {}
}
function releasePremWakeLock() {
  try { if (premWakeLock) premWakeLock.release(); } catch {}
  premWakeLock = null;
}
// Lautstärke/Sync geändert: Cache als veraltet markieren — aber NICHT automatisch
// nochmal die ganze Premiere abspielen. Neu-Schnitt nur beim Speichern-Klick.
function schedulePremRecache() {
  clearTimeout(premRecacheTimer);
  premRecacheTimer = null;
  // Laufenden Erst-Mitschnitt nicht abwürgen und nicht löschen
  if (premCachePending) {
    premCacheDirty = true;
    updateDownloadBtnLabel();
    return;
  }
  if (premCacheReady(premCache)) {
    // Alten Mitschnitt behalten für Sofort-Save; als dirty markieren wenn Settings weg sind
    if (premCache.volSig !== premVolSig()) premCacheDirty = true;
    updateDownloadBtnLabel();
    return;
  }
  premCacheDirty = true;
  updateDownloadBtnLabel();
}

async function downloadPremiere() {
  const nameBase = (scene?.id || "synchro") + "_dub.";
  // Noch am Mitschneiden vom ersten Anschauen? Darauf warten — kein Zweitdurchlauf.
  if (premCachePending) {
    status("play-status", "⏳ Schneide noch vom ersten Anschauen fertig — einen Moment …");
    $("dl-progress").style.display = "";
    try {
      const c = await premCachePending;
      $("dl-progress").style.display = "none";
      if (!premCacheReady(c)) throw new Error("leer");
      premCacheDirty = false;
      const wie = await saveBlob(c.blob, nameBase + c.endung);
      if (wie === "abort") return status("play-status", "Speichern abgebrochen.");
      status("play-status", c.endung === "mp4"
        ? "✅ Gespeichert als MP4 — vom ersten Anschauen, kein zweites Mal nötig."
        : "✅ Gespeichert!");
      SFX.done();
      updateDownloadBtnLabel();
    } catch {
      $("dl-progress").style.display = "none";
      status("play-status", "Schnitt vom ersten Lauf hat nicht geklappt — einmal neu im Hintergrund …", true);
      await playMix({ save: true, quiet: true });
    }
    return;
  }
  // Fertiger Mitschnitt vom Anschauen — auch nutzen wenn nur leicht „dirty“
  // (lieber sofort speichern als unnötig nochmal abspielen)
  if (premCacheReady(premCache)) {
    const wie = await saveBlob(premCache.blob, nameBase + premCache.endung);
    if (wie === "abort") return status("play-status", "Speichern abgebrochen.");
    premCacheDirty = false;
    if (premCache.fps < 5) status("play-status", "⚠ Gespeichert, aber das Bild dürfte ruckeln oder schwarz sein. Bitte Fenster im Vordergrund lassen und Premiere nochmal anschauen.", true);
    else status("play-status", premCache.endung === "mp4"
      ? "✅ Sofort gespeichert als MP4 — vom ersten Anschauen."
      : "✅ Sofort gespeichert! Dein Browser kann nur .webm — für TikTok/Insta ggf. einmal in CapCut zu MP4.");
    SFX.done();
    updateDownloadBtnLabel();
    return;
  }
  // Wirklich kein Mitschnitt (Pause mittendrin, Fehler, …) → einmal im Hintergrund
  status("play-status", "🎬 Schneide Video im Hintergrund — musst nicht zuschauen, Fenster aber bitte offen lassen …");
  await playMix({ save: true, quiet: true });
}

async function playMix(opts) {
  // opts: true/false (alt) oder { save, quiet, cache }
  const saveFile = opts === true || !!(opts && opts.save);
  const quiet = !!(opts && opts.quiet);
  const auchCachen = !saveFile;   // normale Premiere: still mitschneiden für späteren Sofort-Download
  const ctx = getCtx();
  const v = $("play-video");
  playNodes.forEach(n => { try { n.stop(); } catch {} });
  playNodes = [];
  premPaused = false;
  try { await ctx.resume(); } catch {}
  updatePremPauseBtn();

  const g = premGraph(ctx, v);
  const master = g.voiceGain;          // Stimmen laufen über den Voice-Regler in den Graph
  v.playbackRate = 1;

  let fileRec = null;
  let myGen = 0;
  if (saveFile || auchCachen) {
    // Neue Generation — veraltete onstop-Handler dürfen Pending/Cache nicht mehr anfassen
    premCacheGen++;
    myGen = premCacheGen;
    const dest = ctx.createMediaStreamDestination();
    g.masterGain.connect(dest);

    // Bildquelle: Video Bild für Bild auf eine Leinwand malen und DIESE aufnehmen.
    // Der direkte Weg über video.captureStream() liefert auf manchen Rechnern nur
    // Schwarzbild (Hardware-Dekoder/Grafiktreiber) — der Ton war dann da, das Bild fehlte.
    const frames = frameSource(v);
    const stream = new MediaStream([...frames.stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    // MP4 wenn der Browser es kann: das laesst sich direkt bei TikTok/Insta hochladen,
    // ohne vorher in CapCut umgewandelt zu werden. WebM nur noch als Rueckfalloption.
    const mime = videoMime();
    const endung = mime.startsWith("video/mp4") ? "mp4" : "webm";
    try {
      fileRec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    } catch (e) {
      console.warn("MediaRecorder startet nicht:", e);
      fileRec = null;
    }
    const chunks = [];
    const volSig = premVolSig();
    if (fileRec) {
      premActiveRecorder = fileRec;
      fileRec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      fileRec.onerror = e => console.warn("MediaRecorder Fehler:", e);
      // Alten Pending sauber auflösen, bevor wir einen neuen setzen
      if (premCacheResolve) { try { premCacheResolve(null); } catch {} }
      premCachePending = new Promise(res => { premCacheResolve = res; });
      premCacheDirty = false;
      updateDownloadBtnLabel();
      holdPremWakeLock();
      fileRec.onstop = () => {
        if (premActiveRecorder === fileRec) premActiveRecorder = null;
        try { g.masterGain.disconnect(dest); } catch {}
        frames.stop();
        releasePremWakeLock(); // immer, auch bei veraltetem Mitschnitt
        if (myGen !== premCacheGen) return; // veralteter Mitschnitt — Pending gehört dem neueren Lauf
        const blob = new Blob(chunks, { type: mime.split(";")[0] });
        const sek = Math.max(1, v.duration || 1), fps = frames.count() / sek;
        const ok = blob.size > 1000;
        const result = ok ? { blob, endung, volSig, fps } : null;
        premCache = result;
        // Settings während des Mitschnitts geändert? Cache behalten, als dirty markieren
        if (ok) premCacheDirty = (volSig !== premVolSig());
        const r = premCacheResolve;
        premCacheResolve = null;
        premCachePending = null;
        if (r) try { r(result); } catch {}
        updateDownloadBtnLabel();
        if (!ok && !saveFile) {
          status("play-status", "⚠ Sofort-Speichern hat diesmal nicht geklappt (Fenster im Hintergrund?). Beim Speichern einmal durchlaufen — bitte Tab im Vordergrund lassen.", true);
        }
        if (saveFile && ok) {
          const name = (scene?.id || "synchro") + "_dub." + endung;
          saveBlob(blob, name).then(wie => {
            if (wie === "abort") { status("play-status", "Speichern abgebrochen."); return; }
            if (fps < 5) status("play-status", "⚠ Gespeichert, aber das Bild dürfte ruckeln oder schwarz sein (nur " + fps.toFixed(1) + " Bilder/Sek.). Der Browser drosselt das Aufnehmen, wenn das Fenster im Hintergrund ist — bitte nochmal speichern und das Fenster dabei offen im Vordergrund lassen.", true);
            else {
              status("play-status", endung === "mp4"
                ? "✅ Gespeichert als MP4 — kann direkt bei TikTok, Insta oder WhatsApp hochgeladen werden."
                : "✅ Gespeichert! Dein Browser kann nur .webm — für TikTok/Insta einmal in CapCut o. Ä. zu MP4 exportieren.");
              SFX.done();
            }
          });
        } else if (saveFile && !ok) {
          status("play-status", "⚠ Speichern fehlgeschlagen — bitte Tab im Vordergrund lassen und nochmal versuchen.", true);
        } else if (ok && !quiet) {
          status("play-status", "✅ Premiere durch — Speichern ist jetzt sofort bereit!");
        }
      };
    }
    if (saveFile) {
      status("play-status", quiet
        ? "🎬 Schneide im Hintergrund — musst nicht zuschauen, Fenster bitte offen lassen …"
        : "🔴 Nimmt Video auf — Fenster bitte im Vordergrund lassen, sonst wird das Bild schwarz!");
      $("dl-progress").style.display = "";
    }
  }

  v.pause(); v.currentTime = 0;
  await v.play();
  if (fileRec) {
    // timeslice: Chunks regelmäßig abholen — sonst bleibt der Mitschnitt auf manchen Browsern leer
    try { fileRec.start(1000); } catch (e) {
      console.warn("fileRec.start fehlgeschlagen:", e);
      try { fileRec.start(); } catch {}
    }
    const progInterval = setInterval(() => {
      const pct = v.duration ? Math.round((v.currentTime / v.duration) * 100) : 0;
      if ($("dl-progress-bar")) $("dl-progress-bar").style.width = pct + "%";
      if ($("dl-progress-label")) $("dl-progress-label").textContent = pct + "%";
      if (v.ended || fileRec.state === "inactive") clearInterval(progInterval);
    }, 200);
    v.addEventListener("ended", () => { clearInterval(progInterval); if (saveFile) $("dl-progress").style.display = "none"; }, { once: true });
  }
  const t0 = ctx.currentTime;
  const off = syncOffsetMs / 1000;

  for (const item of mixItems) {
    if (item.isOrig && !isOrigItemAudible(item)) continue;
    let role = item.role != null ? (roleOf(item.role) || { pan: 0, effect: "none", gain: 1 }) : { pan: 0, effect: "none", gain: 1 };
    if (scene.lines && item.lineIdx != null) role = effectiveRole(role, scene.lines[item.lineIdx]);
    if (item.effect) role = { ...role, effect: item.effect };   // Spieler-eigene Wahl übersticht alles andere
    if (item.fxAmount !== undefined) role = { ...role, fxAmount: item.fxAmount };
    // „Deine Lautstärke“ aus der Booth — fehlte hier bisher (Export hatte es, Premiere nicht)
    if (item.boost != null && item.boost !== 1) role = { ...role, gain: (role.gain ?? 1) * item.boost };
    if (item.pan != null) role = { ...role, pan: item.pan };   // Spieler-Pan pro Line (links/mitte/rechts)
    const src = ctx.createBufferSource();
    src.buffer = item.buffer;
    src.playbackRate.value = effectPitch(role.effect);
    src.connect(buildChain(ctx, role, master));
    // Spur auf ihr Line-Fenster begrenzen → kein Reinlabern in die nächste Line
    let maxDur = item.buffer.duration;
    if (scene.lines && item.lineIdx != null) {
      const l = scene.lines[item.lineIdx];
      const cutoffT = nextSameRoleStart(item.lineIdx);
      maxDur = Math.min(maxDur, ((cutoffT != null ? cutoffT : l.end + 0.8) - l.t) + 0.25);
    }
    const when = t0 + item.startAt + off;
    if (when >= ctx.currentTime) src.start(when, 0, maxDur);
    else src.start(ctx.currentTime, ctx.currentTime - when, Math.max(0.05, maxDur - (ctx.currentTime - when)));
    playNodes.push(src);
  }
  // Videoende = ALLES stoppt → kein 1–2s-Nachlauf-Audio mehr
  v.addEventListener("ended", () => {
    playNodes.forEach(n => { try { n.stop(); } catch {} });
    premPaused = false;
    updatePremPauseBtn();
    if (pendingRate && !saveFile) { pendingRate = false; showRateCard(); }
  }, { once: true });

  if (fileRec) v.addEventListener("ended", () => { if (fileRec.state !== "inactive") fileRec.stop(); }, { once: true });
}


$("vol-master").oninput = e => { premVol.master = parseFloat(e.target.value); applyPremVol(); schedulePremRecache(); };
$("vol-voice").oninput  = e => { premVol.voice  = parseFloat(e.target.value); applyPremVol(); schedulePremRecache(); };
$("vol-video").oninput  = e => { premVol.video  = parseFloat(e.target.value); applyPremVol(); schedulePremRecache(); };
let boothVol = 0.55;
$("booth-vol").oninput = e => { boothVol = parseFloat(e.target.value); $("booth-video").volume = boothVol; };

$("sync-offset").oninput = (e) => {
  syncOffsetMs = parseInt(e.target.value);
  $("sync-val").textContent = syncOffsetMs + " ms";
  schedulePremRecache();
};

// ── Effekt-Ketten ────────────────────────────────────────────
function buildChain(ctx, role, dest) {
  const input = ctx.createGain();
  input.gain.value = role.gain ?? 1;
  const pan = ctx.createStereoPanner();
  pan.pan.value = role.pan ?? 0;

  // Effekt-Staerke 0..1 -- 0 = aus (nur Originalstimme), 1 = voll.
  // Umgesetzt als Ueberblendung zwischen unbearbeitetem und bearbeitetem Signal.
  // Dadurch wirkt der Regler bei JEDEM Effekt gleich, ohne jeden einzeln umbauen zu muessen.
  let amt = role.fxAmount;
  amt = (amt === undefined || amt === null) ? 1 : Math.max(0, Math.min(1, amt));
  const fxIn = ctx.createGain(), fxOut = ctx.createGain();
  const dryG = ctx.createGain(); dryG.gain.value = 1 - amt;
  const wetG = ctx.createGain(); wetG.gain.value = amt;
  input.connect(fxIn);
  input.connect(dryG); dryG.connect(pan);
  fxOut.connect(wetG); wetG.connect(pan);
  pan.connect(dest);

  let node = fxIn;
  const filt = (type, freq, q, gain) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    if (q) f.Q.value = q; if (gain) f.gain.value = gain;
    node.connect(f); node = f;
  };

  switch (role.effect) {
    case "vintage_1990":
      filt("highpass", 140); filt("lowpass", 5600);
      filt("peaking", 2600, 1, 4.5);
      node = chainShaper(ctx, node, 10);
      break;
    case "radio":
      filt("highpass", 380); filt("lowpass", 3000);
      node = chainShaper(ctx, node, 25);
      break;
    case "telefon":
      filt("highpass", 350); filt("lowpass", 2900); filt("peaking", 1700, 1.3, 5);
      node = chainShaper(ctx, node, 15);
      break;
    case "megaphone":
      filt("highpass", 550); filt("lowpass", 2500); filt("peaking", 1500, 2, 9);
      node = chainShaper(ctx, node, 55);
      break;
    case "underwater": {
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 550;
      node.connect(lp); node = lp;
      filt("peaking", 260, 1.5, 5);
      // Wabbel-Effekt: LFO schiebt die Lowpass-Frequenz langsam auf und ab, wie Schallwellen unter Wasser
      const uwLfo = ctx.createOscillator(); uwLfo.type = "sine"; uwLfo.frequency.value = 3.1;
      const uwDepth = ctx.createGain(); uwDepth.gain.value = 230;
      uwLfo.connect(uwDepth); uwDepth.connect(lp.frequency);
      try { uwLfo.start(); } catch {}
      break;
    }
    case "helium":
      filt("highpass", 200); filt("peaking", 3500, 1, 6);
      break;
    case "monster":
      filt("lowpass", 1900); filt("peaking", 130, 1.4, 7);
      node = chainShaper(ctx, node, 20);
      break;
    case "robot": {
      const lfo = ctx.createOscillator(); lfo.type = "square"; lfo.frequency.value = 38;
      const ringGain = ctx.createGain(); ringGain.gain.value = 0.72;
      const dcOffset = ctx.createGain(); dcOffset.gain.value = 0.28;
      lfo.connect(ringGain.gain);
      node.connect(ringGain); node.connect(dcOffset);
      const merge = ctx.createGain();
      ringGain.connect(merge); dcOffset.connect(merge);
      node = merge;
      try { lfo.start(); } catch {}
      filt("bandpass", 1800, 0.7);
      break;
    }
    case "chorus": {
      // Doppelgänger-Effekt: leicht verstimmte, verzögerte Kopie wird dazugemischt -> schwebender Doppel-Klang
      const dry = ctx.createGain(); dry.gain.value = 0.75;
      const wet = ctx.createGain(); wet.gain.value = 0.55;
      const delay = ctx.createDelay(); delay.delayTime.value = 0.022;
      const chLfo = ctx.createOscillator(); chLfo.type = "sine"; chLfo.frequency.value = 0.9;
      const chDepth = ctx.createGain(); chDepth.gain.value = 0.006;
      chLfo.connect(chDepth); chDepth.connect(delay.delayTime);
      try { chLfo.start(); } catch {}
      node.connect(dry); node.connect(delay); delay.connect(wet);
      const merge2 = ctx.createGain();
      dry.connect(merge2); wet.connect(merge2);
      node = merge2;
      break;
    }
    case "echo": {
      // Deutlicher Einzel-Nachschlag (Slap-Echo), anders als der weiche "halliger Raum"
      const dry = ctx.createGain(); dry.gain.value = 0.9;
      const wet = ctx.createGain(); wet.gain.value = 0.55;
      const delay = ctx.createDelay(); delay.delayTime.value = 0.22;
      const fb = ctx.createGain(); fb.gain.value = 0.22;
      node.connect(dry); node.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet);
      const merge3 = ctx.createGain();
      dry.connect(merge3); wet.connect(merge3);
      node = merge3;
      break;
    }
    case "studio": {
      // Rettet guenstige Mikrofone. Leitgedanke: aufraeumen und glaetten statt aufbohren.
      // Billige Mikros klingen schlecht, WEIL obenrum zu viel Zischeln und Rauschen sitzt --
      // ein Hoehen-Boost macht genau das lauter. Deshalb hier gezielte Korrekturen,
      // sanfte Verdichtung in zwei Stufen und am Ende ein Limiter, damit nichts uebersteuert.
      filt("highpass", 80, 0.7);           // Trittschall, Tischklopfen, Klima-Brummen
      filt("peaking", 175, 0.9, 2);        // etwas Koerper -- duenne Stimmen wirken sonst schmal
      filt("peaking", 400, 1.0, -3);       // Pappkarton-Klang der billigen Kapsel
      filt("peaking", 1050, 1.5, -1.5);    // Naeselndes/Quaekiges rausnehmen
      filt("peaking", 2700, 1.2, 3);       // Praesenz fuer Verstaendlichkeit -- bewusst moderat
      filt("peaking", 5200, 2.4, -2);      // Haerte/Schaerfe
      filt("peaking", 7400, 2.6, -3);      // Zischeln
      filt("highshelf", 11000, 0.7, -3.5); // ganz oben zurueck: da sitzt fast nur Rauschen

      // Erste Stufe: sanft und langsam -- gleicht nur laute und leise Stellen aus,
      // ohne die Stimme zusammenzupressen.
      const lev = ctx.createDynamicsCompressor();
      lev.threshold.value = -22; lev.knee.value = 20; lev.ratio.value = 2.2;
      lev.attack.value = 0.015; lev.release.value = 0.25;
      node.connect(lev); node = lev;

      const makeup = ctx.createGain(); makeup.gain.value = 1.35;
      node.connect(makeup); node = makeup;

      // Zweite Stufe: schneller Limiter als Deckel. Ohne den knallte die Kette vorher
      // ins Maximum und klang dadurch hart und verzerrt.
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.001; lim.release.value = 0.08;
      node.connect(lim); node = lim;
      break;
    }
    case "titan":
      // Sehr tiefe, bedrohliche Stimme -- staerkerer Bruder von "monster", mit mehr Growl
      filt("lowpass", 1300); filt("peaking", 90, 1.6, 9);
      node = chainShaper(ctx, node, 30);
      break;
    case "hall": {
      const dry = ctx.createGain(); dry.gain.value = 0.85;
      const wet = ctx.createGain(); wet.gain.value = 0.4;
      const delay = ctx.createDelay(); delay.delayTime.value = 0.11;
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
      node.connect(dry); dry.connect(fxOut);
      node.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay);
      lp.connect(wet); wet.connect(fxOut);
      return input;
    }
  }
  node.connect(fxOut);
  return input;
}


// Falls eine einzelne Line einen eigenen Effekt festlegt (z.B. "diese eine Line klingt wie Telefon"),
// überschreibt das den normalen Rollen-Effekt NUR für diese Line.
function effectiveRole(role, line) {
  if (line && line.effect) return { ...role, effect: line.effect };
  return role;
}
function effectPitch(effect) {
  if (effect === "helium") return 1.35;
  if (effect === "monster") return 0.72;
  if (effect === "titan") return 0.6;
  return 1;
}
function chainShaper(ctx, node, amount) { const s = shaper(ctx, amount); node.connect(s); return s; }
function shaper(ctx, amount) {
  const ws = ctx.createWaveShaper();
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((3 + amount) * x * 0.5) / (Math.PI + amount * Math.abs(x)) * Math.PI;
  }
  ws.curve = curve; ws.oversample = "2x";
  return ws;
}

// ── Teleprompter (Premiere-Untertitel + Realtime-Cues) ───────
function attachPrompter(videoEl, promptEl, myRoleId) {
  promptEl.innerHTML = "";
  if (!scene?.lines?.length) return;
  const lines = scene.lines;
  let lastIdx = -2;
  videoEl.ontimeupdate = () => {
    const t = videoEl.currentTime;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (t >= lines[i].t && t < lines[i].end) { idx = i; break; }
    if (idx === lastIdx) return;
    lastIdx = idx;
    const cur = idx >= 0 ? lines[idx] : null;
    const next = lines.find(l => l.t > t);
    const mine = cur && myRoleId != null && cur.chars.includes(myRoleId);
    const av = cur && scene.avatars ? scene.avatars[String(cur.chars[0])] : null;
    promptEl.innerHTML =
      (cur ? `<div class="pline ${mine ? "mine" : ""}">
          ${av ? `<img src="${av}" alt="">` : ""}
          <div class="ptext"><div class="pwho">${esc(cur.who)}${mine ? " — 🎙 DU!" : ""}</div><div class="pcap">${esc(cur.text)}</div>${(cur.de && !scene.blind) ? `<div style="font-size:.85rem;color:var(--amber)">${esc(cur.de)}</div>` : ""}</div>
        </div>` : `<div class="pline"><div class="ptext"><div class="pwho">…</div><div class="pcap" style="color:var(--muted)">Ruhe im Studio</div></div></div>`) +
      (next ? `<div class="pnext">Gleich (${Math.max(0, next.t - t).toFixed(0)}s): <b>${esc(next.who)}</b> — ${esc(next.text)}</div>` : "");
  };
}

// ═════════════════════════════════════════════════════════════
// 10) NEUE RUNDE
// ═════════════════════════════════════════════════════════════
$("btn-again").onclick = () => {
  if (isHost) { broadcast({ t: "again" }); resetForNewRound(); }
  else status("play-status", "Nur der Host kann eine neue Runde starten.", true);
};
$("btn-back").onclick = () => {
  if (isHost) { SFX.back(); scene = null; broadcast({ t: "again" }); resetForNewRound(); $("scene-card").style.display = "none"; }
  else status("play-status", "Nur der Host kann die Szene wechseln.", true);
};
function resetForNewRound() {
  players.forEach(p => { p.ready = false; p.done = 0; p.total = 0; p.prem = false; });
  mixItems = []; collected.clear(); collectedOuttakes.clear(); takes = {}; outtakes = []; outtakesCache = null;
  clearTimeout(outtakesPrecacheTimer); outtakesPrecacheTimer = null;
  outtakeAbort = true; resolveOuttakesCachePending(null);
  premOrigOn = true; premOrigUnfilled = []; premOrigMuted = new Set(); premPaused = false;
  invalidatePremCache();
  clearSceneCaches();
  pendingPhaseRestore = null;
  finalTracksData = null; premiereLocked = false; redoMode = null;
  try { if (audioCtx && audioCtx.state === "suspended") audioCtx.resume(); } catch {}
  const pop = $("prem-orig-panel"); if (pop) pop.style.display = "none";
  updatePremPauseBtn();
  pendingRate = false; rateSent = false; allRatings.clear(); myStars = {}; myBuddy = null;
  document.body.classList.remove("cinema");
  const c = $("cinema-curtains"); if (c) c.classList.remove("show", "open");
  $("rate-card").style.display = "none";
  $("rate-rows").innerHTML = ""; $("rate-result").innerHTML = "";
  $("btn-rate-submit").textContent = "Bewertung abschicken";
  $("btn-rate-submit").disabled = true;
  $("btn-next-round").style.display = "none";
  updateOuttakesBtn();
  if (isHost) { ttt = { p: [], board: Array(9).fill(null), turn: 0, winner: null }; broadcast({ t: "tttState", ttt }); renderTTT(); }
  show("scr-lobby");
  if (isHost) broadcastState(); else { renderPlayers(); renderRoles(); }
  status("lobby-status", "Neue Runde — wieder „Bin bereit“ drücken, wenn's losgehen soll.");
}
