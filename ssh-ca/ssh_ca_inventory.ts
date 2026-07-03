/**
 * Inventory report for @evrardjp/ssh-ca OpenSSH CA model instances.
 *
 * The report does not deploy configuration. It summarizes Swamp data so other
 * extensions or humans can consume CA public keys, certificates, and KRLs.
 *
 * @module
 */

type Json = Record<string, unknown>;

type DataMetadata = {
  name?: string;
  version?: number;
  specName?: string;
  tags?: Record<string, string>;
};

type ReportCtx = {
  modelType: string;
  modelId: string;
  definition: { name: string };
  dataRepository: {
    findAllForModel: (
      modelType: string,
      modelId: string,
    ) => Promise<DataMetadata[]>;
    getContent: (
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

function parseJson(bytes: Uint8Array | null): Json | null {
  if (!bytes) return null;
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Json
    : null;
}

async function readData(
  context: ReportCtx,
  item: DataMetadata,
): Promise<Json | null> {
  if (!item.name) return null;
  return await parseJson(
    await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      item.name,
      item.version,
    ),
  );
}

function specName(item: DataMetadata): string {
  return String(item.specName ?? item.tags?.specName ?? "");
}

function esc(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_None._\n";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n") + "\n";
}

/** Model-scope report summarizing SSH CA keys, issued certificates, trust snippets, and revocation lists. */
export const report = {
  name: "@evrardjp/ssh-ca-inventory",
  description:
    "Inventory OpenSSH CA models, certificates, KRLs, and SSH config snippets",
  scope: "model" as const,
  labels: ["ssh", "openssh", "ca", "inventory"],
  execute: async (context: ReportCtx) => {
    const allData = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );
    const caItem = allData.find((item) => item.name === "ca-current") ??
      allData.find((item) => specName(item) === "ca");
    const ca = caItem ? await readData(context, caItem) : null;

    const certificates: Json[] = [];
    const krls: Json[] = [];
    for (const item of allData) {
      if (!item.name) continue;
      const spec = specName(item);
      if (
        spec !== "certificate" && spec !== "keyrevocationlist" &&
        spec !== "revocation"
      ) {
        continue;
      }
      const content = await readData(context, item);
      if (!content) continue;
      const withName = { dataName: item.name, ...content };
      if (spec === "certificate") certificates.push(withName);
      else krls.push(withName);
    }

    const inventory = [{
      modelName: context.definition.name,
      ca,
      certificates,
      krls,
    }];

    const caRows = [[
      esc(context.definition.name),
      esc(ca?.caName),
      esc(ca?.keyAlgorithm),
      esc(ca?.publicKeyFingerprint),
      esc(ca?.publicKey),
    ]];

    const certRows = certificates.map((cert) => [
      esc(context.definition.name),
      esc(cert.certificateType),
      esc(cert.keyId),
      esc(cert.serial),
      esc((cert.principals as unknown[] | undefined)?.join(",")),
      esc(cert.validBefore),
      esc(cert.certificateVaultRef ? "vault" : "data"),
    ]);

    const krlRows = krls.map((krl) => [
      esc(context.definition.name),
      esc(krl.dataName),
      esc(krl.krlFormat),
      esc((String(krl.krlBase64 ?? "")).length),
    ]);

    const config = ca?.publicKey
      ? [
        `# ${context.definition.name}`,
        "# known_hosts @cert-authority example",
        `@cert-authority *.example.local ${ca.publicKey}`,
        "# sshd_config TrustedUserCAKeys file content",
        `${ca.publicKey}`,
        "",
      ].join("\n")
      : "";

    const markdown = [
      "# OpenSSH CA Inventory",
      "",
      "## CA public keys",
      table(
        ["Model", "CA name", "Algorithm", "Fingerprint", "Public key"],
        caRows,
      ),
      "## Active/issued certificates",
      table([
        "Model",
        "Type",
        "Key ID",
        "Serial",
        "Principals",
        "Valid before",
        "Cert stored",
      ], certRows),
      "## KRL / revocation data",
      table(["Model", "Data", "Format", "Base64 bytes"], krlRows),
      "## OpenSSH configuration snippets",
      "```text",
      config.trimEnd(),
      "```",
      "",
    ].join("\n");

    return { markdown, json: { inventory } };
  },
};
