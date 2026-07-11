const unavailable = (): Error => new Error('credential subsystem unavailable');

export const currentKekVersion = (): number => {
  const raw = Deno.env.get('KEEL_CREDENTIAL_KEK_VERSION');
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw unavailable();
  const version = Number(raw);
  if (!Number.isSafeInteger(version)) throw unavailable();
  return version;
};

export const getKek = (version: number): string => {
  if (!Number.isSafeInteger(version) || version <= 0) throw unavailable();
  const current = currentKekVersion();
  const value =
    version === current
      ? Deno.env.get('KEEL_CREDENTIAL_KEK')
      : Deno.env.get(`KEEL_CREDENTIAL_KEK_V${version}`);
  if (!value) throw unavailable();
  return value;
};
