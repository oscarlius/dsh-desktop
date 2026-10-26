import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'..');
const {version}=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const output=mkdtempSync(join(tmpdir(),'dsh-company-host-verification-'));
const {DesktopHostProcess}=await import(pathToFileURL(join(root,'lib/host-process.js')).href);
const {NextProfiles}=await import(pathToFileURL(join(root,'lib/profiles.js')).href);
const home=mkdtempSync(join(output,'home-'));
const manager=new NextProfiles(home);const dir=manager.ensure('desktop');
const egress=join(home,'blocked-egress.log');
const entry=join(home,'isolated-host.mjs');
writeFileSync(entry,`
import {appendFileSync} from 'node:fs';
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://maas.zxrc.com.cn:8090'&&url.pathname==='/api/v1/desktop-auth/policy'){if(url.searchParams.get('clientVersion')!==${JSON.stringify(version)})throw Error('Fixture client version mismatch');return Promise.resolve(new Response(JSON.stringify({upgradeRequired:false}),{headers:{'content-type':'application/json'}}));}if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){appendFileSync(${JSON.stringify(egress)},url.origin+'\\n');return Promise.reject(Error('Fixture blocks external egress'));}return nativeFetch(input,init);};
await import(${JSON.stringify(pathToFileURL(join(root,'scripts/fixtures/isolated-user-host.mjs')).href)});
`);
const report={companyHost:true,isolatedHome:home,checks:[],vaultRequests:0,externalBrowserRequests:0,failures:[]};
let host;
try{
 const logger=chunk=>{writeFileSync(join(home,'host.log'),chunk,{flag:'a'});};
 host=new DesktopHostProcess(process.execPath,root,dir,undefined,{...process.env,DSH_HOME:home,DSH_COMPANY_MODE:'1',DSH_COMPANY_TRANSPORT_VERSION:version,DSH_TELEMETRY_DISABLED:'1'},e=>report.failures.push(e.message),join(root,'.desktop-build/runtime/x64/primary-runtime'),undefined,entry,undefined,undefined,logger,undefined,undefined,undefined,undefined,undefined,async request=>{report.vaultRequests++;assert.equal(request.action,'load');return {};},()=>{report.externalBrowserRequests++;throw Error('No browser authentication in cold boot fixture');});
 const ready=await Promise.race([host.start(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Cold Host boot timeout')),30000);timer.unref();})]);
 const auth=await fetch(ready.url,{redirect:'manual'});const cookie=auth.headers.get('set-cookie')?.split(';')[0];await auth.body?.cancel();assert.ok(cookie);
 const origin=new URL(ready.url).origin;
 const rpc=async(method,args={})=>{const response=await fetch(origin+'/api/pluginManager/'+method,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'pluginManager/'+method,payload:{args}})});const reply=await response.json();assert.equal(reply.result?.ok,true,JSON.stringify(reply));return reply.result.value;};
 const rows=await rpc('listPlugins');
 for(const moduleName of ['dsh-plugin-p7-company-models','dsh-plugin-p7-web-search','dsh-plugin-p7-mcp','dsh-streamfold']){
   const row=rows.find(row=>row.moduleName===moduleName);assert.equal(row?.fiberPhase,'active',JSON.stringify(row));report.checks.push({name:moduleName+' active',pass:true});
 }
 const statusResponse=await fetch(origin+'/p7-company-models/status',{headers:{cookie,origin}});assert.equal(statusResponse.status,200);const status=await statusResponse.json();assert.equal(status.loginRequired,true);assert.equal(status.models.length,0);report.checks.push({name:'unauthenticated company model gate',pass:true});
 assert.ok(ready.injections.some(value=>value.name==='__DSH_COMPANY_POLICY__'&&value.value.requirePersonalLogin===true));
 report.checks.push({name:'first frame company policy',pass:true});
 const restoreDeadline=Date.now()+5000;
 while(report.vaultRequests===0&&Date.now()<restoreDeadline)await new Promise(resolve=>setTimeout(resolve,25));
 assert.ok(report.vaultRequests>0,'Broker must use the native vault bridge');
 assert.equal(report.externalBrowserRequests,0);report.checks.push({name:'native vault connected before broker initialization',pass:true});
 const hmrPlugin=join(home,'hmr-fixture.mjs');
 writeFileSync(hmrPlugin,"export const name='company-hmr-fixture';export function apply(){}\n");
 writeFileSync(join(dir,'cordis.patch.yml'),JSON.stringify([{id:'p7-company-models',config:{requirePersonalLogin:false}},{insert:[{id:'company-hmr-fixture',name:pathToFileURL(hmrPlugin).href}]}]));
 const hmrDeadline=Date.now()+5000;let hmrActive=false;
 while(!hmrActive&&Date.now()<hmrDeadline){hmrActive=(await rpc('listPlugins')).some(row=>row.entryId.endsWith('company-hmr-fixture')&&row.fiberPhase==='active');if(!hmrActive)await new Promise(resolve=>setTimeout(resolve,50));}
 assert.ok(hmrActive,'Profile change must reach the real Loader');
 const reloadedStatus=await fetch(origin+'/p7-company-models/status',{headers:{cookie,origin}}).then(response=>response.json());
 assert.equal(reloadedStatus.loginRequired,true);report.checks.push({name:'real Profile HMR retains sealed company login requirement',pass:true});
 try{report.blockedEgress=readFileSync(egress,'utf8').trim().split('\n').filter(Boolean);}catch{report.blockedEgress=[];}
 assert.deepEqual(report.blockedEgress,[]);assert.deepEqual(report.failures,[]);
 console.log(JSON.stringify({passed:report.checks.length,vaultRequests:report.vaultRequests,externalRequests:0}));
}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{await host?.stop(true).catch(error=>{report.stopError=String(error);process.exitCode=1;});writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));}
