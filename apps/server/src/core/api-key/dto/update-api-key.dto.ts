import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateApiKeyDto {
  @IsUUID()
  apiKeyId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}
