import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./libvirt_vm_pool.ts";

type WriteCall = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

function baseVm(overrides: Record<string, unknown> = {}) {
  return {
    name: "gitea",
    desiredState: "poweredOn",
    ipAddress: "192.0.2.12",
    prefixLength: 24,
    gateway: "192.0.2.1",
    nameserver: "198.51.100.1",
    sshUser: "admin",
    sshPubKeyPath: "~/.ssh/id_ed25519.pub",
    runtimeUsers: [],
    memoryMiB: 2048,
    vcpus: 2,
    diskSizeGb: 20,
    network: "routed",
    imagesDir: "/var/lib/libvirt/images",
    baseImagePath: "/var/lib/libvirt/images/base.qcow2",
    baseImageUrl: "https://example.com/base.qcow2",
    capabilities: ["git"],
    ...overrides,
  };
}

function recordingContext(vms: Array<Record<string, unknown>>) {
  const writes: WriteCall[] = [];
  return {
    writes,
    context: {
      globalArgs: {
        uri: "qemu:///system",
        sshCertificateAuthorities: { host: [], user: [] },
        vms,
      },
      logger: { info: (_message: string) => {} },
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return { kind: "resource", specName, name, version: 1 };
      },
    },
  };
}

async function withFakeVirsh(
  body: string,
  fn: () => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const virsh = `${dir}/virsh`;
  await Deno.writeTextFile(virsh, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(virsh, 0o755);
  const oldPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${oldPath}`);
  try {
    await fn();
  } finally {
    Deno.env.set("PATH", oldPath);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("plan publishes desired actions for a new poweredOn VM without mutating libvirt", async () => {
  await withFakeVirsh("exit 1", async () => {
    const { writes, context } = recordingContext([baseVm()]);

    const result = await model.methods.plan.execute({}, context as never);

    assertEquals(result.dataHandles.length, 2);
    assertEquals(writes.length, 2);
    assertEquals(writes[0].specName, "vm");
    assertEquals(writes[0].name, "gitea");
    assertEquals(writes[0].data.previousState, "absent");
    assertEquals(writes[0].data.currentState, "absent");
    assertEquals(writes[0].data.actions, [
      "ensureImage",
      "define",
      "start",
    ]);
    assertEquals(writes[1].specName, "summary");
    assertEquals(writes[1].data.failed, 0);
  });
});

Deno.test("plan reports destructive cleanup actions for a deleted desired VM", async () => {
  await withFakeVirsh("echo running", async () => {
    const { writes, context } = recordingContext([
      baseVm({ desiredState: "deleted" }),
    ]);

    const result = await model.methods.plan.execute({}, context as never);

    assertEquals(result.dataHandles.length, 2);
    assertEquals(writes[0].data.previousState, "running");
    assertEquals(writes[0].data.actions, [
      "destroy",
      "undefine",
      "removeDisk",
      "removeCloudInitIso",
    ]);
    assertEquals(writes[1].data.actions, [
      "gitea:destroy",
      "gitea:undefine",
      "gitea:removeDisk",
      "gitea:removeCloudInitIso",
    ]);
  });
});
