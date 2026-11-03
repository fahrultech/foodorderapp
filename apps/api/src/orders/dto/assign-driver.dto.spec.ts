import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssignDriverDto } from './assign-driver.dto';

const DRIVER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('AssignDriverDto', () => {
  it('accepts a driver UUID', async () => {
    await expect(validate(plainToInstance(AssignDriverDto, { driverId: DRIVER_ID }))).resolves.toHaveLength(0);
  });

  it('accepts null to unassign', async () => {
    await expect(validate(plainToInstance(AssignDriverDto, { driverId: null }))).resolves.toHaveLength(0);
  });

  it.each([{}, { driverId: 'not-a-uuid' }, { driverId: 42 }])(
    'rejects missing or malformed driverId: %p',
    async (payload) => {
      expect(await validate(plainToInstance(AssignDriverDto, payload))).not.toHaveLength(0);
    },
  );
});
