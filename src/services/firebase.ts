import admin from 'firebase-admin';
import { config, hasFirebase } from '../config/env.js';

let initialized = false;
let db: admin.database.Database | null = null;

export function initFirebase(): void {
  if (initialized || !hasFirebase()) return;
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey,
    }),
    databaseURL: config.firebase.databaseURL,
  });
  initialized = true;
}

export function getDb(): admin.database.Database | null {
  if (!hasFirebase()) return null;
  if (!initialized) initFirebase();
  if (!db) db = admin.database();
  return db;
}

export function isDbAvailable(): boolean {
  return hasFirebase();
}

export async function verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
  if (!hasFirebase()) throw new Error('Firebase not configured');
  if (!initialized) initFirebase();
  return admin.auth().verifyIdToken(idToken);
}

// ---- In-memory fallback store (dev without Firebase) ----
const mem = new Map<string, any>();
export const memStore = {
  get(path: string): any {
    return mem.get(path) ?? null;
  },
  set(path: string, val: any): void {
    mem.set(path, val);
  },
  push(path: string, val: any): string {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const cur = mem.get(path) ?? {};
    cur[id] = val;
    mem.set(path, cur);
    return id;
  },
};

export async function dbGet(path: string): Promise<any> {
  const d = getDb();
  if (!d) return memStore.get(path);
  const snap = await d.ref(path).get();
  return snap.exists() ? snap.val() : null;
}

export async function dbSet(path: string, val: any): Promise<void> {
  const d = getDb();
  if (!d) {
    memStore.set(path, val);
    return;
  }
  await d.ref(path).set(val);
}

export async function dbUpdate(path: string, val: Record<string, any>): Promise<void> {
  const d = getDb();
  if (!d) {
    const cur = memStore.get(path) ?? {};
    memStore.set(path, { ...cur, ...val });
    return;
  }
  await d.ref(path).update(val);
}

export async function dbPush(path: string, val: any): Promise<string> {
  const d = getDb();
  if (!d) return memStore.push(path, val);
  const ref = await d.ref(path).push(val);
  return ref.key as string;
}
