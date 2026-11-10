import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { scoreTrajectory, summarizeTrajectories } from './trajectory-metrics.ts';
import type { DraftRow, Evidence, Scene, ToolStep } from './trajectory-metrics.ts';

const cli = promisify(execFile);
const root = fileURLToPath(new URL('../',import.meta.url));
const readJson = (file:string) => JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const scenes:Scene[] = ['available','occupied'];
const {values,positionals} = parseArgs({options:{
  mode:{type:'string',default:'mock'}, repeats:{type:'string',default:'5'}, baseline:{type:'string'},
  out:{type:'string',default:'.local/trajectory-eval'}, help:{type:'boolean'}
},allowPositionals:true});
if(values.help){
  console.log('npm run eval:trajectory -- [--mode mock|live] [--repeats 1..20] [--baseline DIR] [--out DIR]');
  process.exit(0);
}
const mode = values.mode;
const repeats = Number(values.repeats);
if(positionals.length || (mode!=='live' && mode!=='mock') || !/^[1-9]\d?$/.test(values.repeats!)
    || repeats>20) throw new Error('Invalid evaluation arguments; use --help');

if(mode==='live' && existsSync(join(root,'.env'))) process.loadEnvFile(join(root,'.env'));
if(mode==='live' && (!process.env.AGENT_API_KEY?.trim() || !process.env.AGENT_MODEL?.trim()))
  throw new Error('Configure AGENT_API_KEY and AGENT_MODEL in the project .env before evaluating live');
const model = mode==='live'?process.env.AGENT_MODEL!.trim():'deterministic-mock';
const input = join(root,'examples','paired.input.json');
const fixture = readJson(input);
const expected = {requestId:fixture.requestId, ...fixture.items[0], alternative:'2026-12-01T19:00:00+08:00'};
if(fixture.items.length!==1 || expected.requiredTime!=='2026-12-01T18:00:00+08:00')
  throw new Error('This comparison expects the single-material 18:00 fixture');
const controlledFiles = ['data/assets.json','data/rules.json','data/available.json','data/occupied.json'];
const versions = [{id:'current',dir:root},...(values.baseline?[{id:'baseline',dir:resolve(values.baseline)}]:[])];
for(const version of versions){
  for(const file of controlledFiles){
    if(JSON.stringify(readJson(join(root,file)))!==JSON.stringify(readJson(join(version.dir,file))))
      throw new Error('Controlled fixture differs in '+version.id+': '+file);
  }
}
const digest = (dir:string) => {
  const hash=createHash('sha256');
  for(const file of readdirSync(join(dir,'src')).filter(f=>f.endsWith('.ts')).sort()){
    hash.update(file+'\0').update(readFileSync(join(dir,'src',file),'utf8').replace(/\r\n/g,'\n').trimEnd()+'\n');
  }
  return hash.digest('hex');
};
const invoke = async (dir:string,args:string[]) => {
  const {stdout}=await cli(process.execPath,['src/cli.ts',...args],{cwd:dir,timeout:55_000,maxBuffer:1024*1024,windowsHide:true});
  return JSON.parse(stdout);
};
const temp = mkdtempSync(join(tmpdir(),'trajectory-eval-'));
const tempFiles:string[] = [];
async function run(version:(typeof versions)[number],repeat:number,scene:Scene){
  const base=join(temp,`${version.id}-${repeat}-${scene}`);
  const db=base+'.sqlite', traceFile=base+'.jsonl';
  tempFiles.push(db,db+'-journal',db+'-wal',db+'-shm',traceFile);
  let evidence:Evidence={trace:[],drafts:[]};
  let error:string|undefined;
  try{
    const output = await invoke(version.dir,['run','--input',input,'--mode',mode,'--scenario',scene,'--db',db,'--trace',traceFile]);
    if(output.mode!==mode || output.model!==model) throw new Error('wrong mode or model');
    const trace:ToolStep[]=readFileSync(traceFile,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
    evidence={status:output.status,requestId:output.requestId,item:output.items?.[0],trace,drafts:[]};
    const snapshot=await invoke(version.dir,['inspect','--db',db]);
    if(!Array.isArray(snapshot.drafts)) throw new Error('missing database snapshot');
    evidence.drafts=snapshot.drafts as DraftRow[];
  }catch(e){
    // Do not include stderr or response bodies in evidence.
    error=(e as {killed?:boolean}).killed?'CLI_TIMEOUT':'CLI_OR_EVIDENCE_ERROR';
  }
  const metrics=scoreTrajectory(scene,evidence,expected);
  if(error){metrics.businessPass=false;metrics.decisionPass=false;}
  return {version:version.id,repeat,scene,...metrics,...(error?{error}:{}),...evidence};
}

try{
  const rows:Awaited<ReturnType<typeof run>>[]=[];
  for(let n=1;n<=repeats;n++){
    for(const scene of scenes){
      const order=n%2===1?versions:[...versions].reverse();
      rows.push(...await Promise.all(order.map(version=>run(version,n,scene))));
    }
    console.log(`Round ${n}/${repeats} complete`);
  }
  const {summary,pairedPassing}=summarizeTrajectories(
    versions.map(v=>({version:v.id,runtimeSha256:digest(v.dir)})),rows,repeats);
  const report={mode,model,node:process.version,repeats,fixture:expected,summary,pairedPassing};
  const out=resolve(values.out!);
  mkdirSync(out,{recursive:true});
  writeFileSync(join(out,'summary.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync(join(out,'runs.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  console.log(JSON.stringify(report,null,2));
  if(rows.some(r=>r.version==='current' && (!r.businessPass || !r.decisionPass || r.unnecessarySaveCalls>0))) process.exitCode=1;
}finally{
  for(const file of tempFiles) rmSync(file,{force:true});
  rmdirSync(temp);
}
