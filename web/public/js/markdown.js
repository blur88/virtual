const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SINGLE_RE = /\x1b[@-Z\\-_]/g;
const TUI_BOX_LINE_RE = /^[\s─│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬]+$/;
const TUI_BOX_BORDER_RE = /^[│┃║]\s?(.*?)\s?[│┃║]$/;

/**
 * Strips ANSI escape sequences and TUI box-drawing artifacts from transcript text.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeTranscriptText(raw) {
  const withoutAnsi = String(raw || '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_SINGLE_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');

  const lines = withoutAnsi.split('\n');
  const cleaned = [];
  for (const line of lines) {
    if (TUI_BOX_LINE_RE.test(line) && /[─│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬]/.test(line)) {
      continue;
    }
    const bordered = TUI_BOX_BORDER_RE.exec(line);
    cleaned.push(bordered ? bordered[1] : line);
  }
  return cleaned.join('\n').trim();
}

function appendInlineNodes(doc, parent, text) {
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      const code = doc.createElement('code');
      code.className = 'inline-code';
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const strong = doc.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const em = doc.createElement('em');
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    }
    lastIndex = tokenRe.lastIndex;
  }

  if (lastIndex < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(lastIndex)));
  }
}

function highlightCodeLine(doc, lineEl, line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
    const span = doc.createElement('span');
    span.className = 'tok-comment';
    span.textContent = line;
    lineEl.appendChild(span);
    return;
  }

  const tokenRe = /("[^"]*"|'[^']*'|`[^`]*`|\B--?[a-zA-Z0-9_-]+|\b(?:cd|git|claude|npm|node|docker|tmux|export|const|let|function|return|if|else|import|from)\b)/g;
  let lastIndex = 0;
  let match;
  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > lastIndex) {
      lineEl.appendChild(doc.createTextNode(line.slice(lastIndex, match.index)));
    }
    const tok = match[0];
    const span = doc.createElement('span');
    if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
      span.className = 'tok-str';
    } else if (tok.startsWith('-')) {
      span.className = 'tok-flag';
    } else {
      span.className = 'tok-kw';
    }
    span.textContent = tok;
    lineEl.appendChild(span);
    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < line.length) {
    lineEl.appendChild(doc.createTextNode(line.slice(lastIndex)));
  }
}

function buildCodeBlock(doc, codeText, lang, onCopy) {
  const wrapper = doc.createElement('div');
  wrapper.className = 'code-block';
  wrapper.dataset.testid = 'code-block';

  const header = doc.createElement('div');
  header.className = 'code-block-header';

  const langLabel = doc.createElement('span');
  langLabel.className = 'code-lang';
  langLabel.textContent = lang || 'command';
  header.appendChild(langLabel);

  const copyBtn = doc.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn btn-copy-command';
  copyBtn.dataset.testid = 'copy-command-btn';
  copyBtn.textContent = 'Copy Command';
  copyBtn.addEventListener('click', async () => {
    try {
      await onCopy(codeText);
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('is-copied');
      const timer = setTimeout(() => {
        copyBtn.textContent = 'Copy Command';
        copyBtn.classList.remove('is-copied');
      }, 1500);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
  });
  header.appendChild(copyBtn);

  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  code.className = lang ? `language-${lang}` : 'language-text';

  const lines = codeText.split('\n');
  lines.forEach((line, idx) => {
    highlightCodeLine(doc, code, line);
    if (idx < lines.length - 1) {
      code.appendChild(doc.createTextNode('\n'));
    }
  });

  pre.appendChild(code);
  wrapper.appendChild(header);
  wrapper.appendChild(pre);
  return wrapper;
}

/**
 * Renders sanitized Markdown into a DOM container with syntax highlighting and Copy Command buttons.
 *
 * @param {Document} doc
 * @param {HTMLElement} container
 * @param {string} rawText
 * @param {{ onCopy?: (text: string) => Promise<void> | void }} [options]
 */
export function renderMarkdown(doc, container, rawText, options = {}) {
  const onCopy =
    options.onCopy ||
    (async (text) => {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    });

  const text = sanitizeTranscriptText(rawText);
  const lines = text.split('\n');
  const nodes = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      nodes.push(buildCodeBlock(doc, codeLines.join('\n'), lang, onCopy));
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const tag = `h${headingMatch[1].length}`;
      const el = doc.createElement(tag);
      appendInlineNodes(doc, el, headingMatch[2]);
      nodes.push(el);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const bq = doc.createElement('blockquote');
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      appendInlineNodes(doc, bq, quoteLines.join(' '));
      nodes.push(bq);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const ul = doc.createElement('ul');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = doc.createElement('li');
        appendInlineNodes(doc, li, lines[i].replace(/^\s*[-*]\s+/, ''));
        ul.appendChild(li);
        i += 1;
      }
      nodes.push(ul);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = doc.createElement('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = doc.createElement('li');
        appendInlineNodes(doc, li, lines[i].replace(/^\s*\d+\.\s+/, ''));
        ol.appendChild(li);
        i += 1;
      }
      nodes.push(ol);
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    const p = doc.createElement('p');
    appendInlineNodes(doc, p, paraLines.join(' '));
    nodes.push(p);
  }

  container.replaceChildren(...nodes);
}
