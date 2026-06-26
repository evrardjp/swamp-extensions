import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./qcow2_overlay_prep.ts";

Deno.test("qcow2-overlay-prep exposes prepare method with safe defaults", () => {
  assertEquals(model.type, "@evrardjp/qcow2-overlay-prep");
  assert("prepare" in model.methods);
  const parsed = model.globalArguments.parse({
    baseImagePath: "/tmp/base.qcow2",
    overlayPath: "/tmp/demo.qcow2",
  });
  assertEquals(parsed.diskSizeGb, 20);
  assertEquals(parsed.baseImageUrl, undefined);
});

Deno.test("qcow2-overlay-prep prepare args default to non-destructive behavior", () => {
  const parsed = model.methods.prepare.arguments.parse({});
  assertEquals(parsed.forceDownload, false);
  assertEquals(parsed.recreateOverlay, false);
});
