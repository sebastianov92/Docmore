import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SyncPullDto {
  // the cursor a previous snapshot or pull returned
  @IsString()
  @Matches(/^\d{1,19}$/)
  cursor: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class SyncSpacePagesDto {
  @IsUUID()
  spaceId: string;

  // id of the last page of the previous chunk
  @IsOptional()
  @IsUUID()
  after?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}

export class SyncDocDto {
  @IsUUID()
  pageId: string;

  // base64 Yjs state vector: what the device already has
  @IsOptional()
  @IsString()
  stateVector?: string;

  // base64 Yjs update: what the device wrote offline
  @IsOptional()
  @IsString()
  update?: string;
}

export class SyncDocsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SyncDocDto)
  docs: SyncDocDto[];
}

export class OfflinePinDto {
  @IsIn(['space', 'page'])
  type: 'space' | 'page';

  @IsUUID()
  id: string;
}

export class DeviceDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  deviceId: string;
}

export class SetOfflinePinsDto extends DeviceDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;

  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => OfflinePinDto)
  pins: OfflinePinDto[];
}
