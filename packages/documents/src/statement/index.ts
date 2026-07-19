/**
 * Statement parsing — pure, bytes-only, capability-boundary-clean (Law 1/4/5).
 * Re-exports the defensive types, the CSV and OFX parsers, the shared money
 * string-math, and the exact-only payment-matcher mirror. Nothing here touches
 * Supabase, fetch, or Storage — enforced by scripts/check-capability-boundary.mjs.
 */
export {
  EMPTY_PROVENANCE,
  STATEMENT_PARSER_VERSION,
  emptyStatementFields,
  provenance,
  type FieldProvenance,
  type NullReason,
  type StatementExtractionFields,
  type StatementExtractionRecord,
  type StatementHoldingRecord,
  type StatementKindHint,
  type StatementLineRecord,
} from './types.js';
export {
  currencyScale,
  formatMinorToDecimal,
  parseMoneyToMinor,
  type MoneyParse,
} from './money.js';
export {
  MAX_CSV_ROWS,
  decodeCsvBytes,
  parseCsvStatement,
  tokenizeCsv,
} from './csv.js';
export {
  parseOfxStatement,
  scanOfxSafety,
  tokenizeOfx,
} from './ofx.js';
export {
  DEFAULT_PAYMENT_MATCHER_CONFIG,
  DEFAULT_PAYMENT_WINDOW_DAYS,
  STATEMENT_PAYMENT_MATCHER_VERSION,
  decidePaymentMatch,
  rankPaymentSurvivors,
  type PaymentCandidate,
  type PaymentMatch,
  type PaymentMatcherConfig,
  type PaymentOutcome,
  type PaymentReasonCode,
  type StatementPaymentContext,
} from './payment-matcher.js';
