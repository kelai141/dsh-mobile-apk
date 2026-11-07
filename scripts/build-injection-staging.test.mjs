import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('./build-apk-013.ps1', import.meta.url), 'utf8');
const stagingLoop = /^ {8}foreach \(\$nm in \$externByName\.Keys\) \{\r?\n(?=\s*\$leaf =)[\s\S]*?^ {8}\}/m.exec(source)?.[0];
const available = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
function enumeratePairs(code) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "$market='fixture-source'; $seen=@(); foreach($pair in " + code + ") { $seen += [PSCustomObject]@{leaf=$pair[0];src=$pair[1]} }; ConvertTo-Json -InputObject @($seen) -Compress"], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
test('actual staging loop injects each degraded browser bundle and keeps server-only packages at source', { skip: !available }, () => {
  assert.ok(stagingLoop, 'actual staging loop must be located');
  const setup = [
    "$ErrorActionPreference='Stop'; $Root='repo'; $degradeStaged='stage'; $degradeFailDetail=''",
    "$externByName=[ordered]@{ market='market-source'; browser='browser-source'; server='server-source' }",
    "$externStaged=@{}; foreach ($nm in $externByName.Keys) { $externStaged[$nm]=$externByName[$nm] }",
    "function Test-Path($target) { return $target -notmatch '^server-source' }",
    "function Remove-Item {}; function Get-Command {}; function New-Item {}; function Copy-Item {}",
    "function node { $global:LASTEXITCODE=0 }",
  ].join('; ');
  const script = setup + '\n' + stagingLoop + '\n$externStaged | ConvertTo-Json -Compress';
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const staged = JSON.parse(result.stdout.trim());
  for (const key of ['market', 'browser']) assert.equal(staged[key].replaceAll('\\', '/'), 'stage/' + key + '-degraded');
  assert.equal(staged.server, 'server-source');
});
test('negative control: the old singleton nested array flattens into invalid character pairs', { skip: !available }, () => {
  const pairs = enumeratePairs("@(@('market-degraded', $market))");
  assert.equal(pairs.length, 2);
  assert.notDeepEqual(pairs, [{ leaf: 'market-degraded', src: 'fixture-source' }]);
});
