import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateMarketingLeadDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsEmail()
  @MaxLength(200)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  businessName?: string;

  @IsString()
  @Length(10, 4000)
  message!: string;

  @IsOptional()
  @IsIn(['en', 'sw'])
  locale?: 'en' | 'sw';

  // Honeypot — real users leave empty. Bots fill it in.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
