/*
 * Use this script to convert optolink-splitter poll items into a optolink-bridge data points format.
 *
 * See 'convert_poll_items_example.txt' and use the filename as an input to this script:
 * 
 * yarn node convert_poll_items.js convert_poll_items_example.txt
 * 
 * Input data format from:
 * 
 * https://github.com/philippoo66/optolink-splitter/blob/main/settings_ini.py
 */


import fs from 'node:fs/promises';
import readline from 'node:readline';
import { basename } from 'node:path';
import { exists } from '../utils.js';

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

const warnings = [];
for await (let line of lines) {
  const item = line.match(/(?<=\().*(?=\))/g)?.[0]?.split(/\s*,\s*/);
  if (!item) {
    continue;
  }

  let [poll_cycle, name, address, length, byte_bit_filter, scale_or_type, signed] = item;
  if (!isFinite(poll_cycle)) {
    [name, address, length, byte_bit_filter, scale_or_type, signed] = item;
    poll_cycle = undefined;
  }

  name = name.match(/(?<=\").*(?=\")/g)[0];

  if (!/^\s*"b:/.test(byte_bit_filter)) {
    [scale_or_type, signed] = [byte_bit_filter, scale_or_type];
    byte_bit_filter = undefined;
  } else {
    byte_bit_filter = byte_bit_filter.match(/(?<=\").*(?=\")/g)[0];
  }

  let scale = 1, type;
  if (isFinite(scale_or_type)) {
    scale = parseFloat(scale_or_type);
  } else {
    type = scale_or_type.match(/(?<=\").*(?=\")/g)[0];
  }

  signed = signed === 'True';

  if (!type) {
    type = `int${(parseInt(length) * 8)}`;
    if (!signed) {
      type = `u${type}`;
    }
  }

  if (byte_bit_filter) {
    warnings.push(`Byte-bit filters are currently not supported by optolink-bridge, using "raw" type for "${name}"`);
    type = 'raw';
  }
  if (poll_cycle) {
    warnings.push(`Poll-cycles are not required for optolink-bridge, "${name}" will be published when it is sent via the Optolink interface`);
  }

  console.log(`  ["${name}", ${address}, "${type}"${ scale !== 1 ? `, ${scale}` : '' }],`);
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
