// JSON objects from the backend or a request body, before their fields are checked. No imports, so any module can use it.
export type Payload = Record<string, unknown>;
/** The value as a plain object, or null (arrays and primitives included). */
export const record = (value: unknown): Payload | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : null;
