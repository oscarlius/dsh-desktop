/** Live HTTPS acceptance. OAuth is a local fixture; model/search/Gildata are real network calls. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { AccountBroker } from '../../lib/account-broker.js'
import { CompanyHost } from '../../lib/company-host.js'
import { installPersonalCredentialOverlay } from '../../lib/personal-credential-overlay.js'

const [metadataPath, reportPath] = process.argv.slice(2)
assert(metadataPath && reportPath)
const info=JSON.parse(readFileSync(metadataPath,'utf8'))
assert.equal(new URL(info.origin).hostname,'127.0.0.1')
assert.equal(process.env.NODE_EXTRA_CA_CERTS,info.ca)
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0')
const requireMcp=createRequire(pathToFileURL(resolve('dsh-plugin-p7-mcp/package.json')))
const requireDesktop=createRequire(pathToFileURL(resolve('dsh-plugin-desktop-beta/package.json')))
const {LocalCredentialProvider}=await import(pathToFileURL(requireDesktop.resolve('@deepseek-ai/dsh-credentials-local')).href)
const {ToolRuntime}=await import(pathToFileURL(requireMcp.resolve('@deepseek-ai/dsh-tools')).href)
const ManagedMcp=await import(pathToFileURL(resolve('dsh-plugin-p7-mcp/lib/index.js')).href)
const ctx=new Context()
const profileDir=mkdtempSync(join(tmpdir(),'p7-personal-mcp-'))
ctx.provide('profileContext',{dir:profileDir})
await ctx.plugin(LocalCredentialProvider,{path:join(profileDir,'.credentials.yaml'),watch:false})
ctx.provide('systemPrompt',{tools:()=>()=>{}})
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolRuntime,{mode:'native'})
let providers={};let settingsRevision=0;let selection={provider:'',model:''}
const adapterFiber=await ctx.plugin(PiAi,{providers})
let saved={version:1,origin:info.origin,ownedIds:[]}
const makeBroker=(profileId,employee,deviceFingerprint)=>new AccountBroker({origin:()=>info.origin,profileId,deviceFingerprint,openBrowser:async value=>{
  const landing=await fetch(value,{signal:AbortSignal.timeout(10000)});assert.equal(landing.status,200)
  const html=await landing.text();const href=html.match(/href="([^"]+)"/)[1].replaceAll('&amp;','&')
  const continuation=await fetch(new URL(href,info.origin),{redirect:'manual',signal:AbortSignal.timeout(10000)});assert.equal(continuation.status,302)
  const url=new URL(continuation.headers.get('location'));assert.equal(url.pathname,'/_fixture/authorize');url.searchParams.set('employee',employee)
  const result=await fetch(url,{signal:AbortSignal.timeout(10000)});assert.equal(result.status,200);await result.text()
}})
const account=makeBroker(profileDir,'a',()=>host.currentDeviceId())
ctx.provide('p7Account',account)
const host=new CompanyHost({profileId:profileDir,personalMode:()=>account.usesPersonalToken(),resolvePersonalAccessToken:()=>account.getValidAccessToken(),onPersonalModeLoaded:v=>account.setPersonalMode(v),
  modelNamespace:()=> 'models',settings:{describe:()=>[{ns:'models',revision:settingsRevision,value:{providers}}],mutate:async(_ns,operations,expected)=>{
    assert.equal(expected,settingsRevision);const next={...providers}
    for(const op of operations){if(op.op==='set')next[op.path[1]]=op.value;else if(op.op==='unset')delete next[op.path[1]];else assert.fail('Unexpected settings operation')}
    adapterFiber.update({providers:next});await adapterFiber.await();providers=next;settingsRevision++
  }},persistence:{load:async()=>saved,save:async value=>{saved=structuredClone(value);writeFileSync(join(profileDir,'.p7-company-models.json'),JSON.stringify(value))}},
  credentials:{read:async ref=>(await ctx.credentials.resolve(ref))?.value,set:(ref,value)=>ctx.credentials.set(ref,value),unset:ref=>ctx.credentials.unset(ref)},
  readDefault:()=>selection,saveDefault:async(provider,model)=>{selection={provider,model}}
})
const removeOverlay=installPersonalCredentialOverlay(ctx.credentials,host.credentialRef,account)
const wait=async(predicate,message)=>{const until=Date.now()+15000;while(Date.now()<until){if(await predicate())return;await new Promise(r=>setTimeout(r,50))}assert.fail(message)}
const report={transport:'real HTTPS',oauth:'local fixture',upstreams:'real public P7 model/search and real Gildata',checks:[]}
const check=name=>{report.checks.push(name);console.log('PASS '+name)}
const stream=async(messages,tools)=>{
  const blocks=new BlockAssembler()
  for await(const chunk of ctx.llm.stream({...selection,messages,tools}))blocks.push(chunk)
  assert(!['error','aborted'].includes(blocks.finish.kind),JSON.stringify(blocks.finish))
  return blocks.message({...selection,...(blocks.replayState===undefined?{}:{replayState:blocks.replayState})})
}
let other
try{
  await host.initialize()
  await host.connect(info.origin,'p7k_LOCAL_ACCEPTANCE_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  assert.equal(host.status().phase,'ready');check('legacy shared credential still loads model catalog')
  await account.login();await wait(()=>account.status().phase==='signed-in','Personal login did not complete')
  await host.personalSessionChanged();assert.equal(host.status().phase,'ready')
  assert.equal(account.status().profile.userId,'employee-a');check('PKCE loopback personal login and personal model catalog')
  await ctx.plugin(ManagedMcp)
  await wait(()=>ctx.tools.schemas().length===2,'Managed MCP tools did not register')
  const schemas=ctx.tools.schemas();report.tools=schemas.map(t=>t.name)
  assert(report.tools.includes('mcp__p7__gildata__FinQuery'));check('actual Host MCP plugin registers Gildata and search into ToolRuntime')
  const question=createUserMessage({content:[{type:'text',text:'请必须调用工具 mcp__p7__gildata__FinQuery 查询贵州茅台2024年年报营业总收入和归母净利润，注明报告期、币种和单位。工具名称必须使用提供的完整名称 mcp__p7__gildata__FinQuery，不能使用简称。先调用工具，不要凭记忆回答。'}]})
  const first=await stream([question],schemas.filter(t=>t.name.includes('FinQuery')))
  report.first=first.content
  const call=first.content.find(block=>block.type==='tool-call')
  assert(call,'Live model did not request a tool');assert.equal(call.name,'mcp__p7__gildata__FinQuery')
  const executed=await ctx.tools.execute({name:call.name,arguments:JSON.parse(call.arguments),callId:call.id,signal:AbortSignal.timeout(120000)})
  assert.equal(executed.isError,false,JSON.stringify(executed))
  report.gildata=executed.content
  const answer=await stream([question,first,createToolResultMessage({callId:call.id,content:executed.content,isError:false}),createUserMessage({content:[{type:'text',text:'查询工具已返回数据。现在请根据工具结果直接列出营业总收入、归母净利润的金额、报告期和单位，不要再次调用工具。'}]})],[])
  report.answer=answer.content.filter(t=>t.type==='text').map(t=>t.text).join('')
  assert.match(report.answer,/174[,.]?144|1741\.44|1,741\.44|1,741\.440|174144069958/)
  check('live Qwen tool decision -> DSH ToolRuntime -> local P7 -> Gildata -> model answer')
  const search=await ctx.tools.execute({name:'mcp__p7__search__web_search',arguments:{query:'Model Context Protocol official specification',pageno:1},callId:'real-search',signal:AbortSignal.timeout(60000)})
  report.search=search
  if(search.isError)report.searchUnavailable=true
  else{assert(JSON.stringify(search.content).includes('https://'));check('search MCP returns actual public internet sources')}
  const usage=await account.usage('2026-10-20T00:00:00Z','2026-10-23T00:00:00Z','service')
  assert(usage.totals.mcpCalls>=2);assert(usage.totals.inputTokens>0);report.usageA=usage
  other=makeBroker(profileDir+'-b','b');await other.login();await wait(()=>other.status().phase==='signed-in','Employee B login failed')
  const usageB=await other.usage('2026-10-20T00:00:00Z','2026-10-23T00:00:00Z','service')
  assert.equal(usageB.totals.requests,0);report.usageB=usageB;check('personal A sees actual model/search/MCP usage; B sees no A traffic')
  const serialized=JSON.stringify(saved)
  assert(!serialized.includes('p7d_')&&!serialized.includes('p7r_'));assert.equal(saved.personalMode,true)
  const credentialDocument=readFileSync(join(profileDir,'.credentials.yaml'),'utf8')
  assert(!credentialDocument.includes('p7d_')&&!credentialDocument.includes('p7r_'))
  check('real LocalCredentialProvider and published model adapter use personal tokens without persisting them')
  await account.logout();await host.personalSessionChanged();await wait(()=>ctx.tools.schemas().length===0,'Logout did not remove MCP tools')
  assert.equal(account.usesPersonalToken(),true);assert(credentialDocument.includes('p7k_LOCAL_ACCEPTANCE'));assert.equal(host.status().models.length,0)
  check('logout clears personal tools/models and denies fallback while retaining legacy compatibility')
  report.passed=!report.searchUnavailable
  if(report.searchUnavailable)throw new Error('Core identity/usage passed; public search upstream unavailable in this run. See separate successful live search evidence.')
}catch(error){report.passed=false;report.error=String(error);throw error}
finally{
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n')
  removeOverlay();await host.dispose();await account.logout();await other?.logout();await account.dispose();await other?.dispose();await ctx.fiber.dispose();rmSync(profileDir,{recursive:true,force:true})
}
