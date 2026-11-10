import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { parseRequest } from './domain.ts';
import type { Asset, Rules, Seed } from './domain.ts';
import { Store } from './store.ts';
import { runRequest } from './agent.ts';
import { liveModel, mockModel } from './model.ts';

function fixture<T>(name:string): T {
  return JSON.parse(readFileSync(new URL('../data/'+name, import.meta.url),'utf8'));
}
const readJson = (path:string) => JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const out = (value:unknown) => process.stdout.write(JSON.stringify(value,null,2)+'\n');

async function main() {
  const {values,positionals} = parseArgs({allowPositionals:true,options:{
    input:{type:'string'}, mode:{type:'string',default:'mock'}, db:{type:'string'}, scenario:{type:'string',default:'available'},
    trace:{type:'string'}, 'fail-save':{type:'boolean'}, help:{type:'boolean'}
  }});
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('node src/cli.ts run --input FILE [--mode mock|live] [--scenario available|occupied] [--db FILE] [--trace FILE] [--fail-save]\nnode src/cli.ts inspect --db FILE\n');
    return;
  }
  if (positionals.length !== 1 || !['run','inspect'].includes(command)) throw new Error('未知命令');
  if (command === 'inspect') {
    if (!values.db || !existsSync(values.db)) throw new Error('inspect 需要已存在的 --db 文件');
    const store = new Store(values.db);
    try { out({drafts:store.drafts()}); } finally { store.close(); }
    return;
  }
  if (!values.input) throw new Error('run 需要 --input FILE');
  if (values.mode !== 'mock' && values.mode !== 'live') throw new Error('无效 mode');
  if (values.scenario !== 'available' && values.scenario !== 'occupied') throw new Error('无效 scenario');
  const req = parseRequest(readJson(values.input));
  const data = {assets:fixture<Record<string,Asset>>('assets.json'),rules:fixture<Rules>('rules.json')};
  if (values.mode === 'live' && existsSync('.env')) process.loadEnvFile('.env');
  const selected = values.mode === 'live' ? liveModel() : {decide:mockModel,model:'deterministic-mock'};
  if (values.db && values.db !== ':memory:') mkdirSync(dirname(values.db),{recursive:true});
  const store = new Store(values.db ?? ':memory:');
  try {
    store.seed(fixture<Seed[]>(values.scenario+'.json'));
    const {trace,...result} = await runRequest(store,data,req,{mode:values.mode,...selected,failSave:values['fail-save']});
    if (values.trace) {
      mkdirSync(dirname(values.trace),{recursive:true});
      writeFileSync(values.trace,trace.map(r=>JSON.stringify({...r,requestId:req.requestId,model:selected.model})).join('\n')+(trace.length?'\n':''));
    }
    out({...result,trace:values.trace ?? trace});
  } finally { store.close(); }
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : '未知错误')+'\n');
  process.exitCode=1;
});
