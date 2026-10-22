export class AgentConfigError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) throw new AgentConfigError(code, message, details);
}

export function asResultError(error) {
  if (error instanceof AgentConfigError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
  }
  return { ok: false, error: { code: 'INTERNAL', message: error?.message ?? String(error) } };
}
