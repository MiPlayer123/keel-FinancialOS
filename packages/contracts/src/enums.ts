import { z } from 'zod';

/** Formal ledger account classes. Debit-positive convention (doc 10 §2.4). */
export const LEDGER_ACCOUNT_KINDS = ['asset', 'liability', 'income', 'expense', 'equity'] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];
export const LedgerAccountKindSchema = z.enum(LEDGER_ACCOUNT_KINDS);

export const ENTITY_KINDS = [
  'personal',
  'sole_prop',
  'llc_single',
  'llc_multi',
  's_corp',
  'trust',
  'other',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const EntityKindSchema = z.enum(ENTITY_KINDS);

export const HOUSEHOLD_ROLES = ['owner', 'partner', 'viewer', 'professional'] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];
export const HouseholdRoleSchema = z.enum(HOUSEHOLD_ROLES);

export const TRANSACTION_STATUSES = ['pending', 'posted', 'reviewed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const TransactionStatusSchema = z.enum(TRANSACTION_STATUSES);

export const TRANSACTION_SOURCES = ['sync', 'manual', 'import', 'split_child', 'system'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];
export const TransactionSourceSchema = z.enum(TRANSACTION_SOURCES);

export const BANK_PROVIDERS = ['simulator', 'plaid'] as const;
export type BankProviderName = (typeof BANK_PROVIDERS)[number];
export const BankProviderNameSchema = z.enum(BANK_PROVIDERS);

/**
 * AI risk ladder (CLAUDE.md Law 10). Confidence routes within a class, never
 * across classes.
 */
export const AI_RISK_CLASSES = ['A', 'B', 'C', 'D'] as const;
export type AiRiskClass = (typeof AI_RISK_CLASSES)[number];
export const AiRiskClassSchema = z.enum(AI_RISK_CLASSES);
