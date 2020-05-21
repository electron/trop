import * as commands from '../src/constants';

describe('commands', () => {
  it('should all be unique', () => {
    const commandsRecord: Record<string, string> = commands as any;
    const allCommands = Object.keys(commandsRecord)
      .map((key) => commandsRecord[key])
      .sort();
    const uniqueCommands = Array.from(new Set(allCommands)).sort();
    expect(allCommands).toStrictEqual(uniqueCommands);
  });
});
