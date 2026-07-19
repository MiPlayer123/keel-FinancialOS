export {
  merchantSimilarity,
  merchantTokens,
  normalizeMerchant,
  tokenOverlap,
  trigramSimilarity,
} from './normalize.js';
export {
  buildExtractionRecord,
  EXTRACTOR_PROMPT_VERSION,
  parseReceiptExtraction,
  type ExtractionRecord,
  type ReceiptExtraction,
} from './extraction.js';
export {
  decideMatch,
  DEFAULT_MATCHER_CONFIG,
  MATCHER_VERSION,
  scoreCandidates,
  type CandidateTransaction,
  type MatcherConfig,
  type MatchOutcome,
  type ReasonCode,
  type ScoredCandidate,
} from './matcher.js';
// Statement parsers + defensive types. Also reachable via the
// '@keel/documents/statement' subpath, but re-exported here so the functions
// vendor bundle (scripts/build-functions.mjs `export * from '@keel/documents'`)
// carries them — the statement-extract worker consumes these bytes-only parsers
// (Law 1/5, statement-ingestion-v2 §1 [A1]).
export {
  MAX_CSV_ROWS,
  STATEMENT_PARSER_VERSION,
  parseCsvStatement,
  parseOfxStatement,
  scanOfxSafety,
  type StatementExtractionRecord,
  type StatementKindHint,
} from './statement/index.js';
