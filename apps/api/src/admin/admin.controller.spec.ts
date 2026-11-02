import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

const JWT_TEST = 'admin-controller-http-test-key';

describe('AdminController HTTP', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const overview = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: JWT_TEST })],
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: { overview } },
        JwtAuthGuard,
        RolesGuard,
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new ErrorFormatFilter());
    await app.listen(0);
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    overview.mockResolvedValue({ counts: {}, recentUsers: [], recentRestaurants: [], recentOrders: [] });
  });

  const token = (role: UserRole) =>
    jwt.sign({ sub: '11111111-1111-4111-8111-111111111111', role, typ: TOKEN_TYPE_ACCESS });

  const get = (authorization?: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const port = (app.getHttpServer().address() as AddressInfo).port;
      http
        .get(
          {
            port,
            path: '/api/admin/overview',
            headers: authorization ? { Authorization: authorization } : undefined,
          },
          (res) => {
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }),
            );
          },
        )
        .on('error', reject);
    });

  it('rejects anonymous callers before the service', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(overview).not.toHaveBeenCalled();
  });

  it('rejects non-admin callers before the service', async () => {
    const res = await get(`Bearer ${token(UserRole.OWNER)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(overview).not.toHaveBeenCalled();
  });

  it('returns the overview to admins', async () => {
    const payload = {
      counts: { users: { total: 3 } },
      recentUsers: [],
      recentRestaurants: [],
      recentOrders: [],
    };
    overview.mockResolvedValue(payload);

    const res = await get(`Bearer ${token(UserRole.ADMIN)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(overview).toHaveBeenCalledTimes(1);
  });
});
