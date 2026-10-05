#!/usr/bin/env node
// 用项目内置 TypeScript 的 transpileModule 直接运行 lib/*.test.ts，无需额外依赖
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
Module._extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  module._compile(outputText, filename);
};

const files = process.argv.slice(2);
const targets = files.length
  ? files
  : ['lib/sync.test.ts', 'lib/store.test.ts'];

for (const file of targets) {
  require(path.resolve(root, file));
}
