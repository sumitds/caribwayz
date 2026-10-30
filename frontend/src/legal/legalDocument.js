// Reads the Privacy Policy and Terms of Service for the public /privacy and
// /terms pages, the same way the app does (mobile/lib/src/settings/legal/
// legal_document.dart). Kept free of React so it runs under node --test.
//
// The text is a small Markdown subset: one `#` title, `##` and `###`
// headings, paragraphs, `- ` bullets and `**bold**`. A `>` note that starts
// with "DRAFT" is the draft notice for readers of the file; the pages show
// their own note instead (see LEGAL_APPROVED), so it is left out.

/**
 * Flip to true once the client's lawyer has approved both documents, as
 * LegalDocuments.approvedByLawyer in the app. Until then every page that
 * shows them says they are a draft.
 */
export const LEGAL_APPROVED = false;

export const DRAFT_LABEL = 'Draft, pending legal review';

const VERSION_PREFIX = 'Version:';
const UPDATED_PREFIX = 'Last updated:';

/**
 * Splits [text] on `**` markers into [{ text, bold }]. An unmatched trailing
 * marker is kept as literal text rather than turning the rest bold.
 */
export const parseInline = (text) => {
  const runs = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf('**');
    const close = open < 0 ? -1 : rest.indexOf('**', open + 2);
    if (open < 0 || close < 0) {
      if (rest !== '') runs.push({ text: rest, bold: false });
      return runs;
    }
    if (open > 0) runs.push({ text: rest.slice(0, open), bold: false });
    const bold = rest.slice(open + 2, close);
    if (bold !== '') runs.push({ text: bold, bold: true });
    rest = rest.slice(close + 2);
  }
};

/**
 * Reads [markdown] into { title, version, lastUpdated, blocks }, where each
 * block is { type: 'heading', level: 2 | 3, text }, { type: 'paragraph', text }
 * or { type: 'bullet', text }. Throws when the title, version or date is
 * missing or the body is empty: showing a policy without them would leave the
 * reader unable to tell which text they agreed to.
 */
export const parseLegalDocument = (markdown) => {
  if (typeof markdown !== 'string') throw new Error('The legal document is not text');
  let title = null;
  let version = null;
  let lastUpdated = null;
  const blocks = [];
  const paragraph = [];
  const note = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ');
    paragraph.length = 0;
    if (text.startsWith(VERSION_PREFIX)) {
      version = text.slice(VERSION_PREFIX.length).trim();
    } else if (text.startsWith(UPDATED_PREFIX)) {
      lastUpdated = text.slice(UPDATED_PREFIX.length).trim();
    } else {
      blocks.push({ type: 'paragraph', text });
    }
  };

  const flushNote = () => {
    if (note.length === 0) return;
    const text = note.join(' ');
    note.length = 0;
    if (!text.startsWith('DRAFT')) blocks.push({ type: 'paragraph', text });
  };

  const flush = () => {
    flushParagraph();
    flushNote();
  };

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
    } else if (line.startsWith('### ')) {
      flush();
      blocks.push({ type: 'heading', level: 3, text: line.slice(4).trim() });
    } else if (line.startsWith('## ')) {
      flush();
      blocks.push({ type: 'heading', level: 2, text: line.slice(3).trim() });
    } else if (line.startsWith('# ')) {
      flush();
      if (title !== null) throw new Error('A legal document has exactly one title');
      title = line.slice(2).trim();
    } else if (line.startsWith('- ')) {
      flush();
      blocks.push({ type: 'bullet', text: line.slice(2).trim() });
    } else if (line.startsWith('>')) {
      flushParagraph();
      note.push(line.slice(1).trim());
    } else {
      flushNote();
      paragraph.push(line);
    }
  }
  flush();

  if (!title) throw new Error('The legal document has no title');
  if (!version) throw new Error('The legal document has no version');
  if (!lastUpdated) throw new Error('The legal document has no last updated date');
  if (blocks.length === 0) throw new Error('The legal document has no content');

  return { title, version, lastUpdated, blocks };
};

/** Consecutive bullets grouped into one list, so a page renders <ul> once per list. */
export const groupBullets = (blocks) => {
  const grouped = [];
  for (const block of blocks) {
    const last = grouped[grouped.length - 1];
    if (block.type === 'bullet') {
      if (last && last.type === 'list') last.items.push(block.text);
      else grouped.push({ type: 'list', items: [block.text] });
    } else {
      grouped.push(block);
    }
  }
  return grouped;
};
