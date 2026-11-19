#!/usr/bin/env node
// Keep the MCP and its SSH forward in the same lifetime. Stdout belongs to MCP.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {get} from 'node:http';
import {parseArgs} from 'node:util';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const {values}=parseArgs({options:{'ssh-host':{type:'string'}}});
const host=values['ssh-host'];
if(!host || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(host)){
  console.error('A valid --ssh-host (SSH alias or user@host) is required.'); process.exit(1);
}
// Each MCP session receives its own local port; the service validates its
// original host and origin, which the adapter supplies over the SSH tunnel.
const probe=createServer();
await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
const port=probe.address().port;
await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
const ssh=spawn('ssh',['-T','-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-L',`127.0.0.1:${port}:127.0.0.1:4317`,host],{stdio:['ignore','ignore','inherit']});
let isSshExited=false;
let sshError;
ssh.on('error',error=>{sshError=error;isSshExited=true;});
ssh.on('exit',()=>{isSshExited=true;});
let adapter;
let isStopping=false;
function stop(){if(isStopping)return;isStopping=true;adapter?.kill();ssh.kill();}
process.on('SIGINT',()=>{stop();process.exit(130);});
process.on('SIGTERM',()=>{stop();process.exit(143);});
process.on('exit',stop);
const deadline=Date.now()+15000;
let isReady=false;
while(Date.now()<deadline&&!isSshExited){
  try {
    const status=await new Promise((resolve,reject)=>{const request=get(`http://127.0.0.1:${port}/api/review-service`,{headers:{host:'127.0.0.1:4317'},signal:AbortSignal.timeout(1000)},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('error',reject);response.on('end',()=>{try{resolve(response.statusCode===200?JSON.parse(data):null);}catch(error){reject(error);}});});request.on('error',reject);});
    if(status?.status==='ready'&&status.version===1){isReady=true;break;}
  } catch {}
  await new Promise(resolve=>setTimeout(resolve,150));
}
if(!isReady||isSshExited){
  console.error(`UI Review SSH tunnel failed. Check SSH key authentication, ${host}, and the remote service.${sshError?` ${sshError.message}`:''}`);
  stop(); process.exit(1);
}
const entry=resolve(dirname(fileURLToPath(import.meta.url)),'../dist/request-mcp-cli.js');
adapter=spawn(process.execPath,[entry,'--service',`http://127.0.0.1:${port}`,'--forwarded-origin','http://127.0.0.1:4317'],{stdio:'inherit'});
adapter.on('error',error=>{console.error(`Cannot start UI Review MCP: ${error.message}`);stop();process.exitCode=1;});
adapter.on('exit',(code,signal)=>{stop();process.exitCode=code??(signal?1:0);});
ssh.on('exit',()=>{if(!isStopping){console.error('UI Review SSH tunnel disconnected.');stop();process.exitCode=1;}});
