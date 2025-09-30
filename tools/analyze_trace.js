/**
 * Analyzes a trace file and categorizes the data points.
 * 
 * Use this script to analyze optolink-bridge trace files. This is helpful in case you would like to know what traffic is sent via the Optolink.
 * The Optolink interface usually is quite busy, Vitoconnect utilizes essentially the 4800 baud rate, resulting in about 20-25 packets per second.
 * By enabling the "log_level = trace" in your config.toml, and logging content over some time, you can generate a trace file. feeding this file in
 * this script, allows you to analyze the traffic. In order to narrow down to the statistics are created by summarizing packets received from / sent to
 * a given address. If a data point is already configured in config.toml, the data is output in the format of the data point. If not, the data is output
 * as a raw / hex string. Also the script tries to categorize the addresses into useful categories, such as: no data recorded, addresses with mostly
 * identical values recorded (e.g. enums), addresses with mostly variable values recorded (e.g. numerical / statistical values). This way of reporting
 * allows for a great way of understanding the traffic on the Optolink interface and finding (previously unknown) attributes / addresses.
 * 
 * yarn node analyze_trace.js analyze_trace_example.txt
 * 
 * To narrow the analysis down to one address, specify the address as a second argument:
 * 
 * yarn node analyze_trace.js analyze_trace_example.txt 0x1234
 * 
 * Note that the trace analysis works on different formats of trace files. The regular format is the following:
 * 
 * 2025-02-25 13:27:13.247 Vitoconnect → Optolink 410500212003014a
 * 
 * A date / time stamp, followed by the direction the data was recorded and the hex binary data of the packet. This is the format that Optolink Bridge
 * logs when put into "trace" mode. However this script works with less information as well, so removing the timestamp:
 * 
 * Vitoconnect → Optolink 410500212003014a
 * 
 * Or even the direction information, only logging the hex packet data:
 * 
 * 410500212003014a
 * 
 * Works essentially just as well. However it reduces the readability of the trace file, as well as if there is no timestamp recorded, you might be loosing
 * crucial information required for your analysis, i.e. when certain changes to certain addresses happened.
 */

import fs from 'node:fs/promises';
import readline from 'node:readline';
import { basename } from 'node:path';

import { default as parsePacket, parseValue } from '../parse_vs2.js';
import { exists, readConfig, formatAddr, mapDataPoints, fromLocalToOpto, fromOptoToLocal, fromOpto, directionName } from '../utils.js';
import { fromVitoToOpto, fromOptoToVito } from '../serial.js';

const path = process.argv[2];
if (!path || !(await exists(path))) {
  console.error(`Usage: ${basename(process.argv[1])} <trace-file>`);
  process.exit(1);
}

const config = await readConfig();
const dps = mapDataPoints(config.data_points);

const filterAddr = new Set(process.argv.slice(3).map(addr => {
  addr = addr.toLowerCase();
  if (addr.startsWith('0x')) {
    addr = addr.substring(2);
  }
  if (!/^[0-9a-f]{4}$/.test(addr)) {
    console.error(`Usage: ${basename(process.argv[1])} <trace-file> 0x[hex address]`);
    process.exit(1);
  }

  return parseInt(addr, 16);
}));

const file = await fs.open(path, 'r');
const lines = readline.createInterface({
  input: file.createReadStream(),
  crlfDelay: Infinity,
});

function getNumber(value) {
  const [int, frac] = value.toString().split('.');
  if (frac?.length > 3) {
    return `${int}.${frac.substring(0, 3)}…`;
  }
  return value;
}

/**
 * Get the raw value of a (internal) type. This can be either:
 * - a Buffer (raw value), returned 1:1
 * - an Array, representing a RPC request / response
 * - an object, representing a written value (with "write" property set to true)
 * 
 * @param {Buffer|Array|object} value the (raw / internal) value
 * @param {number} [index] the index of the value to return (for RPCs)
 * @returns {Buffer} the raw hex / buffer value
 */
function getRawValue(value, index) {
  if (Buffer.isBuffer(value)) {
    return value;
  } else if (Array.isArray(value)) {
    return value[index ?? 0];
  } else if (typeof value === 'object' && value.data && value.write === true) {
    return value.data;
  } else {
    throw new Error('Unsupported internal value type', value);
  }
}

/**
 * Prepare a given value that can be traced:
 * - Buffers to hex strings
 * - Numbers stay numbers
 * - BigInts to its string representation
 * - Everything else to a string
 * @param {Buffer|any} value the (raw) value to output
 * @param {object} [dp] the datapoint to parse the value
 * @returns {string} to value formatted as string
 */
function getValue(value, dp) {
  if (Array.isArray(value)) {
    return `${getValue(value[0], dp)} → ${getValue(value[1], dp)}`;
  } else if (typeof value === 'object' && value.data && value.write === true) {
    return `${getValue(value.data, dp)} (!)`;
  } else if (Buffer.isBuffer(value) && dp) {
    try {
      value = dp.parse(value);
    } catch (err) {
      // failed to parse data point, use raw instead
      (dp.err || (dp.err = [])).push(err);
    }
  }

  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }
  
  // in case the data point is unknown, output some scales for numbers
  if (typeof value === 'number') {
    return !dp ? [value, value / 10, value / 100, value / 3600].map(getNumber) : getNumber(value);
  } else if (typeof value === 'bigint' && !dp) {
    return [value, value / BigInt(10), value / BigInt(100), value / BigInt(3600)].map(value => value.toString());
  }

  return value.toString();
}

/**
 * Puts a given set of values into a category.
 * 
 * @param {(Buffer|Array|Object)[]} values the values to categorize
 * @returns {string} a value category
 */
function getType(values) {
  if (values.length === 0) {
    return 'no_data';
  }

  const avgLength = values.reduce((total, value) => {
    // if it is a RPC, use the response data length to determine the type
    return total + getRawValue(value, 1 /* response */).length;
  }, 0) / values.length;
  if (avgLength > 6) {
    return 'strings_or_arrays';
  }

  const valueSet = new Set(values.map(value =>
    (Array.isArray(value) ? value : [value])
      .map(value => getRawValue(value).toString('hex')).join('')));
  if (valueSet.size === 1) {
    return 'identical_values';
  } else if (valueSet.size < 10) {
    return 'mostly_identical_values';
  } else {
    return 'mostly_variable_values';
  }
}

const directionStats = {}, addrStats = {}, rpcReq = {}, malformed = [], perSecond = { avg: 0, secs: 0 };
for await (let line of lines) {
  let date, time;
  if (line.match(/^\d/)) {
    [date, time] = line.split(' ', 2);
    line = line.substring(date.length + time.length + 2);

    // calculate packets per second
    const sec = date + time.split('.', 1)[0];
    if (perSecond.curr !== sec) {
      if (perSecond.cnt) {
        // moving average of packets per second
        perSecond.avg = perSecond.avg + ((perSecond.cnt - perSecond.avg) / ++perSecond.secs);
      }

      perSecond.curr = sec;
      perSecond.cnt = 1;
    } else {
      perSecond.cnt++;
    }
  }

  let direction;
  if (line.startsWith('Local →')) {
    direction = fromLocalToOpto;
  } else if (line.startsWith('Vitoconnect →')) {
    direction = fromVitoToOpto;
  } else if (line.startsWith('Optolink →')) {
    direction = fromOptoToVito;
    if (line.startsWith('Optolink → Local')) {
      direction = fromOptoToLocal;
    }
  } else if (line.match(/^[0-9a-f]+$/)) {
    // try to derive the direction from the binary packet content
    let offset = 0;
    // first byte 06: ACK from Optolink
    if (line.startsWith('06')) {
      offset = 2;
    }
    // first (or following after 61) byte 41 to identify VS2 message format
    if (line[offset] !== '4' || line[offset + 1] !== '1') { // VS2_DAP_STANDARD
      malformed.push({ msg: 'Unknown direction / unexpected packet identifier, expected 41 / VS2_DAP_STANDARD', line });
      continue;
    }
    // skip 41 and length of the packet, upper word of the 3rd byte is the protocol ID (request or response)
    const id = line[offset + 5];
    if (id === '0') {
      direction = fromOptoToVito;
    } else if (id === '1') {
      direction = fromVitoToOpto;
    } else {
      malformed.push({ msg: 'Unknown direction / unexpected packet ID', line });
      continue;
    }
  } else {
    malformed.push({ msg: 'Unexpected line format', line });
    continue;
  }

  const directionStat = directionStats[direction] ?? (directionStats[direction] = { direction, count: 0, ids: {}, fns: {} });

  // statistic 1: count of packets per direction
  directionStat.count++;

  const data = Buffer.from(line.substring(line.lastIndexOf(' ') + 1), 'hex');
  let packet;
  try {
    packet = parsePacket(data, direction & fromOpto);
  } catch (err) {
    malformed.push({ msg: 'Failed to parse', line, data, err });
    continue;
  }

  // sync. packets
  if (!packet.addr) {
    continue;
  }

  // detail analysis of (a) specific address(es) only
  const addr = formatAddr(packet.addr);
  if (filterAddr.size) {
    if (!filterAddr.has(packet.addr)) {
      continue;
    } else if (!packet.data || !packet.data.length) {
      continue;
    }
    
    const addrStat = addrStats[addr] ?? (addrStats[addr] = {});
    if (!addrStat.prevData || !packet.data.equals(addrStat.prevData)) {
      if (addrStat.same > 0) {
        console.log(`… ${addrStat.same}× identical value(s) ${ filterAddr.size > 1 ? `for address ${addr} ` : ''}…`);
      }
  
      addrStat.prevData = Buffer.from(packet.data);
      addrStat.same = 0;
    } else {
      addrStat.same++;
      continue;
    }

    let fn;
    if (packet.fn === 0x01) {
      fn = 'READ';
    } else if (packet.fn === 0x02) {
      fn = 'WRITE';
    } else if (packet.fn === 0x07) {
      fn = 'RPC/' + (packet.id === 0x0 ? 'REQ' : 'RES');
    }
  
    let value;
    const dp = dps.get(packet.addr);
    if (dp) {
      value = `data point: ${getValue(packet.data, dp)}`;
    } else {
      value = `debug: ${JSON.stringify(Object.fromEntries(Object.entries(parseValue('debug', packet.data)).map(([key, value]) => [key, getValue(value)])))}`;
    }

    console.log(`${date && time ? `${date} ${time} ` : ''}${addr} (${fn}): ${getValue(packet.data)} (${value})`)

    continue;
  }

  // statistic 2: number of reads / writes / rpcs and requests / responses traced for every direction
  directionStat.fns[packet.fn] = (directionStat.fns[packet.fn] ?? 0) + 1;
  directionStat.ids[packet.id] = (directionStat.ids[packet.id] ?? 0) + 1;

  const addrStat = addrStats[addr] ?? (addrStats[addr] = { addr: packet.addr, count: 0, ids: {}, fns: {}, values: [], write: [] });

  // statistic 3: number of times address was traced (id [req / res], fn [read / write / rpc])
  addrStat.count++;
  addrStat.fns[packet.fn] = (addrStat.fns[packet.fn] ?? 0) + 1;
  addrStat.ids[packet.id] = (addrStat.ids[packet.id] ?? 0) + 1;

  // statistic 4: found / not found data points
  const dp = addrStats[addr].dp = dps.get(packet.addr);
  dp && (dp.mark = true);

  // statistic 5: written data / rpc data over time
  if (packet.data) {
    if (packet.fn === 0x07) { // remote procedure call
      if (packet.id === 0x0) {
        rpcReq.seq = packet.seq;
        rpcReq.data = Buffer.from(packet.data);
      } else if (rpcReq.seq === packet.seq) {
        // for RPCs bundle request and response statistics
        addrStats[addr].values.push([rpcReq.data, Buffer.from(packet.data)]);
      }
    } else if (packet.fn === 0x02 && packet.id === 0x0) { // write request
      addrStats[addr].values.push({ data: Buffer.from(packet.data), write: true });
    } else {
      addrStats[addr].values.push(Buffer.from(packet.data));
    }
  }
}

try {
  await file.close();
} catch {
  // nothing to do here
}

if (filterAddr.size) {
  for (const [addr, addrStat] of Object.entries(addrStats).filter(([addr, addrStat]) => addrStat.same > 0)) {
    console.log(`… ${addrStat.same}× identical value(s) ${ filterAddr.size > 1 ? `for address ${addr} ` : ''}`);
  }
  process.exit(0);
}

// statistic 6: categorize values by type (mostly identical, mostly variable values, etc.)
const types = {};
for (const [addr, { dp, values }] of Object.entries(addrStats)) {
  const type = addrStats[addr].type = getType(values, dp);  
  (types[type] = types[type] ?? []).push(addrStats[addr]);
}

if (Object.keys(directionStats).length) {
  console.log('Number of packets:');
  for (const { direction, count, fns } of Object.values(directionStats)) {
    console.log(`  ${directionName(direction)}: ${count}${direction === fromVitoToOpto ? ` (${fns[0x01] ?? 0} read, ${fns[0x02] ?? 0} write, ${fns[0x07] ?? 0} rpc, ${count - ((fns[0x01] ?? 0) + (fns[0x02] ?? 0) + (fns[0x07] ?? 0))} misc [e.g. sync.])` : ''}`);
  }
}

if (perSecond.avg) {
  console.log(`Average number of packets per second: ${perSecond.avg.toFixed(2)}`);
}
if (malformed.length) {
  console.log();
  console.log(`Malformed lines / packets: ${malformed.length}, e.g.:`, malformed[0].err ?? malformed[0]?.msg);
}

console.log();
function output(stats, valueFn) {
  const withDps = stats.filter(({ dp }) => dp);
  if (withDps.length) {
    console.log();
    console.log('With configured data points:');
    for (const { addr, count, values, dp } of withDps) {
      console.log(`  ${count}× ${formatAddr(addr)} (${dp.name})${valueFn ? `: ${valueFn(values, dp)}` : ''}`);
    }
  }
  
  const woDps = stats.filter(({ dp }) => !dp);
  if (woDps.length) {
    console.log();
    console.log('Without configured data points (output as raw / hex):');
    for (const { addr, count, values } of woDps) {
      console.log(`  ${count}× ${formatAddr(addr)}${valueFn ? `: ${valueFn(values)}` : ''}`);
    }
  }
}

const condenseRepeated = values => {
  return values.reduce((acc, value, index) => {
    if (index === 0 || (Array.isArray(value) ? (!value[0].equals(values[index - 1][0]) || !value[1].equals(values[index - 1][1])) : !getRawValue(value).equals(getRawValue(values[index - 1])))) {
      acc.push({ value, count: 1 });
    } else {
      acc[acc.length - 1].count++;
    }

    return acc;
  }, []);
};
function outputCondenseRepeated(values, dp) {
  let condensedValues = condenseRepeated(values), suffix = '';
  if (condensedValues.length > 10) {
    condensedValues = condensedValues.slice(0, 10);
    suffix = ', …'
  }

  let result = '';
  for (const { value, count } of condensedValues) {
    if (result) {
      result += ', ';
    }
    result += `${getValue(value, dp)}`;
    if (count > 1) {
      result += `, [${count - 1}× …]`;
    }
  }
  return result + suffix;
}

if (types.mostly_identical_values) {
  console.log('Addresses that contained mostly identical values (e.g. enums / state variables):');
  output(types.mostly_identical_values, outputCondenseRepeated);
  console.log();
}

const filterRepeated = values => {
  return values.filter((value, index) => index === 0 || (Array.isArray(value) ? (!value[0].equals(values[index - 1][0]) || !value[1].equals(values[index - 1][1])) : !getRawValue(value).equals(getRawValue(values[index - 1]))));
};
function outputFilterRepeated(values, dp) {
  let filteredValues = filterRepeated(values), suffix = '';
  if (filteredValues.length > 10) {
    filteredValues = filteredValues.slice(0, 10);
    suffix = ', …'
  }
  return `${filteredValues.map(value => getValue(value, dp)).join(', […], ')}${suffix}`
}

if (types.mostly_variable_values) {
  console.log('Addresses with mostly variable values (e.g. numerical values / statistics):');
  output(types.mostly_variable_values, outputFilterRepeated);
  console.log();
}

if (types.identical_values) {
  console.log('Addresses that never changed / always contained identical values (e.g. configurations):');
  output(types.identical_values, (values, dp) => `${values.length}× ${getValue(values[0], dp)}`);
  console.log();
}

if (types.strings_or_arrays) {
  console.log('Addresses which contained mostly strings or arrays (e.g. labels & complex data types):');
  output(types.strings_or_arrays, (values, dp) => `e.g. ${getValue(values[0], dp)}`);
  console.log();
}

if (types.no_data) {
  console.log('Addresses without any data traced (function calls w/o parameters):');
  output(types.no_data);
  console.log();
}

const dpsWithErr = Array.from(dps.values()).filter(dp => dp.err);
if (dpsWithErr.length) {
  console.log('Data points with errors when parsing:');
  for (const dp of dpsWithErr) {
    console.log(`  ${dp.name} (${formatAddr(dp.addr)}), ${dp.err.length} errors e.g.:`, dp.err[0]);
  }
  console.log();
}

const dpsTraced = Array.from(dps.values()).filter(dp => dp.mark);
if (dpsTraced.length) {
  console.log('Data points that have been traced at least once:');
  for (const dp of dpsTraced) {
    const addr = formatAddr(dp.addr), addrStat = addrStats[addr];
    console.log(`  ${dp.name} (${addr}), traced ${addrStat.count}× e.g.:`, getValue(addrStat.values[0], dp));
  }
  console.log();
}

const dpsNotTraced = Array.from(dps.values()).filter(dp => !dp.mark);
if (dpsNotTraced.length) {
  console.log('Data points that have not been traced:');
  for (const dp of dpsNotTraced) {
    console.log(`  ${dp.name} (${formatAddr(dp.addr)})`);
  }
  console.log();
}
