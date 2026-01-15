import { validatePassword } from './password';

describe('validatePassword', () => {
  it('accepts strong passwords', () => {
    expect(validatePassword('Passw0rd1')).toBe(true);
  });

  it('rejects short passwords', () => {
    expect(validatePassword('Pw0rd')).toBe(false);
  });

  it('rejects passwords without numbers', () => {
    expect(validatePassword('Password')).toBe(false);
  });
});
