import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import * as nodemailer from 'nodemailer';

// ── helpers ────────────────────────────────────────────────────────────────
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });
const mockCreateTransport = jest.fn().mockReturnValue({
  sendMail: mockSendMail,
});

jest.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => mockCreateTransport(...args),
}));

// ── tests ──────────────────────────────────────────────────────────────────
describe('MailService', () => {
  afterEach(() => jest.clearAllMocks());

  function buildConfig(overrides: Record<string, string | undefined> = {}) {
    const cfg: Record<string, string | undefined> = {
      SMTP_HOST: 'smtp.test',
      SMTP_PORT: '587',
      SMTP_USER: 'u@test',
      SMTP_PASS: 'p',
      SMTP_FROM: 'Test <noreply@test>',
      SMTP_SECURE: 'false',
      ...overrides,
    };
    const cs = { get: (k: string) => cfg[k] } as unknown as ConfigService;
    return cs;
  }

  describe('when SMTP_HOST is set', () => {
    let svc: MailService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: buildConfig() },
        ],
      }).compile();
      svc = module.get(MailService);
    });

    it('is enabled', () => expect(svc.enabled).toBe(true));

    it('creates a transport with the right host/port', () => {
      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.test', port: 587, secure: false }),
      );
    });

    it('sends mail via the transporter', async () => {
      await svc.send({ to: 'x@example.com', subject: 'hi', text: 'body' });
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const call = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
      expect(call.to).toBe('x@example.com');
      expect(call.from).toBe('Test <noreply@test>');
    });

    it('does NOT throw when sendMail rejects', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(svc.send({ to: 'x@example.com', subject: 'hi', text: 'body' })).resolves.toBeUndefined();
    });

    it('uses SMTP_SECURE=true to set secure flag', async () => {
      jest.clearAllMocks();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: buildConfig({ SMTP_SECURE: 'true' }) },
        ],
      }).compile();
      module.get(MailService);
      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true }),
      );
    });

    it('omits auth block when SMTP_USER is absent', async () => {
      jest.clearAllMocks();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: buildConfig({ SMTP_USER: undefined, SMTP_PASS: undefined }) },
        ],
      }).compile();
      module.get(MailService);
      const callArg = mockCreateTransport.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.auth).toBeUndefined();
    });
  });

  describe('when SMTP_HOST is absent', () => {
    let svc: MailService;

    beforeEach(async () => {
      jest.clearAllMocks();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: buildConfig({ SMTP_HOST: undefined }) },
        ],
      }).compile();
      svc = module.get(MailService);
    });

    it('is disabled', () => expect(svc.enabled).toBe(false));

    it('does not create a transporter', () => {
      expect(mockCreateTransport).not.toHaveBeenCalled();
    });

    it('send() is a no-op', async () => {
      await svc.send({ to: 'x@example.com', subject: 'hi', text: 'body' });
      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });

  describe('SMTP_JSON_CAPTURE rig mode', () => {
    function build(opts: Record<string, string | undefined> = {}) {
      jest.clearAllMocks();
      return Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: buildConfig(opts) },
        ],
      }).compile();
    }

    it('uses the jsonTransport even with no SMTP_HOST (rig needs no relay)', async () => {
      const svc = (await build({
        SMTP_HOST: undefined,
        SMTP_JSON_CAPTURE: '1',
      })).get(MailService);
      expect(svc.enabled).toBe(true);
      expect(mockCreateTransport).toHaveBeenCalledWith({ jsonTransport: true });
    });

    it('takes precedence over a configured real host', async () => {
      const svc = (await build({ SMTP_JSON_CAPTURE: 'true' })).get(MailService);
      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
      expect(mockCreateTransport).toHaveBeenCalledWith({ jsonTransport: true });
      expect(svc.enabled).toBe(true);
    });

    it('garbage capture values are inert (normal host path, no jsonTransport)', async () => {
      const svc = (await build({ SMTP_JSON_CAPTURE: 'ture' })).get(MailService);
      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.test' }),
      );
      expect(svc.enabled).toBe(true);
    });

    it('logs exactly one single-line MAIL_CAPTURED payload per send', async () => {
      const svc = (await build({ SMTP_JSON_CAPTURE: 'YES' })).get(MailService);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await svc.send({ to: 'guest@example.com', subject: 'Order confirmed — #FO-1', text: 'a\nb' });
      const captured = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith('MAIL_CAPTURED '));
      expect(captured).toHaveLength(1);
      const payload = JSON.parse(captured[0].slice('MAIL_CAPTURED '.length));
      expect(payload).toEqual({
        to: 'guest@example.com',
        subject: 'Order confirmed — #FO-1',
        text: 'a\nb',
      });
      expect(captured[0]).not.toContain('\n');
      logSpy.mockRestore();
    });

    it('silent-disabled path logs nothing when capture is off', async () => {
      const svc = (await build({ SMTP_HOST: undefined })).get(MailService);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await svc.send({ to: 'x@example.com', subject: 's', text: 't' });
      expect(
        logSpy.mock.calls.map((c) => String(c[0])).some((m) => m.startsWith('MAIL_CAPTURED')),
      ).toBe(false);
      logSpy.mockRestore();
    });
  });
});
