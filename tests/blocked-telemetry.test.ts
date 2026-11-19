import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyBlockedTelemetry} from '../src/blocked-telemetry.js';

const site='https://example.com/';
const datadog='https://browser-intake-us5-datadoghq.com/api/v2/rum';

test('blocked telemetry classification is restricted to proven HTTPS destinations and browser POSTs',()=>{
 assert.equal(classifyBlockedTelemetry(site,datadog+'?value=private-fixture','POST','fetch'),'datadog-rum');
 assert.equal(classifyBlockedTelemetry(site,'https://analytics.google.com/g/collect','POST','ping'),'google-analytics');
 assert.equal(classifyBlockedTelemetry(site,'https://www.google.com/pagead/1p-conversion/12345678901/','POST','fetch'),'google-ads');
 for(const [target,endpoint,method,resourceType,requested] of [
  [site,datadog+'/more','POST','fetch'],
  [site,datadog.replace('https:', 'http:'),'POST','fetch'],
  [site,datadog.replace('.com/', '.com:444/'),'POST','fetch'],
  [site,datadog.replace('.com/', '.com.evil.test/'),'POST','fetch'],
  [site,datadog.replace('https://', 'https://user@'),'POST','fetch'],
  [site,datadog.replace('/rum', '/%72um'),'POST','fetch'],
  [site,datadog,'POST','document'],
  [site,datadog,'OPTIONS','other','PUT'],
  [site,datadog,'OPTIONS','fetch','POST'],
  [site,datadog,'OPTIONS','other'],
  [site,datadog,'DELETE','fetch'],
  [site,'https://api.example.com/track','POST','fetch'],
  [site,'https://www.google.com/pagead/1p-conversion/1234567/extra','POST','fetch'],
  [site,'https://www.google.com/pagead/1p-conversion/account1/','POST','fetch'],
  [site,'https://www.google.com/api/primary-data','POST','fetch'],
 ])assert.equal(classifyBlockedTelemetry(target,endpoint,method,resourceType,requested),undefined,[target,endpoint,method,resourceType,requested].join(' '));
});
