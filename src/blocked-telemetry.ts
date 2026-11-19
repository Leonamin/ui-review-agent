export type BlockedTelemetryKind='datadog-rum'|'google-analytics'|'google-ads';

const exactTelemetryEndpoints=new Map<string,BlockedTelemetryKind>([
 ['https://browser-intake-us5-datadoghq.com/api/v2/rum','datadog-rum'],
 ['https://analytics.google.com/g/collect','google-analytics'],
 ['https://www.google.com/g/collect','google-analytics'],
 ['https://stats.g.doubleclick.net/g/collect','google-analytics'],
 ['https://www.google.com/ccm/collect','google-ads'],
 ['https://ad.doubleclick.net/ccm/s/collect','google-ads'],
 ['https://www.google.com/measurement/conversion','google-ads'],
]);

/** Identify already-blocked collection traffic. This never grants network access. */
export function classifyBlockedTelemetry(targetUrl:string|undefined,requestUrl:string,method:string,resourceType:string,preflightMethod?:string):BlockedTelemetryKind|undefined{
 const isPost=method==='POST'&&['fetch','xhr','ping'].includes(resourceType);
 const isPostPreflight=method==='OPTIONS'&&preflightMethod==='POST'&&resourceType==='other';
 if(!isPost&&!isPostPreflight)return;
 const url=URL.parse(requestUrl);
 if(!url||url.protocol!=='https:'||url.username||url.password)return;
 // Match only the collection route. Query, credentials and account values are never retained.
 const endpoint=url.origin+url.pathname;
 const known=exactTelemetryEndpoints.get(endpoint);
 if(known)return known;
 if(url.origin==='https://www.google.com'&&/^\/(?:rmkt\/collect|pagead\/1p-conversion)\/[0-9]{6,15}\/$/.test(url.pathname))return 'google-ads';
 if(url.origin==='https://googleads.g.doubleclick.net'&&/^\/pagead\/viewthroughconversion\/[0-9]{6,15}\/$/.test(url.pathname))return 'google-ads';
}
