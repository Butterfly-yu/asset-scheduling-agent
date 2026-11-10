import { mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

type Case = {name:string; input:'paired'|'missing'|'risk'; want:string; count:number;
  db?:string; scenario?:'occupied'; schedule?:string; failSave?:boolean; failQuery?:'requested'|'alternatives'; offlineOnly?:boolean};
const raw = process.argv.slice(2);
const mode = raw.length === 0 ? 'mock' : raw.length === 2 && raw[0] === '--mode' ? raw[1] : '';
if (mode !== 'mock' && mode !== 'live') throw new Error('usage: npm run demo -- [--mode mock|live]');
const workspace = mkdtempSync(join(tmpdir(),'asset-agent-'));
const dir = join('examples',mode);
mkdirSync(dir,{recursive:true});
const sameDb = join(workspace,'available.sqlite');
const conflictDb = join(workspace,'conflict.sqlite');
const cases:Case[] = [
  {name:'available', input:'paired', db:sameDb, want:'saved', count:1},
  {name:'conflict', input:'paired', db:conflictDb, scenario:'occupied', want:'pending_confirmation',count:0},
  {name:'missing', input:'missing', want:'needs_info',count:0},
  {name:'risk', input:'risk', want:'blocked',count:0},
  {name:'replay', input:'paired', db:sameDb, want:'saved',count:1},
  {name:'write-failure', input:'paired', want:'incomplete',count:0,failSave:true},
  {name:'query-failure', input:'paired', want:'incomplete',count:0,failQuery:'requested'},
  {name:'occupied-alternative', input:'paired', schedule:'data/occupied-next.json',want:'pending_confirmation',count:0,offlineOnly:true},
  {name:'no-alternative', input:'paired', schedule:'data/occupied-all.json',want:'incomplete',count:0,offlineOnly:true}
];
const invoke = (...args:string[]) => {
  const p = spawnSync(process.execPath,['src/cli.ts',...args],{encoding:'utf8'});
  if (p.status !== 0) throw new Error(p.error?.message ?? (p.stderr.trim() || 'CLI execution failed'));
  return p.stdout;
};
const portable = (path:string)=>path.split(String.fromCharCode(92)).join('/');
const tracePath=(name:string)=>portable(join(dir,name+'.trace.jsonl'));
const showDb=(db:string)=>JSON.parse(invoke('inspect','--db',db));
const readTrace=(path:string)=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const writeJson=(name:string,value:unknown)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n');
const summary:{case:string;pass:boolean;status?:string;draftCount?:number;error?:string}[]=[];
function check(name:string,status:string,draftCount:number,verify:()=>void){
  try{verify();summary.push({case:name,pass:true,status,draftCount});}
  catch(e){summary.push({case:name,pass:false,status,draftCount,error:String(e)});}
}

try {
  let firstId:string|undefined;
  let proposal:string|undefined;
  for (const entry of cases.filter(c=>mode==='mock'||!c.offlineOnly)) {
    const db = entry.db ?? join(workspace,entry.name+'.sqlite');
    const trace = tracePath(entry.name);
    const rawOutput = invoke('run','--input',join('examples',entry.input+'.input.json'),'--mode',mode,
      '--db',db,'--trace',trace,
      ...(entry.scenario?['--scenario',entry.scenario]:[]),...(entry.schedule?['--schedule',entry.schedule]:[]),
      ...(entry.failSave?['--fail-save']:[]),...(entry.failQuery?['--fail-query',entry.failQuery]:[]));
    writeFileSync(join(dir,entry.name+'.output.json'),rawOutput);
    const output = JSON.parse(rawOutput);
    const {drafts:rows,proposals}=showDb(db);
    const steps = readTrace(trace);
    writeJson(entry.name+'.db.json',rows);
    const item = output.items[0];
    if(entry.name==='conflict') {proposal=item.proposalId ?? undefined;writeJson('conflict.proposals.json',proposals);}
    check(entry.name,item.status,rows.length,()=>{
      assert.equal(output.mode,mode);
      assert.equal(item.status,entry.want);
      assert.equal(rows.length,entry.count);
      switch(entry.name){
        case 'available': {
          assert.ok(item.draftId);
          assert.equal(item.draftId,rows[0].draftId);
          firstId=item.draftId;
          const observation=steps.findIndex(s=>s.result.code==='AVAILABLE');
          const save=steps.findIndex(s=>s.result.code==='SAVED');
          assert.ok(observation>=0 && save>observation && steps[save].turn>steps[observation].turn);
          break;
        }
        case 'conflict': {
          const conflict=steps.findIndex(s=>s.result.code==='OCCUPIED');
          const alternate=steps.findIndex(s=>s.result.code==='CANDIDATES_FOUND');
          assert.ok(conflict>=0 && alternate>conflict && steps[alternate].turn>steps[conflict].turn);
          assert.equal(steps.some(s=>s.action==='save_draft'),false);
          assert.equal(item.requiredTime,'2026-12-01T18:00:00+08:00');
          assert.equal(item.suggestedTime,'2026-12-01T19:00:00+08:00');
          assert.equal(item.draftId,null);
          assert.ok(proposal);
          assert.equal(proposals[0].proposalId,proposal);
          break;
        }
        case 'missing': assert.ok(item.missing.includes('licensed'));break;
        case 'risk': assert.ok(item.risks.some((r:{ruleId:string})=>r.ruleId==='R-LICENSE'));break;
        case 'replay': assert.equal(item.draftId,firstId);assert.equal(item.saveStatus,'replayed');break;
        case 'write-failure': assert.equal(item.saveStatus,'failed');assert.equal(item.reason,'WRITE_FAILED');break;
        case 'query-failure': {
          assert.equal(item.reason,'SLOT_QUERY_FAILED');
          assert.equal(item.toolErrors[0].scope,'requested');
          const failure=steps.findIndex(s=>s.result.code==='SLOT_QUERY_FAILED');
          assert.ok(failure>=0);
          assert.equal(steps.slice(failure+1).some(s=>['query_slots','save_draft'].includes(s.action)),false);
          break;
        }
        case 'occupied-alternative': assert.equal(item.suggestedTime,'2026-12-01T20:00:00+08:00');break;
        case 'no-alternative': assert.equal(item.reason,'NO_ALTERNATIVE_SLOT');assert.equal(proposals.length,0);break;
      }
    });
  }
  if(proposal){
    const name='confirmation';
    const rawOutput=invoke('confirm','--db',conflictDb,'--proposal',proposal,'--trace',tracePath(name));
    writeFileSync(join(dir,name+'.output.json'),rawOutput);
    const output=JSON.parse(rawOutput);
    const snapshot=showDb(conflictDb);
    writeJson(name+'.db.json',snapshot.drafts);
    writeJson(name+'.proposals.json',snapshot.proposals);
    check(name,output.status,snapshot.drafts.length,()=>{
      assert.equal(output.status,'saved');
      assert.equal(output.confirmedTime,'2026-12-01T19:00:00+08:00');
      assert.equal(output.requiredTime,'2026-12-01T18:00:00+08:00');
      assert.equal(snapshot.drafts.length,1);
      assert.equal(snapshot.drafts[0].draftId,output.draftId);
      assert.equal(snapshot.proposals[0].status,'confirmed');
      const replay=JSON.parse(invoke('confirm','--db',conflictDb,'--proposal',proposal!));
      assert.equal(replay.draftId,output.draftId);
      assert.equal(replay.saveStatus,'replayed');
      assert.equal(showDb(conflictDb).drafts.length,1);
    });
  }
  if(mode==='mock'){
    const name='stale-confirmation';
    const db=join(workspace,name+'.sqlite');
    const initial=JSON.parse(invoke('run','--input','examples/paired.input.json','--scenario','occupied','--db',db));
    const rawOutput=invoke('confirm','--db',db,'--proposal',initial.items[0].proposalId,'--schedule',
      'data/occupied-next.json','--trace',tracePath(name));
    writeFileSync(join(dir,name+'.output.json'),rawOutput);
    const output=JSON.parse(rawOutput);
    const snapshot=showDb(db);
    writeJson(name+'.db.json',snapshot.drafts);
    check(name,output.status,snapshot.drafts.length,()=>{
      assert.equal(output.reason,'SLOT_TAKEN');
      assert.equal(snapshot.drafts.length,0);
      assert.equal(snapshot.proposals[0].status,'pending');
    });
  }
  const report={mode,node:process.version,cases:summary};
  writeJson('summary.json',report);
  console.log(JSON.stringify(report,null,2));
  console.log('Evidence: '+relative(process.cwd(),dir));
  if(summary.some(r=>!r.pass)) process.exitCode=1;
} finally {
  for(const name of [...cases.map(c=>c.name),'stale-confirmation']) rmSync(join(workspace,name+'.sqlite'),{force:true});
  rmdirSync(workspace);
}
