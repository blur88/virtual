/**
 * Renders the Reset Agent confirmation modal with an active-turn warning when Riley is busy.
 *
 * @param {HTMLElement} container
 * @param {{
 *   open: boolean,
 *   isBusy: boolean,
 *   resetting: boolean,
 *   error: string | null,
 * }} state
 * @param {{
 *   onCancel: () => void,
 *   onConfirm: () => Promise<void> | void,
 * }} handlers
 */
export function renderResetAgentModal(container, state, handlers) {
  const doc = container.ownerDocument;
  if (!state.open) {
    container.replaceChildren();
    return;
  }

  const backdrop = doc.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.dataset.testid = 'reset-agent-modal';

  const dialog = doc.createElement('div');
  dialog.className = 'modal-dialog modal-dialog-sm';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Reset Agent Confirmation');

  const header = doc.createElement('div');
  header.className = 'modal-header';
  const title = doc.createElement('h2');
  title.className = 'modal-title';
  title.textContent = 'Reset Agent Session';
  header.appendChild(title);
  dialog.appendChild(header);

  const body = doc.createElement('p');
  body.textContent =
    'This will restart Riley in a fresh Claude Code session and clear the current conversation context.';
  dialog.appendChild(body);

  if (state.isBusy) {
    const warn = doc.createElement('div');
    warn.className = 'warning-banner';
    warn.dataset.testid = 'reset-busy-warning';
    warn.textContent =
      'Warning: Riley is currently processing a turn. Resetting now will interrupt the active response.';
    dialog.appendChild(warn);
  }

  if (state.error) {
    const errEl = doc.createElement('div');
    errEl.className = 'error-banner';
    errEl.dataset.testid = 'reset-agent-error';
    errEl.textContent = state.error;
    dialog.appendChild(errEl);
  }

  const actions = doc.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn';
  cancelBtn.dataset.testid = 'cancel-reset-agent';
  cancelBtn.disabled = Boolean(state.resetting);
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => handlers.onCancel());

  const confirmBtn = doc.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn-danger';
  confirmBtn.dataset.testid = 'confirm-reset-agent';
  confirmBtn.disabled = Boolean(state.resetting);
  confirmBtn.textContent = state.resetting ? 'Resetting...' : 'Confirm Reset';
  confirmBtn.addEventListener('click', () => handlers.onConfirm());

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  dialog.appendChild(actions);

  backdrop.appendChild(dialog);
  container.replaceChildren(backdrop);
}
