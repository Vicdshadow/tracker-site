import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { db, save, flush } from './store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const PING_MIN_GAP = 1000;
const TRAIL_MAX_POINTS = 5000;
const TRAIL_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const SOS_MAX_KEEP = 100;
const VIEWER_TTL = 90 * 1000;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(root, 'public')));

const now = () => Date.now();
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const COLORS = [
  '#e11d48', '#0891b2', '#7c3aed', '#ea580c',
  '#16a34a', '#2563eb', '#db2777', '#65a30d',
];

function colorFor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    color: u.color,
    sharingEnabled: u.sharingEnabled === true,
    shareCircles: Array.isArray(u.shareCircles) ? u.shareCircles : [],
    mode: u.mode === 'network' ? 'network' : 'gps',
    createdAt: u.createdAt,
  };
}

const getUser = (userId) => db.users.find((u) => u.id === userId) || null;
const getUserByEmail = (email) =>
  db.users.find((u) => u.email === String(email || '').trim().toLowerCase()) || null;

function circlesOf(userId) {
  return db.circles.filter((c) => c.memberIds.includes(userId));
}

function isMember(circle, userId) {
  return !!circle && circle.memberIds.includes(userId);
}

function circleById(circleId) {
  return db.circles.find((c) => c.id === circleId) || null;
}

// A user only exposes location to circles they have explicitly switched on.
function sharedCircleIds(userId) {
  const u = getUser(userId);
  if (!u || u.sharingEnabled !== true) return new Set();
  return new Set((u.shareCircles || []).filter((cid) => isMember(circleById(cid), userId)));
}

function circlesVisibleTo(userId) {
  return circlesOf(userId).filter((c) => sharedCircleIds(userId).has(c.id));
}

// Everyone who is allowed to see targetId's position right now.
function watchersOf(targetId) {
  const ids = new Set();
  for (const c of circlesVisibleTo(targetId)) {
    for (const m of c.memberIds) if (m !== targetId) ids.add(m);
  }
  return ids;
}

function trailOf(userId) {
  if (!db.trails[userId]) db.trails[userId] = [];
  return db.trails[userId];
}

function pruneTrail(points) {
  const cutoff = now() - TRAIL_MAX_AGE;
  let cut = 0;
  while (cut < points.length && points[cut].t < cutoff) cut++;
  if (cut > 0) points.splice(0, cut);
  if (points.length > TRAIL_MAX_POINTS) points.splice(0, points.length - TRAIL_MAX_POINTS);
}

function lastPoint(userId) {
  const pts = db.trails[userId];
  return pts && pts.length ? pts[pts.length - 1] : null;
}

/* ------------------------------- realtime ------------------------------- */

const sockets = new Set();

function send(sock, type, payload) {
  if (sock.ws.readyState !== 1) return;
  sock.ws.send(JSON.stringify({ type, ...payload }));
}

function broadcast(userIds, type, payload, exceptSock) {
  for (const sock of sockets) {
    if (exceptSock && sock === exceptSock) continue;
    if (!userIds.has(sock.userId)) continue;
    send(sock, type, payload);
  }
}

function notifySharingChange(userId) {
  const u = getUser(userId);
  broadcast(watchersOf(userId), 'sharing', { user: publicUser(u) });
  pushViewers(userId);
}

const viewerIndex = new Map(); // targetUserId -> Map<viewerUserId, lastActivity>

function pushViewers(targetId) {
  const u = getUser(targetId);
  if (!u || u.sharingEnabled !== true) return;
  const live = new Set();
  for (const [viewerId, at] of viewerIndex.get(targetId) || []) {
    if (now() - at < VIEWER_TTL) live.add(viewerId);
    else viewerIndex.get(targetId).delete(viewerId);
  }
  for (const sock of sockets) {
    if (sock.userId !== targetId) continue;
    send(sock, 'viewers', { count: live.size, ids: [...live] });
  }
}

setInterval(() => {
  for (const targetId of [...viewerIndex.keys()]) pushViewers(targetId);
}, 30 * 1000).unref();

function broadcastPresence(userId, online) {
  broadcast(watchersOf(userId), 'presence', { userId, online });
}

wss.on('connection', (ws, req) => {
  let token = '';
  try {
    token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  } catch {
    return;
  }
  const session = db.sessions.find((s) => s.token === token);
  const user = session ? getUser(session.userId) : null;
  if (!user) {
    ws.close(4001, 'unauthorized');
    return;
  }

  const sock = { ws, userId: user.id, viewing: new Set(), subscribed: new Set() };
  sockets.add(sock);

  const circles = circlesVisibleTo(user.id).map((c) => circleSummary(c));
  send(sock, 'hello', {
    me: publicUser(user),
    circles,
    live: liveSnapshotFor(user.id),
  });
  broadcastPresence(user.id, true);
  for (const targetId of watchersOf(user.id)) pushViewers(targetId);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      send(sock, 'pong', { t: now() });
      return;
    }

    if (msg.type === 'subscribe') {
      const circle = circleById(msg.circleId);
      if (!isMember(circle, user.id)) return;
      sock.subscribed.add(circle.id);
      for (const memberId of circle.memberIds) {
        if (!sharedCircleIds(memberId).has(circle.id)) continue;
        const lp = lastPoint(memberId);
        if (lp) send(sock, 'location', { userId: memberId, ...lp });
      }
      const hours = Math.min(Math.max(Number(msg.hours) || 1, 1), 24);
      const since = now() - hours * 3600 * 1000;
      for (const memberId of circle.memberIds) {
        if (!sharedCircleIds(memberId).has(circle.id)) continue;
        if (memberId === user.id) continue;
        const pts = (db.trails[memberId] || []).filter((p) => p.t >= since);
        if (pts.length) send(sock, 'trail', { userId: memberId, points: pts });
      }
      return;
    }

    if (msg.type === 'unsubscribe') {
      sock.subscribed.delete(msg.circleId);
      return;
    }

    if (msg.type === 'viewing') {
      if (msg.active) sock.viewing.add(msg.circleId);
      else sock.viewing.delete(msg.circleId);
      for (const targetId of watchersOf(user.id)) {
        const m = viewerIndex.get(targetId) || new Map();
        m.set(user.id, now());
        viewerIndex.set(targetId, m);
        pushViewers(targetId);
      }
      return;
    }

    if (msg.type === 'sos-ack') {
      const alert = db.sos.find((a) => a.id === msg.alertId);
      if (!alert || alert.acknowledged.includes(user.id)) return;
      alert.acknowledged.push(user.id);
      save();
      broadcast(watchersOf(alert.userId), 'sos-ack', { alertId: alert.id, by: publicUser(user) });
    }
  });

  ws.on('close', () => {
    sockets.delete(sock);
    broadcastPresence(user.id, false);
    for (const [targetId, m] of viewerIndex) {
      if (m.has(user.id)) {
        m.delete(user.id);
        pushViewers(targetId);
      }
    }
  });

  ws.on('error', () => {});
});

/* --------------------------------- data --------------------------------- */

function circleSummary(c) {
  return {
    id: c.id,
    name: c.name,
    ownerId: c.ownerId,
    memberIds: c.memberIds,
    members: c.memberIds.map((id) => {
      const u = getUser(id);
      return {
        id,
        name: u ? u.name : 'Unknown',
        color: u ? u.color : '#64748b',
        sharingEnabled: u ? u.sharingEnabled === true : false,
        online: [...sockets].some((s) => s.userId === id),
      };
    }),
  };
}

function liveSnapshotFor(userId) {
  const out = [];
  for (const c of circlesVisibleTo(userId)) {
    for (const memberId of c.memberIds) {
      if (memberId === userId) continue;
      if (!sharedCircleIds(memberId).has(c.id)) continue;
      const lp = lastPoint(memberId);
      if (lp) out.push({ userId: memberId, ...lp });
    }
  }
  return out;
}

/* -------------------------------- routes -------------------------------- */

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = db.sessions.find((s) => s.token === token);
  const user = session ? getUser(session.userId) : null;
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  req.token = token;
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 40);
  const password = String(req.body.password || '');

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'That email is already registered' });

  const { salt, hash } = hashPassword(password);
  const user = {
    id: rid(),
    email,
    name,
    salt,
    hash,
    color: colorFor(email),
    sharingEnabled: false,
    shareCircles: [],
    mode: 'gps',
    createdAt: now(),
  };
  db.users.push(user);

  const token = rid(24);
  db.sessions.push({ token, userId: user.id, createdAt: now() });
  save();

  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  const cutoff = now() - SESSION_TTL;
  db.sessions = db.sessions.filter((s) => s.createdAt > cutoff);
  const token = rid(24);
  db.sessions.push({ token, userId: user.id, createdAt: now() });
  save();
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.sessions = db.sessions.filter((s) => s.token !== req.token);
  save();
  res.json({ ok: true });
});

app.post('/api/auth/guest', (req, res) => {
  const preferredName = String(req.body?.name || '').trim().slice(0, 40) || `Explorer ${Math.floor(100 + Math.random() * 900)}`;
  const guestEmail = `guest_${rid(6).toLowerCase()}@beacon.local`;
  const user = {
    id: rid(),
    email: guestEmail,
    name: preferredName,
    salt: '',
    hash: '',
    color: colorFor(guestEmail),
    sharingEnabled: false,
    shareCircles: [],
    mode: 'gps',
    createdAt: now(),
  };
  db.users.push(user);

  const defaultCircle = {
    id: rid(),
    name: 'Family',
    ownerId: user.id,
    memberIds: [user.id],
    createdAt: now(),
  };
  db.circles.push(defaultCircle);
  user.shareCircles = [defaultCircle.id];

  const token = rid(24);
  db.sessions.push({ token, userId: user.id, createdAt: now() });
  save();

  res.status(201).json({ token, user: publicUser(user) });
});

app.patch('/api/me/name', auth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name || name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  req.user.name = name;
  save();
  notifySharingChange(req.user.id);
  res.json({ user: publicUser(req.user) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    circles: circlesOf(req.user.id).map(circleSummary),
    viewers: [...(viewerIndex.get(req.user.id) || new Map()).keys()],
  });
});

app.patch('/api/me/sharing', auth, (req, res) => {
  const u = req.user;
  if (typeof req.body.enabled === 'boolean') u.sharingEnabled = req.body.enabled;
  if (req.body.mode === 'network' || req.body.mode === 'gps') u.mode = req.body.mode;

  const valid = new Set(circlesOf(u.id).map((c) => c.id));
  u.shareCircles = (Array.isArray(req.body.shareCircles) ? req.body.shareCircles : u.shareCircles).filter(
    (cid) => valid.has(cid)
  );

  if (u.sharingEnabled && u.shareCircles.length === 0) {
    return res.status(400).json({ error: 'Pick at least one circle to share with' });
  }
  save();
  notifySharingChange(u.id);
  res.json({ user: publicUser(u) });
});

app.post('/api/circles', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Give the circle a name' });
  const circle = { id: rid(), name, ownerId: req.user.id, memberIds: [req.user.id], createdAt: now() };
  db.circles.push(circle);
  save();
  res.status(201).json({ circle: circleSummary(circle) });
});

// Generate a one-time-use invite link for a circle
app.post('/api/circles/:id/invite-link', auth, (req, res) => {
  const circle = circleById(req.params.id);
  if (!isMember(circle, req.user.id)) return res.status(404).json({ error: 'Circle not found' });
  const code = rid(18);
  if (!db.invites) db.invites = {};
  // Expire any old invites for this circle by this user
  for (const [k, v] of Object.entries(db.invites)) {
    if (v.circleId === circle.id && v.createdBy === req.user.id) delete db.invites[k];
  }
  db.invites[code] = { circleId: circle.id, createdBy: req.user.id, createdAt: now() };
  save();
  let host = req.get('host');
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    const port = host.split(':')[1] || '3000';
    host = `${getLocalIp()}:${port}`;
  }
  const baseUrl = `${req.protocol}://${host}`;
  res.json({ url: `${baseUrl}/?join=${code}`, code });
});

// Join a circle via invite code
app.get('/api/join/:code', auth, (req, res) => {
  if (!db.invites) return res.status(404).json({ error: 'Invite not found or expired' });
  const invite = db.invites[req.params.code];
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });
  const TTL = 7 * 24 * 60 * 60 * 1000;
  if (now() - invite.createdAt > TTL) {
    delete db.invites[req.params.code];
    save();
    return res.status(410).json({ error: 'Invite link has expired' });
  }
  const circle = circleById(invite.circleId);
  if (!circle) return res.status(404).json({ error: 'Circle no longer exists' });
  if (!circle.memberIds.includes(req.user.id)) {
    circle.memberIds.push(req.user.id);
    save();
    broadcast(new Set(circle.memberIds), 'circle-updated', { circle: circleSummary(circle) });
  }
  res.json({ circle: circleSummary(circle) });
});


app.post('/api/circles/:id/members', auth, (req, res) => {
  const circle = circleById(req.params.id);
  if (!isMember(circle, req.user.id)) return res.status(404).json({ error: 'Circle not found' });

  const email = String(req.body.email || '').trim().toLowerCase();
  const target = getUserByEmail(email);
  if (!target) return res.status(404).json({ error: 'No account with that email' });
  if (!circle.memberIds.includes(target.id)) {
    circle.memberIds.push(target.id);
    save();
  }
  broadcast(new Set(circle.memberIds), 'circle-updated', { circle: circleSummary(circle) });
  res.json({ circle: circleSummary(circle) });
});

app.delete('/api/circles/:id/members/:userId', auth, (req, res) => {
  const circle = circleById(req.params.id);
  if (!isMember(circle, req.user.id)) return res.status(404).json({ error: 'Circle not found' });
  circle.memberIds = circle.memberIds.filter((m) => m !== req.params.userId);
  save();
  broadcast(new Set(circle.memberIds), 'circle-updated', { circle: circleSummary(circle) });
  res.json({ circle: circleSummary(circle) });
});

app.delete('/api/circles/:id', auth, (req, res) => {
  const circle = circleById(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  if (circle.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the creator can delete this circle' });
  db.circles = db.circles.filter((c) => c.id !== circle.id);
  for (const u of db.users) u.shareCircles = (u.shareCircles || []).filter((cid) => cid !== circle.id);
  save();
  broadcast(new Set(circle.memberIds), 'circle-removed', { circleId: circle.id });
  res.json({ ok: true });
});

app.post('/api/location', auth, (req, res) => {
  const u = req.user;
  if (u.sharingEnabled !== true) {
    return res.status(403).json({ error: 'Turn on location sharing first', code: 'sharing-off' });
  }
  if (sharedCircleIds(u.id).size === 0) {
    return res.status(403).json({ error: 'You are not sharing with any circle', code: 'no-circles' });
  }

  const lat = Number(req.body.lat);
  const lon = Number(req.body.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Bad coordinates' });
  }

  const lp = lastPoint(u.id);
  if (lp && now() - lp.t < PING_MIN_GAP) return res.json({ ok: true, skipped: true });

  const point = {
    t: now(),
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    acc: Number.isFinite(Number(req.body.acc)) ? Math.round(Number(req.body.acc)) : null,
    spd: Number.isFinite(Number(req.body.spd)) ? Math.round(Number(req.body.spd) * 10) / 10 : null,
    hdg: Number.isFinite(Number(req.body.hdg)) ? Math.round(Number(req.body.hdg)) : null,
    mode: req.body.mode === 'network' ? 'network' : 'gps',
  };

  const trail = trailOf(u.id);
  trail.push(point);
  pruneTrail(trail);
  save();

  const audience = watchersOf(u.id);
  broadcast(audience, 'location', { userId: u.id, ...point });

  res.json({ ok: true, point });
});

app.get('/api/live', auth, (req, res) => {
  res.json({ live: liveSnapshotFor(req.user.id) });
});

app.get('/api/trails', auth, (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 6, 1), 24);
  const since = now() - hours * 3600 * 1000;
  const trails = {};
  for (const c of circlesVisibleTo(req.user.id)) {
    for (const memberId of c.memberIds) {
      if (memberId === req.user.id) continue;
      if (!sharedCircleIds(memberId).has(c.id)) continue;
      const pts = (db.trails[memberId] || []).filter((p) => p.t >= since);
      if (pts.length) trails[memberId] = pts;
    }
  }
  res.json({ hours, trails });
});

app.post('/api/sos', auth, (req, res) => {
  const u = req.user;
  const text = String(req.body.text || '').slice(0, 280);
  const lat = Number.isFinite(Number(req.body.lat)) ? Number(req.body.lat) : null;
  const lon = Number.isFinite(Number(req.body.lon)) ? Number(req.body.lon) : null;
  const withLocation = req.body.includeLocation === true && u.sharingEnabled === true;

  const alert = {
    id: rid(),
    userId: u.id,
    text,
    lat: withLocation ? lat : null,
    lon: withLocation ? lon : null,
    includeLocation: withLocation,
    createdAt: now(),
    acknowledged: [],
  };
  db.sos.push(alert);
  if (db.sos.length > SOS_MAX_KEEP) db.sos.splice(0, db.sos.length - SOS_MAX_KEEP);
  save();

  const audience = new Set();
  for (const c of circlesOf(u.id)) for (const m of c.memberIds) if (m !== u.id) audience.add(m);
  broadcast(audience, 'sos', { alert, user: publicUser(u) });

  res.status(201).json({ alert });
});

app.get('/api/sos', auth, (req, res) => {
  const ids = new Set();
  for (const c of circlesOf(req.user.id)) for (const m of c.memberIds) ids.add(m);
  res.json({ alerts: db.sos.filter((a) => ids.has(a.userId)).slice(-25).reverse() });
});

app.post('/api/sos/:id/ack', auth, (req, res) => {
  const alert = db.sos.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!alert.acknowledged.includes(req.user.id)) alert.acknowledged.push(req.user.id);
  save();
  broadcast(new Set(circlesOf(alert.userId).flatMap((c) => c.memberIds)), 'sos-ack', {
    alertId: alert.id,
    by: publicUser(req.user),
  });
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

server.listen(PORT, () => {
  console.log(`Tracker running on http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}