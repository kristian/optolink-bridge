/*
 * Use this script to convert data points in the "InsideViessmann" / "DP_Listen.zip" format into a optolink-bridge data points format.
 *
 * See 'convert_data_points_example.txt' and use the filename as an input to this script:
 * 
 * yarn node convert_data_points.js convert_data_points_example.txt
 * 
 * Input data format from:
 * 
 * https://github.com/sarnau/InsideViessmannVitosoft
 * https://github.com/philippoo66/ViessData21/blob/master/DP_Listen_2.zip
 */

import fs from 'node:fs/promises';
import readline from 'node:readline';
import { basename } from 'node:path';
import { exists } from '../utils.js';
import { snakeCase } from 'change-case';

let warnings = [];
const path = process.argv[2];
if (!path || !(await exists(path))) {
  console.error(`Usage: ${basename(process.argv[1])} <dps-file>`);
  process.exit(1);
}

const file = await fs.open(path, 'r');
const lines = readline.createInterface({
  input: file.createReadStream(),
  crlfDelay: Infinity,
});

const addrs = new Set(), names = new Set();
for await (let line of lines) {
  var match = /-\s*(?:\([a-f\d]+\)\s*)?(.*?) \(.*?(0x[a-f\d]{4}).*?\((.*?)\)/i.exec(line);
  if (!match) {
    continue;
  }
  
  let [, name, addr, type] = match;

  if (addrs.has(addr)) {
    continue; // duplicate address, sometimes addresses are repeated in order to e.g. describe that they also contain a status bit
  } addrs.add(addr);

  name = snakeCase(name);
  for (let orgName = name, i = 2; names.has(name); name = `${orgName} ${i}`, i++) {}
  names.add(name);

  switch (type) {
    case 'Array':
      type = 'raw';
      break;
    case 'String':
      type = 'utf8';
      break;
    case 'Byte':
      type = 'raw';
      break;
    case 'Int': case 'Int4':
      type = 'uint';
      break;
    case 'SByte': case 'SInt': case 'SInt4':
      type = 'int';
      break;
    default:
      warnings.push(`Unknown type "${type}" for attribute "${name}", using "raw" instead`);
      type = 'raw';
      break;
  }

  console.log(`  ["${name}", ${addr}, "${type}"],`)
}

try {
  await file.close();
} catch {
  // nothing to do here
}

if (warnings.length) {
  console.log();
  for (const warning of warnings) {
    console.warn(warning);
  }
}
