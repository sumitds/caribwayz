// The public /privacy and /terms pages. Run with: npm test (node --test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import privacyPolicy from '../src/legal/privacyPolicy.js';
import termsOfService from '../src/legal/termsOfService.js';
import businessMembershipPolicy from '../src/legal/businessMembershipPolicy.js';
import { parseLegalDocument, parseInline, groupBullets, LEGAL_APPROVED, DRAFT_LABEL } from '../src/legal/legalDocument.js';

const repoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('the legal text', () => {
  test('is word for word the text the app ships and the lawyer reviews', () => {
    assert.equal(privacyPolicy, repoFile('docs/legal/privacy-policy.md'));
    assert.equal(termsOfService, repoFile('docs/legal/terms-of-service.md'));
    assert.equal(privacyPolicy, repoFile('mobile/assets/legal/privacy-policy.md'));
    assert.equal(termsOfService, repoFile('mobile/assets/legal/terms-of-service.md'));
  });

  test('the Business Membership Policy is word for word the client policy file, and reads as a document', () => {
    assert.equal(businessMembershipPolicy, repoFile('docs/legal/business-membership-policy.md'));
    const doc = parseLegalDocument(businessMembershipPolicy);
    assert.equal(doc.title, 'CaribWayz Business Membership Policy');
    assert.equal(doc.version, '0.1 (draft)');
    assert.equal(doc.lastUpdated, '9 November 2026');
    const sections = doc.blocks.filter((b) => b.type === 'heading' && b.level === 2).map((b) => b.text);
    assert.equal(sections.length, 13);
    assert.equal(sections[5], '6. Registration Requirements');
    assert.ok(doc.blocks.some((b) => b.type === 'bullet' && b.text === '**Micro Business:** 1-5 employees, US$20 a year.'));
    assert.ok(!doc.blocks.some((b) => /^DRAFT/.test(b.text)), 'the draft notice comes from the page, not the file');
  });

  test('is still a draft, as in the app, and the pages say so', () => {
    const dart = repoFile('mobile/lib/src/settings/legal/legal_document.dart');
    assert.match(dart, new RegExp(`approvedByLawyer = ${LEGAL_APPROVED};`));
    assert.equal(DRAFT_LABEL, 'Draft, pending legal review');
  });

  test('both documents read with a title, version, date and sections', () => {
    for (const [text, title, version] of [
      [privacyPolicy, 'CaribWayz Privacy Policy', '0.4 (draft)'],
      [termsOfService, 'CaribWayz Terms of Service', '0.3 (draft)'],
    ]) {
      const doc = parseLegalDocument(text);
      assert.equal(doc.title, title);
      assert.equal(doc.version, version);
      assert.match(doc.lastUpdated, /2026/);
      assert.ok(doc.blocks.some((b) => b.type === 'heading' && b.level === 2));
      assert.ok(doc.blocks.some((b) => b.type === 'bullet'));
      assert.ok(!doc.blocks.some((b) => /^DRAFT/.test(b.text)), 'the file\'s own draft note is replaced by the page\'s');
    }
    const terms = parseLegalDocument(termsOfService);
    assert.ok(terms.blocks.some((b) => b.type === 'heading' && b.level === 3 && b.text === '5.1 Storm, earthquake and tsunami alerts'));
  });
});

describe('parseLegalDocument', () => {
  const doc = [
    '# Title', '', '> DRAFT - for readers of the file.', '', 'Version: 2', '', 'Last updated: 1 May 2026', '',
    '## 1. First', '', 'A paragraph that', 'runs over two lines.', '', '- one', '- two', '', '> A note that is not the draft notice.',
    '', '### 1.1 Sub', 'Text.',
  ].join('\r\n');

  test('reads headings, joined paragraphs, bullets and kept notes', () => {
    assert.deepEqual(parseLegalDocument(doc), {
      title: 'Title',
      version: '2',
      lastUpdated: '1 May 2026',
      blocks: [
        { type: 'heading', level: 2, text: '1. First' },
        { type: 'paragraph', text: 'A paragraph that runs over two lines.' },
        { type: 'bullet', text: 'one' },
        { type: 'bullet', text: 'two' },
        { type: 'paragraph', text: 'A note that is not the draft notice.' },
        { type: 'heading', level: 3, text: '1.1 Sub' },
        { type: 'paragraph', text: 'Text.' },
      ],
    });
  });

  test('refuses a document without its title, version, date or content', () => {
    assert.throws(() => parseLegalDocument('Version: 1\n\nLast updated: x\n\nText'), /no title/);
    assert.throws(() => parseLegalDocument('# T\n\nLast updated: x\n\nText'), /no version/);
    assert.throws(() => parseLegalDocument('# T\n\nVersion: 1\n\nText'), /no last updated/);
    assert.throws(() => parseLegalDocument('# T\n\nVersion: 1\n\nLast updated: x'), /no content/);
    assert.throws(() => parseLegalDocument('# T\n# U\n\nVersion: 1\n\nLast updated: x\n\nText'), /exactly one title/);
    assert.throws(() => parseLegalDocument(undefined), /not text/);
    assert.throws(() => parseLegalDocument(''), /no title/);
  });

  test('bold runs, and an unmatched marker stays literal', () => {
    assert.deepEqual(parseInline('a **b** c'), [{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false }]);
    assert.deepEqual(parseInline('**x** and **y'), [{ text: 'x', bold: true }, { text: ' and **y', bold: false }]);
    assert.deepEqual(parseInline('****'), []);
    assert.deepEqual(parseInline(''), []);
  });

  test('consecutive bullets become one list', () => {
    assert.deepEqual(groupBullets([
      { type: 'paragraph', text: 'p' }, { type: 'bullet', text: 'a' }, { type: 'bullet', text: 'b' },
      { type: 'paragraph', text: 'q' }, { type: 'bullet', text: 'c' },
    ]), [
      { type: 'paragraph', text: 'p' }, { type: 'list', items: ['a', 'b'] }, { type: 'paragraph', text: 'q' }, { type: 'list', items: ['c'] },
    ]);
  });
});
