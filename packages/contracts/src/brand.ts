/**
 * Nominal typing helper. `Brand<string, 'HouseholdId'>` is assignable where a
 * plain string is expected, but a plain string is NOT assignable to it —
 * cross-wiring two id kinds is a compile error.
 */
declare const BRAND: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [BRAND]: Name };
