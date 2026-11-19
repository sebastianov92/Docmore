import { IsBoolean, IsString, MaxLength } from 'class-validator';

export class DomainDto {
  @IsString()
  @MaxLength(253)
  domain: string;
}

export class DomainAutoJoinDto {
  @IsBoolean()
  autoJoin: boolean;
}
