/**
 * Runtime-neutral credential envelope encryption using the Web Crypto API.
 * This module is imported by both Deno Edge Functions and the Node harness.
 */

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const encodeBase64 = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64 = (value) => {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("Invalid encrypted credential data.");
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const assertIdentityPart = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.includes("|")) {
    throw new Error("Invalid credential identity.");
  }
};

const aadIdentity = (credentialId, householdId, provider) => {
  assertIdentityPart(credentialId);
  assertIdentityPart(householdId);
  assertIdentityPart(provider);
  return `${credentialId}|${householdId}|${provider}`;
};

const tokenAad = (credentialId, householdId, provider) =>
  textEncoder.encode(aadIdentity(credentialId, householdId, provider));

const wrapAad = (credentialId, householdId, provider, kekVersion) => {
  if (!Number.isSafeInteger(kekVersion)) {
    throw new Error("Invalid credential KEK version.");
  }
  return textEncoder.encode(
    `${aadIdentity(credentialId, householdId, provider)}|${kekVersion}`,
  );
};

const cryptoApi = () => {
  if (
    !globalThis.crypto?.subtle ||
    typeof globalThis.crypto.getRandomValues !== "function"
  ) {
    throw new Error("Credential crypto is unavailable.");
  }
  return globalThis.crypto;
};

const randomIv = () =>
  cryptoApi().getRandomValues(new Uint8Array(GCM_IV_BYTES));

const importKek = async (kekBase64, usages) => {
  const keyBytes = decodeBase64(kekBase64);
  try {
    if (keyBytes.byteLength !== AES_KEY_BYTES) {
      throw new Error("Invalid credential KEK.");
    }
    return await cryptoApi().subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      usages,
    );
  } finally {
    keyBytes.fill(0);
  }
};

const decodeRecord = (record) => {
  if (record === null || typeof record !== "object") {
    throw new Error("Invalid encrypted credential data.");
  }
  if (!Number.isSafeInteger(record.kekVersion)) {
    throw new Error("Invalid encrypted credential data.");
  }

  const ciphertext = decodeBase64(record.ciphertext);
  const iv = decodeBase64(record.iv);
  const wrappedDek = decodeBase64(record.wrappedDek);
  const wrapIv = decodeBase64(record.wrapIv);
  if (
    ciphertext.byteLength < GCM_TAG_BYTES ||
    iv.byteLength !== GCM_IV_BYTES ||
    wrappedDek.byteLength !== AES_KEY_BYTES + GCM_TAG_BYTES ||
    wrapIv.byteLength !== GCM_IV_BYTES
  ) {
    throw new Error("Invalid encrypted credential data.");
  }

  return { ciphertext, iv, wrappedDek, wrapIv, kekVersion: record.kekVersion };
};

const unwrapDekKey = async (
  decodedRecord,
  credentialId,
  householdId,
  provider,
  oldKekBase64,
  extractable,
  usages,
) => {
  const oldKek = await importKek(oldKekBase64, ["unwrapKey"]);
  return await cryptoApi().subtle.unwrapKey(
    "raw",
    decodedRecord.wrappedDek,
    oldKek,
    {
      name: "AES-GCM",
      iv: decodedRecord.wrapIv,
      additionalData: wrapAad(
        credentialId,
        householdId,
        provider,
        decodedRecord.kekVersion,
      ),
      tagLength: 128,
    },
    { name: "AES-GCM", length: 256 },
    extractable,
    usages,
  );
};

export const encryptToken = async (
  token,
  credentialId,
  householdId,
  provider,
  kekBase64,
  kekVersion,
) => {
  let tokenBytes;
  try {
    if (typeof token !== "string") throw new Error("Invalid credential token.");

    const subtle = cryptoApi().subtle;
    const kek = await importKek(kekBase64, ["wrapKey"]);
    const dek = await subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const iv = randomIv();
    tokenBytes = textEncoder.encode(token);
    const ciphertext = new Uint8Array(
      await subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: tokenAad(credentialId, householdId, provider),
          tagLength: 128,
        },
        dek,
        tokenBytes,
      ),
    );

    const wrapIv = randomIv();
    const wrappedDek = new Uint8Array(
      await subtle.wrapKey(
        "raw",
        dek,
        kek,
        {
          name: "AES-GCM",
          iv: wrapIv,
          additionalData: wrapAad(
            credentialId,
            householdId,
            provider,
            kekVersion,
          ),
          tagLength: 128,
        },
      ),
    );

    return {
      ciphertext: encodeBase64(ciphertext),
      iv: encodeBase64(iv),
      wrappedDek: encodeBase64(wrappedDek),
      wrapIv: encodeBase64(wrapIv),
      kekVersion,
    };
  } catch {
    throw new Error("Credential encryption failed.");
  } finally {
    tokenBytes?.fill(0);
  }
};

export const decryptToken = async (
  record,
  credentialId,
  householdId,
  provider,
  kekBase64,
) => {
  let tokenBytes;
  try {
    const subtle = cryptoApi().subtle;
    const decodedRecord = decodeRecord(record);
    const dek = await unwrapDekKey(
      decodedRecord,
      credentialId,
      householdId,
      provider,
      kekBase64,
      false,
      ["decrypt"],
    );
    tokenBytes = new Uint8Array(
      await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodedRecord.iv,
          additionalData: tokenAad(credentialId, householdId, provider),
          tagLength: 128,
        },
        dek,
        decodedRecord.ciphertext,
      ),
    );
    return textDecoder.decode(tokenBytes);
  } catch {
    throw new Error("Credential decryption failed.");
  } finally {
    tokenBytes?.fill(0);
  }
};

export const rewrapDek = async (
  record,
  credentialId,
  householdId,
  provider,
  oldKekBase64,
  newKekBase64,
  newVersion,
) => {
  try {
    const subtle = cryptoApi().subtle;
    const decodedRecord = decodeRecord(record);
    const dek = await unwrapDekKey(
      decodedRecord,
      credentialId,
      householdId,
      provider,
      oldKekBase64,
      true,
      ["encrypt", "decrypt"],
    );
    const newKek = await importKek(newKekBase64, ["wrapKey"]);
    const wrapIv = randomIv();
    const wrappedDek = new Uint8Array(
      await subtle.wrapKey(
        "raw",
        dek,
        newKek,
        {
          name: "AES-GCM",
          iv: wrapIv,
          additionalData: wrapAad(
            credentialId,
            householdId,
            provider,
            newVersion,
          ),
          tagLength: 128,
        },
      ),
    );

    return {
      ciphertext: record.ciphertext,
      iv: record.iv,
      wrappedDek: encodeBase64(wrappedDek),
      wrapIv: encodeBase64(wrapIv),
      kekVersion: newVersion,
    };
  } catch {
    throw new Error("Credential DEK rewrap failed.");
  }
};
