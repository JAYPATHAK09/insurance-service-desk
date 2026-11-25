import assert from 'node:assert/strict';
import {modes,offline} from './lib/engine.js';
assert.equal(offline(modes[0],'Bill | signed','Bill | signed @ ACK')[0].status,'receipt located');
assert.equal(offline(modes[0],'Bill | signed','Bill | unsigned @ ACK')[0].status,'partial evidence');
assert.equal(offline(modes[1],'Diabetes | yes','Diabetes | no')[0].status,'contradiction');
assert.equal(offline(modes[2],'Co-pay | 0%','Co-pay | 20%')[0].status,'changed');
assert.throws(()=>offline(modes[1],'X | yes\nX | no','X | no'));
console.log('All five rule checks passed');
