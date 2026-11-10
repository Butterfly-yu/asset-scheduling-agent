import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { parseRequest, parseAssets, parseRules, parseSchedule } from './domain.ts';
import { Store } from './store.ts';
import { runRequest } from './agent.ts';
import { confirmProposal } from './confirmation.ts';
import { liveModel, mockModel } from './model.ts';

const readJson = (path:string|URL) => JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const fixture = (name:string) => readJson(new URL('../data/'+name, import.meta.url));
const out = (value:unknown) => process.stdout.write(JSON.stringify(value,null,2)+'\n');
function writeTrace(path:string, events:object[], context:object) {
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,events.map(r=>JSON.stringify({...r,...context})).join('\n')+(events.length?'\n':''));
}

async function main() {
  const {values,positionals} = parseArgs({allowPositionals:true,options:{
    input:{type:'string'}, mode:{type:'string'}, db:{type:'string'}, scenario:{type:'string'},
    assets:{type:'string'}, rules:{type:'string'}, schedule:{type:'string'}, proposal:{type:'string'},
    trace:{type:'string'}, 'fail-save':{type:'boolean'}, 'fail-query':{type:'string'}, help:{type:'boolean'}
  }});
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('node src/cli.ts run --input FILE [--mode mock|live] [--scenario available|occupied | --schedule FILE] [--db FILE] [--assets FILE] [--rules FILE] [--trace FILE] [--fail-save] [--fail-query requested|alternatives]\nnode src/cli.ts confirm --db FILE --proposal ID [--assets FILE] [--rules FILE] [--schedule FILE] [--trace FILE] [--fail-save]\nnode src/cli.ts inspect --db FILE\n');
    return;
  }
  if (positionals.length !== 1 || !['run','confirm','inspect'].includes(command)) throw new Error('未知命令');
  if (command === 'inspect' || command === 'confirm') {
    if (!values.db || !existsSync(values.db)) throw new Error(command+' 需要已存在的 --db 文件');
  }
  if (command === 'inspect') {
    const store = new Store(values.db!);
    try { out({drafts:store.drafts(),proposals:store.proposals()}); } finally { store.close(); }
    return;
  }
  if (values.scenario !== undefined && !['available','occupied'].includes(values.scenario)) throw new Error('无效 scenario');
  if (values.schedule && values.scenario) throw new Error('--schedule 和 --scenario 不能同时指定');
  const data = {assets:parseAssets(values.assets ? readJson(values.assets) : fixture('assets.json')),
    rules:parseRules(values.rules ? readJson(values.rules) : fixture('rules.json'))};
  const seeds = parseSchedule(values.schedule ? readJson(values.schedule) : fixture((values.scenario ?? 'available')+'.json'));

  if (command === 'confirm') {
    if (!values.proposal || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values.proposal))
      throw new Error('confirm 需要排期输出中的 --proposal ID');
    const store = new Store(values.db!);
    try {
      store.seed(seeds);
      const {trace,...result}=confirmProposal(store,data,values.proposal,values['fail-save']);
      if(values.trace) writeTrace(values.trace,trace,{mode:'human_confirmation',requestId:result.requestId});
      out({...result,trace:values.trace ?? trace});
    } finally {store.close();}
    return;
  }

  if (!values.input) throw new Error('run 需要 --input FILE');
  const mode = values.mode ?? 'mock';
  if (mode !== 'mock' && mode !== 'live') throw new Error('无效 mode');
  const failQuery = values['fail-query'];
  if (failQuery !== undefined && failQuery !== 'requested' && failQuery !== 'alternatives')
    throw new Error('--fail-query 须为 requested 或 alternatives');
  const req = parseRequest(readJson(values.input));
  if (mode === 'live' && existsSync('.env')) process.loadEnvFile('.env');
  const selected = mode === 'live' ? liveModel() : {decide:mockModel,model:'deterministic-mock'};
  if (values.db && values.db !== ':memory:') mkdirSync(dirname(values.db),{recursive:true});
  const store = new Store(values.db ?? ':memory:');
  try {
    store.seed(seeds);
    const {trace,...result} = await runRequest(store,data,req,{mode,...selected,failSave:values['fail-save'],failQuery});
    if (values.trace) writeTrace(values.trace,trace,{requestId:req.requestId,model:selected.model});
    out({...result,trace:values.trace ?? trace});
  } finally { store.close(); }
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : '未知错误')+'\n');
  process.exitCode=1;
});
