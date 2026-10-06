import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const dbFile = path.join(dataDir, 'db.json');

const EMPTY = {
  users: [],
  sessions: [],
  circles: [],
  trails: {},
  sos: [],
};

// Optional durable store for hosts with an ephemeral filesystem (Render free,
// serverless). When Upstash REST credentials are set, the database is loaded
// from Redis at boot and written back on a slow debounce, so accounts, circles
// and trails survive redeploys, restarts and spin-downs. Without credentials
// everything works exactly as before against data/db.json.
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const REMOTE_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const REMOTE_KEY = (process.env.TRACKER_DB_KEY || 'tracker:db').trim();
const remoteEnabled = Boolean(REMOTE_URL && REMOTE_TOKEN);

// Writes are debounced: locally fast so tests see data immediately, remotely
// slow to stay inside Upstash's free monthly command budget.
const FLUSH_DELAY = remoteEnabled ? 15000 : 250;

function loadFile() {
  try {
    const raw = fs.readFileSync(dbFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
}

// Payloads are gzipped and base64'd: trails can reach several MB, and this
// keeps every SET/GET comfortably inside Upstash's request limits.
function encode() {
  return `gzip:${zlib.gzipSync(JSON.stringify(db)).toString('base64')}`;
}

function decode(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const json = raw.startsWith('gzip:')
    ? zlib.gunzipSync(Buffer.from(raw.slice(5), 'base64')).toString('utf8')
    : raw;
  return JSON.parse(json);
}

async function remoteCall(args) {
  const res = await fetch(REMOTE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${REMOTE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${args[0]} responded ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return data.result;
}

async function loadDb() {
  const fromFile = { ...structuredClone(EMPTY), ...(loadFile() || {}) };
  if (!remoteEnabled) return fromFile;

  try {
    const stored = await remoteCall(['GET', REMOTE_KEY]);
    if (stored == null) {
      // First boot against an empty remote: seed it with whatever the local
      // file has (usually nothing on an ephemeral host).
      console.log('Remote db empty, seeding from local state');
      return fromFile;
    }
    const parsed = decode(stored);
    if (!parsed || typeof parsed !== 'object') throw new Error('unreadable payload');
    return { ...structuredClone(EMPTY), ...parsed };
  } catch (err) {
    console.error(`Remote db load failed (${err.message}), falling back to local file`);
    return fromFile;
  }
}

export const db = await loadDb();

let timer = null;
let dirty = false;
let chain = Promise.resolve();

function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeNow();
  }, FLUSH_DELAY);
}

async function doWrite() {
  dirty = false;
  try {
    writeFile();
    if (remoteEnabled) await remoteCall(['SET', REMOTE_KEY, encode()]);
  } catch (err) {
    console.error('Failed to persist db:', err.message);
  }
  if (dirty) schedule();
}

function writeNow() {
  chain = chain.then(doWrite);
  return chain;
}

export function save() {
  schedule();
}

export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  return writeNow();
}

// Seed the remote store on first boot, and mirror the local file otherwise.
if (remoteEnabled) save();

try {
  writeFile();
} catch (err) {
  console.error('Failed to write local db.json:', err.message);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush().finally(() => process.exit(0));
  });
}
