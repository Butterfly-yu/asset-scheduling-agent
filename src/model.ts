import { tools } from './tools.ts';
import type { ToolResult } from './tools.ts';

export type Call = {id:string; type:'function'; function:{name:string; arguments:string}};
export type Message = {role:'system'|'user'|'assistant'|'tool'; content:string|null; tool_calls?:Call[]; tool_call_id?:string};
export type Reply = {calls:Call[]; text:string|null};
export type Decide = (history:Message[], signal:AbortSignal, offered?:typeof tools) => Promise<Reply>;

export function liveModel(env = process.env, fetcher = fetch) {
  const key = env.AGENT_API_KEY?.trim();
  const model = env.AGENT_MODEL?.trim();
  if (!key || !model) throw new Error('LIVE_CONFIG_MISSING: 请在本机 .env 配置 AGENT_API_KEY 和 AGENT_MODEL');
  const provider = env.AGENT_PROVIDER || 'deepseek';
  if (!['deepseek','compatible'].includes(provider)) throw new Error('AGENT_PROVIDER 须为 deepseek 或 compatible');
  const base = new URL(env.AGENT_BASE_URL || 'https://api.deepseek.com');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('AGENT_BASE_URL 须为无凭据、查询或片段的 HTTPS API 地址');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/chat/completions';
  const decide: Decide = async (messages, signal, offered = tools) => {
    let response: Response;
    try {
      response = await fetcher(base, {method:'POST', signal, redirect:'error',
        headers:{authorization:'Bearer '+key,'content-type':'application/json'},
        body:JSON.stringify({model,messages,tools:offered,tool_choice:'auto',stream:false,
          ...(provider === 'deepseek' ? {thinking:{type:'disabled'}} : {})})});
    } catch {
      throw new Error(signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK_ERROR');
    }
    if (!response.ok) throw new Error('MODEL_HTTP_'+response.status);
    const body = await response.json().catch(() => null);
    const msg = body?.choices?.[0]?.message;
    if (msg?.role !== 'assistant' || (msg.tool_calls !== undefined && msg.tool_calls !== null && !Array.isArray(msg.tool_calls)))
      throw new Error('MODEL_PROTOCOL_ERROR');
    const seen = new Set<string>();
    const calls = (msg.tool_calls ?? []).map((c:Call) => {
      if (c?.type !== 'function' || typeof c.id !== 'string' || !c.id || seen.has(c.id)
          || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')
        throw new Error('MODEL_PROTOCOL_ERROR');
      seen.add(c.id);
      return {id:c.id,type:'function',function:{name:c.function.name,arguments:c.function.arguments}};
    });
    return {calls,text:typeof msg.content === 'string' ? msg.content : null};
  };
  return {decide, model};
}

export const scriptedCall = (name:string, args:object, id='script-1'): Reply =>
  ({calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}],text:null});

export const mockModel: Decide = async history => {
  const observations = history.filter(m => m.role === 'tool');
  const last = observations.at(-1);
  const call = (name:string,args={}) => scriptedCall(name,args,'mock-'+(observations.length+1));
  const done = (suggestedTime:unknown = null):Reply => ({calls:[],text:JSON.stringify({suggestedTime})});
  if (!last) return call('get_asset');
  const result = JSON.parse(last.content!) as ToolResult;
  switch (result.code) {
    case 'FOUND': case 'ASSET_NOT_FOUND': return call('check_rules');
    case 'PASS': return call('query_slots',{scope:'requested'});
    case 'AVAILABLE': return call('save_draft',{time:result.time});
    case 'OCCUPIED': case 'SLOT_TAKEN': return call('query_slots',{scope:'alternatives'});
    case 'CANDIDATES_FOUND': return done((result.available as string[])[0]);
    default: return done();
  }
};
