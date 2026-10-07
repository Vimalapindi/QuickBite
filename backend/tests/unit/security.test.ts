import { hashPassword, verifyPassword } from '../../src/modules/auth/password';
import { signToken, verifyToken } from '../../src/shared/utils/jwt';
import jwt from 'jsonwebtoken';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('salts: same password hashes differently', async () => {
    expect(await hashPassword('same')).not.toEqual(await hashPassword('same'));
  });
  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('jwt', () => {
  it('round-trips id and role', () => {
    const t = signToken({ id: '11111111-1111-1111-1111-111111111111', role: 'ADMIN' });
    expect(verifyToken(t)).toEqual({ id: '11111111-1111-1111-1111-111111111111', role: 'ADMIN' });
  });
  it('rejects tampered, foreign-secret, expired and alg=none tokens', () => {
    const good = signToken({ id: 'u1', role: 'CUSTOMER' });
    expect(verifyToken(good + 'x')).toBeNull();
    expect(verifyToken(jwt.sign({ role: 'ADMIN' }, 'other-secret-other-secret-other', { subject: 'u1' }))).toBeNull();
    expect(verifyToken(jwt.sign({ role: 'ADMIN' }, process.env.JWT_SECRET!, { subject: 'u1', expiresIn: -10 }))).toBeNull();
    const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + Buffer.from('{"sub":"u1","role":"ADMIN"}').toString('base64url') + '.';
    expect(verifyToken(none)).toBeNull();
  });
});
