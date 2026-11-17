import { IUser } from "@/features/user/types/user.types.ts";

export type ApiKeyScope = "read" | "write";

export interface IApiKey {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  creatorId: string;
  workspaceId: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator?: Pick<IUser, "id" | "name" | "avatarUrl" | "email">;
  // Only present in the create response, shown once.
  token?: string;
}

export interface ICreateApiKey {
  name: string;
  expiresAt: string;
  scopes: ApiKeyScope[];
}

export interface IRenameApiKey {
  apiKeyId: string;
  name: string;
}
