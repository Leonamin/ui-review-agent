#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createRequestMcp,ReviewServiceClient} from './request-mcp.js';
const {values}=parseArgs({options:{service:{type:'string',default:'http://127.0.0.1:4317'},'forwarded-origin':{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('UI Review external request MCP (stdio)\nnode dist/request-mcp-cli.js [--service http://127.0.0.1:4317]\nStart pnpm run viewer separately. This adapter never starts its own worker.');process.exit(0);}
try{const client=new ReviewServiceClient(values.service,values['forwarded-origin']);try{await client.request('/api/review-service');}catch(error){console.error(error instanceof Error?error.message:'Review service unavailable');}await createRequestMcp(client).connect(new StdioServerTransport());}
catch(error){console.error(error instanceof Error?error.message:'MCP startup failed');process.exitCode=1;}
