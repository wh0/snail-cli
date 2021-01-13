import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';

export default {
  input: 'snail.js',
  plugins: [
    commonjs(),
    resolve(),
  ],
  acorn: {
    allowHashBang: true,
  },
  output: {
    file: 'dist/snail.js'
  },
}
