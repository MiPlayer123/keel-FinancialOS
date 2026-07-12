import * as jose from "npm:jose@6";
import {
  constantTimeSha256Equal,
  sha256Hex,
  verifyPlaidWebhook,
  type PlaidWebhookKeyResolution,
} from "./plaid-webhook-verify.ts";

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const bodyText = JSON.stringify({
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "item-unit",
  environment: "sandbox",
});
const bodyBytes = new TextEncoder().encode(bodyText);

const keyFixture = async () => {
  const pair = await jose.generateKeyPair("ES256", { extractable: true });
  const publicJwk = await jose.exportJWK(pair.publicKey);
  const privateJwk = await jose.exportJWK(pair.privateKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      ...publicJwk,
      kid: "kid-unit",
      alg: "ES256",
      use: "sig",
    } as jose.JWK,
    privateJwk: {
      ...privateJwk,
      kid: "kid-unit",
      alg: "ES256",
      use: "sig",
    } as jose.JWK,
  };
};

const signBody = async (
  privateKey: CryptoKey,
  overrides: {
    body?: Uint8Array;
    iat?: number;
    kid?: string;
    alg?: string;
  } = {},
): Promise<string> => {
  const hash = await sha256Hex(overrides.body ?? bodyBytes);
  return new jose.SignJWT({ request_body_sha256: hash })
    .setProtectedHeader({
      alg: overrides.alg ?? "ES256",
      typ: "JWT",
      kid: overrides.kid ?? "kid-unit",
    })
    .setIssuedAt(overrides.iat ?? Math.floor(Date.now() / 1000))
    .sign(privateKey);
};

const resolver = (result: PlaidWebhookKeyResolution) =>
  (_kid: string): Promise<PlaidWebhookKeyResolution> => Promise.resolve(result);

Deno.test("constant-time SHA-256 comparison contract", async (test) => {
  await test.step("accepts equal lowercase hashes", () => {
    assertEquals(constantTimeSha256Equal("a".repeat(64), "a".repeat(64)), true);
  });
  await test.step("rejects unequal hashes", () => {
    assertEquals(constantTimeSha256Equal("a".repeat(64), "b".repeat(64)), false);
  });
  await test.step("rejects bad length and non-lowercase-hex before compare", () => {
    assertEquals(constantTimeSha256Equal("a".repeat(63), "a".repeat(64)), false);
    assertEquals(constantTimeSha256Equal("A".repeat(64), "a".repeat(64)), false);
  });
});

Deno.test("verifyPlaidWebhook outcome routing", async (test) => {
  const keys = await keyFixture();
  const jwt = await signBody(keys.privateKey);

  await test.step("verifies ES256, body hash, JSON, environment, and fingerprint", async () => {
    const verdict = await verifyPlaidWebhook(bodyBytes, jwt, {
      keyResolver: resolver({ jwk: keys.publicJwk }),
    });
    assertEquals(verdict.outcome, "verified");
    if (verdict.outcome !== "verified") throw new Error("Expected verified verdict");
    assertEquals(verdict.body, JSON.parse(bodyText));
    assertEquals(verdict.jwtFingerprint, await sha256Hex(new TextEncoder().encode(jwt)));
  });

  await test.step("negative cache is invalid while outage is unverifiable", async () => {
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({ notFound: true }),
      })).outcome,
      "invalid",
    );
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({ outage: true }),
      })).outcome,
      "unverifiable",
    );
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({ jwk: keys.publicJwk, outage: true, stale: false }),
      })).outcome,
      "unverifiable",
    );
  });

  await test.step("budget exhaustion is unverifiable even when a stale JWK is present", async () => {
    const token = await signBody(keys.privateKey);
    assertEquals(
      await verifyPlaidWebhook(bodyBytes, token, {
        keyResolver: resolver({
          jwk: keys.publicJwk,
          stale: true,
          fetchedAt: new Date(Date.now() - 60_000).toISOString(),
          keyExpiredAt: null,
          budgetExhausted: true,
        }),
      }),
      { outcome: "unverifiable", reason: "provider budget exhausted" },
    );
  });

  await test.step("bad or private JWK is unverifiable, not invalid", async () => {
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({ jwk: { ...keys.publicJwk, crv: "P-384" } }),
      })).outcome,
      "unverifiable",
    );
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({ jwk: keys.privateJwk }),
      })).outcome,
      "unverifiable",
    );
  });

  await test.step("safe-stale is bounded by age and token-time expiry", async () => {
    const freshEnough = new Date(Date.now() - 60_000).toISOString();
    const tooOld = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    const tokenIat = Math.floor(Date.now() / 1000);
    const expiredBeforeToken = new Date((tokenIat - 1) * 1000).toISOString();

    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({
          jwk: keys.publicJwk,
          stale: true,
          outage: true,
          fetchedAt: freshEnough,
          keyExpiredAt: null,
        }),
      })).outcome,
      "verified",
    );
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({
          jwk: keys.publicJwk,
          stale: true,
          outage: true,
          fetchedAt: tooOld,
          keyExpiredAt: null,
        }),
      })).outcome,
      "unverifiable",
    );
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, jwt, {
        keyResolver: resolver({
          jwk: keys.publicJwk,
          stale: true,
          outage: true,
          fetchedAt: freshEnough,
          keyExpiredAt: expiredBeforeToken,
        }),
      })).outcome,
      "unverifiable",
    );
  });

  await test.step("alg, typ, kid, and header bounds fail closed", async () => {
    const payload = jose.base64url.encode(JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      request_body_sha256: await sha256Hex(bodyBytes),
    }));
    for (const header of [
      { alg: "none", typ: "JWT", kid: "kid-unit" },
      { alg: "HS256", typ: "JWT", kid: "kid-unit" },
      { alg: "RS256", typ: "JWT", kid: "kid-unit" },
      { alg: "ES384", typ: "JWT", kid: "kid-unit" },
      { alg: "ES256", typ: "not-jwt", kid: "kid-unit" },
      { alg: "ES256", typ: "JWT", kid: "x".repeat(129) },
    ]) {
      const token = `${jose.base64url.encode(JSON.stringify(header))}.${payload}.`;
      assertEquals(
        (await verifyPlaidWebhook(bodyBytes, token, {
          keyResolver: resolver({ jwk: keys.publicJwk }),
        })).outcome,
        "invalid",
      );
    }
    assertEquals(
      (await verifyPlaidWebhook(bodyBytes, "x".repeat(8193), {
        keyResolver: resolver({ jwk: keys.publicJwk }),
      })).outcome,
      "invalid",
    );
  });

  await test.step("future, expired, tampered, and wrong-environment deliveries are invalid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const future = await signBody(keys.privateKey, { iat: now + 600 });
    const expired = await signBody(keys.privateKey, { iat: now - 3600 });
    const tampered = await signBody(keys.privateKey, {
      body: new TextEncoder().encode(`${bodyText}tampered`),
    });
    const productionBytes = new TextEncoder().encode(
      bodyText.replace('"sandbox"', '"production"'),
    );
    const productionJwt = await signBody(keys.privateKey, { body: productionBytes });
    for (const [bytes, token] of [
      [bodyBytes, future],
      [bodyBytes, expired],
      [bodyBytes, tampered],
      [productionBytes, productionJwt],
    ] as const) {
      assertEquals(
        (await verifyPlaidWebhook(bytes, token, {
          keyResolver: resolver({ jwk: keys.publicJwk }),
        })).outcome,
        "invalid",
      );
    }
  });
});
