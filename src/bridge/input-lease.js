/**
 * Creates an Input Lease coordinator arbitraging terminal typing between the Web UI
 * and native `tmux attach` clients.
 */
export function createInputLease() {
  let holder = 'none';
  let updatedAt = new Date().toISOString();

  function snapshot() {
    return { holder, updatedAt };
  }

  return {
    getState: snapshot,

    /**
     * Attempts to record Web UI terminal input.
     * Blocked when native terminal currently holds the lease.
     */
    recordWebInput() {
      if (holder === 'native') {
        return { allowed: false, state: snapshot() };
      }
      holder = 'web';
      updatedAt = new Date().toISOString();
      return { allowed: true, state: snapshot() };
    },

    /**
     * Records external typing activity from a native `tmux attach` client.
     */
    recordNativeActivity() {
      holder = 'native';
      updatedAt = new Date().toISOString();
      return snapshot();
    },

    /**
     * Immediately overrides any native lease back to the Web UI.
     */
    overrideToWeb() {
      holder = 'web';
      updatedAt = new Date().toISOString();
      return snapshot();
    },

    /**
     * Releases the current lease.
     */
    release() {
      holder = 'none';
      updatedAt = new Date().toISOString();
      return snapshot();
    },
  };
}
