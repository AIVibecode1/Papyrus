import { describe, expect, it } from "vitest";

import { categorizeTestError, redactSecrets, truncateError } from "@/lib/provider-errors";

describe("categorizeTestError", () => {
  it("maps network failures before url mentions inside reqwest messages", () => {
    expect(categorizeTestError("error sending request for url (https://api.example.com)")).toBe(
      "network",
    );
    expect(categorizeTestError("connection timed out after 30000ms")).toBe("network");
    expect(categorizeTestError("dns error: failed to lookup host")).toBe("network");
    expect(categorizeTestError("tls handshake failed")).toBe("network");
    expect(categorizeTestError("connection refused")).toBe("network");
  });

  it("maps authentication and key failures", () => {
    expect(categorizeTestError("HTTP 401 Unauthorized")).toBe("auth");
    expect(categorizeTestError("HTTP 403 Forbidden")).toBe("auth");
    expect(categorizeTestError("invalid api key")).toBe("auth");
    expect(categorizeTestError("API key not found for provider")).toBe("auth");
  });

  it("maps model problems", () => {
    expect(categorizeTestError("model 'gpt-5' not found")).toBe("model");
    expect(categorizeTestError("HTTP 404 model does not exist")).toBe("model");
  });

  it("maps configuration and url problems last", () => {
    expect(categorizeTestError("Invalid provider base url: nope")).toBe("url");
    expect(categorizeTestError("base url must start with https")).toBe("url");
  });

  it("falls back to unknown", () => {
    expect(categorizeTestError("some completely unexpected failure")).toBe("unknown");
  });
});

describe("redactSecrets", () => {
  it("strips token-shaped strings from error text", () => {
    const msg = "bad key sk-abc12345XYZ__more9 for provider";
    const out = redactSecrets(msg);
    expect(out).not.toContain("sk-abc12345XYZ__more9");
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("connection refused")).toBe("connection refused");
  });
});

describe("truncateError", () => {
  it("caps long messages and keeps short ones", () => {
    expect(truncateError("short")).toBe("short");
    const long = "x".repeat(300);
    const out = truncateError(long, 160);
    expect(out.length).toBeLessThan(200);
    expect(out.endsWith("…")).toBe(true);
  });
});
