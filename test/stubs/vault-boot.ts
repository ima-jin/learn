import type { AppVaultCredentials, VaultBoot, VaultBootOptions } from '@ima-jin/auth-client';

/** Unit-test transport double; vault-boot.test.ts exercises the real SDK and encryption. */
export function mockVaultBoot<Config extends object>(
  options: VaultBootOptions<Config>,
  load: (options: VaultBootOptions<Config>['vault']) => Promise<AppVaultCredentials>,
): VaultBoot<Config> {
  let config: Readonly<Config> | undefined;
  return {
    getConfig() {
      if (!config) throw new Error('TEST_CONFIG_NOT_READY');
      return config;
    },
    async start(callback) {
      config = Object.freeze(await options.configure(await load(options.vault)));
      return callback(config);
    },
  };
}
