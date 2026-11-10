import { evaluate, nearby, normalizeTime } from './domain.ts';
import type { Asset, Draft, Item, Review, Rules } from './domain.ts';
import { Store } from './store.ts';

export type ToolResult = { code: string; [key: string]: unknown };
export type Data = {assets: Record<string, Asset>; rules: Rules};
const choice = (enumValues: string[]) => ({type:'string', enum:enumValues});
const string = {type:'string'};
const definitions = [
  ['get_asset', '读取当前请求项的素材元数据和资料状态', {}],
  ['check_rules', '审核当前素材在指定渠道的授权和必填字段；先读取素材', {}],
  ['query_slots', '查看硬性时段或同渠道同日接下来的可用时段', {scope:choice(['requested','alternatives'])}],
  ['save_draft', '保存当前素材的排期草稿；必须审核通过且指定时段已查。只有原始硬性时段可保存', {time:string}],
] as const;
export const tools = definitions.map(([name,description,properties]) => ({
  type:'function', function:{name,description,parameters:{type:'object',properties,
    required:Object.keys(properties),additionalProperties:false}}
}));

export function createTools(store: Store, data: Data, requestId: string, item: Item, failSave: boolean) {
  let loaded = false;
  let review: Review | undefined;
  let draft: Draft | undefined;
  let saveStatus = 'not_attempted';
  let requestedChecked = false;
  let requestedOccupied = false;
  let available: string[] = [];
  const asset = Object.hasOwn(data.assets,item.assetId) ? data.assets[item.assetId] : undefined;

  function run(name: string, args: Record<string, unknown>): ToolResult {
    const valid = tools.find(t => t.function.name === name)?.function.parameters.required;
    if (!valid || Object.keys(args).length !== valid.length || !valid.every(k => typeof args[k] === 'string'))
      return {code:'INVALID_TOOL_OR_ARGUMENTS'};
    switch (name) {
      case 'get_asset':
        loaded = true;
        return asset ? {code:'FOUND', assetId:item.assetId, metadata:asset} : {code:'ASSET_NOT_FOUND', assetId:item.assetId};
      case 'check_rules':
        if (!loaded) return {code:'READ_ASSET_FIRST'};
        review = evaluate(asset,item.channel,data.rules);
        return {code:review.status.toUpperCase(), ...review};
      case 'query_slots':
        if (args.scope === 'requested') {
          requestedOccupied = store.occupied(item.channel,item.requiredTime);
          requestedChecked = true;
          return {code:requestedOccupied?'OCCUPIED':'AVAILABLE', time:item.requiredTime};
        }
        if (args.scope !== 'alternatives') return {code:'INVALID_TOOL_OR_ARGUMENTS'};
        available = nearby(item.requiredTime).filter(t => !store.occupied(item.channel,t));
        return {code:available.length?'CANDIDATES_FOUND':'NO_CANDIDATES', available};
      case 'save_draft': {
        let candidate: string;
        try { candidate = normalizeTime(args.time); } catch { return {code:'INVALID_TOOL_OR_ARGUMENTS'}; }
        if (candidate !== normalizeTime(item.requiredTime)) return {code:'CONFIRMATION_REQUIRED'};
        if (!review || review.status !== 'pass' || evaluate(asset,item.channel,data.rules).status !== 'pass')
          return {code:'REVIEW_REQUIRED'};
        if (!requestedChecked) return {code:'QUERY_REQUIRED'};
        const result = store.save(requestId,item,review,failSave);
        if ('draft' in result) {
          draft = result.draft;
          saveStatus = result.code === 'REPLAY' ? 'replayed' : 'saved';
        } else if (result.code === 'SLOT_TAKEN') {
          requestedOccupied = true;
        } else if (!draft) saveStatus = 'failed';
        return result;
      }
      default: return {code:'INVALID_TOOL_OR_ARGUMENTS'};
    }
  }

  function result(final: {suggestedTime?:unknown} | undefined, stopReason?: string) {
    const candidate = final?.suggestedTime;
    const pending = !stopReason && !draft && review?.status === 'pass' && requestedOccupied &&
      typeof candidate === 'string' && available.includes(candidate) &&
      !store.occupied(item.channel,candidate) ? candidate : null;
    let status = 'incomplete';
    let reason: string | null = stopReason ?? null;
    let scheduleStatus = requestedOccupied ? 'conflict' : 'unresolved';
    if (draft) { status='saved'; scheduleStatus='scheduled'; reason=null; }
    else if (stopReason) { /* A run stopped before completing. */ }
    else if (review?.status === 'blocked') { status='blocked'; scheduleStatus='blocked'; reason='RULE_VIOLATION'; }
    else if (review?.status === 'missing_info' || (loaded && !asset)) {
      status='needs_info'; scheduleStatus='needs_info'; reason='MISSING_ASSET_INFO';
    }
    else if (pending) { status='pending_confirmation'; scheduleStatus='pending_confirmation'; reason='TIME_CHANGE_REQUIRES_CONFIRMATION'; }
    else if (saveStatus === 'failed') reason='WRITE_FAILED';
    else reason=requestedOccupied?'NO_CONFIRMED_SLOT':'NO_VERIFIED_OUTCOME';
    return {
      assetId:item.assetId, channel:item.channel, requiredTime:item.requiredTime,
      status, reason, reviewStatus:review?.status ?? (loaded && !asset?'missing_info':'unknown'),
      ruleVersion:review?.version ?? null, risks:review?.risks ?? [],
      missing:review?.missing ?? (loaded && !asset?['asset']:[]),
      scheduleStatus, suggestedTime:draft?.time ?? pending, needsConfirmation:!!pending,
      saveStatus, draftId:draft?.draftId ?? null
    };
  }
  return {run,result};
}
