import axios from 'axios';
import {
  assertOutboundUrlAllowed,
  createPinnedLookup,
  isPublicAddress,
  outboundFetch,
  OutboundUrlPolicyError,
} from './outbound-url-policy';

jest.mock('axios');

const originalAllowedOrigins = process.env.OUTBOUND_ALLOWED_ORIGINS;

describe('outbound URL policy', () => {
  beforeEach(() => {
    process.env.OUTBOUND_ALLOWED_ORIGINS = 'https://media.example.com';
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.OUTBOUND_ALLOWED_ORIGINS;
    } else {
      process.env.OUTBOUND_ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  it('authorizes only configured HTTPS origins', () => {
    expect(
      assertOutboundUrlAllowed('https://media.example.com/image.png').hostname,
    ).toBe('media.example.com');
    expect(() =>
      assertOutboundUrlAllowed('https://other.example.com/image.png'),
    ).toThrow(OutboundUrlPolicyError);
    expect(() =>
      assertOutboundUrlAllowed('http://media.example.com/image.png'),
    ).toThrow(OutboundUrlPolicyError);
    expect(() =>
      assertOutboundUrlAllowed('https://user:pass@media.example.com/image.png'),
    ).toThrow(OutboundUrlPolicyError);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('rejects an explicitly authorized private IP literal', () => {
    process.env.OUTBOUND_ALLOWED_ORIGINS = 'https://169.254.169.254';

    expect(() =>
      assertOutboundUrlAllowed('https://169.254.169.254/latest/meta-data'),
    ).toThrow('Outbound URL resolves to a prohibited address');
  });

  it('returns only the validated public DNS answer to the socket', async () => {
    const lookup = createPinnedLookup(async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    const resolved = await new Promise((resolve, reject) =>
      lookup('media.example.com', { all: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses),
      ),
    );

    expect(resolved).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects DNS answers containing a private address before connection', async () => {
    const lookup = createPinnedLookup(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);

    await expect(
      new Promise((resolve, reject) =>
        lookup('media.example.com', {}, (error, address) =>
          error ? reject(error) : resolve(address),
        ),
      ),
    ).rejects.toThrow(OutboundUrlPolicyError);
  });

  it('fails closed when DNS resolution fails', async () => {
    const lookup = createPinnedLookup(async () => {
      throw new Error('DNS unavailable');
    });

    await expect(
      new Promise((resolve, reject) =>
        lookup('media.example.com', {}, (error, address) =>
          error ? reject(error) : resolve(address),
        ),
      ),
    ).rejects.toThrow('DNS unavailable');
  });

  it('pins the validated DNS answer and does not follow redirects', async () => {
    (axios.request as jest.Mock).mockResolvedValue({
      data: Buffer.from('redirect response'),
      status: 302,
      statusText: 'Found',
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    });

    await expect(
      outboundFetch('https://media.example.com/image.png'),
    ).rejects.toThrow('Outbound redirects are not permitted');
    const config = (axios.request as jest.Mock).mock.calls[0][0];
    expect(config.maxRedirects).toBe(0);
    expect(config.proxy).toBe(false);
    expect(config.httpsAgent.options.keepAlive).toBe(false);
    expect(typeof config.httpsAgent.options.lookup).toBe('function');
  });
});