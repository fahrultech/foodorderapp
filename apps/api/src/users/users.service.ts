import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateNotificationSettingsDto } from './dto/notification-settings.dto';
import { SafeUser, toSafeUser } from '../common/safe-user';

/** Columns a user may change about themselves, in the order they are applied. */
const PROFILE_FIELDS = ['name', 'phone', 'address'] as const;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
  ) {}

  findById(id: string) {
    return this.repo.findOne({ where: { id } });
  }

  update(id: string, data: Partial<Pick<User, (typeof PROFILE_FIELDS)[number]>>) {
    return this.repo.update(id, data);
  }

  /**
   * `PATCH /users/me`. Picks only the allowlisted fields (never trusts extra
   * keys even though the global ValidationPipe already strips them — this is
   * the second gate), rejects an empty patch with 400 rather than silently
   * pretending to succeed, and returns the stored rows re-read from the DB so
   * the client sees exactly what persisted.
   */
  async updateProfile(id: string, dto: UpdateProfileDto): Promise<SafeUser> {
    const patch: Partial<Pick<User, (typeof PROFILE_FIELDS)[number]>> = {};
    for (const field of PROFILE_FIELDS) {
      if (dto[field] !== undefined) patch[field] = dto[field] as string;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No profile fields to update');
    }

    const result = await this.repo.update(id, patch);
    if (!result.affected) throw new NotFoundException('User not found');

    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return toSafeUser(user);
  }

  /**
   * The client-facing channel toggle shape (GET/PATCH
   * `/users/me/notification-settings`, GDPR export parity). Deliberately
   * NOT part of SafeUser: these are settings of the account owner, not a
   * display property every user-mapping call site should carry.
   */
  notificationSettingsOf(user: Pick<User, 'orderEmailEnabled' | 'orderPushEnabled'>) {
    return {
      // Strict false: a never-written column (fixture rows, pre-migration
      // selects) must read as ON, exactly the pre-feature behavior.
      orderEmail: user.orderEmailEnabled !== false,
      orderPush: user.orderPushEnabled !== false,
    };
  }

  async getNotificationSettings(id: string) {
    const user = await this.repo.findOne({
      where: { id },
      select: ['id', 'orderEmailEnabled', 'orderPushEnabled'],
    });
    if (!user) throw new NotFoundException('User not found');
    return this.notificationSettingsOf(user);
  }

  /**
   * `PATCH /users/me/notification-settings`. Allowlisted booleans only;
   * an empty patch 400s instead of pretending to save (updateProfile
   * doctrine); the answer is the persisted row re-read from the DB.
   */
  async updateNotificationSettings(id: string, dto: UpdateNotificationSettingsDto) {
    const patch: Partial<Pick<User, 'orderEmailEnabled' | 'orderPushEnabled'>> = {};
    if (dto.orderEmail !== undefined) patch.orderEmailEnabled = dto.orderEmail;
    if (dto.orderPush !== undefined) patch.orderPushEnabled = dto.orderPush;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No notification settings to update');
    }

    const result = await this.repo.update(id, patch);
    if (!result.affected) throw new NotFoundException('User not found');

    const user = await this.repo.findOne({
      where: { id },
      select: ['id', 'orderEmailEnabled', 'orderPushEnabled'],
    });
    if (!user) throw new NotFoundException('User not found');
    return this.notificationSettingsOf(user);
  }
}
