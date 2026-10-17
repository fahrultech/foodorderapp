import { ConflictException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/user.entity';
import { LoginDto, RegisterDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.users.create({
      email: dto.email,
      name: dto.name,
      passwordHash,
      phone: dto.phone,
      address: dto.address,
    });
    await this.users.save(user);
    return this.issueToken(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new ConflictException('Invalid email or password');
    }
    return this.issueToken(user);
  }

  private async issueToken(user: User) {
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    });
    const { passwordHash, ...safe } = user;
    return { access_token: token, user: safe };
  }
}
