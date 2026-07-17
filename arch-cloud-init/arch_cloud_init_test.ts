import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";
import {
  createModelTestContext,
  withMockedCommand,
  withMockedFetch,
} from "jsr:@systeminit/swamp-testing@0.20260518.13";
import {
  makeCloudInitIso,
  makeCloudInitMetaData,
  makeCloudInitNetworkConfig,
  makeCloudInitUserData,
  model,
} from "./arch_cloud_init.ts";

function globalArgs(
  imagesDir: string,
  overrides: Record<string, unknown> = {},
) {
  return model.globalArguments.parse({
    vmName: "demo",
    hostname: "demo",
    ipAddress: "192.0.2.10/24",
    gateway: "192.0.2.1",
    nameserver: "192.0.2.53",
    sshPubKeyPath: `${imagesDir}/id_ed25519.pub`,
    imagesDir,
    baseImagePath: `${imagesDir}/base.qcow2`,
    ...overrides,
  });
}

function sshWireString(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(4 + value.length);
  new DataView(result.buffer).setUint32(0, value.length);
  result.set(value, 4);
  return result;
}

function publicKey(comment = ""): string {
  const type = new TextEncoder().encode("ssh-ed25519");
  const key = new Uint8Array(32).fill(7);
  const typeField = sshWireString(type);
  const keyField = sshWireString(key);
  const blob = new Uint8Array(typeField.length + keyField.length);
  blob.set(typeField);
  blob.set(keyField, typeField.length);
  const encoded = btoa(String.fromCharCode(...blob));
  return `ssh-ed25519 ${encoded}${comment ? ` ${comment}` : ""}`;
}

async function mockCommand(command: string, args: string[]) {
  assertEquals(command === "qemu-img" || command === "setfacl", true);
  if (command === "qemu-img" && args[0] === "create") {
    await Deno.writeTextFile(args.at(-2)!, "mock qcow2");
  }
  if (command === "qemu-img" && args[0] === "info") {
    const path = args.at(-1)!;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const parent = path.slice(0, path.lastIndexOf("/"));
    const info = name.startsWith("demo.qcow2")
      ? {
        format: "qcow2",
        "backing-filename": `${parent}/base.qcow2`,
        "full-backing-filename": `${parent}/base.qcow2`,
        "virtual-size": 20 * 1024 ** 3,
      }
      : { format: "qcow2", "virtual-size": 2 * 1024 ** 3 };
    return { stdout: JSON.stringify(info), code: 0 };
  }
  return { stdout: "ok", code: 0 };
}

function mockCommandWithOverlayInfo(overlayInfo: Record<string, unknown>) {
  return async (command: string, args: string[]) => {
    if (command === "qemu-img" && args[0] === "info") {
      const path = args.at(-1)!;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name.startsWith("demo.qcow2")) {
        return {
          stdout: JSON.stringify({ format: "qcow2", ...overlayInfo }),
          code: 0,
        };
      }
    }
    return await mockCommand(command, args);
  };
}

async function executePrepare(
  args: ReturnType<typeof globalArgs>,
  context = createModelTestContext({ globalArgs: args }),
) {
  await model.methods.prepare.execute(
    {},
    context.context as Parameters<typeof model.methods.prepare.execute>[1],
  );
  return context;
}

async function writeReusableArtifacts(imagesDir: string) {
  await Promise.all([
    Deno.writeTextFile(
      `${imagesDir}/id_ed25519.pub`,
      publicKey("workstation: primary # key"),
    ),
    Deno.writeTextFile(`${imagesDir}/base.qcow2`, "base"),
    Deno.writeTextFile(`${imagesDir}/demo.qcow2`, "disk"),
    Deno.writeFile(
      `${imagesDir}/demo-cloud-init.iso`,
      makeCloudInitIso([
        ["meta-data", "instance-id: demo\n"],
        ["user-data", "#cloud-config\n"],
        ["network-config", "version: 2\n"],
      ]),
    ),
  ]);
}

Deno.test("arch-cloud-init exposes defaults and rejects unsafe arguments", () => {
  const parsed = model.globalArguments.parse({
    vmName: "demo",
    hostname: "demo",
    ipAddress: "192.0.2.10/24",
    gateway: "192.0.2.1",
    nameserver: "192.0.2.53",
  });
  assertEquals(model.type, "@evrardjp/arch-cloud-init");
  assert("prepare" in model.methods);
  assertEquals(parsed.extraRuncmd, []);
  assertEquals(parsed.sshUser, "admin");
  assertEquals(parsed.networkInterfaceMatch, "en*");
  assertEquals(parsed.pacmanMirrors.length, 3);

  for (
    const invalid of [
      { vmName: "../demo" },
      { hostname: "demo..example" },
      { ipAddress: "192.0.2.10" },
      { gateway: "not-an-ip" },
      { gateway: "2001:db8::1" },
      { diskSizeGb: 0 },
      { baseImageUrl: "file:///tmp/image" },
      { networkInterfaceMatch: "en*\neth0" },
    ]
  ) {
    assertEquals(
      model.globalArguments.safeParse({
        vmName: "demo",
        hostname: "demo",
        ipAddress: "192.0.2.10/24",
        gateway: "192.0.2.1",
        nameserver: "192.0.2.53",
        ...invalid,
      }).success,
      false,
    );
  }
});

Deno.test("cloud-init documents preserve YAML-sensitive scalar values", () => {
  const sshKey = publicKey("workstation: primary # trusted");
  const command = "printf 'value: # literal\nsecond line'";
  const userData = parseYaml(makeCloudInitUserData({
    sshUser: "admin",
    sshPubKey: sshKey,
    pacmanMirrors: ["https://mirror.example/$repo/os/$arch#primary"],
    extraRuncmd: [command],
  })) as {
    users: Array<{ name: string; ssh_authorized_keys: string[] }>;
    write_files: Array<{ content: string }>;
    runcmd: string[];
  };
  assertEquals(userData.users[0].name, "admin");
  assertEquals(userData.users[0].ssh_authorized_keys[0], sshKey);
  assertEquals(userData.runcmd[1], command);
  assertStringIncludes(
    userData.write_files[0].content,
    "https://mirror.example/$repo/os/$arch#primary",
  );

  const metaData = parseYaml(
    makeCloudInitMetaData("demo", "host: # literal\nsecond"),
  ) as Record<string, string>;
  assertEquals(metaData["local-hostname"], "host: # literal\nsecond");

  const network = parseYaml(makeCloudInitNetworkConfig({
    interfaceMatch: "en*",
    ipAddress: "2001:db8::10/64",
    gateway: "2001:db8::1",
    nameserver: "2001:4860:4860::8888",
  })) as {
    ethernets: {
      primary: {
        match: { name: string };
        addresses: string[];
        routes: Array<{ to: string; via: string }>;
      };
    };
  };
  assertEquals(network.ethernets.primary.match.name, "en*");
  assertEquals(network.ethernets.primary.addresses[0], "2001:db8::10/64");
  assertEquals(network.ethernets.primary.routes[0], {
    to: "default",
    via: "2001:db8::1",
  });
});

Deno.test("prepare validates and reuses existing image artifacts", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    await writeReusableArtifacts(imagesDir);
    const args = globalArgs(imagesDir);
    const { result, calls } = await withMockedCommand(
      mockCommand,
      () => executePrepare(args),
    );
    const prep = result.getWrittenResources().find((resource) =>
      resource.specName === "prep"
    );
    assertEquals(prep?.data.baseImageDownloaded, false);
    assertEquals(prep?.data.diskCreated, false);
    assertEquals(prep?.data.isoCreated, false);
    assertEquals(calls.filter((call) => call.args[0] === "info").length, 2);
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare downloads and atomically creates all artifacts", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${imagesDir}/id_ed25519.pub`,
      publicKey("test: key # comment"),
    );
    const args = globalArgs(imagesDir, {
      baseImageUrl: "https://example.test/image?token=hidden&secret=value",
      extraRuncmd: ["printf 'a: # b'"],
    });
    const { result: commandResult } = await withMockedCommand(
      mockCommand,
      () =>
        withMockedFetch(
          () => new Response("downloaded qcow2"),
          () => executePrepare(args),
        ),
    );
    const context = commandResult.result;
    const prep = context.getWrittenResources()[0].data;
    assertEquals(prep.baseImageDownloaded, true);
    assertEquals(prep.diskCreated, true);
    assertEquals(prep.isoCreated, true);
    assertEquals((await Deno.stat(args.baseImagePath)).size > 0, true);
    assertEquals((await Deno.stat(`${imagesDir}/demo.qcow2`)).size > 0, true);
    assertEquals(
      (await Deno.stat(`${imagesDir}/demo-cloud-init.iso`)).size > 0,
      true,
    );
    const entries = [];
    for await (const entry of Deno.readDir(imagesDir)) entries.push(entry.name);
    assertEquals(entries.some((name) => name.endsWith(".tmp")), false);
    assertEquals(
      context.getLogs().some((entry) => entry.message.includes("secret")),
      false,
    );
    assertEquals(
      context.getLogs().some((entry) => entry.message.includes("token=")),
      false,
    );
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare removes only its temporary download after stream failure", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${imagesDir}/id_ed25519.pub`,
      publicKey("test"),
    );
    const args = globalArgs(imagesDir, {
      baseImageUrl: "https://example.test/image?token=hidden",
    });
    const context = createModelTestContext({ globalArgs: args });
    await assertRejects(
      () =>
        withMockedCommand(mockCommand, () =>
          withMockedFetch(
            () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("partial"));
                    controller.error(new Error("interrupted"));
                  },
                }),
              ),
            () => executePrepare(args, context),
          )),
      Error,
      "interrupted",
    );
    await assertRejects(
      () => Deno.stat(args.baseImagePath),
      Deno.errors.NotFound,
    );
    const entries = [];
    for await (const entry of Deno.readDir(imagesDir)) entries.push(entry.name);
    assertEquals(entries.some((name) => name.endsWith(".tmp")), false);
    assertEquals(context.getWrittenFiles().length, 1);
    const logText = new TextDecoder().decode(
      context.getWrittenFiles()[0].content,
    );
    assertStringIncludes(logText, "ERROR: interrupted");
    assertEquals(logText.includes("token=hidden"), false);
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare rejects invalid existing artifacts before mutation", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    await Promise.all([
      Deno.writeTextFile(
        `${imagesDir}/id_ed25519.pub`,
        publicKey("test"),
      ),
      Deno.writeTextFile(`${imagesDir}/base.qcow2`, ""),
    ]);
    const args = globalArgs(imagesDir);
    const context = createModelTestContext({ globalArgs: args });
    await assertRejects(
      () => executePrepare(args, context),
      Error,
      "regular non-empty file",
    );
    assertEquals((await Deno.stat(args.baseImagePath)).size, 0);
    assertEquals(context.getWrittenResources().length, 0);
    assertEquals(context.getWrittenFiles().length, 1);
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare rejects overlays with invalid backing metadata or size", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    await writeReusableArtifacts(imagesDir);
    const args = globalArgs(imagesDir);
    const cases = [
      {
        info: {
          "backing-filename": `${imagesDir}/wrong-base.qcow2`,
          "full-backing-filename": `${imagesDir}/wrong-base.qcow2`,
          "virtual-size": 20 * 1024 ** 3,
        },
        message: "does not match configured base image",
      },
      {
        info: { "virtual-size": 20 * 1024 ** 3 },
        message: "has no backing image",
      },
      {
        info: {
          "backing-filename": args.baseImagePath,
          "full-backing-filename": args.baseImagePath,
          "virtual-size": 19 * 1024 ** 3,
        },
        message: "virtual size must be at least 20 GiB",
      },
    ];
    for (const testCase of cases) {
      await assertRejects(
        () =>
          withMockedCommand(
            mockCommandWithOverlayInfo(testCase.info),
            () => executePrepare(args),
          ),
        Error,
        testCase.message,
      );
    }
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare passes the canonical base path to qemu-img", async () => {
  const imagesDir = await Deno.makeTempDir({
    dir: ".",
    prefix: "arch-cloud-init-relative-",
  });
  try {
    await Promise.all([
      Deno.writeTextFile(`${imagesDir}/id_ed25519.pub`, publicKey("test")),
      Deno.writeTextFile(`${imagesDir}/base.qcow2`, "base"),
    ]);
    const args = globalArgs(imagesDir);
    assertEquals(args.baseImagePath.startsWith("/"), false);
    const { calls } = await withMockedCommand(
      mockCommand,
      () => executePrepare(args),
    );
    const create = calls.find((call) => call.args[0] === "create");
    assert(create);
    const backingIndex = create.args.indexOf("-b") + 1;
    assertEquals(
      create.args[backingIndex],
      await Deno.realPath(args.baseImagePath),
    );
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare rejects malformed OpenSSH public keys", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    const typeOnly = sshWireString(new TextEncoder().encode("ssh-ed25519"));
    const validKey = publicKey();
    const cases = [
      "not-a-key AAAA",
      "ssh-ed25519 AAAA",
      `ssh-rsa ${validKey.split(" ")[1]}`,
      `ssh-ed25519 ${btoa(String.fromCharCode(...typeOnly))}`,
    ];
    for (const invalidKey of cases) {
      await Deno.writeTextFile(`${imagesDir}/id_ed25519.pub`, invalidKey);
      await assertRejects(
        () => executePrepare(globalArgs(imagesDir)),
        Error,
        "one valid OpenSSH public-key line",
      );
    }
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare rejects dot-segment artifact path collisions", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${imagesDir}/id_ed25519.pub`,
      publicKey("test"),
    );
    const args = globalArgs(imagesDir, {
      baseImagePath: `${imagesDir}/./demo.qcow2`,
    });
    await assertRejects(
      () => executePrepare(args),
      Error,
      "must resolve to distinct files",
    );
  } finally {
    await Deno.remove(imagesDir, { recursive: true });
  }
});

Deno.test("prepare rejects symlinked-parent artifact path collisions", async () => {
  const root = await Deno.makeTempDir();
  try {
    const realImagesDir = `${root}/images`;
    const linkedImagesDir = `${root}/images-link`;
    await Deno.mkdir(realImagesDir);
    await Deno.symlink(realImagesDir, linkedImagesDir);
    await Deno.writeTextFile(
      `${realImagesDir}/id_ed25519.pub`,
      publicKey("test"),
    );
    const args = globalArgs(linkedImagesDir, {
      baseImagePath: `${realImagesDir}/demo.qcow2`,
    });
    await assertRejects(
      () => executePrepare(args),
      Error,
      "must resolve to distinct files",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("concurrent prepare runs publish one complete artifact set", async () => {
  const imagesDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${imagesDir}/id_ed25519.pub`,
      publicKey("test"),
    );
    const args = globalArgs(imagesDir);
    const first = createModelTestContext({ globalArgs: args });
    const second = createModelTestContext({ globalArgs: args });
    await withMockedCommand(mockCommand, () =>
      withMockedFetch(
        () => new Response("downloaded qcow2"),
        () =>
          Promise.all([
            executePrepare(args, first),
            executePrepare(args, second),
          ]),
      ));

    const firstPrep = first.getWrittenResources()[0].data;
    const secondPrep = second.getWrittenResources()[0].data;
    for (const field of ["baseImageDownloaded", "diskCreated", "isoCreated"]) {
      assertEquals(Number(firstPrep[field]) + Number(secondPrep[field]), 1);
    }
    const entries = [];
    for await (const entry of Deno.readDir(imagesDir)) entries.push(entry.name);
    assertEquals(entries.some((name) => name.endsWith(".tmp")), false);
    assertEquals((await Deno.stat(args.baseImagePath)).size > 0, true);
    assertEquals((await Deno.stat(`${imagesDir}/demo.qcow2`)).size > 0, true);
    assertEquals(
      (await Deno.stat(`${imagesDir}/demo-cloud-init.iso`)).size > 0,
      true,
    );
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
  assertEquals(iso.length, 64 * 2048);
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
