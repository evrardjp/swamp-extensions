import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./capability_caddy_sites.ts";

Deno.test("capability-caddy-sites exposes its catalog adapter", () => {
  assertEquals(model.type, "@evrardjp/capability-caddy-sites");
  assert("render" in model.methods);
});

Deno.test("capability-caddy-sites applies catalog defaults", () => {
  const parsed = model.methods.render.arguments.parse({});
  assertEquals(parsed.catalogModelName, "lab-capability-catalog");
  assertEquals(parsed.capabilities, []);
  assertEquals(parsed.vm, {});
});
