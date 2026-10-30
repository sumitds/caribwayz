// The website rule the forms share with the API. Run with: npm test (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { isWebAddress } from '../src/utils/webAddress.js';

const require = createRequire(import.meta.url);
const api = require('../../api/src/utils/webAddress.js');

const CASES = [
  '', 'https://grill.example.com', 'http://grill.example.com/menu?x=1', 'www.grill.example', 'grill.example.com:8080/menu',
  'javascript:alert(1)', 'JavaScript:alert(1)', 'javascript://example.com/%0Aalert(1)', 'intent://scan/#Intent;end',
  'intent:#Intent;end', 'data:text/html,x', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'mailto:a@b.com', 'tel:+18765550100',
  'ftp://files.example.com', 'https://user:pass@grill.example.com', 'java\tscript:alert(1)', 'grill', 'https://', 5, null,
];

test('the forms accept and refuse exactly what the API does', () => {
  for (const value of CASES) {
    assert.equal(isWebAddress(value), api.isWebAddress(value), JSON.stringify(value));
  }
  assert.equal(isWebAddress('javascript:alert(1)'), false);
  assert.equal(isWebAddress('www.grill.example'), true);
});
