export interface ImagePoint {x:number;y:number}
export interface ImageRegion {x:number;y:number;width:number;height:number}
export function imagePoint(client:ImagePoint,display:{left:number;top:number;width:number;height:number},natural:{width:number;height:number}):ImagePoint|null {
 if(display.width<=0||display.height<=0||natural.width<=0||natural.height<=0)return null;
 return {x:Math.max(0,Math.min(natural.width,(client.x-display.left)*natural.width/display.width)),y:Math.max(0,Math.min(natural.height,(client.y-display.top)*natural.height/display.height))};
}
export function regionBetween(a:ImagePoint,b:ImagePoint):ImageRegion|null {
 const x=Math.floor(Math.min(a.x,b.x)),y=Math.floor(Math.min(a.y,b.y));
 const width=Math.ceil(Math.max(a.x,b.x))-x,height=Math.ceil(Math.max(a.y,b.y))-y;
 if(Math.abs(a.x-b.x)<1||Math.abs(a.y-b.y)<1)return null;
 return {x,y,width,height};
}
export function isValidRegion(region:ImageRegion,natural:{width:number;height:number}):boolean {
 return Object.values(region).every(Number.isInteger)&&region.x>=0&&region.y>=0&&region.width>0&&region.height>0&&region.x+region.width<=natural.width&&region.y+region.height<=natural.height;
}
