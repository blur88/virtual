export class ApiError extends Error {
  constructor(message, { status = 500, code = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Creates a browser-side API client that talks exclusively to the Web UI reverse proxy.
 * Never handles or stores OFFICE_BRIDGE_TOKEN.
 *
 * @param {{ fetch?: typeof globalThis.fetch }} [options]
 */
export function createApiClient(options = {}) {
  const fetchFn = options.fetch || globalThis.fetch.bind(globalThis);

  async function request(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (init.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetchFn(path, {
      ...init,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    const text = await res.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text };
      }
    }

    if (!res.ok) {
      throw new ApiError(payload.error || `Request failed with status ${res.status}`, {
        status: res.status,
        code: payload.code || null,
      });
    }

    return payload;
  }

  return {
    listProjects() {
      return request('/api/projects');
    },
    getActiveProject() {
      return request('/api/projects/active');
    },
    addProject({ name, path }) {
      return request('/api/projects', { method: 'POST', body: { name, path } });
    },
    editProject(id, { name, path }) {
      return request(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { name, path },
      });
    },
    selectActiveProject(id) {
      return request(`/api/projects/${encodeURIComponent(id)}/activate`, {
        method: 'POST',
      });
    },
    removeProject(id) {
      return request(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    getStatus() {
      return request('/api/status');
    },
    getTranscript() {
      return request('/api/transcript');
    },
    sendChat(message) {
      return request('/api/chat', {
        method: 'POST',
        body: { message },
      });
    },
    resetAgent() {
      return request('/api/agent/reset', {
        method: 'POST',
      });
    },
    overrideTerminalLease() {
      return request('/api/terminal/override-lease', {
        method: 'POST',
      });
    },
  };
}
