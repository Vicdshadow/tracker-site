import fs from 'node:fs';
import path from 'node:path';
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

function load() {
  try {
    const raw = fs.readFileSync(dbFile, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    return structuredClone(EMPTY);
  }
}

export const db = load();

let timer = null;
let writing = false;
let dirty = false;

function writeNow() {
  writing = true;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write db.json:', err);
  } finally {
    writing = false;
  }
  if (dirty) {
    dirty = false;
    schedule();
  }
}

function schedule() {
  dirty = true;
  if (timer || writing) return;
  timer = setTimeout(() => {
    timer = null;
    writeNow();
  }, 250);
}

export function save() {
  schedule();
}

export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  writeNow();
}

process.on('SIGINT', () => {
  flush();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});