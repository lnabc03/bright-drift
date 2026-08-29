import { describe, it, expect } from 'vitest';
import { analyzeBash, analyzePwsh, analyzeCommand } from './static-analysis.js';

describe('analyzeBash', () => {
  const cases: Array<[string, string[]]> = [
    ['echo hello > out.txt', ['out.txt']],
    ['echo hello >> log.txt', ['log.txt']],
    ['npm run build > dist/build.log 2>&1', ['dist/build.log']],
    ['cat a | tee out.txt', ['out.txt']],
    ['cat a | tee -a out.txt other.txt', ['out.txt', 'other.txt']],
    ["sed -i 's/foo/bar/' src/app.ts", ['src/app.ts']],
    ['sed -i.bak s/foo/bar/ src/app.ts', ['src/app.ts']],
    ['gcc main.c -o main', ['main']],
    ['echo hi > "my file.txt"', ['my file.txt']],
    ["echo hi > 'spaced name.txt'", ['spaced name.txt']],
    ['cmd1 > a.txt; cmd2 > b.txt', ['a.txt', 'b.txt']],
    ['cmd1 > a.txt && cmd2 >> b.txt', ['a.txt', 'b.txt']],
    ['ls -la', []],
    ['cat out.txt', []],
  ];

  it.each(cases)('%j → %j', (command, expected) => {
    expect(analyzeBash(command)).toEqual(expected);
  });

  it('returns [] on unterminated quotes instead of throwing', () => {
    expect(analyzeBash('echo "oops > x.txt')).toEqual([]);
  });
});

describe('analyzePwsh', () => {
  const cases: Array<[string, string[]]> = [
    ['echo hello > out.txt', ['out.txt']],
    ['echo hello >> out.txt', ['out.txt']],
    ['Get-Content a.txt | Out-File b.txt', ['b.txt']],
    ['Get-Content a.txt | Out-File -Append b.txt', ['b.txt']],
    ["Set-Content config.yml 'key: 1'", ['config.yml']],
    ["Add-Content log.txt 'line'", ['log.txt']],
    ['Out-File -FilePath out.txt', ['out.txt']],
    ['ls | Tee-Object out.txt', ['out.txt']],
    ['ls | Tee-Object -FilePath out.txt', ['out.txt']],
    ['Set-Content "my file.txt" x', ['my file.txt']],
    ['Get-ChildItem', []],
  ];

  it.each(cases)('%j → %j', (command, expected) => {
    expect(analyzePwsh(command)).toEqual(expected);
  });

  it('returns [] on parse failure', () => {
    expect(analyzePwsh('echo "unterminated > x.txt')).toEqual([]);
  });
});

describe('analyzeCommand dispatch', () => {
  it('routes by shell', () => {
    expect(analyzeCommand('pwsh', 'Set-Content a.txt x')).toEqual(['a.txt']);
    expect(analyzeCommand('bash', 'Set-Content a.txt x')).toEqual([]);
  });
});
