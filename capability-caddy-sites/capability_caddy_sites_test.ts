import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@systeminit/swamp-testing@0.20260518.13";
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

Deno.test("render fails when a requested capability cannot be read", async () => {
  const context = createModelTestContext({ globalArgs: {} });
  const error = await assertRejects(
    () =>
      withMockedCommand(
        (command, args) => {
          assertEquals(command, "swamp");
          assertEquals(args, [
            "data",
            "get",
            "test-catalog",
            "missing-capability",
            "--json",
          ]);
          return Promise.resolve({
            stdout: "",
            stderr: "resource not found",
            code: 1,
          });
        },
        () =>
          model.methods.render.execute(
            {
              catalogModelName: "test-catalog",
              capabilities: ["missing-capability"],
              vm: {},
            },
            context.context,
          ),
      ),
  );
  assert(error instanceof Error);
  assertStringIncludes(error.message, "missing-capability");
  assertStringIncludes(error.message, "swamp data get exited with code 1");
  assertStringIncludes(error.message, "resource not found");
  assertEquals(context.getWrittenResources(), []);
});
