import { decryptToken, encryptToken, rewrapDek } from "./credential-crypto.ts";

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const randomKek = (): string =>
  toBase64(crypto.getRandomValues(new Uint8Array(32)));

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (actual !== expected) throw new Error("Expected values to be equal.");
};

const assertNotEquals = (actual: unknown, expected: unknown): void => {
  if (actual === expected) throw new Error("Expected values to differ.");
};

const assertRejects = async (
  operation: () => Promise<unknown>,
): Promise<void> => {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected operation to reject.");
};

const token = "access-sandbox-deno-canary";
const credentialId = "credential-deno-test-1";
const householdId = "household-deno-test-1";
const provider = "plaid";

Deno.test("credential crypto Option B contract", async (test) => {
  await test.step("round trip", async () => {
    const kek = randomKek();
    const encrypted = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );
    assertEquals(
      await decryptToken(encrypted, credentialId, householdId, provider, kek),
      token,
    );
  });

  await test.step("tampered AAD fails authentication", async () => {
    const kek = randomKek();
    const encrypted = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );
    await assertRejects(() =>
      decryptToken(
        encrypted,
        "credential-tampered",
        householdId,
        provider,
        kek,
      )
    );
  });

  await test.step("tampered ciphertext fails authentication", async () => {
    const kek = randomKek();
    const encrypted = await encryptToken(
      token,
      credentialId,
      householdId,
      provider,
      kek,
      1,
    );
    const bytes = Uint8Array.from(
      atob(encrypted.ciphertext),
      (value) => value.charCodeAt(0),
    );
    bytes[0] ^= 0x01;
    await assertRejects(() =>
      decryptToken(
        { ...encrypted, ciphertext: toBase64(bytes) },
        credentialId,
        householdId,
        provider,
        kek,
      )
    );
  });

  await test.step("DEK rewrap preserves token ciphertext", async () => {
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

    assertEquals(rewrapped.ciphertext, encrypted.ciphertext);
    assertEquals(rewrapped.iv, encrypted.iv);
    assertNotEquals(rewrapped.wrappedDek, encrypted.wrappedDek);
    assertEquals(
      await decryptToken(
        rewrapped,
        credentialId,
        householdId,
        provider,
        newKek,
      ),
      token,
    );
  });

  await test.step("repeated plaintext uses fresh IVs", async () => {
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
    assertNotEquals(first.iv, second.iv);
  });
});
