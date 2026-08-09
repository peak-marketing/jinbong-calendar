'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const {
  parseCsv,
  readWorkbookBuffer,
  safeCellValue,
} = require('./settlement-workbook-reader');

test('CSV parser는 quoted comma/newline을 보존하고 닫히지 않은 quote를 거부한다', () => {
  assert.deepEqual(parseCsv('a,"b,c"\r\n"d\ne",f\n'), [
    ['a', 'b,c'], ['d\ne', 'f'],
  ]);
  assert.throws(() => parseCsv('a,"broken'), /닫히지/);
});

test('XLSX는 수식을 실행하지 않고 cached result와 병합 metadata만 읽는다', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('2026-06 정산');
  sheet.getCell('A1').value = '일자';
  sheet.getCell('B1').value = '금액';
  sheet.getCell('A2').value = '2026-06-01';
  sheet.mergeCells('A2:A3');
  sheet.getCell('B2').value = { formula: '1+1', result: 2 };
  sheet.getCell('B3').value = 3;
  const buffer = await workbook.xlsx.writeBuffer();
  const sheets = await readWorkbookBuffer(Buffer.from(buffer), {
    sheetNames: ['2026-06 정산'],
  });
  const matrix = sheets.get('2026-06 정산');
  assert.equal(matrix[1][1], 2);
  assert.deepEqual(matrix.mergeRanges, [{
    startColumn: 1, startRow: 2, endColumn: 1, endRow: 3,
  }]);
  assert.equal(JSON.stringify(matrix).includes('1+1'), false);
  assert.equal(safeCellValue({ formula: 'process.exit()', result: 7 }), 7);
});
