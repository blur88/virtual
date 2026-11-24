/**
 * Renders the Terminal View header, Input Lease banner, and mounts the xterm.js instance.
 *
 * @param {HTMLElement} container
 * @param {{
 *   inputLease: { holder: 'none' | 'web' | 'native', updatedAt?: string },
 *   terminalConnected: boolean,
 *   cutoffReason: string | null,
 * }} state
 * @param {{
 *   onTakeControl: () => Promise<void> | void,
 *   onMountTerminal: (mountEl: HTMLElement) => void,
 * }} handlers
 */
export function renderTerminalView(container, state, handlers) {
  const doc = container.ownerDocument;

  let shell = container.querySelector('.terminal-shell');
  if (!shell) {
    shell = doc.createElement('div');
    shell.className = 'terminal-shell';

    const header = doc.createElement('div');
    header.className = 'terminal-header';

    const title = doc.createElement('h2');
    title.textContent = 'Embedded Terminal (tmux: ai-office-riley)';

    const leaseStatus = doc.createElement('span');
    leaseStatus.className = 'lease-pill';
    leaseStatus.dataset.testid = 'terminal-lease-status';

    header.appendChild(title);
    header.appendChild(leaseStatus);

    const leaseBannerSlot = doc.createElement('div');
    leaseBannerSlot.dataset.testid = 'input-lease-slot';

    const xtermMount = doc.createElement('div');
    xtermMount.className = 'xterm-mount';
    xtermMount.dataset.testid = 'xterm-mount';

    shell.appendChild(header);
    shell.appendChild(leaseBannerSlot);
    shell.appendChild(xtermMount);
    container.replaceChildren(shell);

    handlers.onMountTerminal(xtermMount);
  }

  const leaseStatus = shell.querySelector('[data-testid="terminal-lease-status"]');
  if (leaseStatus) {
    if (state.cutoffReason) {
      leaseStatus.textContent = 'Session detached';
      leaseStatus.className = 'lease-pill is-cutoff';
    } else if (state.inputLease?.holder === 'native') {
      leaseStatus.textContent = 'Locked (External Terminal)';
      leaseStatus.className = 'lease-pill is-locked';
    } else if (state.terminalConnected) {
      leaseStatus.textContent = 'Interactive (Web Control)';
      leaseStatus.className = 'lease-pill is-active';
    } else {
      leaseStatus.textContent = 'Connecting...';
      leaseStatus.className = 'lease-pill';
    }
  }

  const leaseSlot = shell.querySelector('[data-testid="input-lease-slot"]');
  if (leaseSlot) {
    if (state.inputLease?.holder === 'native') {
      const banner = doc.createElement('div');
      banner.className = 'lease-banner';
      banner.dataset.testid = 'input-lease-banner';

      const msg = doc.createElement('span');
      msg.textContent =
        'External terminal is actively typing. Browser terminal input is paused to prevent garbled commands.';

      const takeBtn = doc.createElement('button');
      takeBtn.type = 'button';
      takeBtn.className = 'btn btn-primary';
      takeBtn.dataset.testid = 'take-control-btn';
      takeBtn.textContent = 'Take Control';
      takeBtn.addEventListener('click', () => handlers.onTakeControl());

      banner.appendChild(msg);
      banner.appendChild(takeBtn);
      leaseSlot.replaceChildren(banner);
    } else {
      leaseSlot.replaceChildren();
    }
  }
}
