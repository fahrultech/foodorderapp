import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
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
}
