import api from "@/lib/api-client";
import { IPagination, QueryParams } from "@/lib/types.ts";
import {
  IApiKey,
  ICreateApiKey,
  IRenameApiKey,
} from "@/features/api-key/types/api-key.types.ts";

export async function getApiKeys(
  params?: QueryParams,
): Promise<IPagination<IApiKey>> {
  const req = await api.post<IPagination<IApiKey>>("/api-keys", {
    ...params,
  });
  return req.data;
}

export async function createApiKey(data: ICreateApiKey): Promise<IApiKey> {
  const req = await api.post<IApiKey>("/api-keys/create", data);
  return req.data;
}

export async function renameApiKey(data: IRenameApiKey): Promise<IApiKey> {
  const req = await api.post<IApiKey>("/api-keys/update", data);
  return req.data;
}

export async function revokeApiKey(apiKeyId: string): Promise<void> {
  await api.post("/api-keys/revoke", { apiKeyId });
}
