import { mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const raw = process.argv.slice(2);
const mode = raw.length === 0 ? 'mock' : raw.length === 2 && raw[0] === '--mode' ? raw[1] : '';
if (mode !== 'mock' && mode !== 'live') throw new Error('usage: npm run demo -- [--mode mock|live]');
const workspace = mkdtempSync(join(tmpdir(),'asset-agent-'));
const dir = join('examples',mode);
mkdirSync(dir,{recursive:true});
const sameDb = join(workspace,'available.sqlite');
const cases = [
  {name:'available', input:'paired', scenario:'available', db:sameDb, want:'saved', count:1},
  {name:'conflict', input:'paired', scenario:'occupied', want:'pending_confirmation',count:0},
  {name:'missing', input:'missing', scenario:'available', want:'needs_info',count:0},
  {name:'risk', input:'risk', scenario:'available', want:'blocked',count:0},
  {name:'replay', input:'paired', scenario:'available', db:sameDb, want:'saved',count:1},
  {name:'write-failure', input:'paired', scenario:'available', want:'incomplete',count:0,fail:true}
];
const invoke = (...args:string[]) => {
  const p = spawnSync(process.execPath,['src/cli.ts',...args],{encoding:'utf8'});
  if (p.status !== 0) throw new Error(p.error?.message ?? (p.stderr.trim() || 'CLI execution failed'));
  return p.stdout;
};
try {
  const summary = [];
  let firstId:string|undefined;
  for (const entry of mode==='live' ? cases.slice(0,2) : cases) {
    const db = entry.db ?? join(workspace,entry.name+'.sqlite');
    const trace = join(dir,entry.name+'.trace.jsonl').split(String.fromCharCode(92)).join('/');
    const rawOutput = invoke('run','--input',join('examples',entry.input+'.input.json'),'--mode',mode,
      '--scenario',entry.scenario,'--db',db,'--trace',trace,...(entry.fail?['--fail-save']:[]));
    writeFileSync(join(dir,entry.name+'.output.json'),rawOutput);
    const output = JSON.parse(rawOutput);
    const rows = JSON.parse(invoke('inspect','--db',db)).drafts;
    const steps = readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
    writeFileSync(join(dir,entry.name+'.db.json'),JSON.stringify(rows,null,2)+'\n');
    const item = output.items[0];
    const verify = () => {
      assert.equal(output.mode,mode);
      assert.equal(item.status,entry.want);
      assert.equal(rows.length,entry.count);
      if (entry.name==='available') {
        assert.ok(item.draftId);
        assert.equal(item.draftId,rows[0].draftId);
        firstId=item.draftId;
        const observation = steps.findIndex(s=>s.result.code==='AVAILABLE');
        const save = steps.findIndex(s=>s.result.code==='SAVED');
        assert.ok(observation>=0 && save>observation && steps[save].turn>steps[observation].turn);
      } else if (entry.name==='conflict') {
        const conflict = steps.findIndex(s=>s.result.code==='OCCUPIED');
        const alternate = steps.findIndex(s=>s.result.code==='CANDIDATES_FOUND');
        assert.ok(conflict>=0 && alternate>conflict && steps[alternate].turn>steps[conflict].turn);
        assert.equal(item.requiredTime,'2026-12-01T18:00:00+08:00');
        assert.equal(item.suggestedTime,'2026-12-01T19:00:00+08:00');
        assert.equal(item.draftId,null);
      } else if (entry.name==='replay') {
        assert.equal(item.draftId,firstId);
        assert.equal(item.saveStatus,'replayed');
      } else if (entry.fail) {
        assert.equal(item.saveStatus,'failed');
        assert.equal(item.reason,'WRITE_FAILED');
      }
    };
    try {verify(); summary.push({case:entry.name,pass:true,status:item.status,draftCount:rows.length});}
    catch (e) {summary.push({case:entry.name,pass:false,status:item.status,draftCount:rows.length,error:String(e)});}
  }
  const report = {mode,node:process.version,cases:summary};
  writeFileSync(join(dir,'summary.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  console.log('Evidence: '+relative(process.cwd(),dir));
  if (summary.some(r=>!r.pass)) process.exitCode=1;
} finally {
  for (const entry of cases) rmSync(join(workspace,entry.name+'.sqlite'),{force:true});
  rmdirSync(workspace);
}
