import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fingerprint, normalizeTime } from './domain.ts';
import type { Draft, Item, Request, Review, Seed } from './domain.ts';

export type Save = { code: 'SAVED' | 'REPLAY'; draft: Draft } | { code: 'SLOT_TAKEN' | 'WRITE_FAILED' };
export type Proposal = {proposalId:string; requestId:string; assetId:string; channel:string;
  requiredTime:string; suggestedTime:string; draftId:string|null};
type Confirm = {code:'SAVED'|'REPLAY'; proposal:Proposal; draft:Draft}
  | {code:'PROPOSAL_NOT_FOUND'|'DRAFT_ALREADY_EXISTS'|'SLOT_TAKEN'|'WRITE_FAILED'|'RULE_VIOLATION'|'MISSING_ASSET_INFO';
    proposal?:Proposal; review?:Review};
type ProposalResult = {code:'PROPOSED'; proposal:Proposal} | {code:'SLOT_TAKEN'|'PROPOSAL_WRITE_FAILED'};

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
        UNIQUE(channel, slot_utc), UNIQUE(request_id, asset_id));
      CREATE TABLE IF NOT EXISTS proposals(
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), asset_id TEXT NOT NULL,
        channel TEXT NOT NULL, required_time TEXT NOT NULL, suggested_time TEXT NOT NULL, slot_utc TEXT NOT NULL,
        draft_id TEXT REFERENCES schedule(id), UNIQUE(request_id, asset_id, slot_utc));`);
  }
  close() { this.db.close(); }
  seed(rows: Seed[]) {
    if (!rows.length) return;
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
  private writeDraft(requestId:string, item:Item, review:Review, failBeforeCommit:boolean): Draft {
    const draft = {draftId:randomUUID(), time:item.requiredTime, review};
    this.db.prepare(`INSERT INTO schedule VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(draft.draftId, item.channel, normalizeTime(item.requiredTime), item.requiredTime,
        requestId, item.assetId, JSON.stringify(review));
    if (failBeforeCommit) throw new Error('injected before commit');
    return draft;
  }
  save(requestId: string, item: Item, review: Review, failBeforeCommit = false): Save {
    try {
      return this.transaction<Save>(() => {
        const original = this.getDraft(requestId, item.assetId);
        if (original) return {code:'REPLAY', draft:original};
        if (this.occupied(item.channel, item.requiredTime)) return {code:'SLOT_TAKEN'};
        return {code:'SAVED', draft:this.writeDraft(requestId,item,review,failBeforeCommit)};
      });
    } catch { return {code:'WRITE_FAILED'}; }
  }
  propose(requestId:string, item:Item, suggestedTime:string): ProposalResult {
    try {
      return this.transaction<ProposalResult>(() => {
        if (this.occupied(item.channel,suggestedTime)) return {code:'SLOT_TAKEN'};
        const slot = normalizeTime(suggestedTime);
        this.db.prepare(`INSERT INTO proposals(id,request_id,asset_id,channel,required_time,suggested_time,slot_utc)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(request_id,asset_id,slot_utc) DO NOTHING`)
          .run(randomUUID(),requestId,item.assetId,item.channel,item.requiredTime,suggestedTime,slot);
        const row = this.db.prepare('SELECT id FROM proposals WHERE request_id=? AND asset_id=? AND slot_utc=?')
          .get(requestId,item.assetId,slot);
        const proposal = row && this.getProposal(String(row.id));
        if (!proposal) throw new Error('Proposal not stored');
        return {code:'PROPOSED',proposal};
      });
    } catch { return {code:'PROPOSAL_WRITE_FAILED'}; }
  }
  proposals() {
    return this.db.prepare(`SELECT p.id AS proposalId,p.request_id AS requestId,p.asset_id AS assetId,p.channel,
      p.required_time AS requiredTime,p.suggested_time AS suggestedTime,p.draft_id AS draftId,
      CASE WHEN p.draft_id IS NOT NULL THEN 'confirmed' WHEN s.id IS NOT NULL THEN 'superseded' ELSE 'pending' END AS status
      FROM proposals p LEFT JOIN schedule s ON s.request_id=p.request_id AND s.asset_id=p.asset_id
      ORDER BY p.rowid`).all();
  }
  private getProposal(proposalId:string): Proposal | undefined {
    const row = this.db.prepare(`SELECT id AS proposalId,request_id AS requestId,asset_id AS assetId,channel,
      required_time AS requiredTime,suggested_time AS suggestedTime,draft_id AS draftId FROM proposals WHERE id=?`).get(proposalId);
    return row ? row as unknown as Proposal : undefined;
  }
  confirm(proposalId:string, reviewFor:(assetId:string,channel:string)=>Review, failBeforeCommit=false): Confirm {
    let proposal: Proposal | undefined;
    let review: Review | undefined;
    try {
      return this.transaction<Confirm>(() => {
        proposal = this.getProposal(proposalId);
        if (!proposal) return {code:'PROPOSAL_NOT_FOUND'};
        const original = this.getDraft(proposal.requestId,proposal.assetId);
        if (original) return original.draftId === proposal.draftId
          ? {code:'REPLAY',proposal,draft:original}
          : {code:'DRAFT_ALREADY_EXISTS',proposal};
        review = reviewFor(proposal.assetId,proposal.channel);
        if (review.status !== 'pass') return {code:review.status==='blocked'?'RULE_VIOLATION':'MISSING_ASSET_INFO',proposal,review};
        if (this.occupied(proposal.channel,proposal.suggestedTime)) return {code:'SLOT_TAKEN',proposal,review};
        const draft = this.writeDraft(proposal.requestId,
          {assetId:proposal.assetId,channel:proposal.channel,requiredTime:proposal.suggestedTime},review,failBeforeCommit);
        this.db.prepare('UPDATE proposals SET draft_id=? WHERE id=?').run(draft.draftId,proposalId);
        return {code:'SAVED',proposal:{...proposal,draftId:draft.draftId},draft};
      });
    } catch { return {code:'WRITE_FAILED',proposal,review}; }
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
