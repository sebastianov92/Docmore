export interface ITemplate {
  id: string;
  title: string | null;
  description?: string | null;
  content?: any;
  icon?: string | null;
  // null means the template is available to the whole workspace
  spaceId?: string | null;
  workspaceId: string;
  creatorId: string | null;
  lastUpdatedById?: string | null;
  creator?: {
    id: string;
    name: string;
    avatarUrl?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ITemplateListParams {
  spaceId?: string;
  currentSpaceId?: string;
  cursor?: string;
  limit?: number;
}

export interface ICreateTemplate {
  title: string;
  spaceId?: string | null;
  icon?: string;
  description?: string;
  content?: any;
}

export interface IUpdateTemplate {
  templateId: string;
  title?: string;
  icon?: string | null;
  description?: string | null;
  content?: any;
  spaceId?: string | null;
}

export interface IUseTemplate {
  templateId: string;
  spaceId: string;
  parentPageId?: string;
}
