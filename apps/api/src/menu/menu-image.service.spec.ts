import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MenuImageService } from './menu-image.service';
import type { MenuImageContentType } from './dto/menu-item.dto';

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const sign = getSignedUrl as jest.Mock;

function config(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

const enabled = {
  S3_ENDPOINT: 'https://objects.example.test',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'foodorder-media',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
  S3_PUBLIC_BASE_URL: 'https://cdn.example.test/menu/',
};

const itemId = '33333333-3333-4333-8333-333333333333';

describe('MenuImageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('fails with a stable 503 when the S3 configuration is incomplete', async () => {
    const service = new MenuImageService(config({ S3_BUCKET: 'foodorder-media' }));

    await expect(
      service.createUpload(itemId, { contentType: 'image/jpeg', sizeBytes: 1024 }),
    ).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'IMAGE_STORAGE_DISABLED',
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/avif', 'avif'],
  ])('presigns one private PUT and returns its public %s URL', async (contentType, extension) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-02T09:00:00.000Z'));
    sign.mockResolvedValue('https://signed.example.test/put');
    const service = new MenuImageService(config(enabled));

    const result = await service.createUpload(itemId, {
      contentType: contentType as MenuImageContentType,
      sizeBytes: 4321,
    });

    expect(result).toMatchObject({
      uploadUrl: 'https://signed.example.test/put',
      imageUrl: expect.stringMatching(
        new RegExp(`^https://cdn\\.example\\.test/menu/menu-items/${itemId}/[0-9a-f-]+\\.${extension}$`),
      ),
      objectKey: expect.stringMatching(
        new RegExp(`^menu-items/${itemId}/[0-9a-f-]+\\.${extension}$`),
      ),
      requiredHeaders: { 'Content-Type': contentType },
      expiresAt: '2026-11-02T09:05:00.000Z',
    });
    expect(sign).toHaveBeenCalledTimes(1);
    const [, command, options] = sign.mock.calls[0];
    expect(command.input).toMatchObject({
      Bucket: 'foodorder-media',
      Key: result.objectKey,
      ContentType: contentType,
      ContentLength: 4321,
    });
    expect(options).toEqual({
      expiresIn: 300,
      signableHeaders: new Set(['content-type']),
    });
  });
});
