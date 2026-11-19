import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UnlockShareDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  password: string;
}
