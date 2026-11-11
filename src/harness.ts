import type { tools } from './tools.ts';

type ToolGrant = {name:string; queryScopes?:readonly string[]};
type AccessReason = 'GRANTED'|'INVALID_ARGUMENTS'|'NOT_GRANTED_AT_TURN_START'|'GRANT_REVOKED';

export function captureToolGrants(offered:typeof tools): ToolGrant[] {
  return offered.map(({function:tool})=>{
    const properties = tool.parameters.properties as {scope?:{enum:string[]}};
    return {name:tool.name,...(properties.scope ? {queryScopes:[...properties.scope.enum]} : {})};
  });
}

export function authorizeToolCall(
  offered:ToolGrant[], current:ToolGrant[], name:string, args:Record<string,unknown>|null, remainingCalls:number
) {
  const matches = (grant:ToolGrant) => grant.name===name &&
    (!grant.queryScopes || typeof args?.scope!=='string' || grant.queryScopes.includes(args.scope));
  let reason:AccessReason = 'GRANTED';
  if(!args) reason='INVALID_ARGUMENTS';
  else if(!offered.some(matches)) reason='NOT_GRANTED_AT_TURN_START';
  else if(!current.some(matches)) reason='GRANT_REVOKED';
  return {
    decision:reason==='GRANTED'?'allowed' as const:'denied' as const,
    reason,
    offeredTools:offered,
    currentTools:current,
    remainingCalls
  };
}
