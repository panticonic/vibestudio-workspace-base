import {
  DurableObjectBase,
  schemaRpc,
  type DurableObjectContext,
} from "@workspace/runtime/worker/kernel";
import {
  PhoneDeviceDiscoverySchema,
  PhoneProviderSchema,
  PhoneProvisioningResultSchema,
  phoneProvisioningMethods,
  type PhoneDeviceDiscovery,
  type PhoneProvider,
  type PhoneProvisionArgs,
  type PhoneProvisioningResult,
} from "@vibestudio/service-schemas/phoneProvisioning";
import type { PhoneNativeDesktop } from "@vibestudio/service-schemas/phoneNativeEndpoint";

/** Userland policy over the exact provider-only native phone endpoint. */
export class PhoneProvisioningDO extends DurableObjectBase {
  static override rpcMethods = phoneProvisioningMethods;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected createTables(): void {}

  @schemaRpc()
  async providers(): Promise<PhoneProvider[]> {
    const desktops = await this.desktops();
    const available: PhoneProvider[] = [];
    const failures: string[] = [];
    for (const desktop of desktops) {
      try {
        const local = PhoneProviderSchema.array().parse(
          await this.rpc.call("main", "phoneNativeEndpoint.providers", [
            { clientId: desktop.clientId },
          ]),
        );
        for (const provider of local) {
          available.push({
            ...provider,
            providerId: desktop.clientId,
            label: desktop.label ?? provider.label,
          });
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (
      desktops.length > 0 &&
      available.length === 0 &&
      failures.length === desktops.length
    ) {
      throw new Error(
        `Connected desktop provider failed: ${failures.join("; ")}`,
      );
    }
    return available;
  }

  @schemaRpc()
  async devices(query?: {
    providerId?: string;
    platform?: "android" | "ios";
  }): Promise<PhoneDeviceDiscovery> {
    const targets = query?.providerId
      ? [await this.select(query.providerId)]
      : await this.desktops();
    const devices: PhoneDeviceDiscovery["devices"] = [];
    const issues: PhoneDeviceDiscovery["issues"] = [];
    for (const target of targets) {
      try {
        const local = PhoneDeviceDiscoverySchema.parse(
          await this.rpc.call("main", "phoneNativeEndpoint.devices", [
            {
              clientId: target.clientId,
              query: query ? { ...query, providerId: undefined } : undefined,
            },
          ]),
        );
        devices.push(
          ...local.devices.map((device) => ({
            ...device,
            providerId: target.clientId,
          })),
        );
        issues.push(
          ...local.issues.map((issue) => ({
            ...issue,
            providerId: target.clientId,
          })),
        );
      } catch (error) {
        issues.push({
          providerId: target.clientId,
          code: "desktop-unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { devices, issues };
  }

  @schemaRpc()
  async provision(input: PhoneProvisionArgs): Promise<PhoneProvisioningResult> {
    const target = await this.select(input.providerId);
    const result = await this.rpc.call(
      "main",
      "phoneNativeEndpoint.provision",
      [
        {
          clientId: target.clientId,
          input: { ...input, providerId: undefined },
        },
      ],
    );
    return PhoneProvisioningResultSchema.parse({
      ...(result as object),
      providerId: target.clientId,
    });
  }

  private async desktops(): Promise<PhoneNativeDesktop[]> {
    this.requireUser();
    const endpoints = await this.rpc.call<PhoneNativeDesktop[]>(
      "main",
      "phoneNativeEndpoint.desktops",
      [],
    );
    return endpoints;
  }

  private async select(providerId?: string): Promise<PhoneNativeDesktop> {
    const available = await this.desktops();
    if (providerId) {
      const selected = available.find(
        (endpoint) => endpoint.clientId === providerId,
      );
      if (!selected)
        throw new Error("The selected desktop provider is no longer connected");
      return selected;
    }
    if (available.length === 0) {
      throw new Error(
        "No desktop for this account is connected to the current server",
      );
    }
    if (available.length > 1) {
      throw new Error(
        "More than one desktop is connected; choose a phone provider first",
      );
    }
    return available[0]!;
  }

  private requireUser(): void {
    const userId = this.caller?.userId;
    if (!userId || userId === "system") {
      throw new Error(
        "Phone provisioning requires an authenticated user account",
      );
    }
  }
}
