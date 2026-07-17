import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import {
  makeCloudInitIso,
  makeCloudInitUserData,
  model,
} from "./arch_cloud_init.ts";

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
  assertEquals(parsed.pacmanMirrors, [
    "https://archlinux.cu.be/$repo/os/$arch",
    "https://mirror.netcologne.de/archlinux/$repo/os/$arch",
    "https://ftp.halifax.rwth-aachen.de/archlinux/$repo/os/$arch",
  ]);
});

Deno.test("arch-cloud-init validates and renders pacman mirrors", () => {
  const invalid = model.globalArguments.safeParse({
    vmName: "demo",
    hostname: "demo",
    ipAddress: "192.0.2.10/24",
    gateway: "192.0.2.1",
    nameserver: "192.0.2.53",
    pacmanMirrors: [
      "https://mirror.example/$repo/os/$arch\nInclude = /tmp/list",
    ],
  });
  assertEquals(invalid.success, false);

  const userData = makeCloudInitUserData({
    sshUser: "admin",
    sshPubKey: "ssh-ed25519 AAAA test",
    pacmanMirrors: ["https://mirror.example/$repo/os/$arch"],
    extraRuncmd: ["pacman-key --init"],
  });
  assertStringIncludes(
    userData,
    "      Server = https://mirror.example/$repo/os/$arch",
  );
  assertStringIncludes(userData, "  - pacman-key --init");
});

Deno.test("prepare reuses existing image artifacts", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    const globalArgs = model.globalArguments.parse({
      vmName: "demo",
      hostname: "demo",
      ipAddress: "192.0.2.10/24",
      gateway: "192.0.2.1",
      nameserver: "192.0.2.53",
      sshPubKeyPath: `${imagesDir}/id_ed25519.pub`,
      imagesDir,
      baseImagePath: `${imagesDir}/base.qcow2`,
    });
    await Promise.all([
      Deno.writeTextFile(globalArgs.baseImagePath, "base"),
      Deno.writeTextFile(`${imagesDir}/demo.qcow2`, "disk"),
      Deno.writeTextFile(`${imagesDir}/demo-cloud-init.iso`, "iso"),
    ]);
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
    });

    await model.methods.prepare.execute(
      {},
      context as Parameters<typeof model.methods.prepare.execute>[1],
    );

    const prep = getWrittenResources().find((resource) =>
      resource.specName === "prep"
    );
    assertEquals(prep?.data.baseImageDownloaded, false);
    assertEquals(prep?.data.diskCreated, false);
    assertEquals(prep?.data.isoCreated, false);
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
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
