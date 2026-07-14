export class DeepworkError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DeepworkError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) {
    throw new DeepworkError(code, message, details);
  }
}
