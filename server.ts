// Hollow Crown multiplayer server: serves the game page and runs lobbies + game relay over WebSocket.
const clientSource = await Bun.file(new URL("./index.html", import.meta.url)).text();
const clientDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientSource));
const clientVersion = Array.from(new Uint8Array(clientDigest), byte => byte.toString(16).padStart(2, "0")).join("");
const HTML = clientSource.replace('<meta name="hc-build" content="">', `<meta name="hc-build" content="${clientVersion}">`);

type Player = { id: string; name: string; cls: string; level: number; skin: string; ready: boolean; ws: any; afk?: boolean; lastFrame?: number; dead?: boolean; voice?: boolean };
type Room = {
  code: string;
  host: string;
  combatHost?: string | null;
  finished?: boolean;
  public: boolean;
  capacity: number;
  state: "lobby" | "playing";
  settings: { gm: string; boss: string; arena: string; diff: string };
  players: Map<string, Player>;
};

const CLASSES = ["sword", "mage", "archer", "rogue", "berserker", "warlock", "sentinel", "paladin", "jester", "soul"];
const BOSSES: Record<string, string> = { varkhul: "keep", thoruun: "storm" };
const DIFFS = ["easy", "normal", "hard", "nightmare", "ultra"];
const MAX = 10;
const DEFAULT_CAPACITY = 5;
const skinType = (value: unknown): string => value === "pixel" || value === "celestial" || value === "angel" || value === "devil" ? value : "classic";
function roomCapacity(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= MAX ? value : fallback;
}
const HOST_EVENTS = new Set(["danger", "cancel", "msg", "shock", "stormThrow", "roarfx", "blink", "eproj", "cleared", "room", "bossDead", "enemyFelled", "oathSeal", "tauntFx", "revive", "wipe", "bossCredit", "soulLinkState"]);
const rooms = new Map<string, Room>();
type OnlinePlayer = { name: string; ping: number | null; probe?: number; sentAt?: number; lastRequest?: number; ws: any };
const onlinePlayers = new Map<string, OnlinePlayer>();
let nextProbe = 0;

function setOnlineName(ws: any, name: unknown) {
  const player = onlinePlayers.get(ws.data.id);
  if (player) player.name = clean(name);
  else onlinePlayers.set(ws.data.id, { name: clean(name), ping: null, ws });
}

function probePing(player: OnlinePlayer, now: number) {
  player.probe = ++nextProbe;
  player.sentAt = now;
  send(player.ws, { t: "pingProbe", token: player.probe });
}

type Presence = { id: string; name: string; cls: string; level: number; skin: string;
  x: number; z: number; facing: number; moving: boolean; seen: number };
const village = new Map<string, Presence>();
const VILLAGE_LIMIT = 32;
function villageUpdate(ws: any, m: any) {
  const id = ws.data.id, now = Date.now();
  if (ws.data.room || now - (ws.data.lastVillage ?? 0) < 95) return;
  if (![m.x, m.z, m.facing].every(Number.isFinite) || Math.abs(m.x) > 24 || m.z < -22 || m.z > 20) return;
  ws.data.lastVillage = now;
  setOnlineName(ws, m.name);
  for (const [key, p] of village) if (now - p.seen > 6500) village.delete(key);
  if (village.has(id) || village.size < VILLAGE_LIMIT) {
    village.set(id, { id, name: clean(m.name), cls: cls(m.cls), level: charLevel(m.level),
      skin: skinType(m.skin), x: m.x, z: m.z, facing: m.facing % (Math.PI * 2), moving: m.moving === true, seen: now });
  }
  const peers = [...village.values()].filter(p => p.id !== id).map(({ seen, ...p }) => p);
  send(ws, { t: "village", peers });
}

function makeCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}
const clean = (s: any, n = 16) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n) || "Adventurer";
const cls = (c: any) => (CLASSES.includes(c) ? c : "sword");
const charLevel = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : 1;

function view(r: Room) {
  return {
    code: r.code, host: r.host, public: r.public, capacity: r.capacity, state: r.state, settings: r.settings,
    players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, cls: p.cls, level: p.level, skin: p.skin, ready: p.ready, voice: !!p.voice })),
  };
}
function send(ws: any, m: any) { try { ws.send(JSON.stringify(m)); } catch {} }
function bcast(r: Room, m: any, except?: string) {
  const s = JSON.stringify(m);
  for (const p of r.players.values()) if (p.id !== except) { try { p.ws.send(s); } catch {} }
}
function pushLobby(r: Room) { bcast(r, { t: "lobby", room: view(r) }); }

function selectCombatHost(r: Room) {
  if (r.finished) return;
  const current = r.players.get(r.combatHost ?? "");
  if (current && !current.afk) return;
  const active = [...r.players.values()].filter(p => !p.afk);
  const replacement = (active.find(p => !p.dead) ?? active[0])?.id ?? null;
  if (r.combatHost === replacement) return;
  r.combatHost = replacement;
  bcast(r, { t: "combatHost", id: replacement });
}

function setAfk(r: Room, p: Player, afk: boolean) {
  if (!!p.afk === afk) return;
  p.afk = afk;
  bcast(r, { t: "afk", id: p.id, afk });
}

function leave(ws: any) {
  const code = ws.data.room;
  if (!code) return;
  ws.data.room = null;
  const r = rooms.get(code);
  if (!r) return;
  r.players.delete(ws.data.id);
  if (r.players.size === 0) { rooms.delete(code); return; }
  bcast(r, { t: "left", id: ws.data.id });
  if (r.host === ws.data.id) {
    r.host = r.players.keys().next().value as string;
    const h = r.players.get(r.host);
    if (h) h.ready = false;
    bcast(r, { t: "host", id: r.host });
  }
  if (r.state === "playing") selectCombatHost(r);
  pushLobby(r);
}

function join(ws: any, r: Room, name: string, c: string, level: unknown, skin: unknown) {
  if (ws.data.room) leave(ws);
  village.delete(ws.data.id);
  const p: Player = { id: ws.data.id, name: clean(name), cls: cls(c), level: charLevel(level), skin: skinType(skin), ready: false, ws };
  setOnlineName(ws, p.name);
  r.players.set(p.id, p);
  ws.data.room = r.code;
  pushLobby(r);
}

function handle(ws: any, m: any) {
  const r = ws.data.room ? rooms.get(ws.data.room) : undefined;
  switch (m.t) {
    case "village": villageUpdate(ws, m); break;
    case "villageLeave": village.delete(ws.data.id); break;
    case "pingReply": {
      const player = onlinePlayers.get(ws.data.id);
      if (player?.sentAt === undefined || player.probe !== m.token) break;
      const elapsed = Date.now() - player.sentAt;
      player.ping = elapsed >= 0 && elapsed <= 8000 ? elapsed : null;
      player.probe = undefined;
      break;
    }
    case "onlineList": {
      setOnlineName(ws, r?.players.get(ws.data.id)?.name ?? m.name);
      const player = onlinePlayers.get(ws.data.id)!;
      const now = Date.now();
      if (now - (player.lastRequest ?? -Infinity) < 800) break;
      player.lastRequest = now;
      if (now - (player.sentAt ?? -Infinity) >= 5000) probePing(player, now);
      send(ws, { t: "onlineList", players: [...onlinePlayers].map(([id, { name, ping }]) => ({ id, name, ping })) });
      break;
    }
    case "list": {
      const list = [...rooms.values()]
        .filter((x) => x.public && x.state === "lobby" && x.players.size < x.capacity)
        .slice(0, 30)
        .map((x) => ({ code: x.code, hostName: x.players.get(x.host)?.name ?? "Unknown", count: x.players.size, capacity: x.capacity, boss: x.settings.boss, diff: x.settings.diff, gm: x.settings.gm }));
      send(ws, { t: "lobbies", list });
      break;
    }
    case "create": {
      const room: Room = { code: makeCode(), host: ws.data.id, public: !!m.public, capacity: roomCapacity(m.capacity, DEFAULT_CAPACITY), state: "lobby", settings: { gm: "boss", boss: "varkhul", arena: "keep", diff: "normal" }, players: new Map() };
      rooms.set(room.code, room);
      join(ws, room, m.name, m.cls, m.level, m.skin);
      break;
    }
    case "join": {
      const room = rooms.get(String(m.code || "").toUpperCase());
      if (!room) return send(ws, { t: "error", msg: "No lobby was found with that code." });
      if (room.state !== "lobby") return send(ws, { t: "error", msg: "That expedition is already in progress." });
      if (ws.data.room === room.code) return send(ws, { t: "lobby", room: view(room) });
      if (room.players.size >= room.capacity) return send(ws, { t: "error", msg: "That party booth is full." });
      join(ws, room, m.name, m.cls, m.level, m.skin);
      break;
    }
    case "leave": leave(ws); break;
    case "chat": {
      if (!r) return;
      const p = r.players.get(ws.data.id);
      const text = String(m.text ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 140);
      if (!p || !text) return;
      const now = Date.now();
      if (ws.data.lastChat && now - ws.data.lastChat < 400) return;
      ws.data.lastChat = now;
      bcast(r, { t: "chat", from: p.id, name: p.name, text });
      break;
    }
    case "voice": {
      const p = r?.players.get(ws.data.id);
      if (!r || !p) return;
      p.voice = m.on === true;
      bcast(r, { t: "voice", id: p.id, on: p.voice }, p.id);
      pushLobby(r);
      break;
    }
    case "rtc": {
      if (!r || !r.players.has(ws.data.id)) return;
      const target = r.players.get(String(m.to ?? ""));
      if (!target || target.id === ws.data.id || !m.data || typeof m.data !== "object") return;
      const now = Date.now();
      ws.data.rtcWindow = ws.data.rtcWindow && now - ws.data.rtcWindow.start < 1000 ? ws.data.rtcWindow : { start: now, n: 0 };
      if (++ws.data.rtcWindow.n > 120) return;
      const out = JSON.stringify({ t: "rtc", from: ws.data.id, data: m.data });
      if (out.length > 20000) return;
      try { target.ws.send(out); } catch {}
      break;
    }
    case "set": {
      if (!r) return;
      const p = r.players.get(ws.data.id);
      if (!p) return;
      if (m.cls !== undefined && r.state === "lobby") {
        p.cls = cls(m.cls);
        p.level = charLevel(m.level);
        if (m.skin !== undefined) p.skin = skinType(m.skin);
      }
      if (m.ready !== undefined) p.ready = !!m.ready;
      pushLobby(r);
      break;
    }
    case "settings": {
      if (!r || r.host !== ws.data.id || r.state !== "lobby") return;
      const s = m.settings || {};
      const capacity = roomCapacity(s.capacity, r.capacity);
      if (capacity < r.players.size) return send(ws, { t: "error", msg: "Party size cannot be smaller than the current party." });
      if (s.gm === "campaign") return send(ws, { t: "error", msg: "Campaign is temporarily unavailable." });
      r.capacity = capacity;
      if (Object.hasOwn(BOSSES, s.boss)) {
        r.settings.boss = s.boss;
        r.settings.arena = BOSSES[s.boss];
      }
      if (DIFFS.includes(s.diff)) r.settings.diff = s.diff;
      pushLobby(r);
      break;
    }
    case "start": {
      if (!r || r.host !== ws.data.id || r.state !== "lobby") return;
      const notReady = [...r.players.values()].some((p) => p.id !== r.host && !p.ready);
      if (notReady) return send(ws, { t: "error", msg: "All players must be ready before starting." });
      r.state = "playing";
      r.combatHost = r.host;
      r.finished = false;
      for (const p of r.players.values()) { p.afk = false; p.lastFrame = Date.now(); p.dead = false; }
      pushLobby(r);
      bcast(r, { t: "start", settings: r.settings, host: r.host, players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, cls: p.cls, level: p.level, skin: p.skin, theme: p.skin === "celestial" ? (Math.random() < 0.5 ? "angel" : "devil") : undefined })) });
      break;
    }
    case "toLobby": {
      if (!r || r.host !== ws.data.id) return;
      r.state = "lobby";
      r.combatHost = undefined;
      for (const p of r.players.values()) p.ready = false;
      pushLobby(r);
      break;
    }
    case "afk": {
      const p = r?.players.get(ws.data.id);
      if (!r || !p || r.state !== "playing" || r.finished) return;
      p.lastFrame = Date.now();
      setAfk(r, p, m.afk === true);
      selectCombatHost(r);
      break;
    }
    case "g": {
      if (!r || r.state !== "playing" || !m.d || typeof m.d !== "object") return;
      const d = m.d;
      const player = r.players.get(ws.data.id);
      if (!player || r.finished) return;
      if (d.k === "p") {
        player.lastFrame = Date.now();
        player.dead = !!d.dead;
        if (player.afk && d.active === true) {
          setAfk(r, player, false);
          selectCombatHost(r);
        }
      }
      if (player.afk) return;
      const hostMessage = d.k === "b" || d.k === "m" || (d.k === "ev" && HOST_EVENTS.has(d.e));
      if (hostMessage && ws.data.id !== r.combatHost) return;
      if (hostMessage && d.k === "ev" && (d.e === "bossDead" || d.e === "wipe")) r.finished = true;
      const out = JSON.stringify({ t: "g", from: ws.data.id, d });
      if (m.host) { const h = r.players.get(r.combatHost ?? ""); if (h && h.id !== ws.data.id) { try { h.ws.send(out); } catch {} } return; }
      for (const p of r.players.values()) if (p.id !== ws.data.id) { try { p.ws.send(out); } catch {} }
      break;
    }
  }
}

setInterval(() => {
  const cutoff = Date.now() - 4500;
  for (const r of rooms.values()) {
    if (r.state !== "playing" || r.finished) continue;
    for (const p of r.players.values()) {
      if (!p.afk && (p.lastFrame ?? 0) < cutoff) setAfk(r, p, true);
    }
    selectCombatHost(r);
  }
}, 1000);

setInterval(() => {
  const now = Date.now();
  for (const player of onlinePlayers.values()) {
    if (player.probe !== undefined) player.ping = null;
    probePing(player, now);
  }
}, 5000);

let nextId = 1;
const server = Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const id = (nextId++).toString(36) + Math.random().toString(36).slice(2, 7);
      if (srv.upgrade(req, { data: { id, room: null } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/client-version") {
      return new Response(clientVersion, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  },
  websocket: {
    idleTimeout: 120,
    maxPayloadLength: 64 * 1024,
    open(ws: any) { send(ws, { t: "welcome", id: ws.data.id }); },
    message(ws: any, raw: any) {
      let m: any;
      try { m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
      if (m && typeof m.t === "string") handle(ws, m);
    },
    close(ws: any) { onlinePlayers.delete(ws.data.id); village.delete(ws.data.id); leave(ws); },
  },
});
console.log("Hollow Crown server listening on", server.port);
