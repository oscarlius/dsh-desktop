import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { publishCompanyRelease, validateCompanyRelease } from './publish-company-release.mjs'

function bundle(t) {
  const root = mkdtempSync(join(tmpdir(), 'p7-paired-release-'))
  t.after(() => rmSync(root, { recursive:true, force:true }))
  const version = '2.0.18-beta.15', sourceCommit = 'a'.repeat(40)
  const manifest = { schemaVersion:1,channel:'companytest',version,sourceCommit,artifacts:[] }
  for(const mode of ['full','update']) {
    const path = join(root,mode,'win-unpacked/resources/app');mkdirSync(path,{recursive:true})
    writeFileSync(join(path,'package.json'),JSON.stringify({version,dshDesktopFlavor:'companytest',dshCompanyReleaseSourceCommit:sourceCommit,...(mode==='update'?{dshDesktopUpdateDistribution:true}:{})}))
  }
  writeFileSync(join(root,'full/win-unpacked/resources/p7-company-connection.json'),JSON.stringify({origin:'https://maas.zxrc.com.cn:8090',key:'p7k_unit_test_not_a_real_secret'}))
  const data = { 'initial-exe':Buffer.from('MZ-full-test-package'), exe:Buffer.from('MZ-credential-free-update-package') }
  data.blockmap=gzipSync(JSON.stringify({version:'2',files:[{name:'file',offset:0,sizes:[data.exe.length],checksums:['fixture']}]}))
  for(const component of ['initial-exe','exe','blockmap']) {
    const path=component==='initial-exe'?`full/P7-DSH-Company-Full-${version}-x64-Setup.exe`:`update/P7-DSH-Company-Test-${version}-x64-Setup.exe${component==='blockmap'?'.blockmap':''}`
    writeFileSync(join(root,path),data[component]);manifest.artifacts.push({component,path,size:data[component].length,sha256:createHash('sha256').update(data[component]).digest('hex'),sha512:createHash('sha512').update(data[component]).digest('base64')})
  }
  const save=()=>writeFileSync(join(root,'release-manifest.json'),JSON.stringify(manifest));save()
  return {root,manifest,save}
}
function server(manifest) {
  const present=new Set(),uploads=[],calls=[]
  let current={published:true,version:'2.0.18-beta.14',revision:5}, failComponent=null
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname,method=options.method||'GET';calls.push({method,path})
    assert.equal(options.headers.Authorization,'Bearer test-session')
    if(path.endsWith('/readiness')) {
      const artifacts=Object.fromEntries(manifest.artifacts.map(a=>[a.component,{available:present.has(a.component),...(present.has(a.component)?a:{})}]))
      return reply({version:manifest.version,ready:present.size===3,artifacts})
    }
    if(method==='POST') {
      const component=path.endsWith('/initial-installer')?'initial-exe':path.endsWith('/blockmap')?'blockmap':'exe'
      const item=manifest.artifacts.find(a=>a.component===component)
      assert.equal(options.headers['X-DSH-Artifact-Name'],item.path.split('/').at(-1))
      for await(const _chunk of options.body) {} // Simulate the server consuming the raw stream.
      if(component===failComponent){failComponent=null;return reply({},503)}
      uploads.push(component);present.add(component);return reply({version:manifest.version,...item})
    }
    if(method==='PUT') {
      assert.equal(present.size,3,'publication must happen after all three staged uploads')
      const body=JSON.parse(options.body);assert.equal(body.expectedRevision,current.revision)
      current={...current,version:body.version,revision:current.revision+1,sha256:manifest.artifacts[1].sha256,blockmapSha256:manifest.artifacts[2].sha256}
    }
    return reply(current)
  }
  return {fetchImpl,present,uploads,calls,get current(){return current},set fail(value){failComponent=value}}
}
const options=(b,s)=>({directory:b.root,token:'test-session',notes:'Paired release test',reason:'test',fetchImpl:s.fetchImpl})

test('validates the paired source, role, checksums and differential coverage',async t=>{
  const b=bundle(t);assert.equal((await validateCompanyRelease(b.root)).manifest.version,b.manifest.version)
  b.manifest.artifacts[0].path=b.manifest.artifacts[1].path;b.save()
  await assert.rejects(validateCompanyRelease(b.root),/Wrong role/)
})
test('tampering or a leaked bootstrap blocks publication before any network call',async t=>{
  const b=bundle(t),s=server(b.manifest)
  writeFileSync(join(b.root,b.manifest.artifacts[1].path),'tampered')
  await assert.rejects(publishCompanyRelease(options(b,s)),/size|hash/);assert.equal(s.calls.length,0)
  const other=bundle(t)
  writeFileSync(join(other.root,'update/win-unpacked/resources/p7-company-connection.json'),'unexpected')
  await assert.rejects(validateCompanyRelease(other.root),/credential-free/)
})
test('rejects a source mismatch and missing Full instead of allowing an update-only release',async t=>{
  const b=bundle(t)
  const path=join(b.root,'update/win-unpacked/resources/app/package.json'),value=JSON.parse(readFileSync(path,'utf8'))
  value.dshCompanyReleaseSourceCommit='b'.repeat(40);writeFileSync(path,JSON.stringify(value))
  await assert.rejects(validateCompanyRelease(b.root),/source\/version/)
  const other=bundle(t);other.manifest.artifacts.shift();other.save()
  await assert.rejects(validateCompanyRelease(other.root),/supplied together/)
})
test('failed upload retains old release; resume skips matching staged Full and only then publishes',async t=>{
  const b=bundle(t),s=server(b.manifest);s.fail='exe'
  await assert.rejects(publishCompanyRelease(options(b,s)),/HTTP 503/)
  assert.equal(s.current.version,'2.0.18-beta.14');assert.equal(s.current.revision,5)
  assert.equal(s.calls.filter(c=>c.method==='PUT').length,0)
  assert.equal(existsSync(join(b.root,'publication-receipt.json')),false)
  const receipt=await publishCompanyRelease(options(b,s))
  assert.equal(receipt.status,'published');assert.equal(receipt.revision,6)
  assert.deepEqual(s.uploads,['initial-exe','exe','blockmap'])
  await publishCompanyRelease(options(b,s))
  assert.equal(s.calls.filter(c=>c.method==='PUT').length,1,'repeat publication must not emit another revision')
})
test('stage-only uploads both installers but leaves the public reminder unchanged',async t=>{
  const b=bundle(t),s=server(b.manifest)
  const receipt=await publishCompanyRelease({...options(b,s),stageOnly:true})
  assert.equal(receipt.status,'staged');assert.equal(s.current.revision,5);assert.equal(s.present.size,3)
  assert.equal(s.calls.filter(c=>c.method==='PUT').length,0)
})
test('an immutable staged mismatch cannot be overwritten or published',async t=>{
  const b=bundle(t),s=server(b.manifest);s.present.add('initial-exe')
  const mock=s.fetchImpl
  const fetchImpl=async(...args)=>{
    const response=await mock(...args)
    if(new URL(args[0]).pathname.endsWith('/readiness')){const body=await response.json();body.artifacts['initial-exe'].sha256='0'.repeat(64);return new Response(JSON.stringify(body))}
    return response
  }
  await assert.rejects(publishCompanyRelease({...options(b,s),fetchImpl}),/Immutable server artifact differs/)
  assert.equal(s.uploads.length,0);assert.equal(s.current.revision,5)
})
