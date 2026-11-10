import { evaluate, nearby, normalizeTime } from './domain.ts';
import type { Asset, Draft, Item, Review, Rules } from './domain.ts';
import { Store } from './store.ts';

export type ToolResult = { code: string; [key: string]: unknown };
export type Data = {assets: Record<string, Asset>; rules: Rules};
export type Fault = {tool:string; code:string; scope?:string};
const choice = (enumValues: string[]) => ({type:'string', enum:enumValues});
const string = {type:'string'};
const definitions = [
  ['get_asset', '读取当前请求项的素材元数据和资料状态', {}],
  ['check_rules', '审核当前素材在指定渠道的授权和必填字段；先读取素材', {}],
  ['query_slots', 'requested 查询原始时段；原时段占用后可用 alternatives 查同日备选', {scope:choice(['requested','alternatives'])}],
  ['save_draft', '只保存当前素材的原始硬性时段。使用用户请求中精确的 requiredTime；备选时段必须由用户另行确认', {time:string}],
] as const;
export const tools = definitions.map(([name,description,properties]) => ({
  type:'function', function:{name,description,parameters:{type:'object',properties,
    required:Object.keys(properties),additionalProperties:false}}
}));

const next: Record<string,string> = {
  RULE_VIOLATION:'处理风险后重新审核。',
  MISSING_ASSET_INFO:'补全列出的资料后重跑请求。',
  TIME_CHANGE_REQUIRES_CONFIRMATION:'由用户使用同一数据库和 proposalId 确认；如果本次使用内存库，请先用 --db 重新生成提案。',
  NO_ALTERNATIVE_SLOT:'当前备选窗口没有空位，请提供其他可接受的发布时间。',
  NO_CONFIRMED_SLOT:'请选择其他可接受的时段，或重新查询备选。',
  INVALID_SUGGESTION:'模型未返回查询证据中的候选；请重试以生成可验证的建议。',
  SUGGESTION_STALE:'候选已被占用，请重新查询。',
  SLOT_QUERY_FAILED:'排期查询失败，请检查数据库后重跑；不要根据本次结果安排发布。',
  ASSET_READ_FAILED:'素材读取失败，请检查素材数据后重跑。',
  RULE_CHECK_FAILED:'规则检查失败，请检查规则配置后重跑。',
  WRITE_FAILED:'草稿未提交；修复存储故障后用同一请求重试。',
  PROPOSAL_WRITE_FAILED:'待确认提案未保存；修复存储故障后重跑。',
  NO_VERIFIED_OUTCOME:'本次未获得完整证据；请查看 Trace 后重试。',
  BUDGET_EXHAUSTED:'达到调用上限，仍未完成；可用同一请求重试。'
};

export function createTools(store: Store, data: Data, requestId: string, item: Item, failSave: boolean, failQuery?:'requested'|'alternatives') {
  let loaded = false;
  let review: Review | undefined;
  let draft: Draft | undefined;
  let saveStatus = 'not_attempted';
  let requestedSlotStatus = 'unchecked';
  let available: string[] = [];
  let alternativesChecked = false;
  const outstanding = new Map<string,Fault>();
  const asset = Object.hasOwn(data.assets,item.assetId) ? data.assets[item.assetId] : undefined;
  const fault = (tool:string,code:string,scope?:string) => {
    const record = {tool,code,...(scope?{scope}:{})};
    outstanding.set(tool+':'+(scope??''),record);
    return record;
  };
  const resolve = (tool:string,scope='') => outstanding.delete(tool+':'+scope);

  function availableTools() {
    const queryFailed = [...outstanding.values()].some(f=>f.tool==='query_slots');
    return tools.filter(({function:{name}})=>name==='get_asset'
      || (name==='check_rules' && loaded)
      || (name==='query_slots' && review?.status==='pass' && !queryFailed)
      || (name==='save_draft' && review?.status==='pass' && requestedSlotStatus==='available'
          && !queryFailed && saveStatus==='not_attempted' && !draft))
      .map(tool=>tool.function.name==='query_slots' && requestedSlotStatus!=='occupied'
        ? {...tool,function:{...tool.function,parameters:{...tool.function.parameters,
          properties:{scope:choice(['requested'])}}}}
        : tool);
  }

  function run(name: string, args: Record<string, unknown>): ToolResult {
    const valid = tools.find(t => t.function.name === name)?.function.parameters.required;
    if (!valid || Object.keys(args).length !== valid.length || !valid.every(k => typeof args[k] === 'string'))
      return {code:'INVALID_TOOL_OR_ARGUMENTS'};
    switch (name) {
      case 'get_asset':
        try {
          const metadata = asset ? {title:asset.title,licensed:asset.licensed,channels:asset.channels} : undefined;
          loaded = true;
          resolve(name);
          return metadata ? {code:'FOUND', assetId:item.assetId, metadata} : {code:'ASSET_NOT_FOUND', assetId:item.assetId};
        } catch { return fault(name,'ASSET_READ_FAILED'); }
      case 'check_rules':
        if (!loaded) return {code:'READ_ASSET_FIRST'};
        try {
          review = evaluate(asset,item.channel,data.rules);
          resolve(name);
          return {code:review.status.toUpperCase(), ...review};
        } catch { review=undefined; return fault(name,'RULE_CHECK_FAILED'); }
      case 'query_slots':
        if (args.scope === 'requested') {
          try {
            if (failQuery==='requested') throw new Error('injected requested query failure');
            requestedSlotStatus = store.occupied(item.channel,item.requiredTime)?'occupied':'available';
            resolve(name,'requested');
            return {code:requestedSlotStatus==='occupied'?'OCCUPIED':'AVAILABLE', time:item.requiredTime};
          } catch {
            requestedSlotStatus='error';
            return fault(name,'SLOT_QUERY_FAILED','requested');
          }
        }
        if (args.scope !== 'alternatives') return {code:'INVALID_TOOL_OR_ARGUMENTS'};
        if (requestedSlotStatus !== 'occupied') return {code:'CONFLICT_REQUIRED'};
        try {
          if (failQuery==='alternatives') throw new Error('injected alternatives query failure');
          available = nearby(item.requiredTime).filter(t => !store.occupied(item.channel,t));
          alternativesChecked = true;
          resolve(name,'alternatives');
          return {code:available.length?'CANDIDATES_FOUND':'NO_CANDIDATES', available};
        } catch {
          available=[]; alternativesChecked=false;
          return fault(name,'SLOT_QUERY_FAILED','alternatives');
        }
      case 'save_draft': {
        let candidate: string;
        try { candidate = normalizeTime(args.time); } catch { return {code:'INVALID_TOOL_OR_ARGUMENTS'}; }
        if (candidate !== normalizeTime(item.requiredTime)) return {code:'CONFIRMATION_REQUIRED'};
        if (!review || review.status !== 'pass' || evaluate(asset,item.channel,data.rules).status !== 'pass')
          return {code:'REVIEW_REQUIRED'};
        if (requestedSlotStatus !== 'available') return {code:'QUERY_REQUIRED'};
        const result = store.save(requestId,item,review,failSave);
        if ('draft' in result) {
          draft = result.draft;
          saveStatus = result.code === 'REPLAY' ? 'replayed' : 'saved';
        } else if (result.code === 'SLOT_TAKEN') requestedSlotStatus='occupied';
        else if (!draft) saveStatus = 'failed';
        return result;
      }
      default: return {code:'INVALID_TOOL_OR_ARGUMENTS'};
    }
  }

  function result(final: {suggestedTime?:unknown} | undefined, stopReason?: string) {
    const candidate = final?.suggestedTime;
    let pending: string | null = null;
    let proposalId: string | null = null;
    let status = 'incomplete';
    let reason: string | null = null;
    let scheduleStatus = requestedSlotStatus==='occupied'?'conflict':'unresolved';
    const unresolved = [...outstanding.values()];
    if (draft) { status='saved'; scheduleStatus='scheduled'; }
    else if (review?.status === 'blocked') { status='blocked'; scheduleStatus='blocked'; reason='RULE_VIOLATION'; }
    else if (review?.status === 'missing_info' || (loaded && !asset)) {
      status='needs_info'; scheduleStatus='needs_info'; reason='MISSING_ASSET_INFO';
    }
    else if (saveStatus === 'failed') reason='WRITE_FAILED';
    else if (unresolved.length) reason=unresolved.at(-1)!.code;
    else if (stopReason) reason=stopReason;
    else if (review?.status === 'pass' && requestedSlotStatus==='occupied') {
      if (typeof candidate === 'string' && available.includes(candidate)) {
        const proposed = store.propose(requestId,item,candidate);
        if ('proposal' in proposed) {
          pending=proposed.proposal.suggestedTime;
          proposalId=proposed.proposal.proposalId;
          status='pending_confirmation'; scheduleStatus='pending_confirmation'; reason='TIME_CHANGE_REQUIRES_CONFIRMATION';
        } else reason=proposed.code==='SLOT_TAKEN'?'SUGGESTION_STALE':proposed.code;
      } else if (candidate != null) reason='INVALID_SUGGESTION';
      else reason=alternativesChecked && !available.length?'NO_ALTERNATIVE_SLOT':'NO_CONFIRMED_SLOT';
    } else reason='NO_VERIFIED_OUTCOME';
    return {
      assetId:item.assetId, channel:item.channel, requiredTime:item.requiredTime,
      status, reason, stopReason:stopReason ?? null, nextStep:reason ? next[reason] ?? '请查看 Trace 并重试。' : null,
      reviewStatus:review?.status ?? (loaded && !asset?'missing_info':'unknown'),
      ruleVersion:review?.version ?? null, risks:review?.risks ?? [],
      missing:review?.missing ?? (loaded && !asset?['asset']:[]),
      scheduleStatus, requestedSlotStatus, suggestedTime:draft?.time ?? pending, alternatives:[...available],
      needsConfirmation:!!pending, proposalId, toolErrors:unresolved,
      saveStatus, draftId:draft?.draftId ?? null
    };
  }
  return {run,result,availableTools};
}
