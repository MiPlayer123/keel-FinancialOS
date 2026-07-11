/** Credential token envelope encryption for Supabase Edge Functions. */
import {
  decryptToken as decryptTokenCore,
  encryptToken as encryptTokenCore,
  rewrapDek as rewrapDekCore,
} from "./credential-crypto-core.mjs";

export interface EncryptedRecord {
  ciphertext: string;
  iv: string;
  wrappedDek: string;
  wrapIv: string;
  kekVersion: number;
}

export const encryptToken = (
  token: string,
  credentialId: string,
  householdId: string,
  provider: string,
  kekBase64: string,
  kekVersion: number,
): Promise<EncryptedRecord> =>
  encryptTokenCore(
    token,
    credentialId,
    householdId,
    provider,
    kekBase64,
    kekVersion,
  );

export const decryptToken = (
  record: EncryptedRecord,
  credentialId: string,
  householdId: string,
  provider: string,
  kekBase64: string,
): Promise<string> =>
  decryptTokenCore(record, credentialId, householdId, provider, kekBase64);

export const rewrapDek = (
  record: EncryptedRecord,
  credentialId: string,
  householdId: string,
  provider: string,
  oldKekBase64: string,
  newKekBase64: string,
  newVersion: number,
): Promise<EncryptedRecord> =>
  rewrapDekCore(
    record,
    credentialId,
    householdId,
    provider,
    oldKekBase64,
    newKekBase64,
    newVersion,
  );
