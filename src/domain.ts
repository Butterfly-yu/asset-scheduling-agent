import { createHash } from 'node:crypto';

export type Item = { assetId: string; channel: string; requiredTime: string };
export type Request = { requestId: string; items: Item[] };
export type Asset = { title?: string; licensed?: boolean; channels?: string[] };
export type Rules = { version: string; required: (keyof Asset)[]; licenseRuleId: string; channelRuleId: string };
export type Review = { status: 'pass' | 'missing_info' | 'blocked'; missing: string[];
  risks: { ruleId: string; reason: string }[]; version: string };
export type Draft = { draftId: string; time: string; review: Review };
export type Seed = { channel: string; time: string; label: string };

const token = /^[\w-]{1,64}$/;
export function normalizeTime(value: unknown): string {
  if (typeof value !== 'string') throw new Error('时间必须是带时区的 ISO 8601 字符串');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const wall = m ? new Date(`${m[1]}:00Z`) : null;
  const date = new Date(value);
  if (!wall || !Number.isFinite(wall.getTime()) || wall.toISOString().slice(0,16) !== m![1]
      || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
    throw new Error('无效时段；格式如 2026-12-01T18:00:00+08:00');
  return date.toISOString();
}

export function parseRequest(value: unknown): Request {
  if (!value || typeof value !== 'object') throw new Error('请求必须是对象');
  const v = value as Request;
  if (typeof v.requestId !== 'string' || !token.test(v.requestId) || !Array.isArray(v.items)
      || v.items.length < 1 || v.items.length > 8) throw new Error('需要合法的 requestId 和 1–8 项素材');
  const seen = new Set<string>();
  return { requestId: v.requestId, items: v.items.map(item => {
    if (!item || typeof item.assetId !== 'string' || !token.test(item.assetId)
        || typeof item.channel !== 'string' || !token.test(item.channel)) throw new Error('需要合法的素材 ID 和渠道');
    if (seen.has(item.assetId)) throw new Error('同一请求不得重复指定素材 ID');
    seen.add(item.assetId);
    normalizeTime(item.requiredTime);
    return {assetId: item.assetId, channel: item.channel, requiredTime: item.requiredTime};
  })};
}

export const fingerprint = (req: Request) => createHash('sha256')
  .update(JSON.stringify(req.items.map(i => [i.assetId, i.channel, normalizeTime(i.requiredTime), i.requiredTime.slice(19)])))
  .digest('hex');

export function evaluate(asset: Asset | undefined, channel: string, rules: Rules): Review {
  const missing = asset ? rules.required.filter(k => {
    if (k === 'licensed') return typeof asset.licensed !== 'boolean';
    if (k === 'title') return typeof asset.title !== 'string' || !asset.title.trim();
    return !Array.isArray(asset.channels) || !asset.channels.every(c => typeof c === 'string') || !asset.channels.length;
  }) : ['asset'];
  const risks: Review['risks'] = [];
  if (asset?.licensed === false) risks.push({ruleId: rules.licenseRuleId, reason:'未取得素材授权'});
  if (Array.isArray(asset?.channels) && asset.channels.length && !asset.channels.includes(channel))
    risks.push({ruleId: rules.channelRuleId, reason:'素材未获该渠道使用许可'});
  return {status: risks.length ? 'blocked' : missing.length ? 'missing_info' : 'pass', missing, risks, version: rules.version};
}

export function nearby(time: string): string[] {
  const hour = Number(time.slice(11,13));
  return [1,2,3].filter(n => hour+n < 24)
    .map(n => time.slice(0,11) + String(hour+n).padStart(2,'0') + time.slice(13));
}
