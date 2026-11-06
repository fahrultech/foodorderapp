import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MenuOptionService } from './menu-option.service';
import { MenuOptionGroup } from './menu-option-group.entity';
import { MenuOptionChoice } from './menu-option-choice.entity';
import { MenuService, Actor } from './menu.service';
import { UserRole } from '../users/user.entity';
import { CreateOrderItemDto } from '../orders/dto/create-order.dto';

const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ITEM_ID = '44444444-4444-4444-8444-444444444444';
// Route-level ids pass the service's isUuid guards — keep them real uuids.
const G1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const owner: Actor = { sub: 'u1', role: UserRole.OWNER };

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (dto: any, value: any) =>
  pipe.transform(value, { metatype: dto, type: 'body' });

function group(overrides: Partial<MenuOptionGroup> = {}): MenuOptionGroup {
  return {
    id: G1,
    menuItemId: ITEM_ID,
    name: 'Size',
    minChoices: 0,
    maxChoices: 1,
    position: 0,
    choices: [],
    ...overrides,
  } as MenuOptionGroup;
}

function choice(overrides: Partial<MenuOptionChoice> = {}): MenuOptionChoice {
  return {
    id: C1,
    groupId: G1,
    name: 'Large',
    priceDeltaCents: 200,
    position: 0,
    ...overrides,
  } as MenuOptionChoice;
}

function build(groups: MenuOptionGroup[] = [], ownedItem = ITEM_ID) {
  const groupRepo: any = {
    findOne: jest.fn(async ({ where }: any) =>
      groups.find((g) => g.id === where.id && g.menuItemId === where.menuItemId) ?? null,
    ),
    find: jest.fn(async ({ where }: any) =>
      groups.filter((g) => (where.menuItemId.value ?? []).includes(g.menuItemId)),
    ),
    create: jest.fn((x: any) => ({ choices: [], ...x })),
    save: jest.fn(async (x: any) => ({ id: G1, ...x })),
    remove: jest.fn(async (x: any) => {
      delete x.id;
      return x;
    }),
  };
  const choiceRepo: any = {
    findOne: jest.fn(async ({ where }: any) => {
      const g = groups.find((x) => x.id === where.groupId);
      return g?.choices.find((c) => c.id === where.id) ?? null;
    }),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => ({ id: C1, ...x })),
    remove: jest.fn(async (x: any) => {
      delete x.id;
      return x;
    }),
  };
  const menuFake: any = {
    loadManagedItem: jest.fn(async (id: string) => {
      if (id !== ownedItem) throw new NotFoundException('Menu item not found');
      return { id };
    }),
  };
  const service = new MenuOptionService(
    groupRepo as Repository<MenuOptionGroup>,
    choiceRepo as Repository<MenuOptionChoice>,
    menuFake as unknown as MenuService,
  );
  return { service, groupRepo, choiceRepo, menuFake };
}

describe('Menu option DTOs — validation via global ValidationPipe', () => {
  const validGroup = { name: 'Size', choices: [{ name: 'Regular' }] };

  it('CreateOptionGroupDto accepts a minimal group and defaults stay unset for the service', async () => {
    const out: any = await check(
      (await import('./dto/menu-option.dto')).CreateOptionGroupDto,
      { ...validGroup },
    );
    expect(out.name).toBe('Size');
    expect(out.choices).toHaveLength(1);
    expect(out.minChoices).toBeUndefined();
  });

  it('rejects a group without choices / blank names / wrong cents', async () => {
    const { CreateOptionGroupDto, CreateOptionChoiceDto } = await import(
      './dto/menu-option.dto'
    );
    await expect(
      check(CreateOptionGroupDto, { name: 'Size', choices: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      check(CreateOptionGroupDto, { name: 'Size', choices: [{ name: '  ' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      check(CreateOptionChoiceDto, { name: 'X', priceDeltaCents: -1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      check(CreateOptionChoiceDto, { name: 'X', priceDeltaCents: 10000001 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('strips undecorated keys (whitelist) — a client cannot forge ids or timestamps', async () => {
    const { CreateOptionGroupDto } = await import('./dto/menu-option.dto');
    const out: any = await check(CreateOptionGroupDto, {
      ...validGroup,
      id: 'evil',
      menuItemId: 'evil',
      choices: [{ name: 'Regular', id: 'evil', groupId: 'evil', createdAt: 'x' }],
    });
    expect(out.id).toBeUndefined();
    expect(out.menuItemId).toBeUndefined();
    expect(out.choices[0].id).toBeUndefined();
    expect(out.choices[0].groupId).toBeUndefined();
    expect(out.choices[0].createdAt).toBeUndefined();
  });

  it('minChoices>maxChoices is caught by the service, not the DTO (per-field bounds pass)', async () => {
    const { CreateOptionGroupDto } = await import('./dto/menu-option.dto');
    const out: any = await check(CreateOptionGroupDto, {
      ...validGroup,
      minChoices: 3,
      maxChoices: 1,
    });
    expect(out.minChoices).toBe(3); // shape-valid — service must reject
  });
});

describe('CreateOrderItemDto.optionChoiceIds', () => {
  it('accepts valid uuid arrays and rejects malformed/non-uuid entries', async () => {
    const ok: any = await check(CreateOrderItemDto, {
      menuItemId: ITEM_ID,
      quantity: 1,
      optionChoiceIds: [ITEM_ID],
    });
    expect(ok.optionChoiceIds).toEqual([ITEM_ID]);
    for (const bad of [['nope'], [123], ['urn:uuid:zz'], new Array(21).fill(ITEM_ID)]) {
      await expect(
        check(CreateOrderItemDto, {
          menuItemId: ITEM_ID,
          quantity: 1,
          optionChoiceIds: bad,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('stays fully optional — old clients omit it and validate as before', async () => {
    const out: any = await check(CreateOrderItemDto, { menuItemId: ITEM_ID, quantity: 2 });
    expect(out.optionChoiceIds).toBeUndefined();
  });
});

describe('MenuOptionService — owner CRUD', () => {
  it('createGroup goes through MenuService ownership (foreign dish -> 404)', async () => {
    const { service, menuFake } = build([]);
    await expect(
      service.createGroup(OTHER_ITEM_ID, owner, {
        name: 'Size',
        choices: [{ name: 'Regular' }],
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(menuFake.loadManagedItem).toHaveBeenCalledWith(OTHER_ITEM_ID, owner);
  });

  it('createGroup accepts a valid group and defaults min/max when omitted', async () => {
    const { service } = build([]);
    const out: any = await service.createGroup(ITEM_ID, owner, {
      name: 'Spice level',
      choices: [{ name: 'Mild' }, { name: 'Hot' }],
    } as any);
    expect(out.menuItemId).toBe(ITEM_ID);
    expect(out.minChoices).toBe(0);
    expect(out.maxChoices).toBe(1);
  });

  it('createGroup rejects min>max and min above the provided choice count', async () => {
    const { service } = build([]);
    await expect(
      service.createGroup(ITEM_ID, owner, {
        name: 'Size',
        minChoices: 3,
        maxChoices: 1,
        choices: [{ name: 'a' }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createGroup(ITEM_ID, owner, {
        name: 'Size',
        minChoices: 2,
        choices: [{ name: 'only one' }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateGroup refuses a min above the CURRENT choice count', async () => {
    const g = group({ minChoices: 0, maxChoices: 5, choices: [choice()] });
    const { service } = build([g]);
    await expect(service.updateGroup(ITEM_ID, G1, owner, { minChoices: 2 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const out: any = await service.updateGroup(ITEM_ID, G1, owner, { minChoices: 1, name: 'Size L' });
    expect(out.name).toBe('Size L');
    expect(out.minChoices).toBe(1);
  });

  it('removeChoice guards the group minimum', async () => {
    const g = group({ minChoices: 2, maxChoices: 2, choices: [choice(), choice({ id: C2, name: 'Jumbo' })] });
    const { service } = build([g]);
    await expect(service.removeChoice(ITEM_ID, G1, C1, owner)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const g2 = group({ minChoices: 0, choices: [choice(), choice({ id: C2 })] });
    const t2 = build([g2]);
    await t2.service.removeChoice(ITEM_ID, G1, C1, owner);
    expect(t2.choiceRepo.remove).toHaveBeenCalled();
  });

  it('group/choice ids outside the dish nest -> 404 (no existence leak)', async () => {
    const g = group({ menuItemId: OTHER_ITEM_ID });
    const { service } = build([g]);
    await expect(service.updateGroup(ITEM_ID, G1, owner, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('addChoice caps at 20 per group', async () => {
    const g = group({ choices: new Array(20).fill(null).map((_, i) => choice({ id: `c${i}` })) });
    const { service } = build([g]);
    await expect(service.addChoice(ITEM_ID, G1, owner, { name: '21st' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('MenuOptionService.resolveSelections — order-line validation', () => {
  const size = () => group({
    minChoices: 0,
    maxChoices: 1,
    choices: [choice({ id: 'cS', name: 'Regular', priceDeltaCents: 0, position: 0 }), choice({ id: 'cL', name: 'Large', priceDeltaCents: 200, position: 1 })],
  });
  const extras = () => group({
    id: 'g2',
    name: 'Add-ons',
    minChoices: 0,
    maxChoices: 2,
    position: 1,
    choices: [choice({ id: 'cE', groupId: 'g2', name: 'Egg', priceDeltaCents: 150, position: 0 }), choice({ id: 'cC', groupId: 'g2', name: 'Cheese', priceDeltaCents: 250, position: 1 })],
  });
  const mandatory = () => group({
    id: 'g3',
    name: 'Cook level',
    minChoices: 1,
    maxChoices: 1,
    position: 2,
    choices: [choice({ id: 'cW', groupId: 'g3', name: 'Well done', priceDeltaCents: 0, position: 0 })],
  });

  function buildResolver(groups: MenuOptionGroup[]) {
    const groupRepo: any = {
      find: jest.fn(async () => groups.map((g) => ({ ...g }))),
    };
    const choiceRepo: any = {};
    const service = new MenuOptionService(
      groupRepo as Repository<MenuOptionGroup>,
      choiceRepo as Repository<MenuOptionChoice>,
      {} as unknown as MenuService,
    );
    return service;
  }

  it('dishes without groups resolve to zero-cost no-op lines', async () => {
    const service = buildResolver([]);
    const out = await service.resolveSelections([{ menuItemId: ITEM_ID }]);
    expect(out).toEqual([{ extraCents: 0, selections: [] }]);
  });

  it('valid selections sum deltas and freeze an ordered receipt', async () => {
    const service = buildResolver([size(), extras()]);
    const out = await service.resolveSelections([
      { menuItemId: ITEM_ID, optionChoiceIds: ['cE', 'cL'] },
    ]);
    expect(out[0].extraCents).toBe(350); // 200 size + 150 egg
    // Receipt ordered GROUP position then choice position: Large (Size), Egg (Add-ons)
    expect(out[0].selections.map((s) => [s.groupName, s.choiceName])).toEqual([
      ['Size', 'Large'],
      ['Add-ons', 'Egg'],
    ]);
    expect(out[0].selections[0]).toEqual({
      groupId: G1,
      groupName: 'Size',
      choiceId: 'cL',
      choiceName: 'Large',
      priceDeltaCents: 200,
    });
  });

  it('rejects unknown ids, foreign-dish ids and duplicates', async () => {
    const service = buildResolver([size()]);
    await expect(
      service.resolveSelections([{ menuItemId: ITEM_ID, optionChoiceIds: ['nope'] }]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.resolveSelections([{ menuItemId: OTHER_ITEM_ID, optionChoiceIds: ['cL'] }]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.resolveSelections([{ menuItemId: ITEM_ID, optionChoiceIds: ['cS', 'cS'] }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces per-group min and max', async () => {
    const service = buildResolver([mandatory()]);
    await expect(
      service.resolveSelections([{ menuItemId: ITEM_ID }]),
    ).rejects.toBeInstanceOf(BadRequestException); // minChoices 1 unmet
    const service2 = buildResolver([size()]);
    await expect(
      service2.resolveSelections([{ menuItemId: ITEM_ID, optionChoiceIds: ['cS', 'cL'] }]),
    ).rejects.toBeInstanceOf(BadRequestException); // maxChoices 1 exceeded
  });

  it('picks on a dish with NO groups are rejected (client sent ids out of thin air)', async () => {
    const service = buildResolver([]);
    await expect(
      service.resolveSelections([{ menuItemId: ITEM_ID, optionChoiceIds: ['ghost'] }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('index-aligns multi-line orders', async () => {
    const service = buildResolver([size()]);
    const out = await service.resolveSelections([
      { menuItemId: ITEM_ID, optionChoiceIds: ['cL'] },
      { menuItemId: ITEM_ID },
      { menuItemId: OTHER_ITEM_ID },
    ]);
    expect(out.map((l) => l.extraCents)).toEqual([200, 0, 0]);
  });
});
