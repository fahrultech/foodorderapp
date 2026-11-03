import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppException } from '../common/app-exception';
import { CreateMenuImageUploadDto, MenuImageContentType } from './dto/menu-item.dto';

const UPLOAD_TTL_SECONDS = 300;

const EXTENSION: Record<MenuImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export interface MenuImageUpload {
  uploadUrl: string;
  imageUrl: string;
  objectKey: string;
  requiredHeaders: { 'Content-Type': MenuImageContentType };
  expiresAt: string;
}

/** S3-compatible presigned PUTs; no image bytes pass through the API process. */
@Injectable()
export class MenuImageService {
  private readonly log = new Logger(MenuImageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string | null;
  private readonly publicBaseUrl: string | null;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('S3_ENDPOINT');
    const region = config.get<string>('S3_REGION');
    const bucket = config.get<string>('S3_BUCKET');
    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
    const publicBaseUrl = config.get<string>('S3_PUBLIC_BASE_URL');
    const enabled = Boolean(
      endpoint && region && bucket && accessKeyId && secretAccessKey && publicBaseUrl,
    );

    if (!enabled) {
      this.client = null;
      this.bucket = null;
      this.publicBaseUrl = null;
      this.log.warn('S3 image configuration incomplete — menu image uploads disabled');
      return;
    }

    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    });
    this.bucket = bucket!;
    this.publicBaseUrl = publicBaseUrl!.replace(/\/+$/, '');
    this.log.log('Menu image upload transport ready');
  }

  async createUpload(itemId: string, dto: CreateMenuImageUploadDto): Promise<MenuImageUpload> {
    if (!this.client || !this.bucket || !this.publicBaseUrl) {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'IMAGE_STORAGE_DISABLED',
        'Menu image uploads are not configured',
      );
    }

    const objectKey = `menu-items/${itemId}/${randomUUID()}.${EXTENSION[dto.contentType]}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: dto.contentType,
      ContentLength: dto.sizeBytes,
    });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_TTL_SECONDS,
      signableHeaders: new Set(['content-type']),
    });

    return {
      uploadUrl,
      imageUrl: `${this.publicBaseUrl}/${objectKey}`,
      objectKey,
      requiredHeaders: { 'Content-Type': dto.contentType },
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }
}
