import { ManagedRunner } from './runner.js';
import { resolveHostConfig } from './config.js';
import { createPlatformDriver } from './platform.js';

export const name = 'dsh-computer-use-host';
export const inject = ['subprocess'];

export function apply(ctx, rawConfig) {
  const config = resolveHostConfig(rawConfig);
  const provider = createPlatformDriver(new ManagedRunner(ctx, config), config);
  return ctx.provide('computer', provider);
}
