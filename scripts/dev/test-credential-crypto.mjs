import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

const { decryptToken, encryptToken, rewrapDek } = await import(
  "../../supabase/functions/_shared/credential-crypto-core.mjs"
);

const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const randomKek = () =>
  toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const token = "access-sandbox-test-canary";
const credentialId = "credential-test-1";
const householdId = "household-test-1";
const provider = "plaid";

const tests = [
  ["round-trip", async () => {
    const kek = randomKek();
    const encrypted = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );

    assert.equal(
      await decryptToken(encrypted, credentialId, householdId, provider, kek),
      token,
    );
  }],
  ["tampered-AAD-throws", async () => {
    const kek = randomKek();
    const encrypted = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );

    await assert.rejects(
      decryptToken(
        encrypted,
        "credential-tampered",
        householdId,
        provider,
        kek,
      ),
    );
  }],
  ["tampered-ciphertext-throws", async () => {
    const kek = randomKek();
    const encrypted = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );
    const tamperedCiphertext = Buffer.from(encrypted.ciphertext, "base64");
    tamperedCiphertext[0] ^= 0x01;

    await assert.rejects(
      decryptToken(
        { ...encrypted, ciphertext: tamperedCiphertext.toString("base64") },
        credentialId,
        householdId,
        provider,
        kek,
      ),
    );
  }],
  ["rewrap-keeps-ciphertext-identical-and-still-decrypts", async () => {
    const oldKek = randomKek();
    const newKek = randomKek();
    const encrypted = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      oldKek,
      1,
    );
    const rewrapped = await rewrapDek(
      encrypted,
      credentialId,
      householdId,
      provider,
      oldKek,
      newKek,
      2,
    );

    assert.deepEqual(
      Buffer.from(rewrapped.ciphertext, "base64"),
      Buffer.from(encrypted.ciphertext, "base64"),
      "rewrap must preserve the ciphertext bytes",
    );
    assert.equal(rewrapped.iv, encrypted.iv);
    assert.equal(rewrapped.kekVersion, 2);
    assert.equal(
      await decryptToken(
        rewrapped,
        credentialId,
        householdId,
        provider,
        newKek,
      ),
      token,
    );
  }],
  ["fresh-IV-differs", async () => {
    const kek = randomKek();
    const first = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );
    const second = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );

    assert.notEqual(first.iv, second.iv);
  }],
];

let failed = false;

for (const [name, test] of tests) {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

process.exitCode = failed ? 1 : 0;
