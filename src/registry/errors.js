/**
 * Typed error for Project Settings Registry and Git validation failures.
 */
export class RegistryError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}
