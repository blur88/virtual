import { renderMarkdown } from '../markdown.js';

/**
 * Renders the Chat View panel with Riley's Markdown conversation stream and prompt input.
 *
 * @param {HTMLElement} container
 * @param {{
 *   turns: Array<{ id?: string, type: string, text: string, timestamp?: string }>,
 *   isBusy: boolean,
 *   draftMessage: string,
 *   sending: boolean,
 * }} state
 * @param {{
 *   onDraftChange: (text: string) => void,
 *   onSendMessage: (text: string) => Promise<void> | void,
 *   onCopy?: (text: string) => Promise<void> | void,
 * }} handlers
 */
export function renderChatView(container, state, handlers) {
  const doc = container.ownerDocument;

  const shell = doc.createElement('div');
  shell.className = 'chat-shell';

  const header = doc.createElement('div');
  header.className = 'chat-header';
  const title = doc.createElement('h2');
  title.textContent = 'Chat with Riley (Office Manager)';
  const statusPill = doc.createElement('span');
  statusPill.className = `agent-status-pill${state.isBusy ? ' is-busy' : ' is-idle'}`;
  statusPill.dataset.testid = 'agent-status-pill';
  statusPill.textContent = state.isBusy ? 'Riley is thinking...' : 'Riley is ready';
  header.appendChild(title);
  header.appendChild(statusPill);

  const stream = doc.createElement('div');
  stream.className = 'chat-stream';
  stream.dataset.testid = 'chat-stream';

  if (state.turns.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'chat-empty muted';
    empty.dataset.testid = 'chat-empty';
    empty.textContent =
      'Ask Riley what you want to build or change. Riley will inspect your Active Project and recommend the right workflow.';
    stream.appendChild(empty);
  } else {
    for (const turn of state.turns) {
      const bubble = doc.createElement('article');
      bubble.className = `chat-bubble chat-bubble-${turn.type || 'assistant'}`;
      bubble.dataset.testid = 'chat-bubble';
      bubble.dataset.role = turn.type || 'assistant';

      const roleLabel = doc.createElement('div');
      roleLabel.className = 'chat-bubble-role';
      roleLabel.textContent =
        turn.type === 'user' ? 'You' : turn.type === 'system' ? 'System' : 'Riley (Office Manager)';

      const body = doc.createElement('div');
      body.className = 'chat-bubble-body';
      if (turn.type === 'user') {
        const p = doc.createElement('p');
        p.textContent = turn.text;
        body.appendChild(p);
      } else {
        renderMarkdown(doc, body, turn.text, { onCopy: handlers.onCopy });
      }

      bubble.appendChild(roleLabel);
      bubble.appendChild(body);
      stream.appendChild(bubble);
    }
  }

  const form = doc.createElement('form');
  form.className = 'chat-form';
  form.dataset.testid = 'chat-form';

  const input = doc.createElement('textarea');
  input.className = 'chat-input';
  input.dataset.testid = 'chat-input';
  input.placeholder = state.isBusy
    ? 'Waiting for Riley to finish current turn...'
    : 'Ask Riley about your Active Project...';
  input.value = state.draftMessage || '';
  input.disabled = Boolean(state.sending);
  input.addEventListener('input', (e) => handlers.onDraftChange(e.target.value));

  const submitBtn = doc.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary chat-send-btn';
  submitBtn.dataset.testid = 'chat-send-btn';
  submitBtn.disabled = Boolean(state.sending || state.isBusy);
  submitBtn.textContent = state.sending ? 'Sending...' : 'Send';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    handlers.onSendMessage(message);
  });

  form.appendChild(input);
  form.appendChild(submitBtn);

  shell.appendChild(header);
  shell.appendChild(stream);
  shell.appendChild(form);
  container.replaceChildren(shell);
}
