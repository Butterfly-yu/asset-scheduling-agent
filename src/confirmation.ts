import { evaluate } from './domain.ts';
import { Store } from './store.ts';
import type { Data } from './tools.ts';

const guidance:Record<string,string> = {
  PROPOSAL_NOT_FOUND:'在原 SQLite 文件中使用排期输出给出的 proposalId。',
  DRAFT_ALREADY_EXISTS:'该素材已有同一请求的草稿；请先查看已保存排期。',
  SLOT_TAKEN:'建议时段已被占用；用同一原始请求重新查找候选。',
  WRITE_FAILED:'草稿未提交；排除存储故障后可用同一提案重试。',
  RULE_VIOLATION:'当前规则已阻断素材；先处理风险，再重新审核。',
  MISSING_ASSET_INFO:'补全当前缺失资料后再确认。'
};

export function confirmProposal(store:Store, data:Data, proposalId:string, failSave=false) {
  const result = store.confirm(proposalId,(assetId,channel)=>evaluate(
    Object.hasOwn(data.assets,assetId)?data.assets[assetId]:undefined,channel,data.rules),failSave);
  const draft = 'draft' in result ? result.draft : undefined;
  const review = draft?.review ?? ('review' in result ? result.review : undefined);
  const saved = !!draft;
  const status = saved ? 'saved' : result.code === 'RULE_VIOLATION' ? 'blocked'
    : result.code === 'MISSING_ASSET_INFO' ? 'needs_info' : 'incomplete';
  return {
    proposalId, requestId:result.proposal?.requestId ?? null, assetId:result.proposal?.assetId ?? null,
    channel:result.proposal?.channel ?? null, requiredTime:result.proposal?.requiredTime ?? null,
    suggestedTime:result.proposal?.suggestedTime ?? null, confirmedTime:draft?.time ?? null,
    status, reason:saved ? null : result.code, nextStep:guidance[result.code] ?? null,
    reviewStatus:review?.status ?? 'unknown', ruleVersion:review?.version ?? null,
    risks:review?.risks ?? [], missing:review?.missing ?? [],
    saveStatus:result.code==='REPLAY'?'replayed':saved?'saved':result.code==='WRITE_FAILED'?'failed':'not_attempted',
    draftId:draft?.draftId ?? null,
    trace:[{step:1,action:'confirm_proposal',args:{proposalId},result:{code:result.code,draftId:draft?.draftId ?? null},
      nextAction:'finish:'+status,basis:saved?'人工确认绑定提案，使用 SQLite 提交回执':'未提交确认草稿，原因见结果码'}]
  };
}
