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
