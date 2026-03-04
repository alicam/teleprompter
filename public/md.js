/**
 * md.js — Minimal Markdown parser for the teleprompter.
 * Supports: # headings, **bold**, *italic*, ==highlight==, `code`, paragraphs, line breaks.
 * No dependencies. Safe: HTML is escaped before inline rules run.
 */
(function (global) {
  'use strict';

  function parseMarkdown(text) {
    if (!text) return '';

    // 1. Escape HTML to prevent XSS
    let safe = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // 2. Split on blank lines → paragraph blocks
    const blocks = safe.split(/\n{2,}/);

    const html = blocks.map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';

      // Headings (must be on their own line at the start of the block)
      const h3 = trimmed.match(/^### (.+)$/m);
      const h2 = trimmed.match(/^## (.+)$/m);
      const h1 = trimmed.match(/^# (.+)$/m);

      if (h1) return `<h1 class="tp-h1">${applyInline(h1[1])}</h1>`;
      if (h2) return `<h2 class="tp-h2">${applyInline(h2[1])}</h2>`;
      if (h3) return `<h3 class="tp-h3">${applyInline(h3[1])}</h3>`;

      // Normal paragraph — apply inline rules then convert \n → <br>
      const inner = applyInline(trimmed).replace(/\n/g, '<br>');
      return `<p>${inner}</p>`;
    }).join('');

    return html;
  }

  function applyInline(s) {
    return s
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g,     '<strong>$1</strong>')
      // Italic: *text* or _text_  (after bold so ** isn't double-matched)
      .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
      .replace(/_([^_\n]+?)_/g,   '<em>$1</em>')
      // Highlight: ==text==
      .replace(/==(.+?)==/g, '<mark>$1</mark>')
      // Inline code: `code`
      .replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseMarkdown };
  } else {
    global.parseMarkdown = parseMarkdown;
  }

})(typeof window !== 'undefined' ? window : this);
