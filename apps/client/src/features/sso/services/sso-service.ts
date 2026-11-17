import api from "@/lib/api-client.ts";
import { IPagination } from "@/lib/types.ts";
import {
  ICreateSsoProvider,
  ISsoProvider,
  IUpdateSsoProvider,
} from "@/features/sso/types/sso.types.ts";

export async function getSsoProviders(): Promise<IPagination<ISsoProvider>> {
  const req = await api.post<IPagination<ISsoProvider>>("/sso/providers");
  return req.data;
}

export async function getSsoProvider(providerId: string): Promise<ISsoProvider> {
  const req = await api.post<ISsoProvider>("/sso/info", { providerId });
  return req.data;
}

export async function createSsoProvider(
  data: ICreateSsoProvider,
): Promise<ISsoProvider> {
  const req = await api.post<ISsoProvider>("/sso/create", data);
  return req.data;
}

export async function updateSsoProvider(
  data: IUpdateSsoProvider,
): Promise<ISsoProvider> {
  const req = await api.post<ISsoProvider>("/sso/update", data);
  return req.data;
}

export async function deleteSsoProvider(providerId: string): Promise<void> {
  await api.post("/sso/delete", { providerId });
}
