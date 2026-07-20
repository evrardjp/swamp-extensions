import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./caddy.ts";

Deno.test("caddy exposes render, validation, and apply methods", () => {
  assertEquals(model.type, "@evrardjp/caddy");
  for (
    const method of [
      "renderReverseProxy",
      "validateConfig",
      "applyConfig",
      "applyReverseProxy",
    ]
  ) {
    assert(method in model.methods);
  }
});

Deno.test("caddy requires explicit upstream TLS verification behavior", () => {
  const parsed = model.methods.renderReverseProxy.arguments.parse({
    sites: [{
      address: "example.test",
      reverseProxy: {
        upstreams: ["https://127.0.0.1:8200"],
        transport: { tlsInsecureSkipVerify: false },
      },
    }],
  });
  assertEquals(parsed.sites[0].tls, "internal");
});
