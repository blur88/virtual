import { createApiClient } from './api-client.js';
import { renderActiveProjectBanner } from './components/active-project-banner.js';
import { renderProjectSettingsModal } from './components/project-settings-modal.js';

/**
 * Creates the AI Office Web UI application controller.
 *
 * @param {{
 *   document?: Document,
 *   fetch?: typeof globalThis.fetch,
 * }} [options]
 */
export function createOfficeApp(options = {}) {
  const doc = options.document || globalThis.document;
  const api = createApiClient({ fetch: options.fetch });

  const state = {
    activeProjectId: null,
    projects: [],
    activeView: 'chat',
    settingsOpen: false,
    editingProjectId: null,
    draftAdd: { name: '', path: '' },
    loading: true,
    busy: false,
    error: null,
  };

  function getActiveProject() {
    if (!state.activeProjectId) return null;
    return state.projects.find((p) => p.id === state.activeProjectId) || null;
  }

  function renderViewPanels() {
    const chatPanel = doc.getElementById('chat-view-panel');
    const terminalPanel = doc.getElementById('terminal-view-panel');
    if (chatPanel) chatPanel.hidden = state.activeView !== 'chat';
    if (terminalPanel) terminalPanel.hidden = state.activeView !== 'terminal';
  }

  async function runMutation(fn) {
    state.busy = true;
    state.error = null;
    render();
    try {
      await fn();
      await refreshProjects();
    } catch (err) {
      state.error = err?.message || 'Operation failed';
    } finally {
      state.busy = false;
      render();
    }
  }

  function render() {
    const bannerEl = doc.getElementById('active-project-banner');
    if (bannerEl) {
      renderActiveProjectBanner(
        bannerEl,
        {
          activeProject: getActiveProject(),
          activeView: state.activeView,
          loading: state.loading,
        },
        {
          onOpenSettings: () => {
            state.settingsOpen = true;
            state.editingProjectId = null;
            state.error = null;
            render();
          },
          onSelectView: (view) => {
            state.activeView = view;
            render();
          },
        }
      );
    }

    const modalRoot = doc.getElementById('project-settings-modal-root');
    if (modalRoot) {
      renderProjectSettingsModal(
        modalRoot,
        {
          open: state.settingsOpen,
          projects: state.projects,
          activeProjectId: state.activeProjectId,
          editingProjectId: state.editingProjectId,
          draftAdd: state.draftAdd,
          busy: state.busy,
          error: state.error,
        },
        {
          onClose: () => {
            state.settingsOpen = false;
            state.editingProjectId = null;
            state.error = null;
            render();
          },
          onDraftAddChange: (draft) => {
            state.draftAdd = draft;
          },
          onAddProject: async ({ name, path }) => {
            state.draftAdd = { name, path };
            await runMutation(async () => {
              await api.addProject({ name, path });
              state.draftAdd = { name: '', path: '' };
            });
          },
          onSelectActive: async (id) => {
            await runMutation(() => api.selectActiveProject(id));
          },
          onStartEdit: (id) => {
            state.editingProjectId = id;
            state.error = null;
            render();
          },
          onCancelEdit: () => {
            state.editingProjectId = null;
            state.error = null;
            render();
          },
          onSaveEdit: async (id, { name, path }) => {
            await runMutation(async () => {
              await api.editProject(id, { name, path });
              state.editingProjectId = null;
            });
          },
          onRemoveProject: async (id) => {
            await runMutation(async () => {
              await api.removeProject(id);
              if (state.editingProjectId === id) {
                state.editingProjectId = null;
              }
            });
          },
        }
      );
    }

    renderViewPanels();
  }

  async function refreshProjects() {
    const data = await api.listProjects();
    state.activeProjectId = data.activeProjectId ?? null;
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    state.loading = false;
    render();
  }

  return {
    state,
    api,
    render,
    refreshProjects,
    async init() {
      render();
      await refreshProjects();
    },
  };
}

if (typeof window !== 'undefined' && window.document && document.getElementById('active-project-banner')) {
  const app = createOfficeApp();
  app.init().catch((err) => {
    console.error('Failed to initialize AI Office Web UI:', err);
  });
}
