import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeCloudInitIso, model } from "./arch_cloud_init.ts";

Deno.test("arch-cloud-init exposes prepare method and new convenience args", () => {
  assertEquals(model.type, "@evrardjp/arch-cloud-init");
  assert("prepare" in model.methods);
  const parsed = model.globalArguments.parse({
    vmName: "demo",
    hostname: "demo",
    ipAddress: "192.0.2.10/24",
    gateway: "192.0.2.1",
    nameserver: "192.0.2.53",
  });
  assertEquals(parsed.extraRuncmd, []);
  assertEquals(parsed.sshUser, "admin");
});

Deno.test("makeCloudInitIso creates CIDATA ISO bytes", () => {
  const iso = makeCloudInitIso([
    ["meta-data", "instance-id: demo\n"],
    ["user-data", "#cloud-config\n"],
    ["network-config", "version: 2\n"],
  ]);
  assertEquals(iso.length % 2048, 0);
  assertEquals(
    new TextDecoder().decode(iso.slice(16 * 2048 + 1, 16 * 2048 + 6)),
    "CD001",
  );
  assertEquals(
    new TextDecoder().decode(iso.slice(16 * 2048 + 40, 16 * 2048 + 46)),
    "CIDATA",
  );
});
