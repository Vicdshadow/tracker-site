const el = (id) => document.getElementById(id);
const TOKEN_KEY = 'beacon.token';
const API_BASE_KEY = 'beacon.apiBase';

// Empty means "same origin as this page". config.js wins on deploys; the
// localStorage override is for pointing a local build at a remote backend.
const API_BASE = String(
  localStorage.getItem(API_BASE_KEY) || window.TRACKER_CONFIG?.apiBase || ''
).trim().replace(/\/+$/, '');

function wsEndpoint(token) {
  const url = new URL(API_BASE || location.origin, location.href);
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = url.pathname.replace(/\/+$/, '');
  return `${proto}//${url.host}${base}/ws?token=${encodeURIComponent(token)}`;
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  me: null,
  circles: [],
  selectedCircle: null,
  markers: new Map(),
  points: new Map(),
  lines: new Map(),
  live: new Map(),
  online: new Set(),
  viewers: [],
  watchId: null,
  lastPost: 0,
  lastFix: null,
  postTimer: null,
  ws: null,
  wsRetry: 0,
  mode: 'gps',
  pendingAlert: null,
  isLocal: false,
  wsStatus: 'connecting',
};

let map = null;

/* -------------------------------- helpers -------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
      await ensureUserSession();
      return;
    }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(text, isError = false) {
  const node = el('toast');
  node.textContent = text;
  node.classList.toggle('err', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.28, 0.56].forEach((delay) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.24);
    });
    setTimeout(() => ctx.close(), 1600);
  } catch { /* audio unavailable */ }
}

/* -------------------------------- profile -------------------------------- */

const profileForm = el('profile-name-form');
if (profileForm) {
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el('display-name-input');
    const newName = input.value.trim();
    if (!newName) return;
    try {
      if (state.isLocal) {
        state.me.name = newName;
        state.circles.forEach((c) => {
          const m = c.members.find((x) => x.id === state.me.id);
          if (m) m.name = newName;
        });
        toast('Name updated.');
        renderMembers();
        renderSharing();
        return;
      }
      const { user } = await api('/api/me/name', {
        method: 'PATCH',
        body: JSON.stringify({ name: newName }),
      });
      state.me.name = user.name;
      toast('Name updated.');
      renderMembers();
      renderSharing();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function resetUser() {
  localStorage.removeItem(TOKEN_KEY);
  stopWatching();
  if (state.ws) state.ws.close();
  state.token = null;
  state.markers.forEach((entry) => entry.marker.remove());
  state.markers.clear();
  state.lines.forEach((line) => line.remove());
  state.lines.clear();
  await ensureUserSession();
  toast('New identity created.');
}

const resetBtn = el('reset-user');
if (resetBtn) {
  resetBtn.addEventListener('click', resetUser);
}

/* ---------------------------------- map ---------------------------------- */

function mapNotice(html, action) {
  const box = el('map-notice');
  if (!box) return;
  box.innerHTML = html || '';
  box.hidden = !html;
  if (!html || !action) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn small-btn';
  btn.textContent = action.label;
  btn.style.marginTop = '10px';
  btn.addEventListener('click', action.onClick);
  box.appendChild(btn);
}

// Three free, keyless basemaps tried in order. Only the first one needs a
// {r} retina token; the other two 404 on "@2x" paths.
const BASEMAP_SOURCES = [
  {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    opts: {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  {
    url: 'https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png',
    opts: {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; Wikimedia',
    },
  },
];
let basemapLayer = null;
let basemapIndex = 0;
let basemapErrors = 0;

function loadBasemap() {
  if (!map || typeof L === 'undefined') return;
  if (basemapLayer) {
    map.removeLayer(basemapLayer);
    basemapLayer = null;
  }
  basemapErrors = 0;
  const layer = L.tileLayer(BASEMAP_SOURCES[basemapIndex].url, BASEMAP_SOURCES[basemapIndex].opts);
  layer.on('tileerror', () => {
    basemapErrors += 1;
    if (basemapErrors < 3) return;
    if (basemapIndex < BASEMAP_SOURCES.length - 1) {
      basemapIndex += 1;
      loadBasemap();
      return;
    }
    mapNotice(
      '<strong>Map background unavailable</strong>' +
        'The streets and terrain could not be downloaded, so the map stays blank. ' +
        'Markers, trails and alerts still work. An ad-blocker, VPN or network filter is usually what blocks map images ' +
        '&mdash; allow images for this site, then retry.',
      {
        label: 'Retry map',
        onClick: () => {
          basemapIndex = 0;
          mapNotice('');
          loadBasemap();
        },
      }
    );
  });
  layer.on('load', () => mapNotice(''));
  basemapLayer = layer;
  layer.addTo(map);
}

function ensureMap() {
  if (map) return map;
  if (typeof L === 'undefined') {
    mapNotice('<strong>Map failed to load</strong>The map library did not load. Press Ctrl+Shift+R to force a refresh.');
    return null;
  }
  map = L.map('map').setView([20, 0], 2);
  loadBasemap();

  syncMapSize();
  // Leaflet caches container dimensions, so a resize or orientation change
  // leaves grey gaps until it is told to re-measure.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => syncMapSize()).observe(el('map'));
  }
  window.addEventListener('resize', syncMapSize);
  window.addEventListener('orientationchange', () => setTimeout(syncMapSize, 250));
  return map;
}

let mapSizeQueued = false;
function syncMapSize() {
  if (!map || mapSizeQueued) return;
  mapSizeQueued = true;
  requestAnimationFrame(() => {
    mapSizeQueued = false;
    if (!map) return;
    const center = map.getCenter();
    map.invalidateSize({ animate: false });
    map.setView(center, map.getZoom(), { animate: false });
  });
}

function markerIcon(color, isMe) {
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;color:${color}">${isMe ? '<span class="me-halo"></span>' : ''}<div class="user-marker" style="background:${color}"></div></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function userColor(userId) {
  if (state.me && userId === state.me.id) return '#38bdf8';
  for (const c of state.circles) {
    const mem = c.members.find((x) => x.id === userId);
    if (mem) return mem.color;
  }
  return '#94a3b8';
}

function memberName(userId) {
  if (state.me && userId === state.me.id) return state.me.name;
  for (const c of state.circles) {
    const mem = c.members.find((x) => x.id === userId);
    if (mem) return mem.name;
  }
  return 'Member';
}

function popupHtml(userId, point) {
  const isMe = state.me && userId === state.me.id;
  const name = isMe ? `${escapeHtml(state.me.name)} (you)` : escapeHtml(memberName(userId));
  const rows = [
    `<strong>${name}</strong>`,
    `Updated ${ago(point.t)}`,
    point.acc != null ? `Accuracy &plusmn;${point.acc} m` : null,
    point.spd != null && point.spd > 0.4 ? `Speed ${point.spd.toFixed(1)} m/s` : null,
    point.mode === 'network' ? 'Cell / WiFi positioning' : 'GPS positioning',
  ].filter(Boolean);
  return `<div>${rows.join('<br>')}</div>`;
}

function placeMarker(userId, point) {
  const m = ensureMap();
  if (!m) return null;
  const isMe = !!state.me && userId === state.me.id;
  const color = userColor(userId);
  let entry = state.markers.get(userId);

  if (!entry) {
    const marker = L.marker([point.lat, point.lon], {
      icon: markerIcon(color, isMe),
      zIndexOffset: isMe ? 1000 : 0,
      keyboard: false,
    }).addTo(m);
    entry = {
      marker,
      color,
      target: L.latLng(point.lat, point.lon),
      current: L.latLng(point.lat, point.lon),
    };
    state.markers.set(userId, entry);
  } else {
    entry.target = L.latLng(point.lat, point.lon);
    if (entry.color !== color) {
      entry.color = color;
      entry.marker.setIcon(markerIcon(color, isMe));
    }
  }

  entry.marker.setPopupContent(popupHtml(userId, point));
  if (!isMe) state.live.set(userId, point);
  if (isMe && el('follow-select').value === 'me') m.panTo(entry.target);
  scheduleFit();
  return entry;
}

let fitTimer = null;
// Positions arrive one message at a time, so fit after the burst settles.
function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    fitTimer = null;
    if (state.markers.size && el('follow-select').value !== 'me') fitMembers();
  }, 500);
}

function removeMarker(userId) {
  const entry = state.markers.get(userId);
  if (entry) {
    entry.marker.remove();
    state.markers.delete(userId);
  }
  state.live.delete(userId);
  state.points.delete(userId);
  if (state.lines.has(userId)) {
    state.lines.get(userId).remove();
    state.lines.delete(userId);
  }
}

function animateMarkers() {
  const step = () => {
    for (const entry of state.markers.values()) {
      if (entry.current.lat === entry.target.lat && entry.current.lng === entry.target.lng) continue;
      entry.current = L.latLng(
        entry.current.lat + (entry.target.lat - entry.current.lat) * 0.18,
        entry.current.lng + (entry.target.lng - entry.current.lng) * 0.18
      );
      entry.marker.setLatLng(entry.current);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function pushPoint(userId, point) {
  const list = state.points.get(userId) || [];
  list.push({ t: point.t, lat: point.lat, lon: point.lon });
  state.points.set(userId, list);
  drawTrails();
}

function drawTrails() {
  if (!ensureMap()) return;
  if (!el('trail-toggle').checked) {
    for (const line of state.lines.values()) line.remove();
    state.lines.clear();
    return;
  }

  const since = Date.now() - Number(el('hours-select').value) * 3600 * 1000;
  const seen = new Set();

  for (const [userId, all] of state.points) {
    const pts = all.filter((p) => p.t >= since);
    if (pts.length < 2) {
      if (state.lines.has(userId)) {
        state.lines.get(userId).remove();
        state.lines.delete(userId);
      }
      continue;
    }
    seen.add(userId);
    const color = userColor(userId);
    const latlngs = pts.map((p) => [p.lat, p.lon]);
    const existing = state.lines.get(userId);
    if (existing) {
      existing.setLatLngs(latlngs);
      existing.setStyle({ color });
    } else {
      state.lines.set(userId, L.polyline(latlngs, {
        color,
        weight: 3,
        opacity: 0.65,
        lineJoin: 'round',
      }).addTo(map));
    }
  }

  for (const [userId, line] of state.lines) {
    if (!seen.has(userId)) {
      line.remove();
      state.lines.delete(userId);
    }
  }
}

el('trail-toggle').addEventListener('change', drawTrails);

el('hours-select').addEventListener('change', () => {
  drawTrails();
  if (state.ws && state.selectedCircle) {
    state.ws.send(JSON.stringify({
      type: 'subscribe',
      circleId: state.selectedCircle,
      hours: Number(el('hours-select').value),
    }));
  }
});

el('follow-select').addEventListener('change', () => {
  if (el('follow-select').value !== 'me') return;
  const entry = state.me && state.markers.get(state.me.id);
  const m = ensureMap();
  if (entry && m) m.setView(entry.target, Math.max(m.getZoom(), 14));
});

function fitMembers() {
  const m = ensureMap();
  if (!m) return;
  const points = [];
  for (const [userId, entry] of state.markers) {
    const me = state.me && userId === state.me.id;
    if (me && el('follow-select').value === 'me') continue;
    points.push(entry.target);
  }
  if (points.length === 1) {
    m.setView(points[0], Math.max(m.getZoom(), 15));
    return;
  }
  if (points.length > 1) m.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 16 });
}

el('fit-members').addEventListener('click', fitMembers);

el('recenter').addEventListener('click', () => {
  const entry = state.me && state.markers.get(state.me.id);
  const m = ensureMap();
  if (entry && m) m.setView(entry.target, 15);
  else fitMembers();
});

/* ------------------------------- geolocation ------------------------------ */

const WATCH_OPTIONS = {
  gps: { enableHighAccuracy: true, timeout: 25000, maximumAge: 2000 },
  network: { enableHighAccuracy: false, timeout: 40000, maximumAge: 30000 },
};

function startWatching() {
  if (!navigator.geolocation) {
    setGpsState('This browser has no location support');
    return;
  }
  stopWatching();
  state.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, WATCH_OPTIONS[state.mode]);
}

function stopWatching() {
  if (state.watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  if (state.postTimer) {
    clearInterval(state.postTimer);
    state.postTimer = null;
  }
}

function onGeoError(err) {
  setGpsState(
    err.code === 1
      ? 'Location permission denied — turn sharing on again to grant it'
      : `Location error: ${err.message}`
  );
}

function setGpsState(text) {
  const node = el('gps-state');
  node.textContent = text;
  node.style.display = text ? '' : 'none';
}

function currentCoords() {
  const f = state.lastFix;
  if (!f) return null;
  return {
    lat: f.coords.latitude,
    lon: f.coords.longitude,
    acc: f.coords.accuracy,
    spd: f.coords.speed,
    hdg: f.coords.heading,
  };
}

async function onFix(pos) {
  state.lastFix = pos;
  const { latitude, longitude, accuracy, speed } = pos.coords;

  placeMarker(state.me.id, { lat: latitude, lon: longitude, t: Date.now() });

  const bits = [`±${Math.round(accuracy)} m`];
  if (speed != null && speed > 0.4) bits.push(`${speed.toFixed(1)} m/s`);
  bits.push(state.mode === 'network' ? 'cell / WiFi' : 'GPS');
  setGpsState(bits.join(' · '));

  pushPoint(state.me.id, { t: Date.now(), lat: latitude, lon: longitude });
  await postLocation(currentCoords());
}

async function postLocation(coords) {
  if (!coords || !state.me || !state.me.sharingEnabled) return;
  if (Date.now() - state.lastPost < 1000) return;
  state.lastPost = Date.now();
  // In local mode, just show the marker — no server needed
  if (state.isLocal) {
    placeMarker(state.me.id, { lat: coords.lat, lon: coords.lon, t: Date.now(), mode: state.mode });
    return;
  }
  try {
    await api('/api/location', {
      method: 'POST',
      body: JSON.stringify({ ...coords, mode: state.mode }),
    });
  } catch (err) {
    if (err.code === 'sharing-off' || err.code === 'no-circles') {
      await applySharing({ sharingEnabled: false }).catch(() => {});
      stopWatching();
      renderSharing();
      toast('Sharing was turned off, so position updates stopped.', true);
    }
  }
}

/* -------------------------------- sharing -------------------------------- */

async function applySharing(patch) {
  if (state.isLocal) {
    if (typeof patch.sharingEnabled === 'boolean') state.me.sharingEnabled = patch.sharingEnabled;
    if (patch.mode) state.me.mode = patch.mode;
    if (patch.shareCircles) state.me.shareCircles = patch.shareCircles;
    renderSharing();
    return state.me;
  }
  const { user } = await api('/api/me/sharing', { method: 'PATCH', body: JSON.stringify(patch) });
  state.me = user;
  renderSharing();
  return user;
}

function startSharingLoop() {
  if (state.postTimer) return;
  state.postTimer = setInterval(() => postLocation(currentCoords()), 20000);
}

async function stopSharing(opts = {}) {
  stopWatching();
  setGpsState('Sharing is off — your position is not sent anywhere');
  try { await applySharing({ sharingEnabled: false }); } catch { /* offline is fine */ }
  if (!opts.silent) toast('Location sharing stopped.');
}

el('sharing-toggle').addEventListener('change', async (e) => {
  if (!e.target.checked) return stopSharing();

  if (state.circles.length === 0) {
    e.target.checked = false;
    toast('Create a circle first so there is someone to share with.', true);
    return;
  }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  try {
    await applySharing({
      sharingEnabled: true,
      shareCircles: state.me.shareCircles.length ? state.me.shareCircles : state.circles.map((c) => c.id),
      mode: state.mode,
    });
    startWatching();
    startSharingLoop();
    toast('Sharing on. Your circles can see you now.');
  } catch (err) {
    e.target.checked = false;
    toast(err.message, true);
  }
});

el('stop-sharing').addEventListener('click', () => stopSharing());

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', async (e) => {
    state.mode = e.target.value;
    if (!state.me || !state.me.sharingEnabled) return;
    try {
      await applySharing({ mode: state.mode });
      startWatching();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

el('share-targets').addEventListener('change', async (e) => {
  if (!e.target.checked && e.target.type !== 'checkbox') return;
  const set = new Set(state.me.shareCircles);
  if (e.target.checked) set.add(e.target.value);
  else set.delete(e.target.value);
  try {
    await applySharing({ shareCircles: [...set] });
  } catch (err) {
    toast(err.message, true);
  }
});

/* -------------------------------- circles -------------------------------- */

el('circle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el('circle-name').value.trim();
  if (!name) return;
  if (state.isLocal) {
    const id = 'circle-' + Date.now();
    const circle = {
      id,
      name,
      ownerId: state.me.id,
      memberIds: [state.me.id],
      members: [{ id: state.me.id, name: state.me.name, color: state.me.color, sharingEnabled: state.me.sharingEnabled, online: true }],
    };
    state.circles.push(circle);
    el('circle-name').value = '';
    selectCircle(circle.id);
    return;
  }
  try {
    const { circle } = await api('/api/circles', { method: 'POST', body: JSON.stringify({ name }) });
    state.circles.push(circle);
    el('circle-name').value = '';
    selectCircle(circle.id);
  } catch (err) {
    toast(err.message, true);
  }
});

const currentCircle = () => state.circles.find((c) => c.id === state.selectedCircle) || state.circles[0] || null;

function selectCircle(id) {
  state.selectedCircle = id;
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({
      type: 'subscribe',
      circleId: id,
      hours: Number(el('hours-select').value),
    }));
    state.ws.send(JSON.stringify({ type: 'viewing', active: true, circleId: id }));
  }
  renderCircles();
  renderMembers();
  renderSharing();
  if (window.innerWidth <= 780) setSidebar(false);
}

/* -------------------------------- members -------------------------------- */

el('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const circle = currentCircle();
  if (!circle) return toast('Select a circle first.', true);
  if (state.isLocal) {
    const email = el('invite-email').value.trim();
    if (!email) return;
    const dummyId = 'mem-' + Date.now();
    circle.memberIds.push(dummyId);
    circle.members.push({ id: dummyId, name: email.split('@')[0], color: '#10b981', sharingEnabled: true, online: true });
    el('invite-email').value = '';
    toast(`${circle.name} now has ${circle.members.length} member(s).`);
    renderCircles();
    renderMembers();
    renderSharing();
    return;
  }
  try {
    const { circle: updated } = await api(`/api/circles/${circle.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: el('invite-email').value }),
    });
    state.circles = state.circles.map((c) => (c.id === updated.id ? updated : c));
    el('invite-email').value = '';
    toast(`${updated.name} now has ${updated.members.length} member(s).`);
    renderCircles();
    renderMembers();
    renderSharing();
    drawTrails();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------ invite link ------------------------------ */

const inviteLinkBtn = el('invite-link-btn');
const inviteLinkInput = el('invite-link-input');
const inviteLinkCopy = el('invite-link-copy');

if (inviteLinkBtn) {
  inviteLinkBtn.addEventListener('click', async () => {
    const circle = currentCircle();
    if (!circle) return toast('Select or create a circle first.', true);
    if (state.isLocal) {
      const url = location.href.split('?')[0] + '?join=local-demo';
      inviteLinkInput.value = url;
      inviteLinkInput.hidden = false;
      inviteLinkCopy.hidden = false;
      toast('Local mode: invite links work once you deploy to a real server.');
      return;
    }
    try {
      const { url } = await api(`/api/circles/${circle.id}/invite-link`, { method: 'POST' });
      inviteLinkInput.value = url;
      inviteLinkInput.hidden = false;
      inviteLinkCopy.hidden = false;
      toast('Link ready — send it to anyone you want in this circle.');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

if (inviteLinkCopy) {
  inviteLinkCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(inviteLinkInput.value).then(() => {
      toast('Copied to clipboard!');
    }).catch(() => {
      inviteLinkInput.select();
      document.execCommand('copy');
      toast('Copied!');
    });
  });
}

async function handleJoinCode(code) {
  if (!code || code === 'local-demo') return;
  try {
    const { circle } = await api(`/api/join/${code}`);
    // Add circle if not already in state
    if (!state.circles.find((c) => c.id === circle.id)) {
      state.circles.push(circle);
    } else {
      state.circles = state.circles.map((c) => (c.id === circle.id ? circle : c));
    }
    state.selectedCircle = circle.id;
    renderCircles();
    renderMembers();
    renderSharing();
    toast(`You joined "${circle.name}"! Turn on Share My Location so others can see you.`);
    // Clean the URL
    history.replaceState(null, '', '/');
  } catch (err) {
    toast(err.message || 'Invalid or expired invite link.', true);
    history.replaceState(null, '', '/');
  }
}

/* ---------------------------------- SOS ---------------------------------- */

el('sos-btn').addEventListener('click', async () => {
  const text = prompt('What happened? (optional)') || '';
  const coords = currentCoords();
  const body = { text, includeLocation: state.me.sharingEnabled };
  if (coords) {
    body.lat = coords.lat;
    body.lon = coords.lon;
  }
  if (state.isLocal) {
    toast('Emergency alert triggered locally.');
    showAlert({ id: 'local-sos', text, includeLocation: state.me.sharingEnabled, lat: body.lat, lon: body.lon, acknowledged: [] }, state.me);
    return;
  }
  try {
    await api('/api/sos', { method: 'POST', body: JSON.stringify(body) });
    toast('Emergency alert sent to your circles.');
  } catch (err) {
    toast(err.message, true);
  }
});

function showAlert(alert, user) {
  state.pendingAlert = alert;
  el('sos-title').textContent = `Emergency: ${user ? user.name : 'Someone'}`;
  el('sos-detail').textContent = [
    alert.text || 'No message',
    alert.includeLocation && alert.lat != null
      ? `Location shared (${alert.lat.toFixed(4)}, ${alert.lon.toFixed(4)})`
      : 'Location not shared',
    alert.acknowledged.length ? `${alert.acknowledged.length} responding` : null,
  ].filter(Boolean).join(' · ');
  el('sos-banner').hidden = false;
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('Emergency alert', {
        body: `${user ? user.name : 'Someone'} needs help. ${alert.text || ''}`,
      });
    } catch { /* notification failed, banner still shows */ }
  }
}

el('sos-ack').addEventListener('click', async () => {
  if (!state.pendingAlert) return;
  try {
    await api(`/api/sos/${state.pendingAlert.id}/ack`, { method: 'POST' });
    toast('Marked as responding.');
  } catch (err) {
    toast(err.message, true);
  }
  el('sos-banner').hidden = true;
  state.pendingAlert = null;
});

el('sos-close').addEventListener('click', () => {
  el('sos-banner').hidden = true;
  state.pendingAlert = null;
});

/* ------------------------------- rendering ------------------------------- */

function renderCircles() {
  const list = el('circle-list');
  list.innerHTML = '';

  // A silent dead socket looks identical to "nobody is sharing". Say which it is.
  const status = document.createElement('p');
  status.className = 'conn-state' + (state.wsStatus === 'live' ? ' ok' : '');
  status.textContent = state.isLocal
    ? 'Local demo mode — no server connection'
    : state.wsStatus === 'live'
      ? 'Connected'
      : state.wsStatus === 'connecting'
        ? 'Connecting…'
        : 'Reconnecting — locations will not update';
  list.appendChild(status);

  if (!state.circles.length) {
    list.innerHTML = '<p class="muted small">No circles yet. Create one to get started.</p>';
    el('member-list').innerHTML = '<p class="muted small">No circle selected.</p>';
    return;
  }
  const circle = currentCircle();
  for (const c of state.circles) {
    const row = document.createElement('div');
    row.className = 'row' + (circle && c.id === circle.id ? ' active' : '');
    row.innerHTML = `
      <span class="dot" style="background:${userColor(c.memberIds[0])}"></span>
      <span>${escapeHtml(c.name)}</span>
      <span class="meta muted small">${c.members.length}</span>`;
    row.addEventListener('click', () => selectCircle(c.id));
    list.appendChild(row);
  }
}

function renderMembers() {
  const list = el('member-list');
  const circle = currentCircle();
  if (!circle) {
    list.innerHTML = '<p class="muted small">No circle selected.</p>';
    return;
  }

  list.innerHTML = '';
  for (const m of circle.members) {
    const isMe = m.id === state.me.id;
    const live = state.live.get(m.id);
    const online = state.online.has(m.id);
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cursor = 'default';
    const status = m.sharingEnabled
      ? (online ? 'Sharing now' : 'Sharing · offline')
      : 'Not sharing';
    row.title = m.sharingEnabled ? '' : 'Turn sharing on on their device to see their position';
    row.innerHTML = `
      <span class="dot" style="background:${m.color}"></span>
      <span>${escapeHtml(m.name)}${isMe ? ' (you)' : ''}<span class="muted small block">${status}</span></span>
      <span class="meta muted small">${live ? ago(live.t) : '—'}</span>`;
    list.appendChild(row);
  }

  // Silence on an empty map is the most confusing failure mode, so say why.
  const noPositions = [...state.markers.keys()].filter((id) => {
    const m = circle.members.find((x) => x.id === id);
    return m && !m.sharingEnabled;
  });
  if (!state.markers.size || noPositions.length) {
    const parts = [];
    if (!state.markers.size) parts.push('No one in this circle is sharing a position yet.');
    else if (noPositions.length) {
      parts.push(`${noPositions.length} member(s) have sharing turned off, so their position is hidden.`);
    }
    const note = document.createElement('p');
    note.className = 'muted small';
    note.style.marginTop = '8px';
    note.textContent = parts.join(' ');
    list.appendChild(note);
  }
}

// Location traffic is the most reliable signal that a member is actually
// sharing, so keep the circle summaries in step with it.
function markSharing(userId, on) {
  for (const c of state.circles) {
    const m = c.members.find((x) => x.id === userId);
    if (m) m.sharingEnabled = on;
  }
}

function bannerText() {
  const names = state.circles
    .filter((c) => state.me.shareCircles.includes(c.id))
    .map((c) => c.name);
  const viewers = state.viewers.length;
  return `Visible to ${names.join(', ') || 'nobody yet'}${viewers ? ` · ${viewers} viewing now` : ''}`;
}

function renderSharing() {
  const me = state.me;
  if (!me) return;

  el('sharing-toggle').checked = me.sharingEnabled;
  el('mode-fieldset').disabled = !me.sharingEnabled;
  el('share-targets').disabled = !me.sharingEnabled;

  const modeRadio = document.querySelector(`input[name="mode"][value="${me.mode}"]`);
  if (modeRadio) modeRadio.checked = true;

  const targets = el('target-list');
  targets.innerHTML = '';
  el('target-empty').hidden = state.circles.length > 0;
  for (const c of state.circles) {
    const label = document.createElement('label');
    const checked = me.shareCircles.includes(c.id) ? 'checked' : '';
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(c.id)}" ${checked} /> ${escapeHtml(c.name)}`;
    targets.appendChild(label);
  }

  el('sharing-banner').hidden = !me.sharingEnabled;
  if (me.sharingEnabled) el('banner-detail').textContent = bannerText();

  const note = el('viewer-note');
  note.hidden = false;
  if (state.viewers.length) {
    note.textContent = `${state.viewers.length} person(s) can see your location right now.`;
  } else if (me.sharingEnabled) {
    note.textContent = 'Nobody is currently viewing your location.';
  } else if (state.circles.length) {
    note.textContent = 'You are not broadcasting, but you can still see everyone sharing in your circles.';
  } else {
    note.textContent = 'Create a circle to share or view locations.';
  }

  const displayEmail = (me.email || '').endsWith('@beacon.local') ? '(guest session)' : me.email;
  el('me-line').textContent = `${me.name || displayEmail} · mode: ${me.mode === 'network' ? 'cell / WiFi' : 'GPS'}`;

  if (!me.sharingEnabled) setGpsState('Sharing is off — your position is not sent anywhere');
  else if (!state.lastFix) setGpsState('Waiting for a position fix…');
}

function renderPresence() {
  const circle = currentCircle();
  if (!circle) return;
  for (const m of circle.members) m.online = state.online.has(m.id);
}

setInterval(() => {
  if (!state.me) return;
  renderMembers();
  if (state.me.sharingEnabled && !el('sharing-banner').hidden) {
    el('banner-detail').textContent = bannerText();
  }
}, 5000);

/* ------------------------------- websocket ------------------------------- */

function connectWs() {
  if (!state.token || state.isLocal) return;
  const ws = new WebSocket(wsEndpoint(state.token));
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.wsRetry = 0;
    state.wsStatus = 'live';
    renderCircles();
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'hello': {
        state.me = msg.me;
        state.circles = msg.circles;
        state.online = new Set();
        if (!state.selectedCircle && state.circles.length) state.selectedCircle = state.circles[0].id;
        for (const p of msg.live) placeMarker(p.userId, p);
        renderCircles();
        renderMembers();
        renderSharing();
        if (state.selectedCircle) selectCircle(state.selectedCircle);
        break;
      }

case 'location': {
          markSharing(msg.userId, true);
          placeMarker(msg.userId, msg);
          if (msg.userId !== state.me.id) {
            pushPoint(msg.userId, msg);
            renderMembers();
          }
          break;
        }

      case 'trail': {
        state.live.set(msg.userId, msg.points[msg.points.length - 1]);
        state.points.set(msg.userId, msg.points);
        drawTrails();
        renderMembers();
        break;
      }

      case 'presence': {
        if (msg.online) state.online.add(msg.userId);
        else state.online.delete(msg.userId);
        renderPresence();
        renderMembers();
        break;
      }

case 'sharing': {
          markSharing(msg.user.id, msg.user.sharingEnabled);
          if (!msg.user.sharingEnabled) removeMarker(msg.user.id);
          renderMembers();
          break;
        }

      case 'viewers': {
        state.viewers = msg.ids;
        renderSharing();
        break;
      }

      case 'circle-updated': {
        state.circles = state.circles.map((c) => (c.id === msg.circle.id ? msg.circle : c));
        renderCircles();
        renderMembers();
        renderSharing();
        break;
      }

      case 'circle-removed': {
        state.circles = state.circles.filter((c) => c.id !== msg.circleId);
        if (state.selectedCircle === msg.circleId) state.selectedCircle = state.circles[0]?.id || null;
        renderCircles();
        renderMembers();
        renderSharing();
        break;
      }

      case 'sos': {
        showAlert(msg.alert, msg.user);
        break;
      }

      case 'sos-ack': {
        toast(`${msg.by.name} is responding.`);
        break;
      }

      default:
        break;
    }
  });

  ws.addEventListener('close', () => {
    if (!state.token) return;
    state.wsStatus = 'offline';
    renderCircles();
    state.wsRetry = Math.min(state.wsRetry + 1, 6);
    setTimeout(connectWs, 500 * 2 ** state.wsRetry);
  });

  ws.addEventListener('error', () => ws.close());
}

/* --------------------------------- boot ---------------------------------- */

const menuBtn = el('menu-btn');
const sidebar = el('sidebar');
function setSidebar(open) {
  if (!sidebar) return;
  sidebar.classList.toggle('open', open);
  if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
  const scrim = el('sidebar-scrim');
  if (scrim) scrim.hidden = !open || window.innerWidth > 780;
  syncMapSize();
}
if (menuBtn) {
  menuBtn.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
}
if (el('sidebar-scrim')) {
  el('sidebar-scrim').addEventListener('click', () => setSidebar(false));
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setSidebar(false);
});
// A circle chosen on a narrow screen should hand the map back to the user.
window.addEventListener('resize', () => {
  if (window.innerWidth > 780) setSidebar(false);
});

async function startApp(user, meData) {
  state.isLocal = false;
  if (el('auth')) el('auth').hidden = true;
  if (el('app')) el('app').hidden = false;

  const me = meData || (await api('/api/me'));
  state.me = me.user;
  state.mode = me.user.mode || 'gps';
  state.circles = me.circles || [];
  state.viewers = me.viewers || [];

  if (el('display-name-input')) {
    el('display-name-input').value = state.me.name || '';
  }

  ensureMap();
  animateMarkers();
  if (!state.selectedCircle && state.circles.length) state.selectedCircle = state.circles[0].id;

  renderCircles();
  renderMembers();
  renderSharing();
  connectWs();

  if (state.me.sharingEnabled) {
    startWatching();
    startSharingLoop();
  }

  if (state.selectedCircle) selectCircle(state.selectedCircle);
}

function startLocalApp() {
  state.isLocal = true;
  if (el('auth')) el('auth').hidden = true;
  if (el('app')) el('app').hidden = false;

  const localName = localStorage.getItem('beacon.preferredName') || 'Explorer';
  state.me = {
    id: 'local-user',
    name: localName,
    email: 'local@beacon.device',
    color: '#38bdf8',
    sharingEnabled: false,
    shareCircles: ['local-circle'],
    mode: 'gps',
  };
  state.circles = [
    {
      id: 'local-circle',
      name: 'Family',
      ownerId: 'local-user',
      memberIds: ['local-user'],
      members: [
        {
          id: 'local-user',
          name: localName,
          color: '#38bdf8',
          sharingEnabled: false,
          online: true,
        },
      ],
    },
  ];
  state.selectedCircle = 'local-circle';

  if (el('display-name-input')) {
    el('display-name-input').value = state.me.name;
  }

  ensureMap();
  animateMarkers();
  renderCircles();
  renderMembers();
  renderSharing();
  toast('Running in instant local mode.');
}

async function ensureUserSession() {
  if (state.token) {
    try {
      const me = await api('/api/me');
      await startApp(me.user, me);
      return;
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
    }
  }

  try {
    const res = await fetch(API_BASE + '/api/auth/guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: localStorage.getItem('beacon.preferredName') || '' }),
    });
    if (res.ok) {
      const data = await res.json();
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      const me = await api('/api/me');
      await startApp(data.user, me);
      return;
    }
  } catch (err) {
    console.warn('Backend not reachable, switching to local mode:', err);
  }

  startLocalApp();
}

(async function boot() {
  await ensureUserSession();
  // Handle invite links like /?join=XXXXX
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) await handleJoinCode(joinCode);
})();