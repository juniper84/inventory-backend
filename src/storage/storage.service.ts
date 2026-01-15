import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly presignTtlSeconds: number;
  private readonly publicBaseUrl?: string;
  private readonly endpoint?: string;
  private readonly forcePathStyle: boolean;

  constructor(private readonly configService: ConfigService) {
    this.bucket =
      this.configService.get<string>('storage.bucket') ||
      process.env.S3_BUCKET ||
      '';
    this.prefix =
      this.configService.get<string>('storage.prefix') ||
      process.env.S3_PREFIX ||
      '';
    this.presignTtlSeconds = parseInt(
      this.configService.get<string>('storage.presignTtlSeconds') ||
        process.env.S3_PRESIGN_TTL_SECONDS ||
        '300',
      10,
    );
    this.publicBaseUrl =
      this.configService.get<string>('storage.publicBaseUrl') ||
      process.env.S3_PUBLIC_BASE_URL;
    this.endpoint =
      this.configService.get<string>('storage.endpoint') ||
      process.env.S3_ENDPOINT;
    this.forcePathStyle =
      this.configService.get<boolean>('storage.forcePathStyle') ??
      process.env.S3_FORCE_PATH_STYLE === 'true';

    this.client = new S3Client({
      region:
        this.configService.get<string>('storage.region') ||
        process.env.AWS_REGION,
      credentials: {
        accessKeyId:
          this.configService.get<string>('storage.accessKeyId') ||
          process.env.AWS_ACCESS_KEY_ID ||
          '',
        secretAccessKey:
          this.configService.get<string>('storage.secretAccessKey') ||
          process.env.AWS_SECRET_ACCESS_KEY ||
          '',
      },
      endpoint: this.endpoint,
      forcePathStyle: this.forcePathStyle,
    });
  }

  buildObjectKey(path: string) {
    const cleanedPrefix = this.prefix
      ? this.prefix.replace(/^\//, '').replace(/\/$/, '') + '/'
      : '';
    return `${cleanedPrefix}${path}`.replace(/\/{2,}/g, '/');
  }

  async createPresignedUpload(params: { key: string; contentType?: string }) {
    if (!this.bucket) {
      throw new Error('S3 bucket not configured.');
    }
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.presignTtlSeconds,
    });

    return {
      url,
      bucket: this.bucket,
      key: params.key,
      publicUrl: this.publicBaseUrl
        ? `${this.publicBaseUrl.replace(/\/$/, '')}/${params.key}`
        : `https://${this.bucket}.s3.amazonaws.com/${params.key}`,
    };
  }

  async uploadObject(params: {
    key: string;
    body: Buffer;
    contentType?: string;
  }) {
    if (!this.bucket) {
      throw new Error('S3 bucket not configured.');
    }
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    });
    await this.client.send(command);
    return {
      bucket: this.bucket,
      key: params.key,
      publicUrl: this.publicBaseUrl
        ? `${this.publicBaseUrl.replace(/\/$/, '')}/${params.key}`
        : `https://${this.bucket}.s3.amazonaws.com/${params.key}`,
    };
  }

  async createPresignedDownload(params: { key: string }) {
    if (!this.bucket) {
      throw new Error('S3 bucket not configured.');
    }
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.presignTtlSeconds,
    });
    return { url };
  }
}
