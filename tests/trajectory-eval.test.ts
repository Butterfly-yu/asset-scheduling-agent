import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTrajectory } from '../scripts/trajectory-metrics.ts';
import type { Evidence } from '../scripts/trajectory-metrics.ts';

const requiredTime='2026-12-01T18:00:00+08:00',alternative='2026-12-01T19:00:00+08:00';
const expected={requestId:'pair-001',assetId:'M01',channel:'short-video',requiredTime,alternative};
const item={assetId:expected.assetId,channel:expected.channel,requiredTime};
const query=(scene:'AVAILABLE'|'OCCUPIED')=>({
  turn:3,action:'query_slots',args:{scope:'requested'},result:{code:scene,time:requiredTime}});
const alternatives={turn:4,action:'query_slots',args:{scope:'alternatives'},
  result:{code:'CANDIDATES_FOUND',available:[alternative]}};
const pending:Evidence={requestId:expected.requestId,status:'action_required',
  item:{...item,status:'pending_confirmation',suggestedTime:alternative,draftId:null,needsConfirmation:true},
  drafts:[],trace:[query('OCCUPIED'),alternatives]};

test('冲突通过业务断言时，仍单独统计被拒绝的保存调用',()=>{
  const trace=[...pending.trace,{turn:5,action:'save_draft',args:{time:alternative},result:{code:'CONFIRMATION_REQUIRED'}},
    {turn:0,action:'persist_proposal',result:{code:'PROPOSED'}}];
  const score=scoreTrajectory('occupied',{...pending,trace},expected);
  assert.deepEqual(score,{businessPass:true,decisionPass:true,modelToolCalls:3,unnecessarySaveCalls:1});
});

test('判断动态决策时区分同一回合、下一回合和没有来源的候选',()=>{
  const score=scoreTrajectory('occupied',pending,expected);
  assert.equal(score.decisionPass,true);
  assert.equal(scoreTrajectory('occupied',{...pending,trace:[query('OCCUPIED'),{...alternatives,turn:3}]},expected).decisionPass,false);
  const unsupported={...alternatives,result:{code:'CANDIDATES_FOUND',available:['other-time']}};
  assert.equal(scoreTrajectory('occupied',{...pending,trace:[query('OCCUPIED'),unsupported]},expected).decisionPass,false);
});

test('正常排期必须有与输出匹配的数据库草稿，冲突场景不能有草稿',()=>{
  const draft={draftId:'draft-001',requestId:expected.requestId,assetId:expected.assetId,
    channel:expected.channel,time:requiredTime};
  const evidence:Evidence={requestId:expected.requestId,status:'completed',
    item:{...item,status:'saved',needsConfirmation:false,suggestedTime:requiredTime,draftId:draft.draftId},
    drafts:[draft],trace:[query('AVAILABLE'),{turn:4,action:'save_draft',args:{time:requiredTime},result:{code:'SAVED'}}]};
  assert.equal(scoreTrajectory('available',evidence,expected).businessPass,true);
  assert.equal(scoreTrajectory('available',{...evidence,drafts:[{...draft,channel:'wrong-channel'}]},expected).businessPass,false);
  assert.equal(scoreTrajectory('available',{...evidence,drafts:[]},expected).businessPass,false);
  assert.equal(scoreTrajectory('occupied',{...pending,drafts:[draft]},expected).businessPass,false);
});

test('模型补查正确但最终输出格式失败，动作通过、业务不通过',()=>{
  const result=scoreTrajectory('occupied',{...pending,status:'incomplete',
    item:{...pending.item,status:'incomplete',reason:'INVALID_FINAL_RESPONSE',suggestedTime:null,needsConfirmation:false}},expected);
  assert.equal(result.decisionPass,true);
  assert.equal(result.businessPass,false);
});
