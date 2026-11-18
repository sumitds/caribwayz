// The public legal pages (/privacy, /terms, /emergency-desk-disclaimer and
// /membership/policy). Run with: npm test (node --test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import privacyPolicy from '../src/legal/privacyPolicy.js';
import termsOfService from '../src/legal/termsOfService.js';
import businessMembershipPolicy from '../src/legal/businessMembershipPolicy.js';
import emergencyDeskDisclaimer from '../src/legal/emergencyDeskDisclaimer.js';
import {
  parseLegalDocument, parseInline, groupBullets, LEGAL_APPROVED, MEMBERSHIP_POLICY_APPROVED, DRAFT_LABEL,
} from '../src/legal/legalDocument.js';

const repoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('the legal text', () => {
  test('is word for word the text the app ships and docs/legal keeps', () => {
    for (const [text, file] of [
      [privacyPolicy, 'privacy-policy.md'],
      [termsOfService, 'terms-of-service.md'],
      [emergencyDeskDisclaimer, 'emergency-desk-disclaimer.md'],
    ]) {
      assert.equal(text, repoFile(`docs/legal/${file}`), file);
      assert.equal(text, repoFile(`mobile/assets/legal/${file}`), file);
    }
  });

  test('the app registers the folder that carries all three documents', () => {
    assert.match(repoFile('mobile/pubspec.yaml'), /^ {4}- assets\/legal\/$/m);
    const dart = repoFile('mobile/lib/src/settings/legal/legal_document.dart');
    assert.match(dart, /emergencyDeskDisclaimerAsset = "assets\/legal\/emergency-desk-disclaimer\.md";/);
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

  test('the three documents are final, as in the app; the membership policy is still a draft', () => {
    const dart = repoFile('mobile/lib/src/settings/legal/legal_document.dart');
    assert.equal(LEGAL_APPROVED, true);
    assert.match(dart, new RegExp(`approvedByLawyer = ${LEGAL_APPROVED};`));
    assert.equal(MEMBERSHIP_POLICY_APPROVED, false);
    assert.equal(DRAFT_LABEL, 'Draft, pending legal review');
  });

  test('every page that shows a document is routed, the disclaimer with the others', () => {
    const app = repoFile('admin/src/App.jsx');
    for (const route of [
      '<Route path="/privacy" element={<LegalPage markdown={privacyPolicy} />} />',
      '<Route path="/terms" element={<LegalPage markdown={termsOfService} />} />',
      '<Route path="/emergency-desk-disclaimer" element={<LegalPage markdown={emergencyDeskDisclaimer} />} />',
      '<Route path="/membership/policy" element={<LegalPage markdown={businessMembershipPolicy} approved={MEMBERSHIP_POLICY_APPROVED} />} />',
    ]) {
      assert.ok(app.includes(route), route);
    }
    const layout = repoFile('admin/src/pages/Public/PublicLayout.jsx');
    assert.ok(layout.includes("{ to: '/emergency-desk-disclaimer', label: 'Emergency Desk' }"), 'the disclaimer is in the public links');
  });

  test('the three documents read as version 1.0, effective 18 November 2026, with no blank left', () => {
    for (const [text, title, lastSection] of [
      [privacyPolicy, 'CaribWayz Privacy Policy', '27. CONTACT AND REGULATORY COMPLAINTS'],
      [termsOfService, 'CaribWayz Terms of Agreement', '28. CONTACT INFORMATION'],
      [emergencyDeskDisclaimer, 'CaribWayz Emergency Desk Disclaimer', '25. CONTACT INFORMATION'],
    ]) {
      const doc = parseLegalDocument(text);
      assert.equal(doc.title, title);
      assert.equal(doc.version, '1.0');
      assert.equal(doc.lastUpdated, '18 November 2026');
      assert.ok(doc.blocks.some((b) => b.type === 'paragraph' && b.text === 'Effective Date: 18 November 2026'), title);
      const sections = doc.blocks.filter((b) => b.type === 'heading' && b.level === 2).map((b) => b.text);
      assert.equal(sections[0].startsWith('1. '), true, title);
      assert.equal(sections[sections.length - 1], lastSection);
      sections.forEach((s, i) => assert.ok(s.startsWith(`${i + 1}. `), `${title}: section ${i + 1} is "${s}"`));
      assert.ok(doc.blocks.some((b) => b.type === 'bullet'));
      assert.ok(!doc.blocks.some((b) => /^DRAFT/.test(b.text)), 'a final document carries no draft note');
      assert.doesNotMatch(text, /\[[^\]]*\]/, `${title} has a [blank] left`);
      assert.doesNotMatch(text, /\u200b|\ufffd/, `${title} carries a stray character from the PDF`);
    }
  });

  test('the privacy policy carries the filled blanks and matches the app', () => {
    for (const fact of [
      'Data Protection Officer: Christina Baker, info@caribwayz.com',
      'CaribWayz hosting region: Render, United States (Oregon, US West).',
      '**Technical and server logs:** Retained for 7 days.',
      '**Backups:** Retained for 3 days, according to the actual hosting and backup arrangements.',
      '**Email delivery provider (SMTP)**',
      'our email delivery provider (SMTP), United States',
      'Profile photograph upload is not currently available, so profile photographs are not uploaded to CaribWayz servers.',
    ]) {
      assert.ok(privacyPolicy.includes(fact), fact);
    }
    assert.ok(!privacyPolicy.includes('Cloud Storage for Firebase.\n'), 'no Storage bucket on the Spark plan');
    assert.ok(!privacyPolicy.includes('Firebase Realtime Database'), 'no Firebase database holds CaribWayz data');
  });

  test('the disclaimer gives the Jamaican emergency numbers', () => {
    const doc = parseLegalDocument(emergencyDeskDisclaimer);
    const bullets = doc.blocks.filter((b) => b.type === 'bullet').map((b) => b.text);
    assert.ok(bullets.includes('Police: 119'));
    assert.ok(bullets.includes('Fire and ambulance: 110'));
    assert.ok(doc.blocks.some((b) => b.text === '**CARIBWAYZ IS NOT A REPLACEMENT FOR OFFICIAL EMERGENCY SERVICES.**'));
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
