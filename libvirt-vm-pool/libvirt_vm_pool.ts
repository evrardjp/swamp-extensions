import { z } from "npm:zod@4";

// @ts-ignore: Deno global available at bundle runtime
const DenoCmd = Deno.Command;
// @ts-ignore: Deno global available at bundle runtime
const DenoFs = {
  stat: (p: string) => Deno.stat(p),
  open: (p: string, o: Deno.OpenOptions) => Deno.open(p, o),
  writeFile: (p: string, d: Uint8Array) => Deno.writeFile(p, d),
  readTextFile: (p: string) => Deno.readTextFile(p),
  remove: (p: string) => Deno.remove(p),
  makeTempFile: (o: Deno.MakeTempOptions) => Deno.makeTempFile(o),
  env: Deno.env,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeCloudInitIso(files: Array<[string, string]>): Uint8Array {
  const S = 2048;
  const encoded: Array<[Uint8Array, Uint8Array]> = files
    .map(([name, content]) =>
      [enc.encode(name.toUpperCase()), enc.encode(content)] as [
        Uint8Array,
        Uint8Array,
      ]
    )
    .sort((a, b) => dec.decode(a[0]).localeCompare(dec.decode(b[0])));
  let lba = 19;
  const extents: number[] = [];
  for (const [, data] of encoded) {
    extents.push(lba);
    lba += Math.ceil(data.length / S) || 1;
  }
  const u32b = (v: number) =>
    new Uint8Array([
      v & 0xff,
      (v >> 8) & 0xff,
      (v >> 16) & 0xff,
      (v >> 24) & 0xff,
      (v >> 24) & 0xff,
      (v >> 16) & 0xff,
      (v >> 8) & 0xff,
      v & 0xff,
    ]);
  const u16b = (v: number) =>
    new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const dirRecord = (
    nameBytes: Uint8Array,
    isDir: boolean,
    extentLba: number,
    dataLen: number,
  ) => {
    const nl = nameBytes.length;
    const rec = new Uint8Array(33 + nl + (nl % 2 === 0 ? 1 : 0));
    let i = 0;
    rec[i++] = rec.length;
    rec[i++] = 0;
    rec.set(u32b(extentLba), i);
    i += 8;
    rec.set(u32b(dataLen), i);
    i += 8;
    rec[i++] = 126;
    rec[i++] = 6;
    rec[i++] = 17;
    rec[i++] = 0;
    rec[i++] = 0;
    rec[i++] = 0;
    rec[i++] = 0;
    rec[i++] = isDir ? 2 : 0;
    rec[i++] = 0;
    rec[i++] = 0;
    rec.set(u16b(1), i);
    i += 4;
    rec[i++] = nl;
    rec.set(nameBytes, i);
    return rec;
  };
  const dotRec = dirRecord(new Uint8Array([0]), true, 18, S);
  const dotdotRec = dirRecord(new Uint8Array([1]), true, 18, S);
  const rootDir = new Uint8Array(S);
  let doff = 0;
  rootDir.set(dotRec, doff);
  doff += dotRec.length;
  rootDir.set(dotdotRec, doff);
  doff += dotdotRec.length;
  for (let i = 0; i < encoded.length; i++) {
    const rec = dirRecord(
      encoded[i][0],
      false,
      extents[i],
      encoded[i][1].length,
    );
    rootDir.set(rec, doff);
    doff += rec.length;
  }
  const totalSectors = lba;
  const pvd = new Uint8Array(S);
  pvd[0] = 1;
  pvd.set(enc.encode("CD001"), 1);
  pvd[6] = 1;
  pvd.fill(0x20, 8, 40);
  pvd.set(enc.encode("CIDATA"), 40);
  pvd.fill(0x20, 46, 72);
  pvd.set(u32b(totalSectors), 80);
  pvd.set(u16b(1), 120);
  pvd.set(u16b(1), 124);
  pvd.set(u16b(S), 128);
  pvd.set(u32b(0), 132);
  pvd.set(dotRec, 156);
  pvd.fill(0x20, 190, 813);
  const d16 = enc.encode("0000000000000000");
  for (const off of [813, 830, 847, 864]) {
    pvd.set(d16, off);
    pvd[off + 16] = 0;
  }
  pvd[881] = 1;
  const vdst = new Uint8Array(S);
  vdst[0] = 255;
  vdst.set(enc.encode("CD001"), 1);
  vdst[6] = 1;
  const iso = new Uint8Array(totalSectors * S);
  iso.set(pvd, 16 * S);
  iso.set(vdst, 17 * S);
  iso.set(rootDir, 18 * S);
  for (let i = 0; i < encoded.length; i++) {
    iso.set(encoded[i][1], extents[i] * S);
  }
  return iso;
}

const DesiredStateSchema = z.enum([
  "deleted",
  "poweredOff",
  "poweredOn",
]);
const BootstrapSSHUserSchema = z.object({
  username: z.string().default("admin"),
  publicKeyPath: z.string().default("~/.ssh/id_ed25519.pub"),
});

const SshHostCertificateSchema = z.object({
  ca: z.string().min(1),
  principals: z.array(z.string().min(1)).min(1),
  hostKeyPath: z.string().default("/etc/ssh/ssh_host_ed25519_key.pub"),
  hostCertificatePath: z.string().default(
    "/etc/ssh/ssh_host_ed25519_key-cert.pub",
  ),
});

const RuntimeUserSchema = z.object({
  username: z.string().min(1),
  groups: z.array(z.string().min(1)).default([]),
  sshCertificate: z.object({
    ca: z.string().min(1),
    principals: z.array(z.string().min(1)).min(1),
  }).optional(),
});

const SshCertificateAuthoritiesSchema = z.object({
  host: z.array(z.object({
    name: z.string().min(1),
    model: z.string().min(1),
    clientKnownHostsPatterns: z.array(z.string().min(1)).default([]),
  })).default([]),
  user: z.array(z.object({
    name: z.string().min(1),
    model: z.string().min(1),
    trustedUserCAKeysPath: z.string().default("/etc/ssh/lab_user_ca.pub"),
  })).default([]),
}).default({ host: [], user: [] });

const DefaultPacmanMirrors = [
  "https://archlinux.cu.be/$repo/os/$arch",
  "https://mirror.netcologne.de/archlinux/$repo/os/$arch",
  "https://ftp.halifax.rwth-aachen.de/archlinux/$repo/os/$arch",
];
const PacmanMirrorsSchema = z.array(z.string().url()).min(1).default(
  DefaultPacmanMirrors,
);

function pacmanMirrorlist(mirrors: string[]): string {
  return [
    "## Managed by Swamp libvirt-vm-pool cloud-init.",
    "## Prefer Belgian and German Arch Linux mirrors for local lab VMs.",
    ...mirrors.map((mirror) => `Server = ${mirror}`),
    "",
  ].join("\\n");
}

const VmSpecSchema = z.object({
  name: z.string(),
  desiredState: DesiredStateSchema.default("poweredOn"),
  hostname: z.string().optional(),
  fqdn: z.string().optional(),
  serviceFqdn: z.string().optional(),
  ipAddress: z.string().describe(
    "Static IP address without prefix length, e.g. 192.0.2.12",
  ),
  prefixLength: z.number().int().default(24),
  gateway: z.string(),
  nameserver: z.string(),
  // Deprecated compatibility fields. Prefer bootstrapSSHUser.
  sshUser: z.string().default("admin"),
  sshPubKeyPath: z.string().default("~/.ssh/id_ed25519.pub"),
  bootstrapSSHUser: BootstrapSSHUserSchema.optional(),
  sshHostCertificate: SshHostCertificateSchema.optional(),
  runtimeUsers: z.array(RuntimeUserSchema).default([]),
  memoryMiB: z.number().int().default(2048),
  vcpus: z.number().int().default(2),
  diskSizeGb: z.number().int().default(20),
  network: z.string().default("routed"),
  imagesDir: z.string().default("/var/lib/libvirt/images"),
  baseImagePath: z.string().default(
    "/var/lib/libvirt/images/arch-cloud-base.qcow2",
  ),
  baseImageUrl: z.string().default(
    "https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2",
  ),
  pacmanMirrors: PacmanMirrorsSchema.describe(
    "Ordered Arch Linux pacman mirrors written to /etc/pacman.d/mirrorlist during cloud-init",
  ),
  capabilities: z.array(z.string()).default([]),
});
type VmSpec = z.infer<typeof VmSpecSchema>;
const GlobalArgsSchema = z.object({
  uri: z.string().default("qemu:///system"),
  sshCertificateAuthorities: SshCertificateAuthoritiesSchema,
  vms: z.array(VmSpecSchema).min(1),
});
const VmResultSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  fqdn: z.string().optional(),
  serviceFqdn: z.string().optional(),
  desiredState: DesiredStateSchema,
  previousState: z.string(),
  currentState: z.string(),
  ipAddress: z.string(),
  sshUser: z.string(),
  bootstrapSSHUser: BootstrapSSHUserSchema,
  sshHostCertificate: SshHostCertificateSchema.optional(),
  runtimeUsers: z.array(RuntimeUserSchema),
  capabilities: z.array(z.string()),
  diskPath: z.string(),
  isoPath: z.string(),
  changed: z.boolean(),
  actions: z.array(z.string()),
  errors: z.array(z.string()).default([]),
  observedAt: z.string(),
});
const SummarySchema = z.object({
  total: z.number().int(),
  changed: z.number().int(),
  failed: z.number().int(),
  desired: z.record(z.string(), DesiredStateSchema),
  actions: z.array(z.string()),
  syncedAt: z.string(),
});

type PoolContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: { info: (message: string) => void };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

async function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new DenoCmd(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: dec.decode(result.stdout),
    stderr: dec.decode(result.stderr),
  };
}

function vmXml(vm: VmSpec): string {
  const host = vm.hostname ?? vm.name;
  const disk = `${vm.imagesDir}/${vm.name}.qcow2`;
  const iso = `${vm.imagesDir}/${vm.name}-cloud-init.iso`;
  return `<domain type='kvm'>
  <name>${vm.name}</name>
  <memory unit='MiB'>${vm.memoryMiB}</memory>
  <vcpu>${vm.vcpus}</vcpu>
  <os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/></os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough'/>
  <clock offset='utc'/>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='${disk}'/><target dev='vda' bus='virtio'/></disk>
    <disk type='file' device='cdrom'><driver name='qemu' type='raw'/><source file='${iso}'/><target dev='sda' bus='sata'/><readonly/></disk>
    <interface type='network'><source network='${vm.network}'/><model type='virtio'/></interface>
    <serial type='pty'><target type='isa-serial' port='0'/></serial>
    <console type='pty'><target type='serial' port='0'/></console>
    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
  </devices>
  <metadata><swamp:vm-pool xmlns:swamp='https://swamp.local/vm-pool' hostname='${host}'/></metadata>
</domain>`;
}

async function domainState(uri: string, name: string): Promise<string> {
  const r = await run("virsh", ["-c", uri, "domstate", name]);
  if (r.code !== 0) return "absent";
  return r.stdout.trim() || "unknown";
}

async function ensureImage(vm: VmSpec, actions: string[]): Promise<void> {
  const base = await DenoFs.stat(vm.baseImagePath).catch(() => null);
  if (!base) {
    const resp = await fetch(vm.baseImageUrl);
    if (!resp.ok || !resp.body) {
      throw new Error(
        `failed to download ${vm.baseImageUrl}: HTTP ${resp.status}`,
      );
    }
    const file = await DenoFs.open(vm.baseImagePath, {
      write: true,
      create: true,
    });
    try {
      await resp.body.pipeTo(file.writable);
    } catch (err) {
      await DenoFs.remove(vm.baseImagePath).catch(() => {});
      throw err;
    }
    actions.push("downloadBaseImage");
  }
  const diskPath = `${vm.imagesDir}/${vm.name}.qcow2`;
  if (!(await DenoFs.stat(diskPath).catch(() => null))) {
    const r = await run("qemu-img", [
      "create",
      "-f",
      "qcow2",
      "-b",
      vm.baseImagePath,
      "-F",
      "qcow2",
      diskPath,
      `${vm.diskSizeGb}G`,
    ]);
    if (r.code !== 0) {
      throw new Error(
        `qemu-img failed for ${vm.name}: ${r.stderr.slice(-500)}`,
      );
    }
    actions.push("createDisk");
  }
  const isoPath = `${vm.imagesDir}/${vm.name}-cloud-init.iso`;
  if (!(await DenoFs.stat(isoPath).catch(() => null))) {
    const bootstrap = vm.bootstrapSSHUser ?? {
      username: vm.sshUser,
      publicKeyPath: vm.sshPubKeyPath,
    };
    const keyPath = bootstrap.publicKeyPath.replace(
      /^~/,
      DenoFs.env.get("HOME") ?? "",
    );
    const sshPubKey = (await DenoFs.readTextFile(keyPath)).trim();
    const hostname = vm.hostname ?? vm.name;
    const metaData = [
      `instance-id: ${vm.name}-1`,
      `local-hostname: ${hostname}`,
      "",
    ].join("\n");
    const networkConfig = [
      "version: 2",
      "ethernets:",
      "  eth0:",
      `    addresses: [${vm.ipAddress}/${vm.prefixLength}]`,
      `    gateway4: ${vm.gateway}`,
      "    nameservers:",
      `      addresses: [${vm.nameserver}]`,
      "",
    ].join("\n");
    const userData = [
      "#cloud-config",
      "users:",
      `  - name: ${bootstrap.username}`,
      "    sudo: ALL=(ALL) NOPASSWD:ALL",
      "    groups: [wheel]",
      "    shell: /bin/bash",
      "    ssh_authorized_keys:",
      `      - ${sshPubKey}`,
<<<<<<< Updated upstream
=======
      "write_files:",
      "  - path: /etc/pacman.d/mirrorlist",
      "    owner: root:root",
      "    permissions: '0644'",
      "    content: |",
      ...pacmanMirrorlist(vm.pacmanMirrors).split("\n").map((line) =>
        `      ${line}`
      ),
      "bootcmd:",
      "  - systemctl disable --now systemd-time-wait-sync.service || true",
      "  - systemctl mask systemd-time-wait-sync.service || true",
>>>>>>> Stashed changes
      "packages:",
      "  - openssh",
      "  - ca-certificates",
      "  - sudo",
      "runcmd:",
      "  - systemctl enable --now sshd",
      "",
    ].join("\n");
    await DenoFs.writeFile(
      isoPath,
      makeCloudInitIso([["meta-data", metaData], [
        "network-config",
        networkConfig,
      ], ["user-data", userData]]),
    );
    actions.push("createCloudInitIso");
  }
}

async function reconcile(
  vm: VmSpec,
  uri: string,
  apply: boolean,
): Promise<z.infer<typeof VmResultSchema>> {
  const actions: string[] = [];
  const errors: string[] = [];
  const diskPath = `${vm.imagesDir}/${vm.name}.qcow2`;
  const isoPath = `${vm.imagesDir}/${vm.name}-cloud-init.iso`;
  const previousState = await domainState(uri, vm.name);
  try {
    if (vm.desiredState === "deleted") {
      if (previousState !== "absent") {
        actions.push(
          previousState === "running" ? "destroy" : "skipDestroyAlreadyStopped",
          "undefine",
          "removeDisk",
          "removeCloudInitIso",
        );
        if (apply) {
          if (previousState === "running") {
            await run("virsh", ["-c", uri, "destroy", vm.name]);
          }
          await run("virsh", [
            "-c",
            uri,
            "undefine",
            vm.name,
            "--remove-all-storage",
          ]).catch(async () => {
            await run("virsh", ["-c", uri, "undefine", vm.name]);
          });
          await DenoFs.remove(diskPath).catch(() => {});
          await DenoFs.remove(isoPath).catch(() => {});
        }
      }
    } else {
      actions.push("ensureImage");
      if (apply) await ensureImage(vm, actions);
      if (previousState === "absent") {
        actions.push("define");
        if (apply) {
          const xmlPath = await DenoFs.makeTempFile({
            prefix: `${vm.name}-`,
            suffix: ".xml",
          });
          await DenoFs.writeFile(xmlPath, enc.encode(vmXml(vm)));
          const r = await run("virsh", ["-c", uri, "define", xmlPath]);
          await DenoFs.remove(xmlPath).catch(() => {});
          if (r.code !== 0) {
            throw new Error(
              `virsh define failed for ${vm.name}: ${r.stderr.slice(-500)}`,
            );
          }
        }
      } else {
        actions.push("skipDefineAlreadyExists");
      }
      if (vm.desiredState === "poweredOn") {
        actions.push("start");
        if (apply && (await domainState(uri, vm.name)) !== "running") {
          const r = await run("virsh", ["-c", uri, "start", vm.name]);
          if (r.code !== 0 && !r.stderr.includes("already active")) {
            throw new Error(
              `virsh start failed for ${vm.name}: ${r.stderr.slice(-500)}`,
            );
          }
        }
      }
      if (vm.desiredState === "poweredOff") {
        actions.push("stop");
        if (apply && (await domainState(uri, vm.name)) === "running") {
          const r = await run("virsh", ["-c", uri, "shutdown", vm.name]);
          if (r.code !== 0) {
            throw new Error(
              `virsh shutdown failed for ${vm.name}: ${r.stderr.slice(-500)}`,
            );
          }
        }
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const currentState = apply ? await domainState(uri, vm.name) : previousState;
  return {
    name: vm.name,
    hostname: vm.hostname ?? vm.name,
    fqdn: vm.fqdn,
    serviceFqdn: vm.serviceFqdn,
    desiredState: vm.desiredState,
    previousState,
    currentState: vm.desiredState === "deleted" && apply && errors.length === 0
      ? "absent"
      : currentState,
    ipAddress: vm.ipAddress,
    sshUser: vm.bootstrapSSHUser?.username ?? vm.sshUser,
    bootstrapSSHUser: vm.bootstrapSSHUser ?? {
      username: vm.sshUser,
      publicKeyPath: vm.sshPubKeyPath,
    },
    sshHostCertificate: vm.sshHostCertificate,
    runtimeUsers: vm.runtimeUsers,
    capabilities: vm.capabilities,
    diskPath,
    isoPath,
    changed: actions.length > 0 && (apply || previousState !== vm.desiredState),
    actions,
    errors,
    observedAt: new Date().toISOString(),
  };
}

async function executePool(context: PoolContext, apply: boolean) {
  const handles: unknown[] = [];
  const results: Array<z.infer<typeof VmResultSchema>> = [];
  for (const vm of context.globalArgs.vms) {
    context.logger.info(
      `${apply ? "Syncing" : "Planning"} VM ${vm.name} -> ${vm.desiredState}`,
    );
    const result = await reconcile(vm, context.globalArgs.uri, apply);
    results.push(result);
    handles.push(await context.writeResource("vm", vm.name, result));
  }
  const summary = {
    total: results.length,
    changed: results.filter((r) => r.changed).length,
    failed: results.filter((r) => r.errors.length > 0).length,
    desired: Object.fromEntries(results.map((r) => [r.name, r.desiredState])),
    actions: results.flatMap((r) => r.actions.map((a) => `${r.name}:${a}`)),
    syncedAt: new Date().toISOString(),
  };
  handles.push(await context.writeResource("summary", "current", summary));
  if (summary.failed > 0) {
    throw new Error(
      `VM pool ${apply ? "sync" : "plan"} had ${summary.failed} failed VM(s)`,
    );
  }
  return { dataHandles: handles };
}

/** Desired-state reconciler for a local libvirt VM pool. Produces per-VM Swamp data for downstream SSH/config models. */
export const model = {
  type: "@evrardjp/libvirt-vm-pool",
<<<<<<< Updated upstream
  version: "2026.07.03.1",
=======
  version: "2026.07.17.2",
>>>>>>> Stashed changes
  globalArguments: GlobalArgsSchema,
  resources: {
    vm: {
      description: "Observed and desired state for one VM in the pool",
      schema: VmResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Summary of a VM pool reconcile run",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    plan: {
      description:
        "Compute desired vs observed VM state and write data without changing libvirt",
      arguments: z.object({}),
      execute: (_args: Record<string, never>, context: PoolContext) =>
        executePool(context, false),
    },
    sync: {
      description:
        "Reconcile all VMs to their desired state and write one data resource per VM",
      arguments: z.object({}),
      execute: (_args: Record<string, never>, context: PoolContext) =>
        executePool(context, true),
    },
  },
};
