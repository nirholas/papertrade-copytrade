import { defineConfig } from 'tsup';

export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: ['esm'], dts: true, clean: true, target: 'node20', noExternal: ['papertrade-sdk'], external: ['viem'] },
  { entry: { bin: 'src/bin.ts' }, format: ['esm'], target: 'node20', noExternal: ['papertrade-sdk'], external: ['viem'], banner: { js: '#!/usr/bin/env node' } },
]);
