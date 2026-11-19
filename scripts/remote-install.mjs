#!/usr/bin/env node
import {cp, mkdir, readFile, appendFile, lstat, access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{'ssh-host':{type:'string'},'codex-home':{type:'string'},'dashboard-url':{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('node scripts/remote-install.mjs --ssh-host user@host [--dashboard-url URL] [--codex-home /path]\nInstalls the UI Review skill and Codex MCP configuration without replacing existing entries.\nThe dashboard URL may use HTTPS or loopback HTTP.');process.exit(0);}
const host=values['ssh-host'];
if(!host||!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(host)){console.error('Provide --ssh-host as an SSH alias or user@host.');process.exit(1);}
let dashboard;
if(values['dashboard-url'] !== undefined){
  try{
    const url=new URL(values['dashboard-url']);
    const isLoopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    const isAllowedProtocol=url.protocol==='https:'||(url.protocol==='http:'&&isLoopback);
    if(!isAllowedProtocol||url.username||url.password||url.href.includes('?')||url.href.includes('#'))throw new Error();
    dashboard=url.href;
  }catch{
    console.error('--dashboard-url must use HTTPS or loopback HTTP, without credentials, query or fragment.');
    process.exit(1);
  }
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const codexHome=resolve(values['codex-home']||process.env.CODEX_HOME||join(homedir(),'.codex'));
const config=join(codexHome,'config.toml');
const skill=join(codexHome,'skills','ui-review');
try{await access(join(root,'dist','request-mcp-cli.js'),constants.R_OK);}catch{console.error('Build the project first: pnpm run build');process.exit(1);}
let existing='';
try{existing=await readFile(config,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
// Refuse all ambiguous existing references, including quoted and dotted TOML keys.
if(/ui-review/i.test(existing)||/^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=/m.test(existing)){console.error(`Existing ui-review configuration or reference in ${config}; review it manually before installing.`);process.exit(1);}
let hasSkill=false;
try{await lstat(skill);hasSkill=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(hasSkill){console.error(`Existing skill at ${skill}; review it before replacing it manually.`);process.exit(1);}
await mkdir(join(codexHome,'skills'),{recursive:true});
await cp(join(root,'skills','ui-review'),skill,{recursive:true,errorOnExist:true,force:false});
await appendFile(join(skill,'SKILL.md'),`\n## 원격 연결\n\n이 스킬은 원격 SSH 터널을 통해 서버에 연결한다. 연결 실패 시 로컬 viewer를 시작하지 말고 SSH 키 인증과 원격 서버 상태를 확인한다. 서버가 반환하는 localhost 대시보드 URL은 클라이언트에서 사용할 수 없다.${dashboard?` 사용자에게는 ${dashboard} 주소를 안내한다.`:' 사용자에게 원격 대시보드 주소를 확인한다.'}\n`);
const entry=join(root,'scripts','remote-mcp.mjs');
const block=`\n[mcp_servers.ui-review]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "--ssh-host", ${JSON.stringify(host)}]\n`;
try{await appendFile(config,(existing.endsWith('\n')||!existing?'':'\n')+block,{mode:0o600});}
catch(error){console.error(`Skill installed at ${skill}, but configuration could not be written: ${error.message}`);process.exit(1);}
console.log(`Installed skill: ${skill}\nRegistered MCP in: ${config}\nRestart Codex. SSH key authentication must work without prompts. The tunnel starts with the MCP and chooses an available local port.`);
