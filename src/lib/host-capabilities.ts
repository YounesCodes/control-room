import type { HostCapabilities } from "../types";

export interface HostCapabilitiesApi {
  cachedCapabilities(connectionId: string): Promise<HostCapabilities | null>;
  refreshCapabilities(connectionId: string): Promise<HostCapabilities>;
}

export async function detectHostCapabilities(
  capabilitiesApi: HostCapabilitiesApi,
  connectionId: string,
): Promise<HostCapabilities> {
  const cached = await capabilitiesApi.cachedCapabilities(connectionId);
  return cached ?? capabilitiesApi.refreshCapabilities(connectionId);
}
