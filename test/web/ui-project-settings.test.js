import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './helpers/fake-dom.js';
import { createOfficeApp } from '../../web/public/js/app.js';

function createOfficeDom() {
  const doc = new FakeDocument();
  const shell = doc.createElement('div');
  shell.id = 'app';

  const banner = doc.createElement('header');
  banner.id = 'active-project-banner';

  const main = doc.createElement('main');
  main.id = 'office-main';

  const chatPanel = doc.createElement('section');
  chatPanel.id = 'chat-view-panel';
  const terminalPanel = doc.createElement('section');
  terminalPanel.id = 'terminal-view-panel';
  terminalPanel.hidden = true;
  main.appendChild(chatPanel);
  main.appendChild(terminalPanel);

  const modalRoot = doc.createElement('div');
  modalRoot.id = 'project-settings-modal-root';

  shell.appendChild(banner);
  shell.appendChild(main);
  shell.appendChild(modalRoot);
  doc.body.appendChild(shell);
  return doc;
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createMockBridgeFetch(initialState) {
  const store = {
    activeProjectId: initialState.activeProjectId ?? null,
    projects: initialState.projects.map((p) => ({ ...p })),
  };

  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};

    if (method === 'GET' && url === '/api/projects') {
      return new Response(JSON.stringify(store), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'POST' && url === '/api/projects') {
      if (body.path === '/nonexistent') {
        return new Response(
          JSON.stringify({
            error: 'Directory does not exist: /nonexistent',
            code: 'NOT_A_DIRECTORY',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (body.path === '/home/blur/virtual/src') {
        return new Response(
          JSON.stringify({
            error: 'Path must be a top-level Git repository root.',
            code: 'NOT_GIT_ROOT',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (store.projects.some((p) => p.path === body.path)) {
        return new Response(
          JSON.stringify({
            error: `Project already registered at path: ${body.path}`,
            code: 'DUPLICATE_PROJECT_PATH',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const created = {
        id: `proj-${store.projects.length + 1}`,
        name: body.name,
        path: body.path,
        branch: body.path.includes('beta') ? 'develop' : 'main',
      };
      store.projects.push(created);
      if (!store.activeProjectId) store.activeProjectId = created.id;
      return new Response(JSON.stringify({ project: created }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const activateMatch = /^\/api\/projects\/([^/]+)\/activate$/.exec(url);
    if (method === 'POST' && activateMatch) {
      const id = decodeURIComponent(activateMatch[1]);
      const found = store.projects.find((p) => p.id === id);
      if (!found) {
        return new Response(JSON.stringify({ error: 'Not found', code: 'PROJECT_NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      store.activeProjectId = found.id;
      return new Response(JSON.stringify({ activeProjectId: found.id, project: found }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const itemMatch = /^\/api\/projects\/([^/]+)$/.exec(url);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      const idx = store.projects.findIndex((p) => p.id === id);
      if (idx === -1) {
        return new Response(JSON.stringify({ error: 'Not found', code: 'PROJECT_NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'PUT') {
        store.projects[idx] = {
          ...store.projects[idx],
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.path !== undefined ? { path: body.path } : {}),
        };
        return new Response(JSON.stringify({ project: store.projects[idx] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'DELETE') {
        const [removed] = store.projects.splice(idx, 1);
        if (store.activeProjectId === id) {
          store.activeProjectId = store.projects[0]?.id ?? null;
        }
        return new Response(
          JSON.stringify({ removed, activeProjectId: store.activeProjectId }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
  };
}

describe('Web UI Active Project Banner & Project Settings', () => {
  it('renders Active Project Banner with name, path, and dynamic branch, and handles empty state', async () => {
    const doc = createOfficeDom();
    const emptyFetch = async () =>
      new Response(JSON.stringify({ activeProjectId: null, projects: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const app = createOfficeApp({ document: doc, fetch: emptyFetch });
    await app.init();

    const banner = doc.getElementById('active-project-banner');
    assert.ok(banner.textContent.includes('No Active Project'));
    assert.ok(banner.querySelector('[data-testid="open-project-settings"]'));

    const docWithProject = createOfficeDom();
    const populatedFetch = async () =>
      new Response(
        JSON.stringify({
          activeProjectId: 'proj-1',
          projects: [
            {
              id: 'proj-1',
              name: 'Virtual Office',
              path: '/home/blur/virtual',
              branch: 'feat/ticket-5',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const app2 = createOfficeApp({ document: docWithProject, fetch: populatedFetch });
    await app2.init();

    const banner2 = docWithProject.getElementById('active-project-banner');
    assert.equal(banner2.querySelector('[data-testid="active-project-name"]').textContent, 'Virtual Office');
    assert.equal(banner2.querySelector('[data-testid="active-project-path"]').textContent, '/home/blur/virtual');
    assert.equal(banner2.querySelector('[data-testid="active-project-branch"]').textContent, 'feat/ticket-5');
  });

  it('opens Project Settings modal, adds a project, and displays inline validation errors', async () => {
    const doc = createOfficeDom();
    const mockFetch = createMockBridgeFetch({
      activeProjectId: 'proj-1',
      projects: [
        { id: 'proj-1', name: 'Alpha', path: '/repos/alpha', branch: 'main' },
      ],
    });

    const app = createOfficeApp({ document: doc, fetch: mockFetch });
    await app.init();

    // Open Project Settings modal
    doc.querySelector('[data-testid="open-project-settings"]').click();
    const modal = doc.querySelector('[data-testid="project-settings-modal"]');
    assert.ok(modal, 'Project Settings modal should render');
    assert.equal(modal.querySelectorAll('[data-testid="project-item"]').length, 1);

    // Attempt to add a non-existent directory -> inline error
    const nameInput = modal.querySelector('[data-testid="add-project-name"]');
    const pathInput = modal.querySelector('[data-testid="add-project-path"]');
    const addForm = modal.querySelector('[data-testid="add-project-form"]');

    nameInput.value = 'Broken';
    pathInput.value = '/nonexistent';
    addForm.dispatchEvent({ type: 'submit' });
    await flushPromises();

    const errorEl = doc.querySelector('[data-testid="project-settings-error"]');
    assert.ok(errorEl);
    assert.ok(errorEl.textContent.includes('Directory does not exist: /nonexistent'));

    // Attempt duplicate path -> inline error
    nameInput.value = 'Dup';
    pathInput.value = '/repos/alpha';
    addForm.dispatchEvent({ type: 'submit' });
    await flushPromises();
    assert.ok(
      doc.querySelector('[data-testid="project-settings-error"]').textContent.includes('already registered')
    );

    // Add valid project -> clears error and appears in list
    nameInput.value = 'Beta';
    pathInput.value = '/repos/beta';
    addForm.dispatchEvent({ type: 'submit' });
    await flushPromises();

    assert.equal(doc.querySelector('[data-testid="project-settings-error"]'), null);
    assert.equal(doc.querySelectorAll('[data-testid="project-item"]').length, 2);
  });

  it('switches active project (updating banner immediately), edits metadata, and removes a project', async () => {
    const doc = createOfficeDom();
    const mockFetch = createMockBridgeFetch({
      activeProjectId: 'proj-1',
      projects: [
        { id: 'proj-1', name: 'Alpha', path: '/repos/alpha', branch: 'main' },
        { id: 'proj-2', name: 'Beta', path: '/repos/beta', branch: 'develop' },
      ],
    });

    const app = createOfficeApp({ document: doc, fetch: mockFetch });
    await app.init();

    doc.querySelector('[data-testid="open-project-settings"]').click();

    // Switch active project to Beta (proj-2)
    doc.querySelector('[data-testid="activate-project-proj-2"]').click();
    await flushPromises();

    assert.equal(doc.querySelector('[data-testid="active-project-name"]').textContent, 'Beta');
    assert.equal(doc.querySelector('[data-testid="active-project-path"]').textContent, '/repos/beta');
    assert.equal(doc.querySelector('[data-testid="active-project-branch"]').textContent, 'develop');

    // Edit Beta's name
    doc.querySelector('[data-testid="edit-project-proj-2"]').click();
    const editName = doc.querySelector('[data-testid="edit-project-name-proj-2"]');
    editName.value = 'Beta Core';
    doc.querySelector('[data-testid="edit-project-form-proj-2"]').dispatchEvent({ type: 'submit' });
    await flushPromises();

    assert.equal(doc.querySelector('[data-testid="active-project-name"]').textContent, 'Beta Core');

    // Remove Alpha (proj-1)
    doc.querySelector('[data-testid="remove-project-proj-1"]').click();
    await flushPromises();

    assert.equal(doc.querySelectorAll('[data-testid="project-item"]').length, 1);
    assert.equal(doc.querySelector('[data-testid="active-project-name"]').textContent, 'Beta Core');
  });
});
