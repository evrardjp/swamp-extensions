import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { makeNoCloudIso, model } from "./cloud_init_nocloud.ts";

Deno.test("makeNoCloudIso creates a CIDATA ISO with NoCloud files", () => {
  const iso = makeNoCloudIso([
    ["meta-data", "instance-id: test\n"],
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

  const text = new TextDecoder().decode(iso);
  assert(text.includes("META-DATA"));
  assert(text.includes("USER-DATA"));
  assert(text.includes("NETWORK-CONFIG"));
  assert(text.includes("#cloud-config"));
});

Deno.test("makeNoCloudIso rejects duplicate file names", () => {
  assertRejects(
    async () => {
      makeNoCloudIso([
        ["meta-data", "a"],
        ["META-DATA", "b"],
      ]);
    },
    Error,
    "Duplicate ISO filename",
  );
});

Deno.test("generate writes Swamp file, summary, and optional host output", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".iso" });
  await Deno.remove(tempPath);
  const writes: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [];
  let fileBytes: Uint8Array | undefined;

  const result = await model.methods.generate.execute(
    {
      userData: "#cloud-config\nusers: []\n",
      instanceId: "unit-test-1",
      localHostname: "unit-test",
      outputPath: tempPath,
      overwrite: false,
    },
    {
      globalArgs: { defaultInstanceId: "default-test" },
      createFileWriter: (specName: string, instanceName: string) => {
        assertEquals(specName, "iso");
        assertEquals(instanceName, "seed");
        return {
          writeAll: (content: Uint8Array) => {
            fileBytes = content;
            return Promise.resolve({ name: "iso-seed" });
          },
        };
      },
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return Promise.resolve({ name });
      },
      logger: { info: () => {} },
    },
  );

  assertEquals(result.dataHandles.length, 2);
  assert(fileBytes && fileBytes.length > 0);
  assertEquals(await Deno.readFile(tempPath), fileBytes);
  assertEquals(writes[0].specName, "isoSummary");
  assertEquals(writes[0].name, "current");
  assertEquals(writes[0].data.files, ["meta-data", "user-data"]);
  assertEquals(writes[0].data.wroteOutputPath, true);
  await Deno.remove(tempPath);
});

Deno.test("generate rejects missing user-data before writing outputs", async () => {
  let wrote = false;
  await assertRejects(
    () =>
      model.methods.generate.execute(
        { overwrite: false },
        {
          globalArgs: { defaultInstanceId: "default-test" },
          createFileWriter: () => ({
            writeAll: () => {
              wrote = true;
              return Promise.resolve({ name: "iso-seed" });
            },
          }),
          writeResource: () => {
            wrote = true;
            return Promise.resolve({ name: "current" });
          },
          logger: { info: () => {} },
        },
      ),
    Error,
    "userData is required",
  );
  assertEquals(wrote, false);
});
