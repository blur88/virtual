import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './helpers/fake-dom.js';
import { renderMarkdown } from '../../web/public/js/markdown.js';
import { createOfficeApp } from '../../web/public/js/app.js';

function createOfficeDom() {
  const doc = new FakeDocument();
  const shell = doc.createElement('div');
  shell.id = 'app';

  const banner = doc.createElement('header');
  banner.id = 'active-project-banner';

  const statusBannerRoot = doc.createElement('div');
  statusBannerRoot.id = 'status-banner-root';

  const main = doc.createElement('main');
  main.id = 'workspace-main';

  const chatPanel = doc.createElement('section');
  chatPanel.id = 'chat-view-panel';
  const terminalPanel = doc.createElement('section');
  terminalPanel.id = 'terminal-view-panel';
  terminalPanel.hidden = true;
  main.appendChild(chatPanel);
  main.appendChild(terminalPanel);

  const modalRoot = doc.createElement('div');
  modalRoot.id = 'project-settings-modal-root';

  const resetModalRoot = doc.createElement('div');
  resetModalRoot.id = 'reset-agent-modal-root';

  shell.appendChild(banner);
  shell.appendChild(statusBannerRoot);
  shell.appendChild(main);
  shell.appendChild(modalRoot);
  shell.appendChild(resetModalRoot);
  doc.body.appendChild(shell);
  return doc;
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this._emit('open', {});
    });
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', { code: 1000, reason: 'Normal closure' });
  }

  _emit(type, event) {
    for (const fn of this.listeners.get(type) || []) {
      fn(event);
    }
  }

  emitMessage(payload) {
    this._emit('message', { data: JSON.stringify(payload) });
  }

  emitClose(code = 1006, reason = 'Connection lost') {
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', { code, reason });
  }
}

class FakeTerminal {
  static instances = [];
  constructor() {
    this.written = [];
    this._onData = null;
    this.opened = false;
    FakeTerminal.instances.push(this);
  }
  open(el) {
    this.opened = Boolean(el);
  }
  write(data) {
    this.written.push(data);
  }
  clear() {
    this.written = [];
  }
  onData(fn) {
    this._onData = fn;
    return { dispose() {} };
  }
  triggerInput(data) {
    if (this._onData) this._onData(data);
  }
  dispose() {}
}

function createHarness(options = {}) {
  FakeWebSocket.instances = [];
  FakeTerminal.instances = [];
  const doc = createOfficeDom();
  const calls = [];
  let agentBusy = options.initialBusy ?? false;
  let leaseState = options.initialLease ?? { holder: 'none', updatedAt: '2026-11-25T00:00:00Z' };

  const fetchFn = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, url, body });

    if (method === 'GET' && url === '/api/projects') {
      return new Response(
        JSON.stringify({
          activeProjectId: 'proj-1',
          projects: [{ id: 'proj-1', name: 'Virtual', path: '/home/blur/virtual', branch: 'main' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'GET' && url === '/api/status') {
      return new Response(
        JSON.stringify({
          ok: true,
          agent: { idle: !agentBusy, isBusy: agentBusy },
          inputLease: leaseState,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'GET' && url === '/api/transcript') {
      return new Response(
        JSON.stringify({ activeFile: 'session.jsonl', turns: options.initialTurns || [], isBusy: agentBusy }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'POST' && url === '/api/chat') {
      if (options.chatErrorStatus) {
        return new Response(
          JSON.stringify({ error: options.chatErrorMessage || 'Chat error', code: options.chatErrorCode }),
          { status: options.chatErrorStatus, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true, delivered: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url === '/api/terminal/override-lease') {
      leaseState = { holder: 'web', updatedAt: '2026-11-25T00:01:00Z' };
      return new Response(JSON.stringify({ ok: true, inputLease: leaseState }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url === '/api/agent/reset') {
      agentBusy = false;
      leaseState = { holder: 'none', updatedAt: '2026-11-25T00:02:00Z' };
      return new Response(JSON.stringify({ ok: true, inputLease: leaseState }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
  };

  const app = createOfficeApp({
    document: doc,
    fetch: fetchFn,
    WebSocket: FakeWebSocket,
    Terminal: FakeTerminal,
    wsBaseUrl: 'ws://localhost:3000',
    reconnectDelayMs: options.reconnectDelayMs ?? 15,
    onCopy: options.onCopy,
  });

  return { doc, app, calls, getChatWs: () => FakeWebSocket.instances.find((w) => w.url.endsWith('/ws/chat')), getTerminalWs: () => FakeWebSocket.instances.find((w) => w.url.endsWith('/ws/terminal')) };
}

describe('Chat View Markdown & Copy Command', () => {
  it('strips ANSI/TUI artifacts, renders Markdown with syntax highlighting, and copies command on click', async () => {
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const copiedTexts = [];
    const rawText = [
      '\x1b[32m╭────────────────────────────╮\x1b[0m',
      '## Recommended Workflow',
      'Run **ask-matt** using `/plan` in your terminal:',
      '',
      '```bash',
      '# Start planning for active project',
      'cd /home/blur/my-project && claude "/plan add auth"',
      '```',
      '\x1b[32m╰────────────────────────────╯\x1b[0m',
    ].join('\n');

    renderMarkdown(doc, container, rawText, {
      onCopy: async (text) => {
        copiedTexts.push(text);
      },
    });

    const renderedText = container.textContent;
    assert.ok(!renderedText.includes('\x1b['), 'should strip ANSI escape sequences');
    assert.ok(!renderedText.includes('╭'), 'should strip TUI box-drawing characters');
    assert.ok(container.querySelector('h2'), 'should render Markdown heading');
    assert.ok(container.querySelector('strong'), 'should render bold text');
    assert.ok(container.querySelector('code.inline-code'), 'should render inline code');

    const codeBlock = container.querySelector('[data-testid="code-block"]');
    assert.ok(codeBlock, 'should render fenced code block');
    assert.ok(
      codeBlock.querySelector('code.language-bash'),
      'should apply language class for syntax highlighting'
    );
    assert.ok(
      codeBlock.querySelector('.tok-comment'),
      'should syntax-highlight comments inside code block'
    );

    const copyBtn = codeBlock.querySelector('[data-testid="copy-command-btn"]');
    assert.ok(copyBtn, 'should render prominent Copy Command button');
    assert.ok(copyBtn.textContent.includes('Copy Command'));

    copyBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(copiedTexts, [
      '# Start planning for active project\ncd /home/blur/my-project && claude "/plan add auth"',
    ]);
    assert.equal(copyBtn.textContent, 'Copied!');
  });
});

describe('Web UI Dual-View Chat, Terminal, Input Lease & Reset Agent', () => {
  it('renders Chat View turns from WS /ws/chat, sends prompts via /api/chat, and toggles seamlessly with Terminal View', async () => {
    const { doc, app, calls, getChatWs, getTerminalWs } = createHarness();
    await app.init();
    await flushPromises();

    const chatWs = getChatWs();
    assert.ok(chatWs, 'should open WS /ws/chat on init');
    chatWs.emitMessage({
      type: 'history',
      turns: [
        { id: 'u1', type: 'user', text: 'How do I plan a feature?' },
        {
          id: 'a1',
          type: 'assistant',
          text: '### Next Step\nRun:\n```bash\nclaude "/plan feature"\n```',
        },
      ],
      isBusy: false,
    });

    const bubbles = doc.querySelectorAll('[data-testid="chat-bubble"]');
    assert.equal(bubbles.length, 2);
    assert.ok(bubbles[1].querySelector('[data-testid="copy-command-btn"]'));

    // Send a new chat message
    const chatInput = doc.querySelector('[data-testid="chat-input"]');
    const chatForm = doc.querySelector('[data-testid="chat-form"]');
    chatInput.value = 'Check status please';
    chatForm.dispatchEvent({ type: 'submit' });
    await flushPromises();

    assert.ok(
      calls.some((c) => c.method === 'POST' && c.url === '/api/chat' && c.body.message === 'Check status please'),
      'should POST /api/chat with user message'
    );
    assert.equal(doc.querySelector('[data-testid="chat-input"]').value, '', 'should clear chat input after send');

    // Toggle to Terminal View
    doc.querySelector('[data-testid="tab-terminal"]').click();
    await flushPromises();
    assert.equal(doc.getElementById('chat-view-panel').hidden, true);
    assert.equal(doc.getElementById('terminal-view-panel').hidden, false);

    const termWs = getTerminalWs();
    assert.ok(termWs, 'should open WS /ws/terminal');
    termWs.emitMessage({ type: 'output', data: 'Riley ready> ' });
    assert.equal(FakeTerminal.instances.length, 1);
    assert.deepEqual(FakeTerminal.instances[0].written, ['Riley ready> ']);

    // Toggle back to Chat View — underlying session & bubbles preserved
    doc.querySelector('[data-testid="tab-chat"]').click();
    assert.equal(doc.getElementById('chat-view-panel').hidden, false);
    assert.equal(doc.getElementById('terminal-view-panel').hidden, true);
    assert.equal(doc.querySelectorAll('[data-testid="chat-bubble"]').length, 2);
    app.destroy();
  });

  it('enforces Input Lease soft lock when external terminal is typing and supports Take Control override', async () => {
    const { doc, app, calls, getTerminalWs } = createHarness();
    await app.init();
    await flushPromises();

    doc.querySelector('[data-testid="tab-terminal"]').click();
    await flushPromises();

    const termWs = getTerminalWs();
    const term = FakeTerminal.instances[0];

    // Native terminal takes lease
    termWs.emitMessage({ type: 'lease', inputLease: { holder: 'native', updatedAt: '2026-11-25T00:00:01Z' } });
    const leaseBanner = doc.querySelector('[data-testid="input-lease-banner"]');
    assert.ok(leaseBanner, 'should show Input Lease soft lock banner');
    assert.ok(leaseBanner.textContent.includes('External terminal is actively typing'));

    // Browser terminal input is blocked while holder === 'native'
    term.triggerInput('ls\r');
    assert.equal(
      termWs.sent.filter((s) => JSON.parse(s).type === 'input').length,
      0,
      'should block terminal input when native terminal holds lease'
    );

    // Click "Take Control" override button
    doc.querySelector('[data-testid="take-control-btn"]').click();
    await flushPromises();

    assert.ok(
      calls.some((c) => c.method === 'POST' && c.url === '/api/terminal/override-lease'),
      'should POST /api/terminal/override-lease'
    );
    assert.equal(doc.querySelector('[data-testid="input-lease-banner"]'), null, 'should clear lock banner after Take Control');

    // Browser terminal input now succeeds
    term.triggerInput('status\r');
    assert.equal(
      termWs.sent.filter((s) => JSON.parse(s).type === 'input').length,
      1,
      'should allow terminal input after Take Control'
    );
    app.destroy();
  });

  it('opens Reset Agent confirmation modal with busy warning when active and resets session on confirm', async () => {
    const { doc, app, calls, getChatWs } = createHarness();
    await app.init();
    await flushPromises();

    const chatWs = getChatWs();
    chatWs.emitMessage({
      type: 'history',
      turns: [{ id: 'u1', type: 'user', text: 'Working...' }],
      isBusy: false,
    });

    // Idle reset modal: no busy warning, cancel does not call API
    doc.querySelector('[data-testid="reset-agent-btn"]').click();
    assert.ok(doc.querySelector('[data-testid="reset-agent-modal"]'));
    assert.equal(doc.querySelector('[data-testid="reset-busy-warning"]'), null);
    doc.querySelector('[data-testid="cancel-reset-agent"]').click();
    assert.equal(doc.querySelector('[data-testid="reset-agent-modal"]'), null);
    assert.equal(calls.filter((c) => c.url === '/api/agent/reset').length, 0);

    // Busy reset modal: displays warning, confirm calls /api/agent/reset and clears turns
    chatWs.emitMessage({ type: 'status', isBusy: true });
    doc.querySelector('[data-testid="reset-agent-btn"]').click();
    assert.ok(doc.querySelector('[data-testid="reset-busy-warning"]'), 'should warn when agent turn is active');

    doc.querySelector('[data-testid="confirm-reset-agent"]').click();
    await flushPromises();

    assert.equal(calls.filter((c) => c.method === 'POST' && c.url === '/api/agent/reset').length, 1);
    assert.equal(doc.querySelector('[data-testid="reset-agent-modal"]'), null);
    assert.equal(doc.querySelectorAll('[data-testid="chat-bubble"]').length, 0);
    app.destroy();
  });

  it('displays status banners for connection loss (with WS auto-reconnect), rate limits, and terminal cutoff', async () => {
    const { doc, app, getChatWs, getTerminalWs } = createHarness({
      reconnectDelayMs: 15,
      chatErrorStatus: 429,
      chatErrorMessage: 'Rate limit exceeded: please wait 60s',
    });
    await app.init();
    await flushPromises();

    // 1. Rate limit error from /api/chat
    const chatInput = doc.querySelector('[data-testid="chat-input"]');
    chatInput.value = 'Hello';
    doc.querySelector('[data-testid="chat-form"]').dispatchEvent({ type: 'submit' });
    await flushPromises();

    const rateBanner = doc.querySelector('[data-testid="status-banner"][data-kind="rate-limit"]');
    assert.ok(rateBanner, 'should show rate-limit warning banner');
    assert.ok(rateBanner.textContent.includes('Rate limit'));

    // 2. Connection loss + auto-reconnect on WS /ws/chat
    const firstChatWs = getChatWs();
    const initialWsCount = FakeWebSocket.instances.length;
    firstChatWs.emitClose(1006, 'Abnormal closure');

    const connBanner = doc.querySelector('[data-testid="status-banner"][data-kind="connection"]');
    assert.ok(connBanner, 'should show connection loss banner');
    assert.ok(connBanner.querySelector('[data-testid="banner-reconnect-btn"]'));

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(
      FakeWebSocket.instances.length > initialWsCount,
      'should automatically attempt WS /ws/chat reconnect'
    );
    assert.equal(
      doc.querySelector('[data-testid="status-banner"][data-kind="connection"]'),
      null,
      'should clear connection banner once reconnected'
    );

    // 3. Terminal cutoff error banner with Reset Agent recovery action
    doc.querySelector('[data-testid="tab-terminal"]').click();
    await flushPromises();
    const termWs = getTerminalWs();
    termWs.emitMessage({ type: 'cutoff', reason: 'Agent exited to raw host shell' });

    const errBanner = doc.querySelector('[data-testid="status-banner"][data-kind="agent-error"]');
    assert.ok(errBanner, 'should show agent-error banner on terminal cutoff');
    assert.ok(errBanner.querySelector('[data-testid="banner-reset-btn"]'));
    app.destroy();
  });
});
