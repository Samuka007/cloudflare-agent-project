import { describe, expect, it } from "vitest";
import { isPublicHttpsBaseUrl } from "../../src/contract/api/system.js";

/**
 * SEC-W5-003 baseUrl validator: the probe faces decrypt stored credentials
 * onto the row's baseUrl, so only deliberate public https origins are legal.
 * The matrix pins the rejects an attacker would reach for (http downgrades,
 * IP literals and their spellings, single-label and reserved-suffix intranet
 * hosts, userinfo tricks) alongside the shapes real providers use.
 */

describe("#399 isPublicHttpsBaseUrl", () => {
  it("accepts public https origins, explicit ports, and IDNA hosts", () => {
    const accepted = [
      "https://api.anthropic.com",
      "https://api.openai.com/v1",
      "https://upstream.example.com:8443",
      "https://api.deepseek.com/",
      "https://xn--e1afmkfd.xn--p1ai",
      "https://Api.Example.COM./v1",
    ];
    for (const value of accepted) {
      expect(isPublicHttpsBaseUrl(value), value).toBe(true);
    }
  });

  it("rejects non-https schemes, IP literals, and intranet shapes", () => {
    const rejected = [
      "http://api.anthropic.com",
      "ftp://api.anthropic.com",
      "https://192.168.1.1",
      "https://127.0.0.1",
      "https://127.0.0.1:8080",
      "https://[::1]/v1",
      "https://[fe80::1]/v1",
      "https://2130706433",
      "https://intranet",
      "https://localhost",
      "https://localhost:8443",
      "https://panel.local",
      "https://foo.internal",
      "https://box.home.arpa",
      "https://api.test",
      "https://user@api.anthropic.com",
      "https://user:pass@api.anthropic.com",
      "https://",
      "not a url",
      "",
    ];
    for (const value of rejected) {
      expect(isPublicHttpsBaseUrl(value), value).toBe(false);
    }
  });
});
