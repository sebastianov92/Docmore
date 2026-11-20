import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  url: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

export class UpdateWebhookDto {
  @IsUUID()
  webhookId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // mint a new secret (the old one stops working)
  @IsOptional()
  @IsBoolean()
  rotateSecret?: boolean;
}

export class WebhookIdDto {
  @IsUUID()
  webhookId: string;
}
