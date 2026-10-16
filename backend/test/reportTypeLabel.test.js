const test = require('node:test');
const assert = require('node:assert/strict');
const { reportTypeLabel } = require('../src/controllers/reportController');

test('construction reports read as roadworks, matching the app', () => {
  assert.equal(reportTypeLabel('construction'), 'roadworks');
});

test('other report types keep their own words', () => {
  assert.equal(reportTypeLabel('police'), 'police');
  assert.equal(reportTypeLabel('road_closure'), 'road closure');
  assert.equal(reportTypeLabel('flood'), 'flood');
});
