import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fingerprint, normalizeTime } from './domain.ts';
import type { Draft, Item, Request, Review, Seed } from './domain.ts';

export type Save = { code: 'SAVED' | 'REPLAY'; draft: Draft } | { code: 'SLOT_TAKEN' | 'WRITE_FAILED' };

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 1500; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule(
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, slot_utc TEXT NOT NULL, display_time TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('existing','draft')), request_id TEXT REFERENCES requests(id),
        asset_id TEXT, review_json TEXT,
        UNIQUE(channel, slot_utc), UNIQUE(request_id, asset_id));`);
  }
  close() { this.db.close(); }
  seed(rows: Seed[]) {
    this.transaction(() => {
      const add = this.db.prepare(`INSERT INTO schedule(id, channel, slot_utc, display_time, kind)
        VALUES(?, ?, ?, ?, 'existing') ON CONFLICT(channel, slot_utc) DO NOTHING`);
      for (const row of rows) add.run(randomUUID(), row.channel, normalizeTime(row.time), row.time);
    });
  }
  bind(req: Request) {
    const hash = fingerprint(req);
    this.db.prepare('INSERT INTO requests VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(req.requestId, hash);
    const row = this.db.prepare('SELECT fingerprint FROM requests WHERE id=?').get(req.requestId);
    return row?.fingerprint === hash;
  }
  getDraft(requestId: string, assetId: string): Draft | undefined {
    const row = this.db.prepare(`SELECT id, display_time, review_json FROM schedule
      WHERE kind='draft' AND request_id=? AND asset_id=?`).get(requestId, assetId);
    return row ? {draftId:String(row.id), time:String(row.display_time), review:JSON.parse(String(row.review_json))} : undefined;
  }
  occupied(channel: string, time: string) {
    return !!this.db.prepare('SELECT 1 FROM schedule WHERE channel=? AND slot_utc=?').get(channel, normalizeTime(time));
  }
  drafts() {
    return this.db.prepare(`SELECT id AS draftId, request_id AS requestId, asset_id AS assetId,
      channel, display_time AS time FROM schedule WHERE kind='draft' ORDER BY rowid`).all();
  }
  save(requestId: string, item: Item, review: Review, failBeforeCommit = false): Save {
    try {
      return this.transaction<Save>(() => {
        const original = this.getDraft(requestId, item.assetId);
        if (original) return {code:'REPLAY', draft:original};
        if (this.occupied(item.channel, item.requiredTime)) return {code:'SLOT_TAKEN'};
        const draft = {draftId:randomUUID(), time:item.requiredTime, review};
        this.db.prepare(`INSERT INTO schedule VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`)
          .run(draft.draftId, item.channel, normalizeTime(item.requiredTime), item.requiredTime,
            requestId, item.assetId, JSON.stringify(review));
        if (failBeforeCommit) throw new Error('injected before commit');
        return {code:'SAVED', draft};
      });
    } catch { return {code:'WRITE_FAILED'}; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite may have already rolled back. */ }
      throw error;
    }
  }
}
