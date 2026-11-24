/**
 * Renders the Active Project Banner showing the active project's name, directory path,
 * dynamic Git branch, view tabs (Chat / Terminal), and the Project Settings trigger.
 *
 * @param {HTMLElement} container
 * @param {{
 *   activeProject: { id: string, name: string, path: string, branch: string | null } | null,
 *   activeView: 'chat' | 'terminal',
 *   loading?: boolean,
 * }} state
 * @param {{
 *   onOpenSettings: () => void,
 *   onSelectView: (view: 'chat' | 'terminal') => void,
 * }} handlers
 */
export function renderActiveProjectBanner(container, state, handlers) {
  const doc = container.ownerDocument;

  const brand = doc.createElement('div');
  brand.className = 'banner-brand';

  const title = doc.createElement('span');
  title.className = 'office-title';
  title.textContent = 'AI Office';
  brand.appendChild(title);

  const info = doc.createElement('div');
  info.className = 'active-project-info';

  if (state.activeProject) {
    const nameEl = doc.createElement('span');
    nameEl.className = 'active-project-name';
    nameEl.dataset.testid = 'active-project-name';
    nameEl.textContent = state.activeProject.name;

    const pathEl = doc.createElement('span');
    pathEl.className = 'active-project-path';
    pathEl.dataset.testid = 'active-project-path';
    pathEl.textContent = state.activeProject.path;

    const branchEl = doc.createElement('span');
    branchEl.className = 'branch-badge';
    branchEl.dataset.testid = 'active-project-branch';
    branchEl.textContent = state.activeProject.branch || 'detached HEAD';

    info.appendChild(nameEl);
    info.appendChild(pathEl);
    info.appendChild(branchEl);
  } else {
    const emptyEl = doc.createElement('span');
    emptyEl.className = 'muted';
    emptyEl.dataset.testid = 'active-project-empty';
    emptyEl.textContent = state.loading ? 'Loading projects...' : 'No Active Project Selected';
    info.appendChild(emptyEl);
  }

  brand.appendChild(info);

  const controls = doc.createElement('div');
  controls.className = 'banner-controls';

  const tabs = doc.createElement('div');
  tabs.className = 'view-tabs';
  tabs.setAttribute('role', 'tablist');

  for (const view of ['chat', 'terminal']) {
    const tab = doc.createElement('button');
    tab.type = 'button';
    tab.className = `tab-btn${state.activeView === view ? ' is-active' : ''}`;
    tab.dataset.testid = `tab-${view}`;
    tab.textContent = view === 'chat' ? 'Chat' : 'Terminal';
    tab.addEventListener('click', () => handlers.onSelectView(view));
    tabs.appendChild(tab);
  }
  controls.appendChild(tabs);

  const settingsBtn = doc.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'btn btn-primary';
  settingsBtn.dataset.testid = 'open-project-settings';
  settingsBtn.textContent = 'Project Settings';
  settingsBtn.addEventListener('click', () => handlers.onOpenSettings());
  controls.appendChild(settingsBtn);

  const actionsSlot = doc.createElement('div');
  actionsSlot.id = 'banner-actions-slot';
  controls.appendChild(actionsSlot);

  container.replaceChildren(brand, controls);
}
