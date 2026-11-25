/**
 * Renders user-friendly status/warning/error banners with clear recovery actions.
 *
 * @param {HTMLElement} container
 * @param {{
 *   banner: { kind: 'connection' | 'rate-limit' | 'agent-error' | 'missing-skill', message: string, actionLabel?: string } | null
 * }} state
 * @param {{
 *   onReconnect: () => void,
 *   onOpenReset: () => void,
 *   onDismiss: () => void,
 * }} handlers
 */
export function renderStatusBanner(container, state, handlers) {
  const doc = container.ownerDocument;
  if (!state.banner) {
    container.replaceChildren();
    return;
  }

  const { kind, message, actionLabel } = state.banner;
  const el = doc.createElement('div');
  el.className = `status-banner status-banner-${kind}`;
  el.dataset.testid = 'status-banner';
  el.dataset.kind = kind;
  el.setAttribute('role', 'alert');

  const text = doc.createElement('span');
  text.className = 'status-banner-message';
  text.textContent = message;
  el.appendChild(text);

  const actions = doc.createElement('div');
  actions.className = 'status-banner-actions';

  if (kind === 'connection') {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.dataset.testid = 'banner-reconnect-btn';
    btn.textContent = actionLabel || 'Reconnect';
    btn.addEventListener('click', () => handlers.onReconnect());
    actions.appendChild(btn);
  } else if (kind === 'agent-error' || kind === 'missing-skill') {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = kind === 'agent-error' ? 'btn btn-danger' : 'btn';
    btn.dataset.testid = 'banner-reset-btn';
    btn.textContent = actionLabel || 'Reset Agent';
    btn.addEventListener('click', () => handlers.onOpenReset());
    actions.appendChild(btn);
  }

  const dismissBtn = doc.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn';
  dismissBtn.dataset.testid = 'banner-dismiss-btn';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => handlers.onDismiss());
  actions.appendChild(dismissBtn);

  el.appendChild(actions);
  container.replaceChildren(el);
}
