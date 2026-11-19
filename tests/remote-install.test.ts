import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';

const root=resolve('.');
const install=join(root,'scripts/remote-install.mjs');
const runner=join(root,'scripts/remote-mcp.mjs');

before(()=>{
 if(!existsSync(join(root,'dist/request-mcp-cli.js'))){
  const result=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc')],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,`MCP build failed: ${result.stdout} ${result.stderr}`);
 }
});

test('remote install preserves existing config and refuses a second installation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ui-review-install-'));
 try{
  const config=join(dir,'config.toml');
  await writeFile(config,'model = "example"\n');
  const args=[install,'--ssh-host','alice@review-server','--dashboard-url','http://127.0.0.1:4317','--codex-home',dir];
  const first=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);
  const written=await readFile(config,'utf8');
  assert.match(written,/^model = "example"/);
  assert.match(written,/\[mcp_servers\.ui-review\]/);
  assert.match(written,/alice@review-server/);
  const skill=await readFile(join(dir,'skills/ui-review/SKILL.md'),'utf8');
  assert.match(skill,/UI Review/);
  assert.ok(skill.includes('http://127.0.0.1:4317/'));
  const second=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.notEqual(second.status,0);
  assert.equal(await readFile(config,'utf8'),written);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('remote installer accepts HTTPS dashboard URLs and rejects unsafe URL forms',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ui-review-install-url-'));
 try{
  const args=[install,'--ssh-host','review-server','--codex-home',dir,'--dashboard-url'];
  for(const url of ['http://review.example.com','http://localhost.example.com','http://alice:secret@localhost','https://review.example.com/?','https://review.example.com/#']){
   const result=spawnSync(process.execPath,[...args,url],{encoding:'utf8'});
   assert.notEqual(result.status,0,url);
   assert.match(result.stderr,/must use HTTPS or loopback HTTP/);
   assert.equal(existsSync(join(dir,'config.toml')),false);
  }
  const result=spawnSync(process.execPath,[...args,'https://review.example.com'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.ok((await readFile(join(dir,'skills/ui-review/SKILL.md'),'utf8')).includes('https://review.example.com/'));
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('remote MCP forwards stdio and stops the SSH child',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ui-review-ssh-'));
 const fake=join(dir,'ssh');
 const log=join(dir,'ssh-args');
 await writeFile(fake,`#!${process.execPath}\nconst http=require('node:http'); const fs=require('node:fs'); fs.writeFileSync(process.env.FAKE_SSH_LOG,JSON.stringify(process.argv.slice(2))); http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.headers.host!=='127.0.0.1:4317'){res.statusCode=403;res.end('{}');return;}res.end(JSON.stringify({status:'ready',version:1}));}).listen(Number(process.argv[process.argv.indexOf('-L')+1].split(':')[1]),'127.0.0.1'); process.on('SIGTERM',()=>process.exit(0));\n`);
 await chmod(fake,0o755);
 const child=spawn(process.execPath,[runner,'--ssh-host','alice@review-server'],{env:{...process.env,PATH:dir+':'+process.env.PATH,FAKE_SSH_LOG:log},stdio:['pipe','pipe','pipe']});
 let output='';let errors='';
 child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
 try{
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  const deadline=Date.now()+7000;
  while(!output.includes('"id":1')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
  assert.match(output,/"id":1/,errors);
  assert.match(await readFile(log,'utf8'),/ExitOnForwardFailure=yes/);
  child.stdin.end();
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('MCP did not exit after stdin closed')),3000))]);
  const forwarded=JSON.parse(await readFile(log,'utf8'));
  const port=Number(forwarded[forwarded.indexOf('-L')+1].split(':')[1]);
  const probe=createServer();
  const until=Date.now()+3000;
  while(true){
   try{await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});break;}
   catch(error){if(Date.now()>until)throw error;await new Promise(r=>setTimeout(r,50));}
  }
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
 } finally {child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});


test('remote installer refuses inline MCP table without changing config',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ui-review-inline-'));
 try{
  const config=join(dir,'config.toml');
  const before='"mcp_servers" = { other = { command = "node" } }\n';
  await writeFile(config,before);
  const result=spawnSync(process.execPath,[install,'--ssh-host','host','--codex-home',dir],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.equal(await readFile(config,'utf8'),before);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('remote MCP reports SSH authentication failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ui-review-ssh-fail-'));
 try{
  await writeFile(join(dir,'ssh'),'#!/bin/sh\necho "Permission denied" >&2\nexit 255\n');
  await chmod(join(dir,'ssh'),0o755);
  const result=spawnSync(process.execPath,[runner,'--ssh-host','host'],{env:{...process.env,PATH:dir+':'+process.env.PATH},encoding:'utf8',timeout:5000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/SSH tunnel failed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('forwarded requests use the remote service host and origin',async()=>{
 const {createServer}=await import('node:http');
 const {ReviewServiceClient}=await import('../src/request-mcp.js');
 const server=createServer((request,response)=>{
  assert.equal(request.headers.host,'127.0.0.1:4317');
  assert.equal(request.headers.origin,'http://127.0.0.1:4317');
  response.setHeader('content-type','application/json');
  response.end('{"ok":true}');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const client=new ReviewServiceClient(`http://127.0.0.1:${address.port}`,'http://127.0.0.1:4317');
  assert.deepEqual(await client.request('/api/test',{value:1}),{ok:true});
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
