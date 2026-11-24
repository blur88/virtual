import { createApiClient } from './api-client.js';
import { renderActiveProjectBanner } from './components/active-project-banner.js';
import { renderProjectSettingsModal } from './components/project-settings-modal.js';
import { renderChatView } from './components/chat-view.js';
import { renderTerminalView } from './components/terminal-view.js';
import { renderStatusBanner } from './components/status-banner.js';
import { renderResetAgentModal } from './components/reset-agent-modal.js';

const RATE_LIMIT_RE = /\b(rate limit|usage limit|too many requests|429)\b/i;

function resolveWsBaseUrl(explicitBase) {
  if (explicitBase) return explicitBase.replace(/\/+$/, '');
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return 'ws://localhost:3000';
}

/**
 * Creates the AI Office Web UI application controller.
 *
 * @param {{
 *   document?: Document,
 *   fetch?: typeof globalThis.fetch,
 *   WebSocket?: typeof globalThis.WebSocket,
 *   Terminal?: any,
 *   wsBaseUrl?: string,
 *   reconnectDelayMs?: number,
 *   onCopy?: (text: string) => Promise<void> | void,
 * }} [options]
 */
export function createOfficeApp(options = {}) {
  const doc = options.document || globalThis.document;
  const WsCtor = options.WebSocket !== undefined ? options.WebSocket : globalThis.WebSocket;
  const TerminalCtor = options.Terminal !== undefined ? options.Terminal : globalThis.Terminal;
  const wsBaseUrl = resolveWsBaseUrl(options.wsBaseUrl);
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
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
    // Chat & agent state
    turns: [],
    agentBusy: false,
    draftMessage: '',
    sendingChat: false,
    chatConnected: false,
    // Terminal & Input Lease state
    inputLease: { holder: 'none', updatedAt: null },
    terminalConnected: false,
    cutoffReason: null,
    // Reset modal & status banner
    resetModalOpen: false,
    resettingAgent: false,
    resetError: null,
    statusBanner: null,
  };

  let chatWs = null;
  let terminalWs = null;
  let termInstance = null;
  let chatReconnectTimer = null;
  let terminalReconnectTimer = null;
  let destroyed = false;

  function getActiveProject() {
    if (!state.activeProjectId) return null;
    return state.projects.find((p) => p.id === state.activeProjectId) || null;
  }

  function renderViewPanels() {
    const chatPanel = doc.getElementById('chat-view-panel');
    const terminalPanel = doc.getElementById('terminal-view-panel');
    if (chatPanel) {
      chatPanel.hidden = state.activeView !== 'chat';
      renderChatView(
        chatPanel,
        {
          turns: state.turns,
          isBusy: state.agentBusy,
          draftMessage: state.draftMessage,
          sending: state.sendingChat,
        },
        {
          onDraftChange: (text) => {
            state.draftMessage = text;
          },
          onSendMessage: sendChatMessage,
          onCopy: options.onCopy,
        }
      );
    }
    if (terminalPanel) {
      terminalPanel.hidden = state.activeView !== 'terminal';
      renderTerminalView(
        terminalPanel,
        {
          inputLease: state.inputLease,
          terminalConnected: state.terminalConnected,
          cutoffReason: state.cutoffReason,
        },
        {
          onTakeControl: overrideLease,
          onMountTerminal: mountXterm,
        }
      );
    }
  }

  function renderBannerActions() {
    const slot = doc.getElementById('banner-actions-slot');
    if (!slot) return;
    const resetBtn = doc.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-danger';
    resetBtn.dataset.testid = 'reset-agent-btn';
    resetBtn.textContent = 'Reset Agent';
    resetBtn.addEventListener('click', () => {
      state.resetModalOpen = true;
      state.resetError = null;
      render();
    });
    slot.replaceChildren(resetBtn);
  }

  function mountXterm(mountEl) {
    if (termInstance || typeof TerminalCtor !== 'function') return;
    termInstance = new TerminalCtor({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
    });
    termInstance.open(mountEl);
    termInstance.onData((data) => {
      if (state.inputLease?.holder === 'native') {
        return;
      }
      if (terminalWs && terminalWs.readyState === 1) {
        terminalWs.send(JSON.stringify({ type: 'input', data }));
      }
    });
  }

  function appendOrUpdateTurn(turn) {
    if (!turn) return;
    if (turn.id && state.turns.some((t) => t.id === turn.id)) {
      return;
    }
    state.turns.push(turn);
    if (turn.type === 'assistant' && RATE_LIMIT_RE.test(turn.text || '')) {
      state.statusBanner = {
        kind: 'rate-limit',
        message: 'Usage or rate limit reached. Wait a moment before sending another prompt or reset the session.',
      };
    }
  }

  function scheduleChatReconnect() {
    if (destroyed || chatReconnectTimer || typeof WsCtor !== 'function') return;
    chatReconnectTimer = setTimeout(() => {
      chatReconnectTimer = null;
      if (!destroyed) connectChatWs();
    }, reconnectDelayMs);
    if (typeof chatReconnectTimer.unref === 'function') {
      chatReconnectTimer.unref();
    }
  }

  function connectChatWs() {
    if (destroyed || typeof WsCtor !== 'function') return;
    if (chatReconnectTimer) {
      clearTimeout(chatReconnectTimer);
      chatReconnectTimer = null;
    }
    const ws = new WsCtor(`${wsBaseUrl}/ws/chat`);
    chatWs = ws;

    ws.addEventListener('open', () => {
      state.chatConnected = true;
      if (state.statusBanner?.kind === 'connection') {
        state.statusBanner = null;
      }
      render();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'history') {
        state.turns = Array.isArray(msg.turns) ? msg.turns : [];
        state.agentBusy = Boolean(msg.isBusy);
      } else if (msg.type === 'turn') {
        appendOrUpdateTurn(msg.turn);
      } else if (msg.type === 'status') {
        state.agentBusy = Boolean(msg.isBusy);
      } else if (msg.type === 'reset') {
        state.turns = [];
        state.agentBusy = false;
      } else if (msg.type === 'error') {
        state.statusBanner = {
          kind: RATE_LIMIT_RE.test(msg.message || '') ? 'rate-limit' : 'agent-error',
          message: msg.message || 'Riley encountered an unexpected error.',
        };
      }
      render();
    });

    ws.addEventListener('close', () => {
      state.chatConnected = false;
      if (!destroyed) {
        state.statusBanner = {
          kind: 'connection',
          message: 'Connection to Host Bridge lost. Attempting to reconnect...',
        };
        render();
        scheduleChatReconnect();
      }
    });
  }

  function scheduleTerminalReconnect() {
    if (destroyed || terminalReconnectTimer || state.cutoffReason || typeof WsCtor !== 'function') {
      return;
    }
    terminalReconnectTimer = setTimeout(() => {
      terminalReconnectTimer = null;
      if (!destroyed && state.activeView === 'terminal' && !state.cutoffReason) {
        connectTerminalWs();
      }
    }, reconnectDelayMs);
    if (typeof terminalReconnectTimer.unref === 'function') {
      terminalReconnectTimer.unref();
    }
  }

  function connectTerminalWs() {
    if (destroyed || typeof WsCtor !== 'function') return;
    if (terminalReconnectTimer) {
      clearTimeout(terminalReconnectTimer);
      terminalReconnectTimer = null;
    }
    state.cutoffReason = null;
    const ws = new WsCtor(`${wsBaseUrl}/ws/terminal`);
    terminalWs = ws;

    ws.addEventListener('open', () => {
      state.terminalConnected = true;
      render();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        termInstance?.write(msg.data);
      } else if (msg.type === 'lease' || msg.type === 'lease-blocked') {
        if (msg.inputLease) {
          state.inputLease = msg.inputLease;
          render();
        }
      } else if (msg.type === 'cutoff') {
        state.terminalConnected = false;
        state.cutoffReason = msg.reason || 'Agent session detached';
        state.statusBanner = {
          kind: 'agent-error',
          message: `Terminal disconnected: ${state.cutoffReason}. Reset Agent to start a fresh Riley session.`,
        };
        render();
      }
    });

    ws.addEventListener('close', () => {
      state.terminalConnected = false;
      if (!destroyed && !state.cutoffReason && state.activeView === 'terminal') {
        render();
        scheduleTerminalReconnect();
      }
    });
  }

  async function sendChatMessage(message) {
    state.sendingChat = true;
    render();
    try {
      await api.sendChat(message);
      state.draftMessage = '';
      if (state.statusBanner?.kind === 'rate-limit' || state.statusBanner?.kind === 'agent-error') {
        state.statusBanner = null;
      }
    } catch (err) {
      if (err?.status === 429 || RATE_LIMIT_RE.test(err?.message || '')) {
        state.statusBanner = {
          kind: 'rate-limit',
          message: err.message || 'Rate limit reached. Please wait before retrying.',
        };
      } else {
        state.statusBanner = {
          kind: 'agent-error',
          message: err?.message || 'Failed to deliver message to Riley.',
        };
      }
    } finally {
      state.sendingChat = false;
      render();
    }
  }

  async function overrideLease() {
    try {
      const res = await api.overrideTerminalLease();
      if (res?.inputLease) {
        state.inputLease = res.inputLease;
      } else {
        state.inputLease = { holder: 'web', updatedAt: new Date().toISOString() };
      }
      if (terminalWs && terminalWs.readyState === 1) {
        terminalWs.send(JSON.stringify({ type: 'override-lease' }));
      }
      render();
    } catch (err) {
      state.statusBanner = {
        kind: 'agent-error',
        message: err?.message || 'Failed to override Input Lease.',
      };
      render();
    }
  }

  async function confirmResetAgent() {
    state.resettingAgent = true;
    state.resetError = null;
    render();
    try {
      const res = await api.resetAgent();
      state.turns = [];
      state.agentBusy = false;
      state.cutoffReason = null;
      state.inputLease = res?.inputLease || { holder: 'none', updatedAt: null };
      state.resetModalOpen = false;
      state.statusBanner = null;
      termInstance?.clear?.();
      if (state.activeView === 'terminal' && !terminalWs) {
        connectTerminalWs();
      }
    } catch (err) {
      state.resetError = err?.message || 'Failed to reset agent session.';
    } finally {
      state.resettingAgent = false;
      render();
    }
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
            if (view === 'terminal' && !terminalWs) {
              connectTerminalWs();
            }
          },
        }
      );
      renderBannerActions();
    }

    const statusBannerRoot = doc.getElementById('status-banner-root');
    if (statusBannerRoot) {
      renderStatusBanner(
        statusBannerRoot,
        { banner: state.statusBanner },
        {
          onReconnect: () => {
            connectChatWs();
            if (state.activeView === 'terminal') connectTerminalWs();
          },
          onOpenReset: () => {
            state.resetModalOpen = true;
            state.resetError = null;
            render();
          },
          onDismiss: () => {
            state.statusBanner = null;
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

    const resetModalRoot = doc.getElementById('reset-agent-modal-root');
    if (resetModalRoot) {
      renderResetAgentModal(
        resetModalRoot,
        {
          open: state.resetModalOpen,
          isBusy: state.agentBusy,
          resetting: state.resettingAgent,
          error: state.resetError,
        },
        {
          onCancel: () => {
            state.resetModalOpen = false;
            state.resetError = null;
            render();
          },
          onConfirm: confirmResetAgent,
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
    connectChatWs,
    connectTerminalWs,
    async init() {
      render();
      await refreshProjects();
      connectChatWs();
    },
    destroy() {
      destroyed = true;
      if (chatReconnectTimer) clearTimeout(chatReconnectTimer);
      if (terminalReconnectTimer) clearTimeout(terminalReconnectTimer);
      chatWs?.close?.();
      terminalWs?.close?.();
      termInstance?.dispose?.();
    },
  };
}

if (typeof window !== 'undefined' && window.document && document.getElementById('active-project-banner')) {
  const app = createOfficeApp();
  app.init().catch((err) => {
    console.error('Failed to initialize AI Office Web UI:', err);
  });
}
