const assert = require('assert');
const tripcode = require('./tripcode');

tripcode.setSalt('0123456789012345'); // dummy salt - secure trips untested

assert.equal(tripcode.hash('GUH', ''), '!LUF/KZkngk');
console.log('OK');
