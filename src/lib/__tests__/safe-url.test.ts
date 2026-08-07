// Plan 071: markdown link scheme allowlist. AI output and user notes
// are untrusted; only absolute http(s) URLs may reach the OS opener.
import { describe, expect, it } from "vitest";

import { isSafeOpenUrl } from "@/lib/safe-url";

describe("isSafeOpenUrl", () => {
  it("allows http and https (case-insensitive scheme)", () => {
    expect(isSafeOpenUrl("https://arxiv.org/abs/2607.00001")).toBe(true);
    expect(isSafeOpenUrl("http://localhost:3000")).toBe(true);
    expect(isSafeOpenUrl("HTTP://EXAMPLE.COM/x")).toBe(true);
    expect(isSafeOpenUrl("  https://arxiv.org/x  ")).toBe(true);
  });

  it("rejects script and data carriers", () => {
    expect(isSafeOpenUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeOpenUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeOpenUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects file and local schemes", () => {
    expect(isSafeOpenUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeOpenUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeOpenUrl("blob:https://example.com/id")).toBe(false);
    expect(isSafeOpenUrl("mailto:user@example.com")).toBe(false);
  });

  it("rejects empty, relative and protocol-relative URLs", () => {
    expect(isSafeOpenUrl("")).toBe(false);
    expect(isSafeOpenUrl("   ")).toBe(false);
    expect(isSafeOpenUrl("papers/2607.00001")).toBe(false);
    expect(isSafeOpenUrl("/abs/2607.00001")).toBe(false);
    expect(isSafeOpenUrl("//example.com/path")).toBe(false);
  });
});
