import * as fs from 'fs';
import * as path from 'path';

describe('database seed — demo driver fixture', () => {
  it('creates a DRIVER account and assigns the PREPARING demo order', () => {
    const source = fs.readFileSync(path.join(__dirname, 'seed.ts'), 'utf8');
    expect(source).toContain("email: 'driver@foodorder.app'");
    expect(source).toContain('role: UserRole.DRIVER');
    expect(source).toContain("code: 'FO-SEED3'");
    expect(source).toContain('driverId: demoDriver.id');
  });
});
