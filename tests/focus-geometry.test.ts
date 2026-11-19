import test from 'node:test';import assert from 'node:assert/strict';
import {imagePoint,regionBetween,isValidRegion} from '../viewer/features/focus/geometry.js';
test('selection maps responsive display coordinates to original pixels and clamps captured pointer outside image',()=>{
 const display={left:100,top:200,width:400,height:200},natural={width:1600,height:800};
 assert.deepEqual(imagePoint({x:200,y:250},display,natural),{x:400,y:200});
 assert.deepEqual(imagePoint({x:-1,y:999},display,natural),{x:0,y:800});
 assert.equal(imagePoint({x:0,y:0},{...display,width:0},natural),null);
});
test('reverse drag preserves same region, rejects empty/subpixel selections, validates image edges',()=>{
 const a={x:10.2,y:12.3},b={x:40.8,y:42.2};assert.deepEqual(regionBetween(a,b),regionBetween(b,a));
 assert.deepEqual(regionBetween(a,b),{x:10,y:12,width:31,height:31});assert.equal(regionBetween(a,a),null);
 assert.equal(regionBetween(a,{x:10.8,y:40}),null);
 assert.equal(isValidRegion({x:0,y:0,width:100,height:200},{width:100,height:200}),true);
 assert.equal(isValidRegion({x:1,y:0,width:100,height:200},{width:100,height:200}),false);
 assert.equal(isValidRegion({x:0,y:0,width:NaN,height:1},{width:100,height:200}),false);
});
