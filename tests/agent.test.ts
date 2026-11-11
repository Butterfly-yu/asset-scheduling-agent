import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRequest,normalizeTime} from '../src/domain.ts';
import type {Item} from '../src/domain.ts';
import {Store} from '../src/store.ts';
import {runRequest} from '../src/agent.ts';
import {createTools} from '../src/tools.ts';
import type {Data} from '../src/tools.ts';
import {liveModel,mockModel,scriptedCall} from '../src/model.ts';
import type {Decide} from '../src/model.ts';

const json = (file:string) => JSON.parse(readFileSync(new URL('../data/'+file,import.meta.url),'utf8'));
const data:Data = {assets:json('assets.json'),rules:json('rules.json')};
const req = parseRequest(JSON.parse(readFileSync(new URL('../examples/paired.input.json',import.meta.url),'utf8')));
const hard = req.items[0].requiredTime;
const alternate = '2026-12-01T19:00:00+08:00';
const channel = req.items[0].channel;
const forAsset = (assetId:string) => ({...req,items:[{...req.items[0],assetId}]});
const run = (store:Store, request=req, overrides:Partial<Parameters<typeof runRequest>[3]> = {}) =>
  runRequest(store,data,request,{mode:'mock',decide:mockModel,...overrides});
const final = {calls:[],text:'{"suggestedTime":null}'};
function memory(t:Parameters<Parameters<typeof test>[1]>[0]) {
  const store = new Store(':memory:');
  t.after(()=>store.close());
  return store;
}

test('同一请求：空闲时保存；仅改变占用后模型补查并等待确认',async t=>{
  const a = memory(t);
  const b = memory(t);
  b.seed(json('occupied.json'));
  const available = await run(a);
  const conflict = await run(b);
  assert.equal(available.items[0].status,'saved');
  assert.equal(available.items[0].draftId,a.drafts()[0].draftId);
  assert.equal(conflict.items[0].status,'pending_confirmation');
  assert.equal(conflict.items[0].requiredTime,hard);
  assert.equal(conflict.items[0].suggestedTime,alternate);
  assert.equal(conflict.items[0].needsConfirmation,true);
  assert.equal(b.drafts().length,0);
  const occupied = conflict.trace.find(s=>s.result.code==='OCCUPIED')!;
  const lookup = conflict.trace.find(s=>s.result.code==='CANDIDATES_FOUND')!;
  assert.ok(occupied.turn < lookup.turn);
  assert.equal(occupied.nextAction,'query_slots');
});

test('资料缺失、未知素材和授权风险分别有可验证证据',async t=>{
  const db=memory(t);
  const missing=await run(db,forAsset('M02'));
  const absent=await run(db,{...forAsset('M00'),requestId:'absent'});
  const risk=await run(db,{...forAsset('M03'),requestId:'risk'});
  assert.equal(missing.items[0].status,'needs_info');
  assert.deepEqual(missing.items[0].missing,['licensed']);
  assert.deepEqual(absent.items[0].missing,['asset']);
  assert.equal(risk.items[0].status,'blocked');
  assert.equal(risk.items[0].risks[0].ruleId,'R-LICENSE');
  assert.equal(db.drafts().length,0);
});

test('不同进程生命周期的连接重放同一草稿；相同 ID 更换请求被拒绝',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'schedule-test-'));
  const path=join(folder,'shared.sqlite');
  t.after(()=>{rmSync(path,{force:true});rmdirSync(folder);});
  const first=new Store(path);
  const original=await run(first);
  first.close();
  const second=new Store(path);
  try {
    const replay=await run(second,req,{decide:async()=>assert.fail('重放不应调用模型')});
    assert.equal(replay.items[0].draftId,original.items[0].draftId);
    assert.equal(replay.items[0].saveStatus,'replayed');
    assert.equal((await run(second,forAsset('M04'))).reason,'IDEMPOTENCY_CONFLICT');
    assert.equal(second.drafts().length,1);
  } finally {second.close();}
});

test('提交前保存错误回滚；同 ID 修复后可以重试',async t=>{
  const db=memory(t);
  const failed=await run(db,req,{failSave:true});
  assert.equal(failed.items[0].reason,'WRITE_FAILED');
  assert.equal(failed.items[0].saveStatus,'failed');
  assert.equal(failed.items[0].draftId,null);
  assert.equal(db.drafts().length,0);
  const retried=await run(db);
  assert.equal(retried.items[0].status,'saved');
  assert.equal(db.drafts().length,1);
});

test('模型尝试改期、自行声明授权或绕过审核均无法写入',async t=>{
  const db=memory(t);
  db.bind(req);
  const tool=createTools(db,data,req.requestId,req.items[0],false);
  assert.equal(tool.run('save_draft',{time:hard}).code,'REVIEW_REQUIRED');
  tool.run('get_asset',{});tool.run('check_rules',{});tool.run('query_slots',{scope:'requested'});
  assert.equal(tool.run('save_draft',{time:alternate,confirmed:true}).code,'INVALID_TOOL_OR_ARGUMENTS');
  assert.equal(tool.run('save_draft',{time:alternate}).code,'CONFIRMATION_REQUIRED');
  assert.equal(db.drafts().length,0);
});

test('查询后插入占用，事务复查阻止过期观察造成的冲突',t=>{
  const db=memory(t);
  db.bind(req);
  const tool=createTools(db,data,req.requestId,req.items[0],false);
  tool.run('get_asset',{});tool.run('check_rules',{});
  assert.equal(tool.run('query_slots',{scope:'requested'}).code,'AVAILABLE');
  db.seed([{channel,time:'2026-12-01T10:00:00Z',label:'后来占用'}]);
  assert.equal(tool.run('save_draft',{time:hard}).code,'SLOT_TAKEN');
  assert.equal(db.drafts().length,0);
});

test('不接受未经查询的备选时间或模型自行声称已保存',async t=>{
  const db=memory(t);
  db.seed(json('occupied.json'));
  const decide:Decide=async(h,s)=>{
    if(h.filter(m=>m.role==='tool').length===3)
      return {calls:[],text:JSON.stringify({suggestedTime:alternate,status:'saved',draftId:'made-up'})};
    return mockModel(h,s);
  };
  const output=await run(db,req,{decide});
  assert.equal(output.items[0].status,'incomplete');
  assert.equal(output.items[0].draftId,null);
  assert.equal(output.items[0].suggestedTime,null);
});

test('同一模型回合批量请求也无法突破工具预算',async t=>{
  const db=memory(t);
  const decide:Decide=async()=>({calls:Array.from({length:20},(_,i)=>scriptedCall('get_asset',{},String(i)).calls[0]),text:null});
  const output=await run(db,req,{decide,maxCalls:3});
  assert.equal(output.items[0].reason,'BUDGET_EXHAUSTED');
  assert.equal(output.trace.length,3);
  assert.equal(db.drafts().length,0);
});

test('最后一次调用保存成功但运行预算耗尽，输出保留真实草稿回执',async t=>{
  for(const limit of [{maxCalls:4},{maxTurns:4}]){
    const db=memory(t);
    const output=await run(db,req,limit);
    const item=output.items[0];
    assert.equal(output.status,'incomplete');
    assert.equal(item.status,'incomplete');
    assert.equal(item.reason,'BUDGET_EXHAUSTED');
    assert.equal(item.stopReason,'BUDGET_EXHAUSTED');
    assert.equal(item.saveStatus,'saved');
    assert.equal(item.scheduleStatus,'scheduled');
    assert.equal(item.draftId,db.drafts()[0].draftId);
    assert.equal(output.trace.at(-1)?.nextAction,'stop:BUDGET_EXHAUSTED');
    const replay=await run(db,req,limit);
    assert.equal(replay.status,'completed');
    assert.equal(replay.items[0].saveStatus,'replayed');
    assert.equal(replay.items[0].draftId,item.draftId);
    assert.equal(db.drafts().length,1);
  }
});

test('预算耗尽时保留实际写入失败的原因',async t=>{
  const db=memory(t);
  const output=await run(db,req,{maxCalls:4,failSave:true});
  const item=output.items[0];
  assert.equal(output.status,'incomplete');
  assert.equal(item.status,'incomplete');
  assert.equal(item.reason,'WRITE_FAILED');
  assert.equal(item.stopReason,'BUDGET_EXHAUSTED');
  assert.equal(item.saveStatus,'failed');
  assert.equal(item.draftId,null);
  assert.equal(db.drafts().length,0);
});

test('已提交草稿保留，即使模型在下一回合断开',async t=>{
  const db=memory(t);
  const decide:Decide=async(h,s)=>{
    if(h.at(-1)?.content?.includes('"SAVED"')) throw new Error('MODEL_NETWORK_ERROR');
    return mockModel(h,s);
  };
  const output=await run(db,req,{decide});
  assert.equal(output.items[0].status,'saved');
  assert.equal(output.trace.at(-1)?.nextAction,'stop:MODEL_NETWORK_ERROR');
  assert.equal(db.drafts().length,1);
});

test('批内同渠道同时段只保存一项；不吞掉已成功的结果',async t=>{
  const db=memory(t);
  const items:Item[]=[...req.items,{...req.items[0],assetId:'M04'}];
  const output=await run(db,{...req,items});
  assert.equal(output.status,'partial');
  assert.deepEqual(output.items.map(i=>i.status),['saved','pending_confirmation']);
  assert.equal(db.drafts().length,1);
});

test('时间验证排除缺少偏移量及不存在的日期',()=>{
  assert.throws(()=>normalizeTime('2026-12-01T18:00:00'));
  assert.throws(()=>normalizeTime('2026-02-31T18:00:00+08:00'));
  assert.equal(normalizeTime(hard),normalizeTime('2026-12-01T10:00:00Z'));
});

test('DeepSeek 适配器按协议回传 tool_call_id 和工具结果；此测试不访问真实模型',async t=>{
  const db=memory(t);
  const env={AGENT_BASE_URL:'https://api.deepseek.com',AGENT_MODEL:'example-model',AGENT_API_KEY:'synthetic-test-key'};
  let count=0;
  const fake:typeof fetch=async(input,init)=>{
    assert.equal(String(input),'https://api.deepseek.com/chat/completions');
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer synthetic-test-key');
    const payload=JSON.parse(String(init?.body));
    assert.deepEqual(payload.thinking,{type:'disabled'});
    assert.deepEqual(payload.tools.map((t:{function:{name:string}})=>t.function.name),[['get_asset'],['get_asset','check_rules'],['get_asset','check_rules','query_slots'],['get_asset','check_rules','query_slots','save_draft'],['get_asset','check_rules','query_slots']][count]);
    if(count++) {
      const prior=payload.messages.at(-1);
      assert.equal(prior.role,'tool');
      assert.equal(prior.tool_call_id,payload.messages.at(-2).tool_calls[0].id);
      assert.equal(typeof JSON.parse(prior.content).code,'string');
    }
    const reply=await mockModel(payload.messages,new AbortController().signal);
    return Response.json({choices:[{message:{role:'assistant',content:reply.text,tool_calls:reply.calls}}]});
  };
  const output=await run(db,req,{mode:'live',...liveModel(env,fake)});
  assert.equal(count,5);
  assert.equal(output.items[0].status,'saved');
});

test('模型错误不能凭空变成业务成功；配置和报错不回显密钥',async t=>{
  const db=memory(t);
  assert.throws(()=>liveModel({}),/LIVE_CONFIG_MISSING/);
  const configured=liveModel({AGENT_MODEL:'example-model',AGENT_API_KEY:'fake-secret'},async()=>new Response('fake-secret',{status:401}));
  const output=await run(db,req,{mode:'live',...configured});
  assert.equal(output.items[0].reason,'MODEL_HTTP_401');
  assert.equal(db.drafts().length,0);
  assert.ok(!JSON.stringify(output).includes('fake-secret'));
});
