/**
 * Type declaration for the capability-boundary gate's importable helper. The
 * script itself is a plain `.mjs` (run by CI via `node`), but tests import
 * `scanText` to assert the gate fires on planted violations.
 */
export declare function scanText(rel: string, text: string): string[];
