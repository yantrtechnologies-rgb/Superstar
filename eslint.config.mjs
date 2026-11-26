import tseslint from 'typescript-eslint';

export default tseslint.config(
  // infra/ holds plain CommonJS helper scripts that run on the server, not part of the TypeScript apps.
  { ignores: ['**/.next/**', '**/dist/**', '**/next-env.d.ts', 'infra/**'] },
  ...tseslint.configs.recommended,
);
