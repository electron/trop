process.env.SPEC_RUNNING = '1';

module.exports = {
  roots: [
    '<rootDir>/spec'
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  clearMocks: true,
  testRegex: '(/spec/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: [
    'ts',
    'tsx',
    'js',
    'jsx',
    'json',
    'node'
  ],
}
