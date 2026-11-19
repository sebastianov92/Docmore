import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';

export class BrowseSpacesDto extends PaginationOptions {}

export class JoinSpaceDto {
  @IsUUID()
  spaceId: string;
}

export class CreateJoinRequestDto {
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListJoinRequestsDto {
  @IsUUID()
  spaceId: string;
}

export class JoinRequestIdDto {
  @IsUUID()
  requestId: string;
}
