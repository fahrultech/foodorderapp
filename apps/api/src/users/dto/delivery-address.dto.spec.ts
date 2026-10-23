import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../../common/app-config';
import {
  CreateDeliveryAddressDto,
  UpdateDeliveryAddressDto,
} from './delivery-address.dto';

/** Same options the app boots with — this tests real whitelist stripping. */
const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
const createCheck = (value: any) =>
  pipe.transform(value, { metatype: CreateDeliveryAddressDto, type: 'body' });
const updateCheck = (value: any) =>
  pipe.transform(value, { metatype: UpdateDeliveryAddressDto, type: 'body' });

describe('CreateDeliveryAddressDto (POST /users/me/addresses)', () => {
  it('accepts a complete valid address, isDefault optional', async () => {
    const out: any = await createCheck({
      label: 'Home',
      recipientName: 'Ada',
      phone: '+62 812 3456 7890',
      address: 'Jl. Merdeka 1',
    });
    expect(out).toBeInstanceOf(CreateDeliveryAddressDto);
    expect(out.isDefault).toBeUndefined();
    const withFlag: any = await createCheck({
      label: 'Office',
      recipientName: 'Ada',
      phone: '0811 000 111',
      address: 'SCBD Lot 5',
      isDefault: true,
    });
    expect(withFlag.isDefault).toBe(true);
  });

  it('requires label, recipientName and address', async () => {
    const base = { recipientName: 'Ada', phone: '+62 8123456789', address: 'x' };
    await expect(createCheck({ ...base, label: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(createCheck({ ...base, label: undefined })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      createCheck({ label: 'Home', phone: '+62 8123456789', address: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      createCheck({ label: 'Home', recipientName: 'Ada', phone: '+62 8123456789' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces bounds: label 40, recipientName 120, address 500, dialable phone', async () => {
    const base = { recipientName: 'Ada', phone: '+62 8123456789', address: 'Jl. Test 1' };
    await expect(createCheck({ ...base, label: 'l'.repeat(41) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(createCheck({ ...base, recipientName: 'n'.repeat(121) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(createCheck({ ...base, address: 'a'.repeat(501) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(createCheck({ ...base, label: 'Home', phone: 'not-a-phone' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(createCheck({ ...base, label: 'Home', phone: '+62 abc 123' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('isDefault must be boolean, strips ownership/identity fields', async () => {
    await expect(
      createCheck({
        label: 'Home',
        recipientName: 'Ada',
        phone: '+62 8123456789',
        address: 'x',
        isDefault: 'true',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const out: any = await createCheck({
      label: 'Home',
      recipientName: 'Ada',
      phone: '+62 8123456789',
      address: 'x',
      userId: 'victim-uuid',
      id: 'forged-uuid',
      createdAt: '2020-01-01',
    });
    expect(out.userId).toBeUndefined();
    expect(out.id).toBeUndefined();
    expect(out.createdAt).toBeUndefined();
  });
});

describe('UpdateDeliveryAddressDto (PATCH /users/me/addresses/:id)', () => {
  it('accepts each field alone', async () => {
    expect((await updateCheck({ label: 'Casa' }) as any).label).toBe('Casa');
    expect((await updateCheck({ phone: '+62 811 2222 3333' }) as any).phone).toBe('+62 811 2222 3333');
    expect(await updateCheck({})).toBeInstanceOf(UpdateDeliveryAddressDto);
  });

  it('rejects blank strings for the required-shape fields (clearing is DELETE-only)', async () => {
    await expect(updateCheck({ label: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(updateCheck({ address: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(updateCheck({ recipientName: '' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('strips isDefault and identity fields — the flag moves via POST /:id/default', async () => {
    const out: any = await updateCheck({
      label: 'Casa',
      isDefault: true,
      userId: 'victim',
      id: 'other-uuid',
    });
    expect(out.label).toBe('Casa');
    expect(out.isDefault).toBeUndefined();
    expect(out.userId).toBeUndefined();
    expect(out.id).toBeUndefined();
  });
});
