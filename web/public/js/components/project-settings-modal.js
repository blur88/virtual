/**
 * Renders the Project Settings modal for viewing, adding, editing, activating,
 * and removing Target Projects.
 *
 * @param {HTMLElement} container
 * @param {{
 *   open: boolean,
 *   projects: Array<{ id: string, name: string, path: string, branch: string | null }>,
 *   activeProjectId: string | null,
 *   editingProjectId: string | null,
 *   draftAdd?: { name: string, path: string },
 *   busy?: boolean,
 *   error?: string | null,
 * }} state
 * @param {{
 *   onClose: () => void,
 *   onAddProject: (input: { name: string, path: string }) => Promise<void> | void,
 *   onSelectActive: (id: string) => Promise<void> | void,
 *   onStartEdit: (id: string) => void,
 *   onCancelEdit: () => void,
 *   onSaveEdit: (id: string, input: { name: string, path: string }) => Promise<void> | void,
 *   onRemoveProject: (id: string) => Promise<void> | void,
 *   onDraftAddChange?: (draft: { name: string, path: string }) => void,
 * }} handlers
 */
export function renderProjectSettingsModal(container, state, handlers) {
  if (!state.open) {
    container.replaceChildren();
    return;
  }

  const doc = container.ownerDocument;

  const backdrop = doc.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.dataset.testid = 'project-settings-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      handlers.onClose();
    }
  });

  const dialog = doc.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Project Settings');
  dialog.dataset.testid = 'project-settings-modal';

  // Header
  const header = doc.createElement('div');
  header.className = 'modal-header';

  const title = doc.createElement('h2');
  title.className = 'modal-title';
  title.textContent = 'Project Settings';

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn';
  closeBtn.dataset.testid = 'close-project-settings';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => handlers.onClose());

  header.appendChild(title);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  // Inline validation / API error banner
  if (state.error) {
    const errorEl = doc.createElement('div');
    errorEl.className = 'error-banner';
    errorEl.setAttribute('role', 'alert');
    errorEl.dataset.testid = 'project-settings-error';
    errorEl.textContent = state.error;
    dialog.appendChild(errorEl);
  }

  // Registered Target Projects list
  const list = doc.createElement('ul');
  list.className = 'project-list';

  if (state.projects.length === 0) {
    const empty = doc.createElement('li');
    empty.className = 'project-item muted';
    empty.textContent = 'No Target Projects registered yet. Add a Git repository below.';
    list.appendChild(empty);
  } else {
    for (const project of state.projects) {
      const isActive = project.id === state.activeProjectId;
      const isEditing = project.id === state.editingProjectId;

      const item = doc.createElement('li');
      item.className = `project-item${isActive ? ' is-active' : ''}`;
      item.dataset.testid = 'project-item';
      item.dataset.projectId = project.id;

      if (isEditing) {
        const editForm = doc.createElement('form');
        editForm.dataset.testid = `edit-project-form-${project.id}`;
        editForm.className = 'form-grid';

        const nameField = doc.createElement('div');
        nameField.className = 'field';
        const nameLabel = doc.createElement('label');
        nameLabel.textContent = 'Project Name';
        const nameInput = doc.createElement('input');
        nameInput.type = 'text';
        nameInput.required = true;
        nameInput.value = project.name;
        nameInput.dataset.testid = `edit-project-name-${project.id}`;
        nameField.appendChild(nameLabel);
        nameField.appendChild(nameInput);

        const pathField = doc.createElement('div');
        pathField.className = 'field';
        const pathLabel = doc.createElement('label');
        pathLabel.textContent = 'Repository Path';
        const pathInput = doc.createElement('input');
        pathInput.type = 'text';
        pathInput.required = true;
        pathInput.value = project.path;
        pathInput.dataset.testid = `edit-project-path-${project.id}`;
        pathField.appendChild(pathLabel);
        pathField.appendChild(pathInput);

        editForm.appendChild(nameField);
        editForm.appendChild(pathField);

        const editActions = doc.createElement('div');
        editActions.className = 'project-item-actions';

        const saveBtn = doc.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.className = 'btn btn-primary';
        saveBtn.disabled = Boolean(state.busy);
        saveBtn.dataset.testid = `save-project-${project.id}`;
        saveBtn.textContent = 'Save';

        const cancelBtn = doc.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn';
        cancelBtn.dataset.testid = `cancel-edit-${project.id}`;
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => handlers.onCancelEdit());

        editActions.appendChild(saveBtn);
        editActions.appendChild(cancelBtn);
        editForm.appendChild(editActions);

        editForm.addEventListener('submit', (e) => {
          e.preventDefault();
          handlers.onSaveEdit(project.id, {
            name: nameInput.value,
            path: pathInput.value,
          });
        });

        item.appendChild(editForm);
      } else {
        const row = doc.createElement('div');
        row.className = 'project-item-row';

        const meta = doc.createElement('div');
        meta.className = 'project-item-meta';

        const nameRow = doc.createElement('div');
        const nameStrong = doc.createElement('strong');
        nameStrong.textContent = project.name;
        nameRow.appendChild(nameStrong);

        if (isActive) {
          const pill = doc.createElement('span');
          pill.className = 'active-pill';
          pill.textContent = 'Active';
          nameRow.appendChild(pill);
        }

        const pathSpan = doc.createElement('span');
        pathSpan.className = 'active-project-path';
        pathSpan.textContent = project.path;

        const branchSpan = doc.createElement('span');
        branchSpan.className = 'branch-badge';
        branchSpan.textContent = project.branch || 'detached HEAD';

        meta.appendChild(nameRow);
        meta.appendChild(pathSpan);
        meta.appendChild(branchSpan);

        const actions = doc.createElement('div');
        actions.className = 'project-item-actions';

        if (!isActive) {
          const selectBtn = doc.createElement('button');
          selectBtn.type = 'button';
          selectBtn.className = 'btn btn-primary';
          selectBtn.disabled = Boolean(state.busy);
          selectBtn.dataset.testid = `activate-project-${project.id}`;
          selectBtn.textContent = 'Set Active';
          selectBtn.addEventListener('click', () => handlers.onSelectActive(project.id));
          actions.appendChild(selectBtn);
        }

        const editBtn = doc.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn';
        editBtn.disabled = Boolean(state.busy);
        editBtn.dataset.testid = `edit-project-${project.id}`;
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => handlers.onStartEdit(project.id));
        actions.appendChild(editBtn);

        const removeBtn = doc.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-danger';
        removeBtn.disabled = Boolean(state.busy);
        removeBtn.dataset.testid = `remove-project-${project.id}`;
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => handlers.onRemoveProject(project.id));
        actions.appendChild(removeBtn);

        row.appendChild(meta);
        row.appendChild(actions);
        item.appendChild(row);
      }

      list.appendChild(item);
    }
  }

  dialog.appendChild(list);

  // Add Project Form
  const addForm = doc.createElement('form');
  addForm.className = 'project-form';
  addForm.dataset.testid = 'add-project-form';

  const formHeading = doc.createElement('strong');
  formHeading.textContent = 'Add Target Project';
  addForm.appendChild(formHeading);

  const grid = doc.createElement('div');
  grid.className = 'form-grid';

  const addNameField = doc.createElement('div');
  addNameField.className = 'field';
  const addNameLabel = doc.createElement('label');
  addNameLabel.textContent = 'Project Name';
  const addNameInput = doc.createElement('input');
  addNameInput.type = 'text';
  addNameInput.required = true;
  addNameInput.placeholder = 'e.g. My App';
  addNameInput.value = state.draftAdd?.name || '';
  addNameInput.dataset.testid = 'add-project-name';
  addNameField.appendChild(addNameLabel);
  addNameField.appendChild(addNameInput);

  const addPathField = doc.createElement('div');
  addPathField.className = 'field';
  const addPathLabel = doc.createElement('label');
  addPathLabel.textContent = 'Git Repository Path';
  const addPathInput = doc.createElement('input');
  addPathInput.type = 'text';
  addPathInput.required = true;
  addPathInput.placeholder = '/home/blur/my-project';
  addPathInput.value = state.draftAdd?.path || '';
  addPathInput.dataset.testid = 'add-project-path';
  addPathField.appendChild(addPathLabel);
  addPathField.appendChild(addPathInput);

  const syncDraft = () => {
    handlers.onDraftAddChange?.({
      name: addNameInput.value,
      path: addPathInput.value,
    });
  };
  addNameInput.addEventListener('input', syncDraft);
  addPathInput.addEventListener('input', syncDraft);

  grid.appendChild(addNameField);
  grid.appendChild(addPathField);
  addForm.appendChild(grid);

  const addSubmit = doc.createElement('button');
  addSubmit.type = 'submit';
  addSubmit.className = 'btn btn-primary';
  addSubmit.disabled = Boolean(state.busy);
  addSubmit.dataset.testid = 'add-project-submit';
  addSubmit.textContent = 'Add Project';
  addForm.appendChild(addSubmit);

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handlers.onAddProject({
      name: addNameInput.value,
      path: addPathInput.value,
    });
  });

  dialog.appendChild(addForm);
  backdrop.appendChild(dialog);
  container.replaceChildren(backdrop);
}
