import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {parseRequest,parseRules,parseSchedule,parseAssets} from '../src/domain.ts';
import {runRequest} from '../src/agent.ts';
import {confirmProposal} from '../src/confirmation.ts';
import {mockModel,scriptedCall} from '../src/model.ts';
import type {Decide} from '../src/model.ts';

const fixture = (name:string) => JSON.parse(readFileSync(new URL('../'+name,import.meta.url),'utf8'));
const data={assets:parseAssets(fixture('data/assets.json')),rules:parseRules(fixture('data/rules.json'))};
const req=parseRequest(fixture('examples/paired.input.json'));
const first=fixture('data/occupied.json')[0];
const time=(hour:number)=>`2026-12-01T${hour}:00:00+08:00`;
const seed=(hour:number)=>({...first,time:time(hour)});
const options={mode:'mock' as const,decide:mockModel};
function memory(t:TestContext, busy:number[] = [18]) {
  const db=new Store(':memory:');
  t.after(()=>db.close());
  db.seed(busy.map(seed));
  return db;
}
async function getProposal(db:Store) {
  const r=await runRequest(db,data,req,options);
  assert.equal(r.items[0].status,'pending_confirmation');
  const item=r.items[0];
  assert.ok(item.proposalId);
  return item;
}

test('排期查询失败进入最终结果；无时段写入、可重试',async t=>{
  for(const scope of ['requested','alternatives'] as const){
    const db=memory(t);
    const failed=await runRequest(db,data,req,{...options,failQuery:scope});
    const item=failed.items[0];
    assert.equal(item.status,'incomplete');
    assert.equal(item.reason,'SLOT_QUERY_FAILED');
    assert.deepEqual(item.toolErrors,[{tool:'query_slots',code:'SLOT_QUERY_FAILED',scope}]);
    assert.equal(item.proposalId,null);
    assert.equal(db.drafts().length,0);
    const recovered=await runRequest(db,data,req,options);
    assert.equal(recovered.items[0].status,'pending_confirmation');
    assert.deepEqual(recovered.items[0].toolErrors,[]);
  }
});

test('写入失败后模型格式错误不会遮掉已知的保存失败',async t=>{
  const db=memory(t,[]);
  const decide:Decide=async(h,s)=>{
    if(h.at(-1)?.content?.includes('"WRITE_FAILED"')) return {calls:[],text:'invalid-final'};
    return mockModel(h,s);
  };
  const failed=await runRequest(db,data,req,{...options,decide,failSave:true});
  assert.equal(failed.items[0].reason,'WRITE_FAILED');
  assert.equal(failed.items[0].stopReason,'INVALID_FINAL_RESPONSE');
  assert.equal(failed.items[0].saveStatus,'failed');
  assert.equal(db.drafts().length,0);
});

test('冲突后不向模型提供保存工具，模型伪造调用也被运行层拒绝',async t=>{
  const db=memory(t);
  let attempted=false;
  const decide:Decide=async(h,s,offered)=>{
    assert.ok(!offered?.some(tool=>tool.function.name==='save_draft'));
    if(!attempted && h.at(-1)?.content?.includes('"CANDIDATES_FOUND"')){
      attempted=true;
      return scriptedCall('save_draft',{time:time(19)},'fake-save');
    }
    if(attempted) return {calls:[],text:JSON.stringify({suggestedTime:time(19)})};
    return mockModel(h,s);
  };
  const r=await runRequest(db,data,req,{...options,decide});
  assert.equal(r.items[0].status,'pending_confirmation');
  assert.equal(r.trace.find(s=>s.action==='save_draft')?.result.code,'TOOL_NOT_AVAILABLE');
  assert.equal(db.drafts().length,0);
});

test('同一模型回合不能在读取素材前夹带未授权的工具',async t=>{
  const db=memory(t,[]);
  const decide:Decide=async(h,s)=>{
    if(h.length===2) return {text:null,calls:[
      ...scriptedCall('get_asset',{},'first').calls,...scriptedCall('save_draft',{time:time(18)},'second').calls]};
    return mockModel(h,s);
  };
  const r=await runRequest(db,data,req,{...options,decide});
  assert.equal(r.trace[1].result.code,'TOOL_NOT_AVAILABLE');
  assert.equal(db.drafts().length,0);
});

test('候选跟随实际占用；搜索范围无候选时明确返回原因',async t=>{
  const occupied=memory(t,[18,19]);
  assert.equal((await getProposal(occupied)).suggestedTime,time(20));
  const full=memory(t,[18,19,20,21]);
  const result=await runRequest(full,data,req,options);
  assert.equal(result.items[0].reason,'NO_ALTERNATIVE_SLOT');
  assert.equal(result.items[0].needsConfirmation,false);
  assert.equal(full.proposals().length,0);
});

test('跨连接确认及重放：原始时段保留，确认同一提案只保存一次',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'schedule-confirm-'));
  const path=join(folder,'confirm.sqlite');
  t.after(()=>{rmSync(path,{force:true});rmdirSync(folder);});
  const firstStore=new Store(path);
  let proposal:string;
  try {
    firstStore.seed([seed(18)]);
    proposal=(await getProposal(firstStore)).proposalId!;
    assert.equal((await getProposal(firstStore)).proposalId,proposal);
    assert.equal(firstStore.drafts().length,0);
  } finally {firstStore.close();}
  const second=new Store(path);
  try {
    const result=confirmProposal(second,data,proposal!);
    assert.equal(result.requiredTime,time(18));
    assert.equal(result.confirmedTime,time(19));
    assert.ok(result.draftId);
    assert.equal(second.proposals()[0].status,'confirmed');
    assert.equal(confirmProposal(second,data,proposal!).draftId,result.draftId);
    const replay=await runRequest(second,data,req,options);
    assert.equal(replay.items[0].draftId,result.draftId);
    assert.equal(second.drafts().length,1);
  } finally {second.close();}
});

test('确认时重新检查占用，已被抢占的提案不写入；重查可生成新提案',async t=>{
  const db=memory(t);
  const old=await getProposal(db);
  db.seed([seed(19)]);
  assert.equal(confirmProposal(db,data,old.proposalId!).reason,'SLOT_TAKEN');
  assert.equal(db.drafts().length,0);
  const next=await getProposal(db);
  assert.notEqual(next.proposalId,old.proposalId);
  assert.equal(next.suggestedTime,time(20));
  const done=confirmProposal(db,data,next.proposalId!);
  assert.equal(done.confirmedTime,time(20));
  assert.equal(confirmProposal(db,data,old.proposalId!).reason,'DRAFT_ALREADY_EXISTS');
  assert.equal(db.drafts().length,1);
});

test('确认时重新检查素材规则，风险或缺资料均阻止写入',async t=>{
  const db=memory(t);
  const {proposalId}=await getProposal(db);
  const blocked={...data,assets:{...data.assets,M01:{...data.assets.M01,licensed:false}}};
  assert.equal(confirmProposal(db,blocked,proposalId!).reason,'RULE_VIOLATION');
  const missing={...data,assets:{...data.assets,M01:{title:'待补资料'}}};
  assert.equal(confirmProposal(db,missing,proposalId!).reason,'MISSING_ASSET_INFO');
  assert.equal(db.drafts().length,0);
  assert.equal(db.proposals()[0].status,'pending');
});

test('确认写入失败回滚且可重试；不存在的提案返回明确原因',async t=>{
  const db=memory(t);
  const {proposalId}=await getProposal(db);
  assert.equal(confirmProposal(db,data,'00000000-0000-0000-0000-000000000000').reason,'PROPOSAL_NOT_FOUND');
  const failed=confirmProposal(db,data,proposalId!,true);
  assert.equal(failed.reason,'WRITE_FAILED');
  assert.equal(failed.draftId,null);
  assert.equal(db.proposals()[0].status,'pending');
  assert.equal(db.drafts().length,0);
  assert.equal(confirmProposal(db,data,proposalId!).status,'saved');
});

test('自定义数据拒绝错误类型和缺失的硬性授权规则',()=>{
  assert.throws(()=>parseRules({...data.rules,required:['title']}));
  assert.throws(()=>parseAssets({M01:{licensed:'true'}}));
  assert.throws(()=>parseSchedule([{channel:'short-video',time:'2026-12-01T19:00:00'}]));
});

test('同一回合预先夹带备选查询不会跳过模型观察',async t=>{
  const db=memory(t);
  const decide:Decide=async(h,s)=>{
    if(h.filter(m=>m.role==='tool').length===2) return {text:null,calls:[
      ...scriptedCall('query_slots',{scope:'requested'},'observe-first').calls,
      ...scriptedCall('query_slots',{scope:'alternatives'},'premature-query').calls]};
    if(h.at(-1)?.content?.includes('"TOOL_NOT_AVAILABLE"'))
      return scriptedCall('query_slots',{scope:'alternatives'},'informed-query');
    return mockModel(h,s);
  };
  const r=await runRequest(db,data,req,{...options,decide});
  assert.equal(r.items[0].status,'pending_confirmation');
  const observed=r.trace.find(s=>s.result.code==='OCCUPIED')!;
  const refused=r.trace.find(s=>s.result.code==='TOOL_NOT_AVAILABLE')!;
  const candidates=r.trace.find(s=>s.result.code==='CANDIDATES_FOUND')!;
  assert.equal(refused.turn,observed.turn);
  assert.ok(candidates.turn>observed.turn);
});
