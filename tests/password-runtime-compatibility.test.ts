import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

describe("Cloudflare password KDF compatibility", () => {
  it("accepts the selected scrypt parameters in workerd while documenting the local PBKDF2 difference", async () => {
    const script = `
      import { scrypt } from "node:crypto";

      export default {
        async fetch() {
          let legacyPbkdf2Supported = true;
          try {
            const material = await crypto.subtle.importKey(
              "raw",
              new TextEncoder().encode("Password-42!"),
              "PBKDF2",
              false,
              ["deriveBits"],
            );
            await crypto.subtle.deriveBits(
              {
                name: "PBKDF2",
                hash: "SHA-256",
                salt: new Uint8Array(16),
                iterations: 600000,
              },
              material,
              256,
            );
          } catch {
            legacyPbkdf2Supported = false;
          }

          const derived = await new Promise((resolve, reject) => {
            scrypt(
              "Password-42!",
              new Uint8Array(16),
              32,
              { N: 32768, r: 8, p: 3, maxmem: 67108864 },
              (error, value) => error ? reject(error) : resolve(value),
            );
          });
          return Response.json({
            legacyPbkdf2Supported,
            scryptBytes: derived.byteLength,
          });
        },
      };
    `;
    const miniflare = new Miniflare({
      modules: true,
      script,
      compatibilityDate: "2026-07-28",
      compatibilityFlags: ["nodejs_compat"],
    });

    try {
      const response = await miniflare.dispatchFetch("http://localhost");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        // Local Miniflare accepts this call; the hosted Worker rejects it at
        // its 100,000-iteration production ceiling. This environment mismatch
        // is why the original defect escaped localhost tests.
        legacyPbkdf2Supported: true,
        scryptBytes: 32,
      });
    } finally {
      await miniflare.dispose();
    }
  });
});
