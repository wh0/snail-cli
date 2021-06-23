module.exports = {
  env: {
    commonjs: true,
    es2021: true,
    node: true,
  },
  extends: [
    'airbnb-base',
  ],
  parserOptions: {
    ecmaVersion: 12,
  },
  rules: {
    'default-case': 'off',
    'global-require': 'off',
    'guard-for-in': 'off',
    'max-len': 'warn',
    'no-await-in-loop': 'off',
    'no-bitwise': 'off',
    'no-console': 'off',
    'no-continue': 'off',
    'no-else-return': 'off',
    'no-lonely-if': 'off',
    'no-mixed-operators': ['warn', {groups: [['<', '<=', '>', '>=', 'in', 'instanceof', '==', '!=', '===', '!==', '&', '^', '|']]}],
    'no-param-reassign': 'warn',
    'no-plusplus': 'off',
    'no-restricted-syntax': ['error', 'LabeledStatement', 'WithStatement'],
    'no-return-await': 'off',
    'no-shadow': 'warn',
    'no-unused-vars': ['warn', {args: 'none'}],
    'object-curly-spacing': ['error', 'never'],
    'one-var': 'off',
    'one-var-declaration-per-line': 'off',
    'padded-blocks': ['error', {blocks: 'never', classes: 'always', switches: 'never'}],
    'prefer-destructuring': 'off',
    'prefer-template': 'off',
    'quote-props': ['error', 'consistent'],
    'strict': 'off',
    'vars-on-top': 'off',
  },
};
