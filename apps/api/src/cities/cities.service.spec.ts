import { CitiesService } from './cities.service';
import { City } from './city.entity';

const rows: City[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'jakarta',
    name: 'Jakarta',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as City,
  {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'retired-city',
    name: 'Retired City',
    isActive: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as City,
];

describe('CitiesService', () => {
  it('lists active cities alphabetically', async () => {
    const find = jest.fn().mockResolvedValue([rows[0]]);
    const service = new CitiesService({ find } as any);

    await expect(service.findActive()).resolves.toEqual([rows[0]]);
    expect(find).toHaveBeenCalledWith({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  });

  it('finds an active city by id and rejects inactive rows', async () => {
    const findOne = jest
      .fn()
      .mockResolvedValueOnce(rows[0])
      .mockResolvedValueOnce(null);
    const service = new CitiesService({ findOne } as any);

    await expect(service.findActiveById(rows[0].id)).resolves.toBe(rows[0]);
    await expect(service.findActiveById(rows[1].id)).resolves.toBeNull();
    expect(findOne).toHaveBeenNthCalledWith(1, {
      where: { id: rows[0].id, isActive: true },
    });
  });
});
