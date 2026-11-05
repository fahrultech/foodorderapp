import { validate } from 'class-validator';
import { DeleteAccountDto } from './delete-account.dto';

describe('DeleteAccountDto', () => {
  const valid = () => {
    const dto = new DeleteAccountDto();
    dto.password = ['correct', 'horse'].join('-');
    dto.confirmation = 'DELETE';
    return dto;
  };

  it('accepts a current password plus the exact destructive confirmation', async () => {
    await expect(validate(valid())).resolves.toHaveLength(0);
  });

  it('rejects missing credentials and a non-exact confirmation', async () => {
    const dto = new DeleteAccountDto();
    dto.password = '';
    dto.confirmation = 'delete';
    const errors = await validate(dto);
    expect(errors.map((error) => error.property).sort()).toEqual(['confirmation', 'password']);
  });
});
