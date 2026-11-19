import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateInviteRequestDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  emails: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class InviteRequestIdDto {
  @IsUUID()
  requestId: string;
}
