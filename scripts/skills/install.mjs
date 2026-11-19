import {cp, mkdir, lstat, realpath} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{target:{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('pnpm run skill:install --target /absolute/path/to/skills\nCopies ui-review into the explicit skills directory. Existing destinations are never overwritten.');process.exit(0);}
if(!values.target){console.error('--target is required. Choose a Codex or Claude skills directory explicitly.');process.exit(1);}
const source=resolve(dirname(fileURLToPath(import.meta.url)),'../../skills/ui-review');
const destination=join(resolve(values.target),'ui-review');
try{await lstat(destination);throw new Error(`Destination already exists: ${destination}. Review it before replacing it manually.`);}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(values.target,{recursive:true});
const targetRoot=await realpath(values.target);
await cp(source,join(targetRoot,'ui-review'),{recursive:true,errorOnExist:true,force:false});
console.log(`Installed: ${join(targetRoot,'ui-review')}\nRestart or reload your agent to discover the skill. MCP configuration is separate and was not changed.`);
