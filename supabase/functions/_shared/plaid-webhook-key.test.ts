import * as jose from "npm:jose@6";
import {
  createPlaidWebhookKeyResolver,
  fetchWebhookVerificationKey,
  type WebhookKeyAdminClient,
} from "./plaid-webhook-key.ts";

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

type RpcResult = { data: unknown; error: unknown };

const adminWith = (
  handler: (name: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult>,
): WebhookKeyAdminClient => ({ rpc: handler });

const makePublicJwk = async (kid = "kid-key-unit") => {
  const pair = await jose.generateKeyPair("ES256", { extractable: true });
  const publicJwk = await jose.exportJWK(pair.publicKey);
  const privateJwk = await jose.exportJWK(pair.privateKey);
  return {
    publicJwk: { ...publicJwk, kid, alg: "ES256", use: "sig" },
    privateJwk: { ...privateJwk, kid, alg: "ES256", use: "sig" },
  };
};

Deno.test("dedicated webhook verification-key fetch", async (test) => {
  const keys = await makePublicJwk();

  await test.step("hermetic response is consumed before live fetch", async () => {
    let liveCalls = 0;
    const admin = adminWith(() => ({
      data: {
        httpStatus: 200,
        bodyText: JSON.stringify({
          key: { ...keys.publicJwk, created_at: 100, expired_at: null },
        }),
      },
      error: null,
    }));
    const result = await fetchWebhookVerificationKey(admin, "kid-key-unit", {
      fetchImpl: () => {
        liveCalls += 1;
        throw new Error("live fetch must not run");
      },
      config: { plaidEnv: "sandbox", clientId: "client", secret: "secret" },
    });
    assertEquals(result.status, "ok");
    assertEquals(liveCalls, 0);
  });

  await test.step("only exact HTTP-400 invalid-key-id is invalid_kid", async () => {
    const response = (httpStatus: number, errorCode: string) =>
      adminWith(() => ({
        data: { httpStatus, bodyText: JSON.stringify({ error_code: errorCode }) },
        error: null,
      }));
    assertEquals(
      (await fetchWebhookVerificationKey(
        response(400, "INVALID_WEBHOOK_VERIFICATION_KEY_ID"),
        "kid-key-unit",
      )).status,
      "invalid_kid",
    );
    assertEquals(
      (await fetchWebhookVerificationKey(
        response(400, "INVALID_REQUEST"),
        "kid-key-unit",
      )).status,
      "outage",
    );
    assertEquals(
      (await fetchWebhookVerificationKey(
        response(500, "INVALID_WEBHOOK_VERIFICATION_KEY_ID"),
        "kid-key-unit",
      )).status,
      "outage",
    );
  });

  await test.step("live path preserves status and exact code without PlaidClientError", async () => {
    const admin = adminWith((name) => ({
      data: name === "keel_provider_budget_reserve" ? true : null,
      error: null,
    }));
    let requestBody = "";
    const result = await fetchWebhookVerificationKey(admin, "kid-key-unit", {
      config: { plaidEnv: "sandbox", clientId: "client-canary", secret: "secret-canary" },
      fetchImpl: (_input, init) => {
        requestBody = String(init?.body);
        return Promise.resolve(new Response(
          JSON.stringify({ error_code: "INVALID_WEBHOOK_VERIFICATION_KEY_ID" }),
          { status: 400 },
        ));
      },
    });
    assertEquals(result.status, "invalid_kid");
    assertEquals(JSON.parse(requestBody), {
      client_id: "client-canary",
      secret: "secret-canary",
      key_id: "kid-key-unit",
    });
  });

  await test.step("live credentials and full key never reach captured logs", async () => {
    const admin = adminWith((name) => ({
      data: name === "keel_provider_budget_reserve" ? true : null,
      error: null,
    }));
    const captured: unknown[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => captured.push(args);
    console.warn = (...args: unknown[]) => captured.push(args);
    console.error = (...args: unknown[]) => captured.push(args);
    try {
      const result = await fetchWebhookVerificationKey(admin, "kid-key-unit", {
        config: {
          plaidEnv: "sandbox",
          clientId: "client-log-canary",
          secret: "secret-log-canary",
        },
        fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
          key: { ...keys.publicJwk, created_at: 100, expired_at: null },
        }), { status: 200 })),
      });
      assertEquals(result.status, "ok");
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
    const logText = JSON.stringify(captured);
    assertEquals(logText.includes("client-log-canary"), false);
    assertEquals(logText.includes("secret-log-canary"), false);
    assertEquals(logText.includes(String(keys.publicJwk.x)), false);
  });

  await test.step("wrong env or missing credentials is outage without network", async () => {
    const admin = adminWith(() => ({ data: null, error: null }));
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    assertEquals(
      (await fetchWebhookVerificationKey(admin, "kid-key-unit", {
        config: { plaidEnv: "development", clientId: "client", secret: "secret" },
        fetchImpl,
      })).status,
      "outage",
    );
    assertEquals(
      (await fetchWebhookVerificationKey(admin, "kid-key-unit", {
        config: { plaidEnv: "sandbox" },
        fetchImpl,
      })).status,
      "outage",
    );
    assertEquals(calls, 0);
  });

  await test.step("host follows PLAID_ENV: production fetches production.plaid.com", async () => {
    const admin = adminWith((name) => ({
      data: name === "keel_provider_budget_reserve" ? true : null,
      error: null,
    }));
    let requestedUrl = "";
    const result = await fetchWebhookVerificationKey(admin, "kid-key-unit", {
      config: { plaidEnv: "production", clientId: "client", secret: "secret" },
      fetchImpl: (input) => {
        requestedUrl = String(input);
        return Promise.resolve(new Response(JSON.stringify({
          key: { ...keys.publicJwk, created_at: 100, expired_at: null },
        }), { status: 200 }));
      },
    });
    assertEquals(result.status, "ok");
    assertEquals(requestedUrl, "https://production.plaid.com/webhook_verification_key/get");
  });

  await test.step("open provider budget is distinct, metered, and never fetches", async () => {
    const names: string[] = [];
    let fetchCalls = 0;
    const admin = adminWith((name) => {
      names.push(name);
      if (name === "keel_consume_webhook_key_response") return { data: null, error: null };
      if (name === "keel_provider_budget_reserve") return { data: false, error: null };
      return { data: null, error: null };
    });
    const result = await fetchWebhookVerificationKey(admin, "kid-budget-open", {
      config: {
        plaidEnv: "sandbox",
        clientId: "client",
        secret: "secret",
        dailyLimit: 1,
      },
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    assertEquals(result, { status: "budget_exhausted" });
    assertEquals(fetchCalls, 0);
    assertEquals(names, [
      "keel_consume_webhook_key_response",
      "keel_provider_budget_reserve",
      "keel_meter_provider_call",
    ]);
  });
});

Deno.test("webhook key resolver cache semantics", async (test) => {
  const keys = await makePublicJwk();

  await test.step("fresh cache hit never fetches", async () => {
    const calls: string[] = [];
    const admin = adminWith((name) => {
      calls.push(name);
      return {
        data: {
          jwk: keys.publicJwk,
          notFound: false,
          stale: false,
          fetchedAt: new Date().toISOString(),
          keyExpiredAt: null,
        },
        error: null,
      };
    });
    const resolve = createPlaidWebhookKeyResolver(admin, {
      fetchKey: () => {
        throw new Error("fetch must not run");
      },
    });
    assertEquals((await resolve("kid-key-unit")).jwk, keys.publicJwk);
    assertEquals(calls, ["keel_webhook_key_get"]);
  });

  await test.step("miss fetches, validates/imports, and positive-caches timestamps", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = adminWith((name, args) => {
      calls.push({ name, args });
      if (name === "keel_webhook_key_get") return { data: null, error: null };
      return { data: null, error: null };
    });
    const resolve = createPlaidWebhookKeyResolver(admin, {
      fetchKey: () => Promise.resolve({
        status: "ok" as const,
        key: { ...keys.publicJwk, created_at: 100, expired_at: 200 },
      }),
    });
    assertEquals((await resolve("kid-key-unit")).jwk, {
      ...keys.publicJwk,
      created_at: 100,
      expired_at: 200,
    });
    assertEquals(calls.map((call) => call.name), [
      "keel_webhook_key_get",
      "keel_webhook_key_put_positive",
    ]);
    assertEquals(calls[1]?.args.p_key_created_at, new Date(100_000).toISOString());
    assertEquals(calls[1]?.args.p_key_expired_at, new Date(200_000).toISOString());
  });

  await test.step("invalid kid negative-caches and outage bumps failure", async () => {
    const run = async (status: "invalid_kid" | "outage") => {
      const calls: string[] = [];
      const admin = adminWith((name) => {
        calls.push(name);
        return { data: name === "keel_webhook_key_get" ? null : null, error: null };
      });
      const resolve = createPlaidWebhookKeyResolver(admin, {
        fetchKey: () => Promise.resolve({ status }),
      });
      return { result: await resolve("kid-key-unit"), calls };
    };
    const invalid = await run("invalid_kid");
    assertEquals(invalid.result, { notFound: true });
    assertEquals(invalid.calls, ["keel_webhook_key_get", "keel_webhook_key_put_negative"]);
    const outage = await run("outage");
    assertEquals(outage.result, { outage: true });
    assertEquals(outage.calls, ["keel_webhook_key_get", "keel_webhook_key_bump_failure"]);
  });

  await test.step("stale outage returns bounded-fallback metadata", async () => {
    const cached = {
      jwk: keys.publicJwk,
      notFound: false,
      stale: true,
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      keyExpiredAt: null,
    };
    const calls: string[] = [];
    const admin = adminWith((name) => {
      calls.push(name);
      return { data: name === "keel_webhook_key_get" ? cached : null, error: null };
    });
    const resolve = createPlaidWebhookKeyResolver(admin, {
      fetchKey: () => Promise.resolve({ status: "outage" }),
    });
    assertEquals(await resolve("kid-key-unit"), { ...cached, outage: true });
    assertEquals(calls, ["keel_webhook_key_get", "keel_webhook_key_bump_failure"]);
  });

  await test.step("safe-stale cache hit never fetches or reserves budget", async () => {
    const tokenIat = Math.floor(Date.now() / 1000);
    const cached = {
      jwk: keys.publicJwk,
      notFound: false,
      stale: true,
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      keyExpiredAt: null,
    };
    const calls: string[] = [];
    const admin = adminWith((name) => {
      calls.push(name);
      return { data: name === "keel_webhook_key_get" ? cached : null, error: null };
    });
    const resolve = createPlaidWebhookKeyResolver(admin, {
      fetchKey: () => {
        throw new Error("safe-stale key must not fetch");
      },
    });

    assertEquals(await resolve("kid-key-unit", tokenIat), cached);
    assertEquals(calls, ["keel_webhook_key_get"]);
  });

  await test.step("budget exhaustion never falls back to an unusable stale key", async () => {
    const cached = {
      jwk: keys.publicJwk,
      notFound: false,
      stale: true,
      fetchedAt: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(),
      keyExpiredAt: null,
    };
    const admin = adminWith((name) => ({
      data: name === "keel_webhook_key_get" ? cached : null,
      error: null,
    }));
    const resolve = createPlaidWebhookKeyResolver(admin, {
      fetchKey: () => Promise.resolve({ status: "budget_exhausted" }),
    });

    assertEquals(
      await resolve("kid-key-unit", Math.floor(Date.now() / 1000)),
      { budgetExhausted: true },
    );
  });

  await test.step("stale cache refreshes and returns the fetched positive key", async () => {
    const refreshed = await makePublicJwk("kid-key-unit");
    const calls: string[] = [];
    const admin = adminWith((name) => {
      calls.push(name);
      if (name === "keel_webhook_key_get") {
        return {
          data: {
            jwk: keys.publicJwk,
            notFound: false,
            stale: true,
            fetchedAt: new Date(Date.now() - 60_000).toISOString(),
            keyExpiredAt: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const resolve = createPlaidWebhookKeyResolver(admin, {
      fetchKey: () => Promise.resolve({
        status: "ok",
        key: { ...refreshed.publicJwk, created_at: 100, expired_at: null },
      }),
    });
    const result = await resolve("kid-key-unit");
    assertEquals(result.jwk, { ...refreshed.publicJwk, created_at: 100, expired_at: null });
    assertEquals(calls, ["keel_webhook_key_get", "keel_webhook_key_put_positive"]);
  });

  await test.step("fetched bad shape, private key, or import failure is outage and never cached", async () => {
    for (const key of [
      { ...keys.publicJwk, crv: "P-384", created_at: 100, expired_at: null },
      { ...keys.privateJwk, created_at: 100, expired_at: null },
      { ...keys.publicJwk, x: "!!!!", created_at: 100, expired_at: null },
    ]) {
      const calls: string[] = [];
      const admin = adminWith((name) => {
        calls.push(name);
        return { data: null, error: null };
      });
      const resolve = createPlaidWebhookKeyResolver(admin, {
        fetchKey: () => Promise.resolve({ status: "ok", key }),
      });
      assertEquals((await resolve("kid-key-unit")).outage, true);
      assertEquals(calls.includes("keel_webhook_key_put_positive"), false);
    }
  });
});
