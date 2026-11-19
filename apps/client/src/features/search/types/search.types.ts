import { IUser } from "@/features/user/types/user.types.ts";
import { IGroup } from "@/features/group/types/group.types.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { IPage } from "@/features/page/types/page.types.ts";

export interface IPageSearch {
  id: string;
  title: string;
  icon: string;
  parentPageId: string;
  slugId: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  rank: string;
  highlight: string;
  matchedText: string[];
  wholeWord: boolean;
  space: Partial<ISpace>;
  // Set on hits that are rows of a base: the link opens that row.
  rowId?: string;
  isBaseRow?: boolean;
}

export interface SearchSuggestionParams {
  query: string;
  includeUsers?: boolean;
  includeGroups?: boolean;
  includePages?: boolean;
  spaceId?: string;
  limit?: number;
}

export interface ISuggestionResult {
  users?: Partial<IUser[]>;
  groups?: Partial<IGroup[]>;
  pages?: Partial<IPage[]>;
}

export interface IPageSearchParams {
  query: string;
  spaceId?: string;
  shareId?: string;
  // owners/admins: every space of the workspace
  allSpaces?: boolean;
  creatorId?: string;
  labelIds?: string[];
  titleOnly?: boolean;
  includeArchived?: boolean;
}

export interface IAttachmentSearch {
  id: string;
  fileName: string;
  pageId: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  rank: string;
  highlight: string;
  space: {
    id: string;
    name: string;
    slug: string;
    icon: string;
    archivedAt?: Date | null;
  };
  page: {
    id: string;
    title: string;
    slugId: string;
  };
}
