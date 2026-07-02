import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./ssh_ca_inventory.ts";

const encoder = new TextEncoder();

Deno.test("ssh-ca inventory report summarizes CA, certificates, and KRLs", async () => {
  const contents = new Map<string, Record<string, unknown>>([
    ["ca-current", {
      caName: "lab-ca",
      keyAlgorithm: "ed25519",
      publicKeyFingerprint: "SHA256:test",
      publicKey: "ssh-ed25519 AAAATEST lab-ca",
    }],
    ["cert-host", {
      certificateType: "host",
      keyId: "host-1",
      serial: 42,
      principals: ["host.local"],
      validBefore: "2026-08-01T00:00:00.000Z",
      certificateVaultRef: "${{ vault.get('v', 'cert') }}",
    }],
    ["krl-current", {
      krlFormat: "openssh-krl",
      krlBase64: "YWJjZA==",
    }],
  ]);

  const result = await report.execute({
    modelType: "@evrardjp/ssh-ca",
    modelId: "model-1",
    definition: { name: "local-ssh-ca" },
    dataRepository: {
      findAllForModel: async () => [
        { name: "ca-current", version: 1, specName: "ca" },
        { name: "cert-host", version: 1, tags: { specName: "certificate" } },
        { name: "krl-current", version: 1, specName: "keyrevocationlist" },
      ],
      getContent: async (_modelType, _modelId, dataName) => {
        const content = contents.get(dataName);
        return content ? encoder.encode(JSON.stringify(content)) : null;
      },
    },
  });

  assertStringIncludes(result.markdown, "# OpenSSH CA Inventory");
  assertStringIncludes(result.markdown, "local-ssh-ca");
  assertStringIncludes(result.markdown, "host-1");
  assertStringIncludes(result.markdown, "@cert-authority *.example.local");
  const inventory = result.json.inventory as Array<Record<string, unknown>>;
  assertEquals(inventory.length, 1);
  assertEquals(inventory[0].modelName, "local-ssh-ca");
});

Deno.test("ssh-ca inventory report handles models without CA data", async () => {
  const result = await report.execute({
    modelType: "@evrardjp/ssh-ca",
    modelId: "model-1",
    definition: { name: "empty-ca" },
    dataRepository: {
      findAllForModel: async () => [],
      getContent: async () => null,
    },
  });

  assertStringIncludes(result.markdown, "empty-ca");
  assertStringIncludes(result.markdown, "_None._");
  const inventory = result.json.inventory as Array<Record<string, unknown>>;
  assertEquals(inventory[0].ca, null);
});
