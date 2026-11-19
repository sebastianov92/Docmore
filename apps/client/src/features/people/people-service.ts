import api from "@/lib/api-client";

export interface IMemberProfile {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  timezone: string | null;
  locale: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  deactivatedAt: string | null;
}

export async function getMemberProfile(userId: string): Promise<IMemberProfile> {
  const req = await api.post<IMemberProfile>("/users/info", { userId });
  return req.data;
}
