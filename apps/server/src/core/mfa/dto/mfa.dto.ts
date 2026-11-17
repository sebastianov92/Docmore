import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class SetupMfaDto {
  @IsOptional()
  @IsIn(['totp'])
  method?: 'totp';
}

export class EnableMfaDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  verificationCode: string;
}

export class ConfirmPasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  confirmPassword?: string;
}

export class VerifyMfaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code: string;
}
